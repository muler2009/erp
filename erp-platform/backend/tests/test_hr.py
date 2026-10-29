import threading
from datetime import date, datetime, timedelta, timezone as tz
from decimal import Decimal as D

import pytest
from django.db import connections
from django_tenants.utils import schema_context

from modules.finance import models as fm
from modules.finance import services as fin
from modules.hr import models as hm
from modules.hr import lifecycle as life
from modules.hr import services as hr
from platform_core.organizations import services as org
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from shared.events.models import OutboxEvent
from shared.workflows import services as wf
from shared.workflows.models import ApprovalTask
from tests.conftest import ACME_HOST, Api
from tests.test_finance import prepare, user

MAR = (date(2026, 3, 1), date(2026, 3, 31))  # 22 working days (Mon-Fri)


def hire(f, name, user_key=None, manager=None, salary="2200", hire_date=date(2026, 1, 5), contract=True):
    p = f["people"]
    e = hr.create_employee(p["hrm"].id, first_name=name, last_name="Test", hire_date=hire_date, user_id=p[user_key].id if user_key else None, manager_id=manager.id if manager else None, bank_account="000123")
    for item in e.checklist.all():
        hr.complete_checklist_item(p["hrm"].id, item.id)
    hr.activate_employee(p["hrm"].id, e.id)
    if contract:
        hr.add_contract(p["hrm"].id, e.id, start_date=hire_date, monthly_salary=salary, currency="USD")
    e.refresh_from_db()
    return e


def setup_env(tenant):
    env = prepare(tenant)
    hr.seed_defaults()
    p = env["people"]
    p.update(hrm=user(tenant, f"hrm@{tenant.slug}.test", "hr_manager"), hro=user(tenant, f"hro@{tenant.slug}.test", "hr_officer"), dm=user(tenant, f"dm@{tenant.slug}.test", "department_manager"),
             e1=user(tenant, f"e1@{tenant.slug}.test", "employee"), e2=user(tenant, f"e2@{tenant.slug}.test", "employee"), dm2=user(tenant, f"dm2@{tenant.slug}.test", "department_manager"))
    env["f"] = env
    return env


@pytest.fixture
def f(acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        yield setup_env(tenant)


def bal(code):
    return abs(fin.account_balance(fm.Account.objects.get(code=code)))


def rules(f):
    hr.set_tax_brackets(f["people"]["hrm"].id, [{"lower_bound": "0", "rate": "0"}, {"lower_bound": "1000", "rate": "10"}, {"lower_bound": "2000", "rate": "20"}])
    allowance = hr.create_component(f["people"]["hrm"].id, code="HOUSING", name="Housing", kind="ALLOWANCE", calc="FIXED", value="200")
    loan = hr.create_component(f["people"]["hrm"].id, code="LOAN", name="Loan repayment", kind="DEDUCTION", calc="FIXED", value="50")
    return allowance, loan


# ----------------------------------------------------------------------------- employees
@pytest.mark.django_db
def test_onboarding_checklist_gates_activation_and_emits_event(f):
    p = f["people"]
    e = hr.create_employee(p["hrm"].id, first_name="Abel", last_name="K", hire_date=date(2026, 3, 2))
    assert e.employee_no == "EMP-00001" and e.status == "ONBOARDING" and e.checklist.count() == 5
    with pytest.raises(DomainError) as x:
        hr.activate_employee(p["hrm"].id, e.id)
    assert x.value.get_codes() == "onboarding_incomplete"
    for i in e.checklist.all():
        hr.complete_checklist_item(p["hrm"].id, i.id)
    assert hr.activate_employee(p["hrm"].id, e.id).status == "ACTIVE"
    assert OutboxEvent.objects.filter(event_type="hr.employee.created", payload__employee_id=str(e.id)).count() == 1
    with pytest.raises(DomainError):
        hr.activate_employee(p["hrm"].id, e.id)
    with pytest.raises(ValidationFailed):
        hr.create_employee(p["hrm"].id, first_name=" ", last_name="x", hire_date=date(2026, 3, 2))
    with pytest.raises(ValidationFailed):
        hr.create_employee(p["hrm"].id, first_name="Out", last_name="Sider", hire_date=date(2026, 3, 2), user_id="00000000-0000-0000-0000-000000000001")  # not a member


@pytest.mark.django_db
def test_manager_cycles_and_double_user_links_are_refused(f):
    a = hire(f, "A", "e1")
    b = hire(f, "B", manager=a)
    with pytest.raises(ValidationFailed) as x:
        life.change_assignment(f["people"]["hrm"].id, a.id, kind="REPORTING_LINE", effective_date=date(2026, 3, 1), manager_id=b.id, reason="x")
    assert x.value.get_codes() == "management_cycle"
    with pytest.raises(ValidationFailed) as x:
        hr.update_employee(f["people"]["hrm"].id, a.id, manager_id=b.id)  # history-bearing fields are not editable in place
    assert x.value.get_codes() == "use_assignment_change"
    with pytest.raises(DomainError):
        hr.create_employee(f["people"]["hrm"].id, first_name="Dup", last_name="Link", hire_date=date(2026, 3, 2), user_id=f["people"]["e1"].id)


@pytest.mark.django_db
def test_contract_rules(f):
    p = f["people"]
    e = hire(f, "C", contract=False)
    hr.add_contract(p["hrm"].id, e.id, start_date=date(2026, 1, 5), end_date=date(2026, 6, 30), monthly_salary="1000", currency="USD", kind="FIXED_TERM")
    with pytest.raises(DomainError) as x:
        hr.add_contract(p["hrm"].id, e.id, start_date=date(2026, 6, 1), monthly_salary="1200", currency="USD")
    assert x.value.get_codes() == "contract_overlap"
    hr.add_contract(p["hrm"].id, e.id, start_date=date(2026, 7, 1), monthly_salary="1200", currency="USD")
    for bad in (dict(kind="FIXED_TERM"), dict(monthly_salary="-5"), dict(currency="XXX")):
        args = dict(start_date=date(2027, 1, 1), monthly_salary="1", currency="USD", **{k: v for k, v in bad.items() if k == "kind"})
        args.update({k: v for k, v in bad.items() if k != "kind"})
        with pytest.raises(ValidationFailed):
            hr.add_contract(p["hrm"].id, e.id, **args)


@pytest.mark.django_db
def test_offboarding_ends_contract_and_blocks_further_changes(f):
    p = f["people"]
    e = hire(f, "Leaver", "e1")
    req = hr.allocate_leave(p["hrm"].id, e.id, leave_type=hm.LeaveType.objects.get(code="ANNUAL").id, year=2026, days=10)
    lr = hr.request_leave(p["e1"].id, e.id, leave_type=req.leave_type_id, start_date=date(2026, 9, 7), end_date=date(2026, 9, 8))
    hr.start_offboarding(p["hrm"].id, e.id, termination_date=date(2026, 3, 20), reason="Resigned")
    with pytest.raises(DomainError):
        hr.complete_offboarding(p["hrm"].id, e.id)  # tasks open
    for i in e.checklist.filter(kind="OFFBOARDING"):
        hr.complete_checklist_item(p["hrm"].id, i.id)
    with pytest.raises(DomainError) as x:
        hr.complete_offboarding(p["hrm"].id, e.id)
    assert x.value.get_codes() == "settlement_missing"
    hr.record_settlement(p["hrm"].id, e.id, amount="1500", notes="unused leave paid out")
    hr.complete_offboarding(p["hrm"].id, e.id)
    e.refresh_from_db(); lr.refresh_from_db()
    assert e.status == "TERMINATED" and e.contracts.get().end_date == date(2026, 3, 20) and lr.status == "CANCELLED"
    assert OutboxEvent.objects.filter(event_type="hr.employee.terminated").count() == 1
    with pytest.raises(DomainError):
        hr.update_employee(p["hrm"].id, e.id, first_name="x")


# ----------------------------------------------------------------------------- attendance
@pytest.mark.django_db
def test_attendance_clock_in_out_once_per_day(f):
    p = f["people"]
    e = hire(f, "Clock", "e1")
    t0 = datetime(2026, 3, 16, 8, 0, tzinfo=tz.utc)
    hr.check_in(p["e1"].id, now=t0)
    with pytest.raises(DomainError) as x:
        hr.check_in(p["e1"].id, now=t0 + timedelta(hours=1))
    assert x.value.get_codes() == "already_checked_in"
    a = hr.check_out(p["e1"].id, now=t0 + timedelta(hours=8, minutes=30))
    assert a.hours == D("8.50")
    with pytest.raises(DomainError) as x:
        hr.check_out(p["e1"].id, now=t0 + timedelta(hours=9))
    assert x.value.get_codes() == "not_checked_in"
    with pytest.raises(DomainError):
        hr.check_in(p["hrm"].id)  # no employee record
    fixed = hr.record_attendance(p["hrm"].id, e.id, work_date=date(2026, 3, 16), check_in=t0, check_out=t0 + timedelta(hours=9))
    assert fixed.hours == D("9.00") and hm.Attendance.objects.count() == 1
    with pytest.raises(ValidationFailed):
        hr.record_attendance(p["hrm"].id, e.id, work_date=date(2026, 3, 17), check_in=t0, check_out=t0 - timedelta(hours=1))


# ----------------------------------------------------------------------------- leave
def annual(f, e, days=5):
    lt = hm.LeaveType.objects.get(code="ANNUAL")
    hr.allocate_leave(f["people"]["hrm"].id, e.id, leave_type=lt.id, year=2026, days=days)
    return lt


@pytest.mark.django_db
def test_leave_balance_overlap_and_business_days(f):
    p = f["people"]
    e = hire(f, "Lee", "e1")
    lt = annual(f, e, 5)
    org.add_holiday(None, date(2026, 4, 8), "Holiday")
    r = hr.request_leave(p["e1"].id, e.id, leave_type=lt.id, start_date=date(2026, 4, 6), end_date=date(2026, 4, 10))  # Mon-Fri with a holiday → 4 days
    assert r.days == 4 and r.status == "PENDING"
    assert hr.leave_balance(e, lt, 2026)["remaining"] == 1
    with pytest.raises(DomainError) as x:
        hr.request_leave(p["e1"].id, e.id, leave_type=lt.id, start_date=date(2026, 4, 9), end_date=date(2026, 4, 9))
    assert x.value.get_codes() == "leave_overlap"
    with pytest.raises(DomainError) as x:
        hr.request_leave(p["e1"].id, e.id, leave_type=lt.id, start_date=date(2026, 5, 4), end_date=date(2026, 5, 5))
    assert x.value.get_codes() == "insufficient_leave_balance"
    with pytest.raises(ValidationFailed) as x:
        hr.request_leave(p["e1"].id, e.id, leave_type=lt.id, start_date=date(2026, 5, 9), end_date=date(2026, 5, 10))  # weekend
    assert x.value.get_codes() == "no_working_days"
    with pytest.raises(DomainError):
        hr.request_leave(p["e2"].id, e.id, leave_type=lt.id, start_date=date(2026, 6, 1), end_date=date(2026, 6, 1))  # someone else's record
    hr.cancel_leave(p["e1"].id, r.id)
    assert hr.leave_balance(e, lt, 2026)["remaining"] == 5


@pytest.mark.django_db
def test_leave_decision_by_manager_with_separation_of_duties(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e = hire(f, "Staff", "e1", manager=boss)
    lt = annual(f, e)
    r = hr.request_leave(p["e1"].id, e.id, leave_type=lt.id, start_date=date(2026, 4, 6), end_date=date(2026, 4, 6))
    with pytest.raises(DomainError) as x:
        hr.decide_leave(p["dm2"].id, r.id, approve=True)  # another manager: not their report
    assert x.value.status_code == 404
    with pytest.raises(DomainError):
        hr.decide_leave(p["e1"].id, r.id, approve=True)  # employee role lacks hr.leave.approve → also hidden
    with pytest.raises(ValidationFailed):
        hr.decide_leave(p["dm"].id, r.id, approve=False)  # rejection needs a note
    own = hr.request_leave(p["dm"].id, boss.id, leave_type=annual(f, boss).id, start_date=date(2026, 4, 7), end_date=date(2026, 4, 7))
    with pytest.raises(DomainError) as x:
        hr.decide_leave(p["dm"].id, own.id, approve=True)  # own leave: hidden or refused
    assert x.value.get_codes() in ("separation_of_duties", "not_found")
    assert hr.decide_leave(p["dm"].id, r.id, approve=True).status == "APPROVED"
    with pytest.raises(DomainError):
        hr.decide_leave(p["dm"].id, r.id, approve=True)  # already decided
    assert hr.decide_leave(p["hrm"].id, own.id, approve=False, note="busy period").status == "REJECTED"  # HR can decide a manager's own request


@pytest.mark.django_db
def test_workflow_governed_leave(f):
    p = f["people"]
    wf.create_definition(p["hrm"].id, code="lv", name="Leave", subject_type="hr.leave", stages=[{"order": 1, "name": "HR", "approvers": [{"type": "USER", "ref": str(p["hrm"].id)}]}])
    e = hire(f, "Wf", "e1")
    lt = annual(f, e)
    r1 = hr.request_leave(p["e1"].id, e.id, leave_type=lt.id, start_date=date(2026, 4, 6), end_date=date(2026, 4, 6))
    r2 = hr.request_leave(p["e1"].id, e.id, leave_type=lt.id, start_date=date(2026, 4, 7), end_date=date(2026, 4, 7))
    with pytest.raises(DomainError) as x:
        hr.decide_leave(p["hrm"].id, r1.id, approve=True)
    assert x.value.get_codes() == "workflow_governed"
    wf.decide(p["hrm"].id, ApprovalTask.objects.get(instance_id=r1.workflow_instance_id, assignee_id=p["hrm"].id).id, "APPROVE")
    wf.decide(p["hrm"].id, ApprovalTask.objects.get(instance_id=r2.workflow_instance_id, assignee_id=p["hrm"].id).id, "REJECT", "no")
    r1.refresh_from_db(); r2.refresh_from_db()
    assert (r1.status, r2.status) == ("APPROVED", "REJECTED")
    assert hr.leave_balance(e, lt, 2026)["used"] == 1  # rejected leave frees the balance


# ----------------------------------------------------------------------------- timesheets
@pytest.mark.django_db
def test_timesheet_submit_and_approval(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e = hire(f, "TS", "e1", manager=boss)
    wk = date(2026, 3, 16)
    entries = [{"work_date": wk + timedelta(days=i), "hours": "8", "project_ref": "P-1"} for i in range(5)]
    ts = hr.save_timesheet(p["e1"].id, e.id, wk, entries)
    assert sum(x.hours for x in ts.entries.all()) == 40
    for bad in ([{"work_date": wk, "hours": "25"}], [{"work_date": wk + timedelta(days=9), "hours": "1"}], [{"work_date": wk, "hours": "20"}, {"work_date": wk, "hours": "5"}]):
        with pytest.raises(ValidationFailed):
            hr.save_timesheet(p["e1"].id, e.id, wk, bad)
    with pytest.raises(ValidationFailed):
        hr.save_timesheet(p["e1"].id, e.id, wk + timedelta(days=1), entries)  # not a Monday
    with pytest.raises(DomainError):
        hr.decide_timesheet(p["dm"].id, ts.id, approve=True)  # not submitted
    hr.submit_timesheet(p["e1"].id, ts.id)
    with pytest.raises(DomainError):
        hr.save_timesheet(p["e1"].id, e.id, wk, entries)  # frozen while submitted
    with pytest.raises(DomainError):
        hr.decide_timesheet(p["e2"].id, ts.id, approve=True)
    assert hr.decide_timesheet(p["dm"].id, ts.id, approve=False, note="fix project codes").status == "REJECTED"
    hr.save_timesheet(p["e1"].id, e.id, wk, entries)  # editable again
    hr.submit_timesheet(p["e1"].id, ts.id)
    assert hr.decide_timesheet(p["dm"].id, ts.id, approve=True).status == "APPROVED"


# ----------------------------------------------------------------------------- payroll
@pytest.mark.django_db
def test_payslip_arithmetic_with_allowance_deduction_pension_and_progressive_tax(f):
    p = f["people"]
    allowance, loan = rules(f)
    e = hire(f, "Pay", "e1")
    hr.assign_component(p["hrm"].id, e.id, component=allowance.id, start_date=date(2026, 1, 1))
    hr.assign_component(p["hrm"].id, e.id, component=loan.id, start_date=date(2026, 1, 1))
    run = hr.create_payroll_run(p["hro"].id, *MAR)
    s = run.payslips.get()
    assert (s.working_days, s.payable_days, s.basic, s.allowances, s.gross) == (22, 22, D("2200"), D("200"), D("2400"))
    assert (s.pension_employee, s.pension_employer, s.taxable_income) == (D("154"), D("242"), D("2246"))
    assert s.income_tax == D("149.20") and s.other_deductions == D("50") and s.net == D("2046.80")
    assert (run.gross_total, run.net_total, run.tax_total) == (D("2400"), D("2046.80"), D("149.20"))
    assert run.rules_snapshot["tax_brackets"][1] == ["1000.0000", "10.000"]
    assert sorted(l.code for l in s.lines.all()) == ["BASIC", "HOUSING", "INCOME_TAX", "LOAN", "PENSION"]
    assert sum(l.amount for l in s.lines.all()) == s.net  # the slip lines add up to the net pay


@pytest.mark.django_db
def test_proration_for_mid_month_hire_unpaid_leave_and_termination(f):
    p = f["people"]
    full = hire(f, "Full")
    mid = hire(f, "Mid", hire_date=date(2026, 3, 16))  # 12 working days remain (16–31 Mar)
    unpaid = hire(f, "Unpaid", "e1")
    lt = hm.LeaveType.objects.get(code="UNPAID")
    r = hr.request_leave(p["e1"].id, unpaid.id, leave_type=lt.id, start_date=date(2026, 3, 2), end_date=date(2026, 3, 3))
    hr.decide_leave(p["hrm"].id, r.id, approve=True)
    gone = hire(f, "Gone")
    hr.start_offboarding(p["hrm"].id, gone.id, termination_date=date(2026, 3, 13), reason="x")  # 10 working days
    run = hr.create_payroll_run(p["hro"].id, *MAR)
    slip = {s.employee.name.split()[0]: s for s in run.payslips.all()}
    assert slip["Full"].basic == D("2200")
    assert slip["Mid"].payable_days == 12 and slip["Mid"].basic == D("1200")
    assert slip["Unpaid"].unpaid_leave_days == 2 and slip["Unpaid"].payable_days == 20 and slip["Unpaid"].basic == D("2000")
    assert slip["Gone"].payable_days == 10 and slip["Gone"].basic == D("1000")


@pytest.mark.django_db
def test_run_period_uniqueness_and_validation(f):
    p = f["people"]
    with pytest.raises(DomainError) as x:
        hr.create_payroll_run(p["hro"].id, *MAR)  # nobody to pay yet
    assert x.value.get_codes() == "nothing_to_pay" and not hm.PayrollRun.objects.exists()
    hire(f, "One")
    with pytest.raises(ValidationFailed):
        hr.create_payroll_run(p["hro"].id, date(2026, 3, 2), date(2026, 3, 31))
    run = hr.create_payroll_run(p["hro"].id, *MAR)
    with pytest.raises(DomainError) as x:
        hr.create_payroll_run(p["hro"].id, *MAR)
    assert x.value.get_codes() == "run_exists"
    hr.cancel_payroll(p["hro"].id, run.id)
    assert hr.create_payroll_run(p["hro"].id, *MAR).id != run.id  # a cancelled run frees the period
    assert hm.TaxBracket.objects.count() == 0  # no statutory table is invented: tax is zero until configured
    assert hm.Payslip.objects.filter(run__status="DRAFT").first().income_tax == 0


@pytest.mark.django_db
def test_negative_net_pay_is_refused(f):
    p = f["people"]
    e = hire(f, "Debt", "e1", salary="100")
    big = hr.create_component(p["hrm"].id, code="BIG", name="Big deduction", kind="DEDUCTION", calc="FIXED", value="500")
    hr.assign_component(p["hrm"].id, e.id, component=big.id, start_date=date(2026, 1, 1))
    with pytest.raises(DomainError) as x:
        hr.create_payroll_run(p["hro"].id, *MAR)
    assert x.value.get_codes() == "negative_net_pay"
    assert not hm.PayrollRun.objects.exists()  # nothing left behind


def approved_run(f):
    p = f["people"]
    rules(f)
    e = hire(f, "Pay", "e1")
    run = hr.create_payroll_run(p["hro"].id, *MAR)
    hr.submit_payroll(p["hro"].id, run.id)
    hr.approve_payroll(p["hrm"].id, run.id)
    run.refresh_from_db()
    return run, e


@pytest.mark.django_db
def test_payroll_lifecycle_separation_of_duties_and_ledger(f):
    p = f["people"]
    run, e = approved_run(f)
    run2 = hr.create_payroll_run(p["hro"].id, date(2026, 4, 1), date(2026, 4, 30))
    hr.submit_payroll(p["hro"].id, run2.id)
    with pytest.raises(DomainError) as x:
        hr.approve_payroll(p["hro"].id, run2.id)  # the preparer
    assert x.value.get_codes() == "separation_of_duties"
    with pytest.raises(DomainError) as x:
        hr.recalculate_payroll(p["hro"].id, run.id)  # frozen once approved
    assert x.value.get_codes() == "invalid_state_transition"
    with pytest.raises(DomainError) as x:
        hr.post_payroll(p["hrm"].id, run.id)  # the approver
    assert x.value.get_codes() == "separation_of_duties"
    with pytest.raises(DomainError):
        hr.pay_payroll(p["ctrl"].id, run.id)  # not posted yet
    hr.post_payroll(p["hro"].id, run.id)
    gross_plus_er = run.gross_total + run.pension_employer_total
    assert bal("5300") == gross_plus_er and bal("2400") == run.net_total
    assert bal("2410") == run.tax_total + run.deduction_total and bal("2420") == run.pension_employee_total + run.pension_employer_total
    for who in ("hro", "hrm"):
        with pytest.raises(DomainError) as x:
            hr.pay_payroll(p[who].id, run.id, payment_date=date(2026, 4, 1))
        assert x.value.get_codes() == "separation_of_duties"
    paid = hr.pay_payroll(p["ctrl"].id, run.id, payment_date=date(2026, 4, 1))
    assert paid.status == "PAID" and bal("2400") == 0 and bal("1010") == run.net_total
    with pytest.raises(DomainError):
        hr.pay_payroll(p["ctrl"].id, run.id)  # never twice
    assert OutboxEvent.objects.filter(event_type="hr.payroll.posted", payload__run_id=str(run.id)).count() == 1
    assert OutboxEvent.objects.filter(event_type="hr.payroll.paid", payload__run_id=str(run.id)).count() == 1


@pytest.mark.django_db
def test_payslip_visibility_and_reject_returns_to_draft(f):
    p = f["people"]
    rules(f)
    e1, e2 = hire(f, "One", "e1"), hire(f, "Two", "e2")
    run = hr.create_payroll_run(p["hro"].id, *MAR)
    assert hr.payslips_visible_to(p["e1"].id).count() == 0  # nothing before approval
    hr.submit_payroll(p["hro"].id, run.id)
    with pytest.raises(ValidationFailed):
        hr.reject_payroll(p["hrm"].id, run.id, " ")
    hr.reject_payroll(p["hrm"].id, run.id, "check allowances")
    run.refresh_from_db()
    assert run.status == "DRAFT"
    hr.submit_payroll(p["hro"].id, run.id)
    hr.approve_payroll(p["hrm"].id, run.id)
    assert [s.employee_id for s in hr.payslips_visible_to(p["e1"].id)] == [e1.id]
    assert hr.payslips_visible_to(p["e1"].id, e2).count() == 0
    assert hr.payslips_visible_to(p["hrm"].id).count() == 2
    assert hr.payslips_visible_to(p["dm"].id).count() == 0


@pytest.mark.django_db
def test_workflow_governed_payroll_approval(f):
    p = f["people"]
    wf.create_definition(p["hrm"].id, code="pr", name="Payroll", subject_type="hr.payroll", stages=[{"order": 1, "name": "HR head", "approvers": [{"type": "USER", "ref": str(p["hrm"].id)}]}])
    hire(f, "W")
    run = hr.create_payroll_run(p["hro"].id, *MAR)
    hr.submit_payroll(p["hro"].id, run.id)
    run.refresh_from_db()
    with pytest.raises(DomainError) as x:
        hr.approve_payroll(p["hrm"].id, run.id)
    assert x.value.get_codes() == "workflow_governed"
    wf.decide(p["hrm"].id, ApprovalTask.objects.get(instance_id=run.workflow_instance_id, assignee_id=p["hrm"].id).id, "APPROVE")
    run.refresh_from_db()
    assert run.status == "APPROVED" and run.approved_by == p["hrm"].id


# ----------------------------------------------------------------------------- HTTP
@pytest.fixture
def api_env(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = setup_env(tenant)
        boss = hire(env, "Boss", "dm")
        hire(env, "Staff", "e1", manager=boss)
        hire(env, "Other", "e2")
    apis = {}
    for key in ("hrm", "hro", "dm", "dm2", "e1", "e2", "ctrl", "auditor"):
        ExternalIdentity.objects.create(user=env["people"][key], issuer="https://kc.test/realms/erp", subject=f"{key}-sub")
        apis[key] = Api(ACME_HOST)
        assert apis[key].login(idp, f"{key}-sub").status_code == 302
    return env, apis


@pytest.mark.django_db
def test_hr_api_visibility_and_permissions(api_env):
    env, api = api_env
    mine = api["e1"].get("/api/v1/hr/employees").json()["results"]
    assert [x["name"] for x in mine] == ["Staff Test"] and "bank_account" in mine[0]  # sees only themselves, incl. own details
    assert {x["name"] for x in api["dm"].get("/api/v1/hr/employees").json()["results"]} == {"Boss Test", "Staff Test"}  # self + direct report
    assert len(api["hrm"].get("/api/v1/hr/employees").json()["results"]) == 3
    other = next(x for x in api["hrm"].get("/api/v1/hr/employees").json()["results"] if x["name"] == "Other Test")
    assert api["e1"].get(f"/api/v1/hr/employees/{other['id']}").status_code == 404
    assert api["dm2"].get(f"/api/v1/hr/employees/{other['id']}").status_code == 404
    assert api["e1"].post("/api/v1/hr/employees", {"first_name": "x", "last_name": "y", "hire_date": "2026-03-01"}).status_code == 403
    assert api["e1"].get(f"/api/v1/hr/employees/{other['id']}/contracts").status_code == 403  # salaries need hr.compensation.view
    assert api["hro"].get(f"/api/v1/hr/employees/{other['id']}/contracts").status_code == 403  # officers do not see pay
    assert api["hrm"].get(f"/api/v1/hr/employees/{other['id']}/contracts").status_code == 200
    assert api["auditor"].get("/api/v1/hr/reports/headcount").status_code == 200
    assert api["auditor"].get("/api/v1/hr/payroll/runs").status_code == 403
    assert api["e1"].get("/api/v1/hr/payroll/runs").status_code == 403
    assert api["e1"].get("/api/v1/hr/me").json()["leave_balances"][0]["leave_type"] in ("ANNUAL", "SICK", "UNPAID")
    assert api["dm"].get("/api/v1/hr/me/payslips").status_code == 200


@pytest.mark.django_db
def test_hr_api_leave_and_payroll_end_to_end(api_env):
    env, api = api_env
    emps = {x["name"]: x["id"] for x in api["hrm"].get("/api/v1/hr/employees").json()["results"]}
    assert api["e1"].post("/api/v1/hr/leave/allocations", {"employee": emps["Staff Test"], "leave_type": "x", "days": "99"}).status_code == 403  # employees cannot grant themselves leave
    with schema_context("t_acme"):
        lt = str(hm.LeaveType.objects.get(code="ANNUAL").id)
    assert api["hrm"].post("/api/v1/hr/leave/allocations", {"employee": emps["Staff Test"], "leave_type": lt, "year": 2026, "days": "5"}).status_code == 201
    r = api["e1"].post("/api/v1/hr/leave/requests", {"leave_type": "ANNUAL", "start_date": "2026-04-06", "end_date": "2026-04-07"})
    assert r.status_code == 201 and r.json()["days"] == "2.00"
    rid = r.json()["id"]
    assert api["e1"].post(f"/api/v1/hr/leave/requests/{rid}/approve").status_code == 403
    assert api["dm2"].post(f"/api/v1/hr/leave/requests/{rid}/approve").status_code == 404
    assert api["dm"].post(f"/api/v1/hr/leave/requests/{rid}/approve").json()["status"] == "APPROVED"
    assert api["e2"].get("/api/v1/hr/leave/requests").json()["results"] == []
    assert api["dm"].get("/api/v1/hr/leave/requests").json()["results"][0]["id"] == rid
    run = api["hro"].post("/api/v1/hr/payroll/runs", {"period_start": "2026-03-01", "period_end": "2026-03-31"})
    assert run.status_code == 201
    rid = run.json()["id"]
    assert api["e1"].get("/api/v1/hr/me/payslips").json()["results"] == []  # before approval
    assert api["hro"].post(f"/api/v1/hr/payroll/runs/{rid}/submit").json()["status"] == "PENDING_APPROVAL"
    assert api["hro"].post(f"/api/v1/hr/payroll/runs/{rid}/approve").status_code == 403  # lacks hr.payroll.approve
    assert api["hrm"].post(f"/api/v1/hr/payroll/runs/{rid}/approve").json()["status"] == "APPROVED"
    assert len(api["e1"].get("/api/v1/hr/me/payslips").json()["results"]) == 1
    assert api["e2"].get("/api/v1/hr/me/payslips").json()["results"][0]["employee_no"] != api["e1"].get("/api/v1/hr/me/payslips").json()["results"][0]["employee_no"]
    assert api["hrm"].post(f"/api/v1/hr/payroll/runs/{rid}/post").status_code == 403  # approver cannot post
    assert api["hro"].post(f"/api/v1/hr/payroll/runs/{rid}/post").json()["status"] == "POSTED"
    assert api["hro"].post(f"/api/v1/hr/payroll/runs/{rid}/pay").status_code == 403  # lacks hr.payroll.pay
    assert api["ctrl"].post(f"/api/v1/hr/payroll/runs/{rid}/pay", {"payment_date": "2026-04-01"}).json()["status"] == "PAID"
    assert api["ctrl"].post(f"/api/v1/hr/payroll/runs/{rid}/pay").status_code == 409


@pytest.mark.django_db
def test_hr_requires_module_entitlement(api_env, acme):
    env, api = api_env
    from platform_core.tenants.models import ModuleEntitlement

    ModuleEntitlement.objects.filter(tenant_id=acme["id"], module="hr").update(enabled=False)
    assert api["hrm"].get("/api/v1/hr/employees").status_code == 403
    assert api["e1"].get("/api/v1/hr/me").status_code == 403


# ----------------------------------------------------------------------------- concurrency
@pytest.mark.django_db(transaction=True)
def test_concurrent_payment_and_leave_requests(own_tenant):
    tenant = own_tenant("hrrace")
    with schema_context(tenant.schema_name):
        env = setup_env(tenant)
        p = env["people"]
        e = hire(env, "Race", "e1")
        lt = annual(env, e, 10)
        run = hr.create_payroll_run(p["hro"].id, *MAR)
        hr.submit_payroll(p["hro"].id, run.id)
        hr.approve_payroll(p["hrm"].id, run.id)
        hr.post_payroll(p["hro"].id, run.id)
        ids = dict(run=run.id, ctrl=p["ctrl"].id, e1=p["e1"].id, emp=e.id, lt=lt.id)
    results = []

    def attempt(fn):
        def go():
            try:
                with schema_context(tenant.schema_name):
                    fn()
                results.append("ok")
            except DomainError as x:
                results.append(x.get_codes())
            finally:
                connections.close_all()
        return go

    pay = attempt(lambda: hr.pay_payroll(ids["ctrl"], ids["run"], payment_date=date(2026, 4, 1)))
    ts = [threading.Thread(target=pay) for _ in range(3)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert sorted(results) == ["invalid_state_transition", "invalid_state_transition", "ok"]
    results.clear()
    leave = attempt(lambda: hr.request_leave(ids["e1"], ids["emp"], leave_type=ids["lt"], start_date=date(2026, 6, 1), end_date=date(2026, 6, 2)))
    ts = [threading.Thread(target=leave) for _ in range(2)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert sorted(results) == ["leave_overlap", "ok"]
    with schema_context(tenant.schema_name):
        assert hm.LeaveRequest.objects.count() == 1 and bal("2400") == 0

from datetime import date, datetime, timezone as tz
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.finance import models as fm
from modules.finance import services as fin
from modules.hr import attendance as att
from modules.hr import models as hm
from modules.hr import payroll_ext as px
from modules.hr import services as hr
from platform_core.tenants.models import Tenant
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant
from tests.test_finance import user
from tests.test_hr import MAR, api_env, f, hire, rules  # noqa: F401

APR = (date(2026, 4, 1), date(2026, 4, 30))


def at(d, h):
    return datetime(d.year, d.month, d.day, h, tzinfo=tz.utc)


def bal(code):
    return abs(fin.account_balance(fm.Account.objects.get(code=code)))


@pytest.fixture
def hrm2(f):
    u = user(current_tenant(), "hrm2@acme.test", "hr_manager")
    f["people"]["hrm2"] = u
    return u


def post(f, run):
    p = f["people"]
    hr.submit_payroll(p["hro"].id, run.id)
    hr.approve_payroll(p["hrm"].id, run.id)
    return hr.post_payroll(p["hro"].id, run.id)


@pytest.mark.django_db
def test_salary_revision_needs_a_second_approver_and_splits_the_contract(f, hrm2):
    p = f["people"]
    e = hire(f, "Raise", "e1")
    with pytest.raises(DomainError):
        px.request_revision(p["hro"].id, e.id, effective_date=date(2026, 4, 1), new_salary="2500", reason="x")
    r = px.request_revision(p["hrm"].id, e.id, effective_date=date(2026, 4, 1), new_salary="2500", reason="Annual review")
    assert r.old_salary == D("2200")
    with pytest.raises(DomainError):
        px.request_revision(p["hrm"].id, e.id, effective_date=date(2026, 5, 1), new_salary="2600", reason="again")
    with pytest.raises(DomainError) as x:
        px.decide_revision(p["hrm"].id, r.id, approve=True)
    assert x.value.get_codes() == "separation_of_duties"
    assert px.decide_revision(hrm2.id, r.id, approve=True).status == "APPROVED"
    hist = px.salary_history(p["hrm"].id, e)
    assert [(h["effective_date"], h["end_date"], D(h["monthly_salary"])) for h in hist] == [("2026-01-05", "2026-03-31", D("2200")), ("2026-04-01", None, D("2500"))]
    assert hm.EmployeeEvent.objects.filter(employee=e, kind="SALARY_REVISION").count() == 1
    with pytest.raises(DomainError):
        px.decide_revision(hrm2.id, r.id, approve=True)
    r2 = px.request_revision(p["hrm"].id, e.id, effective_date=date(2026, 6, 1), new_salary="3000", reason="promo")
    with pytest.raises(ValidationFailed):
        px.decide_revision(hrm2.id, r2.id, approve=False)
    assert px.decide_revision(hrm2.id, r2.id, approve=False, note="not yet").status == "REJECTED"
    assert hr.create_payroll_run(p["hro"].id, *MAR).payslips.get().basic == D("2200")
    assert hr.create_payroll_run(p["hro"].id, *APR).payslips.get().basic == D("2500")


@pytest.mark.django_db
def test_retroactive_revision_into_a_closed_payroll_month_is_blocked(f, hrm2):
    p = f["people"]
    rules(f)
    e = hire(f, "Late", "e1")
    post(f, hr.create_payroll_run(p["hro"].id, *MAR))
    r = px.request_revision(p["hrm"].id, e.id, effective_date=date(2026, 3, 16), new_salary="2400", reason="backdated")
    with pytest.raises(DomainError) as x:
        px.decide_revision(hrm2.id, r.id, approve=True)
    assert x.value.get_codes() == "retroactive_revision_blocked"


@pytest.mark.django_db
def test_inputs_flow_into_the_slip_once_and_are_released_on_cancel(f, hrm2):
    p = f["people"]
    rules(f)
    e = hire(f, "Bonus", "e1")
    b = px.add_input(p["hrm"].id, e.id, kind="BONUS", month=date(2026, 3, 20), amount="300", description="Q1 bonus")
    adj = px.add_input(p["hrm"].id, e.id, kind="ADJUSTMENT", month=MAR[0], amount="-40", description="Correction")
    com = px.add_input(p["hrm"].id, e.id, kind="COMMISSION", month=MAR[0], amount="100", description="Commission", taxable=False)
    for bad in (dict(kind="BONUS", amount="-5"), dict(kind="BONUS", amount="0"), dict(kind="NOPE", amount="5")):
        with pytest.raises(ValidationFailed):
            px.add_input(p["hrm"].id, e.id, month=MAR[0], description="x", **bad)
    with pytest.raises(DomainError) as x:
        px.decide_input(p["hrm"].id, b.id, approve=True)
    assert x.value.get_codes() == "separation_of_duties"
    run = hr.create_payroll_run(p["hro"].id, *MAR)
    assert run.payslips.get().other_earnings == 0  # unapproved inputs are not paid
    for i in (b, adj, com):
        px.decide_input(hrm2.id, i.id, approve=True)
    run = hr.recalculate_payroll(p["hro"].id, run.id)
    s = run.payslips.get()
    assert (s.other_earnings, s.other_deductions, s.gross, s.taxable_income, s.income_tax, s.net) == (D("400"), D("40"), D("2600"), D("2346"), D("169.20"), D("2236.80"))
    assert sum(l.amount for l in s.lines.all()) == s.net
    hr.recalculate_payroll(p["hro"].id, run.id)
    assert hr.recalculate_payroll(p["hro"].id, run.id).payslips.get().other_earnings == D("400")  # never doubled
    hr.cancel_payroll(p["hro"].id, run.id)
    assert hm.PayrollInput.objects.filter(payroll_run__isnull=True, status="APPROVED").count() == 3
    again = hr.create_payroll_run(p["hro"].id, *MAR)
    assert again.payslips.get().other_earnings == D("400")
    post(f, again)
    with pytest.raises(DomainError) as x:
        px.add_input(p["hrm"].id, e.id, kind="BONUS", month=MAR[0], amount="1", description="late")
    assert x.value.get_codes() == "period_locked"


@pytest.mark.django_db
def test_overtime_is_paid_with_multipliers_and_only_once(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e = hire(f, "Extra", "e1", manager=boss)
    att.seed_defaults()
    for d, h_in, h_out in ((date(2026, 3, 19), 8, 20), (date(2026, 3, 21), 9, 12)):
        hr.record_attendance(p["hrm"].id, e.id, work_date=d, check_in=at(d, h_in), check_out=at(d, h_out))
    for d, h in ((date(2026, 3, 19), "2.5"), (date(2026, 3, 21), "4")):
        o = att.request_overtime(p["e1"].id, e.id, work_date=d, hours=h, reason="work")
        att.decide_overtime(p["dm"].id, o.id, approve=True)
    run = hr.create_payroll_run(p["hro"].id, *MAR)
    s = run.payslips.get(employee=e)
    assert s.overtime_pay == D("121.88")  # 12.50/h: 2.5h x 1.5 + 3h (capped at worked) x 2.0
    assert s.gross == s.basic + D("121.88")
    assert hr.recalculate_payroll(p["hro"].id, run.id).payslips.get(employee=e).overtime_pay == D("121.88")
    hr.cancel_payroll(p["hro"].id, run.id)
    assert hm.OvertimeRequest.objects.filter(payroll_run__isnull=False).count() == 0
    run2 = hr.create_payroll_run(p["hro"].id, *MAR)
    assert run2.payslips.get(employee=e).overtime_pay == D("121.88")
    post(f, run2)
    assert hm.OvertimeRequest.objects.filter(payroll_run=run2).count() == 2


@pytest.mark.django_db
def test_loan_schedule_deduction_repayment_and_reversal(f, hrm2):
    p = f["people"]
    rules(f)
    e = hire(f, "Borrower", "e1")
    loan = px.request_loan(p["e1"].id, e.id, principal="100", installments=3, start_month=date(2026, 3, 1), reason="rent")
    with pytest.raises(DomainError):
        px.request_loan(p["e1"].id, e.id, principal="50", installments=1, start_month=MAR[0])  # one open loan at a time
    with pytest.raises(DomainError):
        px.decide_loan(p["e1"].id, loan.id, approve=True)  # employee lacks the permission
    loan = px.decide_loan(p["hrm"].id, loan.id, approve=True)
    assert [i.amount for i in loan.schedule.order_by("due_month")] == [D("33.33"), D("33.33"), D("33.34")]  # last absorbs rounding
    assert px.outstanding_loan(e) == D("100")
    run = hr.create_payroll_run(p["hro"].id, *MAR)
    s = run.payslips.get()
    assert s.other_deductions == D("33.33") and any(l.code == "LOAN" for l in s.lines.all())
    with pytest.raises(DomainError):
        px.cancel_loan(p["hrm"].id, loan.id)  # a deduction has been scheduled in a run
    run = post(f, run)
    loan.refresh_from_db()
    assert loan.status == "ACTIVE" and px.outstanding_loan(e) == D("66.67")
    px.reverse_payroll(f["people"]["ctrl"].id, run.id, reason="wrong figures", reversal_date=date(2026, 4, 1))
    assert px.outstanding_loan(e) == D("100")
    assert hm.LoanInstallment.objects.filter(payroll_run__isnull=False).count() == 0


@pytest.mark.django_db
def test_loan_larger_than_pay_is_refused_and_rejection_needs_a_note(f, hrm2):
    p = f["people"]
    e = hire(f, "Big", "e1")
    loan = px.request_loan(p["e1"].id, e.id, principal="9000", installments=1, start_month=MAR[0])
    px.decide_loan(p["hrm"].id, loan.id, approve=True)
    with pytest.raises(DomainError) as x:
        hr.create_payroll_run(p["hro"].id, *MAR)
    assert x.value.get_codes() == "negative_net_pay"
    other = hire(f, "Other", "e2")
    l2 = px.request_loan(p["hrm"].id, other.id, principal="10", installments=1, start_month=MAR[0])
    with pytest.raises(ValidationFailed):
        px.decide_loan(hrm2.id, l2.id, approve=False)
    with pytest.raises(ValidationFailed):
        px.request_loan(p["hrm"].id, other.id, principal="0", installments=1, start_month=MAR[0])


@pytest.mark.django_db
def test_reversal_restores_the_ledger_and_allows_a_corrected_run(f):
    p = f["people"]
    rules(f)
    hire(f, "Rev", "e1")
    run = post(f, hr.create_payroll_run(p["hro"].id, *MAR))
    assert bal("5300") > 0
    with pytest.raises(DomainError):
        px.reverse_payroll(p["hro"].id, run.id, reason="x", reversal_date=date(2026, 4, 1))  # needs hr.payroll.pay
    with pytest.raises(ValidationFailed):
        px.reverse_payroll(p["ctrl"].id, run.id, reason=" ", reversal_date=date(2026, 4, 1))
    done = px.reverse_payroll(p["ctrl"].id, run.id, reason="Wrong rates", reversal_date=date(2026, 4, 1))
    assert done.status == "CANCELLED" and done.reversal_journal_id
    assert bal("5300") == 0 and bal("2400") == 0 and bal("2410") == 0 and bal("2420") == 0
    with pytest.raises(DomainError):
        px.reverse_payroll(p["ctrl"].id, run.id, reason="again", reversal_date=date(2026, 4, 1))
    fresh = hr.create_payroll_run(p["hro"].id, *MAR)
    paid = post(f, fresh)
    hr.pay_payroll(p["ctrl"].id, paid.id, payment_date=date(2026, 4, 1))
    with pytest.raises(DomainError):
        px.reverse_payroll(p["ctrl"].id, paid.id, reason="too late", reversal_date=date(2026, 4, 1))


@pytest.mark.django_db
def test_register_cost_allocation_and_payment_instructions(f):
    p = f["people"]
    rules(f)
    a = hire(f, "Alpha", "e1")
    b = hire(f, "Beta", "e2")
    hm.Employee.objects.filter(pk=b.pk).update(bank_account="")
    hm.Employee.objects.filter(pk=a.pk).update(bank_account="=HYPERLINK(1)")
    run = hr.create_payroll_run(p["hro"].id, *MAR)
    reg = px.payroll_register(p["hrm"].id, run.id)
    assert len(reg["rows"]) == 2 and D(reg["totals"]["net"]) == run.net_total
    with pytest.raises(DomainError):
        px.payroll_register(p["e1"].id, run.id)
    assert px.cost_allocation(p["hrm"].id, run.id)[0]["department"] == "(none)"
    with pytest.raises(DomainError):
        px.payment_instructions(p["ctrl"].id, run.id)  # not approved yet
    hr.submit_payroll(p["hro"].id, run.id)
    hr.approve_payroll(p["hrm"].id, run.id)
    out = px.payment_instructions(p["ctrl"].id, run.id)
    assert [x["employee_no"] for x in out["payments"]] == [a.employee_no] and out["missing_bank_account"] == [b.employee_no]
    with pytest.raises(DomainError):
        px.payment_instructions(p["hrm"].id, run.id)  # only those who release payments
    csv_text = px.payment_instructions(p["ctrl"].id, run.id, as_csv=True)
    assert "'=HYPERLINK(1)" in csv_text


@pytest.mark.django_db
def test_payroll_extension_http_permissions(api_env):
    env, api = api_env
    emps = {x["name"]: x["id"] for x in api["hrm"].get("/api/v1/hr/employees").json()["results"]}
    sid = emps["Staff Test"]
    assert api["e1"].post("/api/v1/hr/compensation/revisions", {"employee": sid, "effective_date": "2026-04-01", "new_salary": "9999", "reason": "me"}).status_code == 403
    assert api["hrm"].post("/api/v1/hr/compensation/revisions", {"employee": sid, "effective_date": "2026-04-01", "new_salary": "2500", "reason": "review"}).status_code == 201
    assert api["e1"].get(f"/api/v1/hr/employees/{sid}/salary-history").status_code == 403
    assert len(api["hrm"].get(f"/api/v1/hr/employees/{sid}/salary-history").json()) == 1
    assert api["e1"].post("/api/v1/hr/payroll/inputs", {"employee": sid, "kind": "BONUS", "month": "2026-03-01", "amount": "5", "description": "x"}).status_code == 403
    r = api["hrm"].post("/api/v1/hr/payroll/inputs", {"employee": sid, "kind": "BONUS", "month": "2026-03-01", "amount": "50", "description": "spot"})
    assert r.status_code == 201
    assert api["hrm"].post(f"/api/v1/hr/payroll/inputs/{r.json()['id']}/approve").status_code == 403  # SoD: same person
    loan = api["e1"].post("/api/v1/hr/loans", {"principal": "200", "installments": 2, "start_month": "2026-03-01"})
    assert loan.status_code == 201 and loan.json()["employee"] == sid
    assert len(api["e2"].get("/api/v1/hr/loans").json()["results"]) == 0  # other employees' loans are invisible
    assert api["e1"].post(f"/api/v1/hr/loans/{loan.json()['id']}/approve").status_code == 403
    assert api["hrm"].post(f"/api/v1/hr/loans/{loan.json()['id']}/approve").json()["status"] == "ACTIVE"
    assert api["e1"].get("/api/v1/hr/payroll/runs/00000000-0000-0000-0000-000000000000/register").status_code == 403
    assert api["hrm"].get("/api/v1/hr/payroll/runs/00000000-0000-0000-0000-000000000000/payment-instructions").status_code == 403

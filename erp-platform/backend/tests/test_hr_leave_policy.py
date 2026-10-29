from datetime import date
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.hr import leave_policy as lp
from modules.hr import models as hm
from modules.hr import services as hr
from platform_core.tenants.models import Tenant
from shared.api.errors import DomainError, ValidationFailed
from tests.test_hr import api_env, f  # noqa: F401
from tests.test_hr import hire


def lt(code):
    return hm.LeaveType.objects.get(code=code)


def total(e, code, year, kind=None):
    qs = hm.LeaveAllocation.objects.filter(employee=e, leave_type=lt(code), year=year)
    return sum((a.days for a in qs.filter(kind=kind) if kind) or [a.days for a in qs], D("0"))


@pytest.mark.django_db
def test_monthly_accrual_prorates_the_hire_month_and_is_idempotent(f):
    e = hire(f, "Accr", hire_date=date(2026, 1, 16))  # 16 of 31 days worked in January
    assert lp.accrue_leave(date(2026, 3, 31)) >= 3
    first = hm.LeaveAllocation.objects.filter(employee=e, leave_type=lt("ANNUAL"), period="2026-01").get().days
    assert first == (D("16") / 12 * D(16) / 31).quantize(D("0.01"))
    assert hm.LeaveAllocation.objects.filter(employee=e, leave_type=lt("ANNUAL"), period="2026-02").get().days == D("1.33")
    assert lp.accrue_leave(date(2026, 3, 31)) == 0  # re-running creates nothing
    assert lp.accrue_leave(date(2026, 4, 30)) >= 1  # catch-up only adds April
    assert hm.LeaveAllocation.objects.filter(employee=e, leave_type=lt("ANNUAL")).count() == 4


@pytest.mark.django_db
def test_upfront_grant_is_prorated_for_the_hire_year_and_eligibility_is_enforced(f):
    e = hire(f, "Mid", "e1", hire_date=date(2026, 7, 1))
    lp.accrue_leave(date(2026, 7, 31))
    assert hm.LeaveAllocation.objects.get(employee=e, leave_type=lt("SICK")).days == D("5.00")  # 10 * 6/12
    lp.configure_leave_type(f["people"]["hrm"].id, "ANNUAL", eligibility_months=6)
    assert lp.accrue_leave(date(2026, 8, 31)) == 0 or not hm.LeaveAllocation.objects.filter(employee=e, leave_type=lt("ANNUAL"), period="2026-08").exists()
    with pytest.raises(DomainError) as x:
        hr.request_leave(f["people"]["e1"].id, e.id, leave_type=lt("ANNUAL").id, start_date=date(2026, 8, 3), end_date=date(2026, 8, 3))
    assert x.value.get_codes() in ("not_eligible", "insufficient_leave_balance")


@pytest.mark.django_db
def test_carryover_is_capped_and_expires(f):
    p = f["people"]
    e = hire(f, "Carry", "e1", hire_date=date(2025, 1, 6))
    hr.allocate_leave(p["hrm"].id, e.id, leave_type=lt("ANNUAL").id, year=2026, days=20)
    assert lp.process_year_end(2026) >= 1
    c = hm.LeaveAllocation.objects.get(employee=e, leave_type=lt("ANNUAL"), year=2027, kind="CARRYOVER")
    assert c.days == D("5") and c.expires_on == date(2027, 3, 31)  # cap 5, expires after 3 months
    assert lp.process_year_end(2026) == 0
    hr.allocate_leave(p["hrm"].id, e.id, leave_type=lt("ANNUAL").id, year=2027, days=1)
    assert hr.leave_balance(e, lt("ANNUAL"), 2027, as_of=date(2027, 2, 1))["remaining"] == 6
    after = hr.leave_balance(e, lt("ANNUAL"), 2027, as_of=date(2027, 4, 15))
    assert after["remaining"] == 1 and after["expired"] == 5
    r = hr.request_leave(p["e1"].id, e.id, leave_type=lt("ANNUAL").id, start_date=date(2027, 3, 1), end_date=date(2027, 3, 1))  # uses the expiring days first
    assert hr.leave_balance(e, lt("ANNUAL"), 2027, as_of=date(2027, 4, 15))["remaining"] == 1
    assert r.days == 1


@pytest.mark.django_db
def test_half_days_notice_and_max_consecutive_rules(f):
    p = f["people"]
    e = hire(f, "Rules", "e1")
    hr.allocate_leave(p["hrm"].id, e.id, leave_type=lt("ANNUAL").id, year=2026, days=20)
    r = hr.request_leave(p["e1"].id, e.id, leave_type=lt("ANNUAL").id, start_date=date(2026, 9, 7), end_date=date(2026, 9, 7), half_day="AM")
    assert r.days == D("0.5")
    with pytest.raises(ValidationFailed) as x:
        hr.request_leave(p["e1"].id, e.id, leave_type=lt("ANNUAL").id, start_date=date(2026, 9, 8), end_date=date(2026, 9, 9), half_day="PM")
    assert x.value.get_codes() == "invalid_half_day"
    lp.configure_leave_type(p["hrm"].id, "ANNUAL", allow_half_day=False)
    with pytest.raises(ValidationFailed):
        hr.request_leave(p["e1"].id, e.id, leave_type=lt("ANNUAL").id, start_date=date(2026, 9, 10), end_date=date(2026, 9, 10), half_day="PM")
    lp.configure_leave_type(p["hrm"].id, "ANNUAL", max_consecutive_days=3)
    with pytest.raises(DomainError):
        hr.request_leave(p["e1"].id, e.id, leave_type=lt("ANNUAL").id, start_date=date(2026, 10, 5), end_date=date(2026, 10, 9))  # 5 > 3
    lp.configure_leave_type(p["hrm"].id, "ANNUAL", max_consecutive_days=None, min_notice_days=30)
    with pytest.raises(DomainError):
        hr.request_leave(p["e1"].id, e.id, leave_type=lt("ANNUAL").id, start_date=date.today(), end_date=date.today())
    with pytest.raises(ValidationFailed):
        lp.configure_leave_type(p["hrm"].id, "ANNUAL", grant_mode="NOPE")
    with pytest.raises(ValidationFailed):
        lp.configure_leave_type(p["hrm"].id, "NEWTYPE", annual_days="-1", name="x")


@pytest.mark.django_db
def test_delegated_approval_and_revocation(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e = hire(f, "Report", "e1", manager=boss)
    hr.allocate_leave(p["hrm"].id, e.id, leave_type=lt("ANNUAL").id, year=2026, days=10)
    r = hr.request_leave(p["e1"].id, e.id, leave_type=lt("ANNUAL").id, start_date=date(2026, 9, 7), end_date=date(2026, 9, 7))
    with pytest.raises(Exception):
        hr.decide_leave(p["dm2"].id, r.id, approve=True)  # not the manager, no delegation
    today = date.today()
    d = lp.delegate_approvals(p["dm"].id, p["dm2"].id, start_date=today, end_date=date(today.year + 1, 1, 1))
    with pytest.raises(ValidationFailed):
        lp.delegate_approvals(p["dm"].id, p["dm"].id, start_date=today, end_date=today)  # to self
    with pytest.raises(ValidationFailed):
        lp.delegate_approvals(p["dm"].id, p["e2"].id, start_date=today, end_date=today)  # delegate cannot approve leave
    with pytest.raises(DomainError):
        lp.delegate_approvals(p["e1"].id, p["dm2"].id, start_date=today, end_date=today)  # delegator is not an approver
    lp.revoke_delegation(p["dm"].id, d.id)
    with pytest.raises(Exception):
        hr.decide_leave(p["dm2"].id, r.id, approve=True)  # revoked
    d2 = lp.delegate_approvals(p["dm"].id, p["dm2"].id, start_date=today, end_date=date(today.year + 1, 1, 1))
    assert hr.decide_leave(p["dm2"].id, r.id, approve=True).status == "APPROVED"
    with pytest.raises(Exception):
        lp.revoke_delegation(p["dm2"].id, d2.id)  # only the delegator can revoke


@pytest.mark.django_db
def test_calendar_and_reports_respect_visibility(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    a = hire(f, "Team", "e1", manager=boss)
    b = hire(f, "Other", "e2")
    for e in (a, b):
        hr.allocate_leave(p["hrm"].id, e.id, leave_type=lt("ANNUAL").id, year=2026, days=10)
    ra = hr.request_leave(p["e1"].id, a.id, leave_type=lt("ANNUAL").id, start_date=date(2026, 9, 7), end_date=date(2026, 9, 8))
    hr.request_leave(p["e2"].id, b.id, leave_type=lt("ANNUAL").id, start_date=date(2026, 9, 9), end_date=date(2026, 9, 9))
    hr.decide_leave(p["dm"].id, ra.id, approve=True)
    cal = lp.leave_calendar(p["hrm"].id, date(2026, 9, 1), date(2026, 9, 30))
    assert {l["name"] for l in cal["leaves"]} >= {"Team Test", "Other Test"}
    mine = lp.leave_calendar(p["dm"].id, date(2026, 9, 1), date(2026, 9, 30))
    assert {l["name"] for l in mine["leaves"]} == {"Team Test"}  # a manager sees only their reports
    with pytest.raises(ValidationFailed):
        lp.leave_calendar(p["hrm"].id, date(2026, 9, 30), date(2026, 9, 1))
    rep = lp.leave_report(p["hrm"].id, 2026, group="type")
    annual = next(r for r in rep if r["key"] == ["ANNUAL"])
    assert annual["allocated"] == "20.00" or D(annual["allocated"]) == 20
    assert D(annual["used"]) == 3 and D(annual["pending"]) == 1
    assert D(annual["utilization_percent"]) == D("15.00")
    with pytest.raises(ValidationFailed):
        lp.leave_report(p["hrm"].id, 2026, group="bogus")
    assert any(r["type"] == "ANNUAL" and D(r["days"]) == 2 for r in lp.absence_summary(p["hrm"].id, 2026))
    assert lp.leave_report(p["dm"].id, 2026, group="type")[0]["key"] == ["ANNUAL"]


@pytest.mark.django_db
def test_scheduled_daily_task_runs_in_the_tenant(f):
    from modules.hr import tasks

    e = hire(f, "Daily", hire_date=date(2026, 1, 5))
    out = tasks.daily_tenant.run() if hasattr(tasks.daily_tenant, "run") else None
    assert out is None or "accrued" in out
    assert hm.LeaveAllocation.objects.filter(employee=e).exists()


@pytest.mark.django_db
def test_leave_policy_http_permissions(api_env):
    env, api = api_env
    assert api["e1"].put("/api/v1/hr/leave/types/ANNUAL", {"annual_days": "30"}).status_code == 403
    assert api["hrm"].put("/api/v1/hr/leave/types/ANNUAL", {"annual_days": "18", "min_notice_days": 2}).json()["annual_days"] == "18.00"
    assert api["e1"].get("/api/v1/hr/leave/types/ANNUAL").json()["min_notice_days"] == 2
    assert api["hrm"].get("/api/v1/hr/leave/types/NOPE").status_code == 404
    assert api["e1"].post("/api/v1/hr/leave/run/accrue", {}).status_code == 403
    assert api["hrm"].post("/api/v1/hr/leave/run/accrue", {"on_date": "2026-03-31"}).status_code == 200
    assert api["hrm"].post("/api/v1/hr/leave/run/bogus", {}).status_code == 400
    assert api["e1"].post("/api/v1/hr/leave/delegations", {"delegate": str(env["people"]["dm2"].id), "start_date": "2026-03-01", "end_date": "2026-03-05"}).status_code == 403
    r = api["dm"].post("/api/v1/hr/leave/delegations", {"delegate": str(env["people"]["dm2"].id), "start_date": "2026-03-01", "end_date": "2026-03-05"})
    assert r.status_code == 201
    assert api["dm2"].post(f"/api/v1/hr/leave/delegations/{r.json()['id']}/revoke", {}).status_code == 404
    assert api["dm"].post(f"/api/v1/hr/leave/delegations/{r.json()['id']}/revoke", {}).status_code == 200
    assert api["e1"].get("/api/v1/hr/leave/calendar?from=2026-03-01&to=2026-03-31").status_code == 200
    assert api["e1"].get("/api/v1/hr/reports/leave?group=type").status_code == 200
    assert api["hrm"].get("/api/v1/hr/reports/leave?kind=absence").status_code == 200

from datetime import date, datetime, time, timedelta, timezone as tz
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.hr import attendance as att
from modules.hr import models as hm
from modules.hr import services as hr
from platform_core.organizations import services as org
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from tests.conftest import ACME_HOST, Api
from tests.test_hr import hire, setup_env

MON, TUE, WED, THU, FRI, SAT = (date(2026, 3, d) for d in (16, 17, 18, 19, 20, 21))
NOW = date(2026, 3, 25)  # "today" for the calculations below


def at(d, h, m=0):
    return datetime(d.year, d.month, d.day, h, m, tzinfo=tz.utc)


@pytest.fixture
def f(acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = setup_env(tenant)
        att.seed_defaults()
        yield env


def punch(f, e, d, cin, cout, **kw):
    return hr.record_attendance(f["people"]["hrm"].id, e.id, work_date=d, check_in=cin, check_out=cout, **kw)


def day(e, d):
    return att.summarize_day(e, d, today=NOW)


@pytest.mark.django_db
def test_on_time_late_early_and_overtime_are_calculated_from_the_schedule(f):
    e = hire(f, "Clock")
    punch(f, e, MON, at(MON, 8, 5), at(MON, 17, 0))  # inside the 10 minute grace: on time, but 5 minutes were not worked
    s = day(e, MON)
    assert (s["scheduled_hours"], s["worked_hours"], s["late_minutes"], s["early_minutes"], s["overtime_hours"], s["status"]) == (D("8.00"), D("7.92"), 0, 0, D("0.00"), "PRESENT")
    punch(f, e, TUE, at(TUE, 8, 30), at(TUE, 17, 0))
    s = day(e, TUE)
    assert s["late_minutes"] == 20 and s["status"] == "LATE" and "LATE" in s["exceptions"]  # 30 minutes minus grace
    punch(f, e, WED, at(WED, 8, 0), at(WED, 16, 0))
    s = day(e, WED)
    assert s["early_minutes"] == 60 and s["worked_hours"] == D("7.00") and "EARLY_DEPARTURE" in s["exceptions"]
    punch(f, e, THU, at(THU, 8, 0), at(THU, 19, 0))
    s = day(e, THU)
    assert s["worked_hours"] == D("10.00") and s["overtime_hours"] == D("2.00") and "OVERTIME" in s["exceptions"]


@pytest.mark.django_db
def test_rest_day_and_holiday_work_is_all_overtime_and_absence_leave_and_missed_punch(f):
    e = hire(f, "Odd")
    org.add_holiday(None, WED, "Holiday")
    punch(f, e, SAT, at(SAT, 9, 0), at(SAT, 13, 0))
    s = day(e, SAT)
    assert (s["day_type"], s["worked_hours"], s["overtime_hours"]) == ("REST_DAY", D("4.00"), D("4.00"))  # short shifts get no break deduction
    punch(f, e, WED, at(WED, 8, 0), at(WED, 18, 0))
    s = day(e, WED)
    assert (s["day_type"], s["overtime_hours"]) == ("HOLIDAY", D("9.00"))
    assert day(e, THU)["status"] == "ABSENT" and day(e, THU)["exceptions"] == ["ABSENT"]
    assert att.summarize_day(e, NOW, today=NOW)["status"] == "PENDING"  # today is not absent yet
    assert day(e, date(2026, 3, 22))["status"] == "OFF"  # Sunday, nothing expected
    hr.allocate_leave(f["people"]["hrm"].id, e.id, leave_type=hm.LeaveType.objects.get(code="ANNUAL").id, year=2026, days=5)
    lr = hr.request_leave(f["people"]["hrm"].id, e.id, leave_type=hm.LeaveType.objects.get(code="ANNUAL").id, start_date=FRI, end_date=FRI)
    hr.decide_leave(f["people"]["hrm"].id, lr.id, approve=True)  # HR on behalf of the (unlinked) employee
    assert day(e, FRI)["status"] == "ON_LEAVE"
    hr.record_attendance(f["people"]["hrm"].id, e.id, work_date=MON, check_in=at(MON, 8), check_out=None)
    s = day(e, MON)
    assert s["status"] == "INCOMPLETE" and s["exceptions"] == ["MISSED_PUNCH"]


@pytest.mark.django_db
def test_employment_dates_limit_expected_attendance(f):
    e = hire(f, "Late", hire_date=date(2026, 3, 18))
    assert day(e, TUE)["status"] == "OFF"  # before the hire date nobody is absent
    assert day(e, THU)["status"] == "ABSENT"


@pytest.mark.django_db
def test_overnight_shift_belongs_to_the_day_it_starts_and_device_tail_punches_follow(f):
    p = f["people"]
    night = att.create_schedule(p["hrm"].id, code="NIGHT", name="Night", work_days=[1, 2, 3, 4, 5], start_time=time(22, 0), end_time=time(6, 0), break_minutes=30, grace_minutes=5)
    e = hire(f, "Owl")
    att.assign_schedule(p["hrm"].id, e.id, schedule_id=night.id, effective_from=date(2026, 1, 1))
    punch(f, e, MON, at(MON, 22, 0), at(TUE, 6, 0))
    s = day(e, MON)
    assert (s["scheduled_hours"], s["worked_hours"], s["late_minutes"], s["early_minutes"], s["overtime_hours"]) == (D("7.50"), D("7.50"), 0, 0, D("0.00"))
    res = att.import_punches(p["hrm"].id, [{"employee_no": e.employee_no, "timestamp": at(WED, 22, 1).isoformat()}, {"employee_no": e.employee_no, "timestamp": at(THU, 6, 2).isoformat()}])
    assert res["created"] == 1  # the 06:02 punch is the tail of Wednesday night's shift, not a Thursday check-in
    rec = hm.Attendance.objects.get(employee=e, work_date=WED)
    assert rec.check_out == at(THU, 6, 2) and not hm.Attendance.objects.filter(employee=e, work_date=THU).exists()


@pytest.mark.django_db
def test_schedule_rules_and_effective_dated_assignment(f):
    p = f["people"]
    for bad in (dict(work_days=[]), dict(work_days=[8]), dict(start_time=time(8), end_time=time(8)), dict(break_minutes=600)):
        args = dict(code="X", name="x", work_days=[1], start_time=time(8), end_time=time(16), break_minutes=30)
        args.update(bad)
        with pytest.raises(ValidationFailed):
            att.create_schedule(p["hrm"].id, **args)
    with pytest.raises(DomainError):
        att.create_schedule(p["hrm"].id, code="STANDARD", name="dup", work_days=[1], start_time=time(8), end_time=time(16))
    short = att.create_schedule(p["hrm"].id, code="SHORT", name="Short", work_days=[1, 2, 3], start_time=time(9), end_time=time(15), break_minutes=0)
    e = hire(f, "Sched")
    att.assign_schedule(p["hrm"].id, e.id, schedule_id=short.id, effective_from=date(2026, 3, 16), effective_to=date(2026, 3, 31))
    with pytest.raises(DomainError) as x:
        att.assign_schedule(p["hrm"].id, e.id, schedule_id=short.id, effective_from=date(2026, 3, 20))
    assert x.value.get_codes() == "schedule_overlap"
    assert att.schedule_for(e, date(2026, 3, 10)).code == "STANDARD" and att.schedule_for(e, date(2026, 3, 17)).code == "SHORT" and att.schedule_for(e, date(2026, 4, 1)).code == "STANDARD"
    assert day(e, THU)["day_type"] == "REST_DAY"  # Thursday is not a SHORT work day


# ----------------------------------------------------------------------------- corrections and overtime approvals
@pytest.mark.django_db
def test_attendance_correction_needs_approval_and_separation_of_duties(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e = hire(f, "Forgot", "e1", manager=boss)
    punch(f, e, MON, at(MON, 8, 0), None)  # forgot to clock out
    c = att.request_correction(p["e1"].id, e.id, work_date=MON, check_in=at(MON, 8, 0), check_out=at(MON, 17, 0), reason="Forgot to clock out")
    with pytest.raises(DomainError):
        att.request_correction(p["e1"].id, e.id, work_date=MON, check_in=at(MON, 8), check_out=at(MON, 17), reason="again")
    with pytest.raises(ValidationFailed):
        att.request_correction(p["e1"].id, e.id, work_date=date(2999, 1, 1), check_in=at(MON, 8), reason="future")
    with pytest.raises(DomainError):
        att.decide_correction(p["e1"].id, c.id, approve=True)  # the requester
    with pytest.raises(DomainError):
        att.decide_correction(p["dm2"].id, c.id, approve=True)  # not their manager
    att.decide_correction(p["dm"].id, c.id, approve=True)
    rec = hm.Attendance.objects.get(employee=e, work_date=MON)
    assert rec.check_out == at(MON, 17) and rec.source == "CORRECTION" and day(e, MON)["exceptions"] == []
    c2 = att.request_correction(p["e1"].id, e.id, work_date=TUE, check_in=at(TUE, 8), check_out=at(TUE, 17), reason="Remote day", work_mode="REMOTE")
    with pytest.raises(ValidationFailed):
        att.decide_correction(p["hrm"].id, c2.id, approve=False)
    assert att.decide_correction(p["hrm"].id, c2.id, approve=False, note="no evidence").status == "REJECTED"
    assert not hm.Attendance.objects.filter(employee=e, work_date=TUE).exists()


@pytest.mark.django_db
def test_overtime_is_paid_only_when_approved_and_worked_with_policy_multipliers(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e = hire(f, "Extra", "e1", manager=boss)
    punch(f, e, THU, at(THU, 8), at(THU, 20, 0))  # 11h worked → 3h over
    punch(f, e, SAT, at(SAT, 9), at(SAT, 12, 0))  # 3h on a rest day
    ot1 = att.request_overtime(p["e1"].id, e.id, work_date=THU, hours="2.5", reason="Release")
    ot2 = att.request_overtime(p["e1"].id, e.id, work_date=SAT, hours="4", reason="Fix")
    ot3 = att.request_overtime(p["e1"].id, e.id, work_date=FRI, hours="2", reason="Never came")
    with pytest.raises(DomainError):
        att.request_overtime(p["e1"].id, e.id, work_date=THU, hours="1", reason="dup")
    with pytest.raises(ValidationFailed):
        att.request_overtime(p["e1"].id, e.id, work_date=MON, hours="9", reason="above policy max")
    assert att.payable_overtime(e, THU, SAT) == []  # nothing approved yet
    with pytest.raises(DomainError):
        att.decide_overtime(p["e1"].id, ot1.id, approve=True)
    for o in (ot1, ot2, ot3):
        att.decide_overtime(p["dm"].id, o.id, approve=True)
    rows = {r.work_date: (h, mult) for r, h, mult in att.payable_overtime(e, THU, SAT)}
    assert rows == {THU: (D("2.50"), D("1.50")), SAT: (D("3.00"), D("2.00"))}  # capped at what was actually worked; FRI worked nothing
    att.update_overtime_policy(p["hrm"].id, weekday_multiplier="1.75")
    assert {r.work_date: mult for r, h, mult in att.payable_overtime(e, THU, SAT)}[THU] == D("1.75")
    with pytest.raises(ValidationFailed):
        att.update_overtime_policy(p["hrm"].id, weekday_multiplier="0.5")


# ----------------------------------------------------------------------------- device import
@pytest.mark.django_db
def test_device_import_is_idempotent_and_never_overwrites_manual_records(f):
    p = f["people"]
    a, b = hire(f, "Dev1"), hire(f, "Dev2")
    punches = [{"employee_no": a.employee_no, "timestamp": at(MON, 8, 3).isoformat()}, {"employee_no": a.employee_no, "timestamp": at(MON, 17, 10).isoformat()}, {"employee_no": a.employee_no, "timestamp": at(MON, 12, 0).isoformat()},
               {"employee_no": b.employee_no, "timestamp": at(MON, 9, 0).isoformat()}, {"employee_no": "EMP-99999", "timestamp": at(MON, 9).isoformat()}, {"employee_no": b.employee_no, "timestamp": "2026-03-16T09:00:00"}]
    res = att.import_punches(p["hrm"].id, punches)
    assert (res["created"], res["unknown_employees"], res["invalid_rows"]) == (2, ["EMP-99999"], 1)
    ra, rb = hm.Attendance.objects.get(employee=a, work_date=MON), hm.Attendance.objects.get(employee=b, work_date=MON)
    assert (ra.check_in, ra.check_out, ra.source) == (at(MON, 8, 3), at(MON, 17, 10), "DEVICE") and rb.check_out is None
    again = att.import_punches(p["hrm"].id, punches)
    assert again["created"] == 0 and again["updated"] == 0 and hm.Attendance.objects.count() == 2
    more = att.import_punches(p["hrm"].id, [{"employee_no": b.employee_no, "timestamp": at(MON, 18, 0).isoformat()}])
    assert more["updated"] == 1 and hm.Attendance.objects.get(employee=b).check_out == at(MON, 18)
    punch(f, a, TUE, at(TUE, 8), at(TUE, 16))  # manual
    skip = att.import_punches(p["hrm"].id, [{"employee_no": a.employee_no, "timestamp": at(TUE, 7).isoformat()}, {"employee_no": a.employee_no, "timestamp": at(TUE, 20).isoformat()}])
    assert skip["skipped"] == 1 and hm.Attendance.objects.get(employee=a, work_date=TUE).check_in == at(TUE, 8)
    with pytest.raises(ValidationFailed):
        att.import_punches(p["hrm"].id, [{}] * 5001)


# ----------------------------------------------------------------------------- reports
@pytest.mark.django_db
def test_attendance_reports_by_day_week_and_month_are_scoped(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e1 = hire(f, "Ann", "e1", manager=boss)
    e2 = hire(f, "Bob", "e2")
    punch(f, e1, MON, at(MON, 8), at(MON, 17))
    punch(f, e1, TUE, at(TUE, 8, 40), at(TUE, 19, 0))  # late 30 min, 9.33 h worked = 1.33 h over
    punch(f, e2, MON, at(MON, 8), at(MON, 17))
    rows = att.attendance_report(p["hrm"].id, MON, FRI, group="month", today=NOW)
    ann = next(r for r in rows if r["name"] == "Ann Test")
    assert (ann["present_days"], ann["absent_days"], ann["late_count"], ann["late_minutes"], ann["overtime_hours"]) == (2, 3, 1, 30, "1.33")
    assert next(r for r in rows if r["name"] == "Bob Test")["absent_days"] == 4
    daily = att.attendance_report(p["hrm"].id, MON, TUE, group="day", employee_id=e1.id, today=NOW)
    assert [r["period"] for r in daily] == ["2026-03-16", "2026-03-17"]
    week = att.attendance_report(p["hrm"].id, MON, date(2026, 3, 27), group="week", employee_id=e1.id, today=NOW)
    assert [r["period"] for r in week] == ["2026-03-16", "2026-03-23"]
    assert {r["name"] for r in att.attendance_report(p["dm"].id, MON, FRI, today=NOW)} == {"Boss Test", "Ann Test"}  # self + direct report
    assert {r["name"] for r in att.attendance_report(p["e2"].id, MON, FRI, today=NOW)} == {"Bob Test"}
    with pytest.raises(ValidationFailed):
        att.attendance_report(p["hrm"].id, MON, MON + timedelta(days=200))
    ex = att.exceptions_report(p["hrm"].id, MON, TUE, today=NOW)
    assert any(r["name"] == "Ann Test" and set(r["exceptions"]) == {"LATE", "OVERTIME"} for r in ex)
    assert any(r["name"] == "Bob Test" and r["exceptions"] == ["ABSENT"] and r["date"] == str(TUE) for r in ex)


@pytest.mark.django_db
def test_clock_in_records_work_mode(f):
    p = f["people"]
    hire(f, "Remote", "e1")
    a = hr.check_in(p["e1"].id, now=at(MON, 8, 0), work_mode="REMOTE")
    assert a.work_mode == "REMOTE" and a.source == "CLOCK"
    with pytest.raises(ValidationFailed):
        hr.check_in(p["e1"].id, now=at(TUE, 8), work_mode="MOON")


# ----------------------------------------------------------------------------- HTTP
@pytest.fixture
def api_env(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = setup_env(tenant)
        att.seed_defaults()
        boss = hire(env, "Boss", "dm")
        hire(env, "Staff", "e1", manager=boss)
        hire(env, "Other", "e2")
    apis = {}
    for key in ("hrm", "hro", "dm", "e1", "e2"):
        ExternalIdentity.objects.create(user=env["people"][key], issuer="https://kc.test/realms/erp", subject=f"{key}-sub")
        apis[key] = Api(ACME_HOST)
        assert apis[key].login(idp, f"{key}-sub").status_code == 302
    return env, apis


@pytest.mark.django_db
def test_attendance_api_permissions_and_flow(api_env):
    env, api = api_env
    emps = {x["name"]: x["id"] for x in api["hrm"].get("/api/v1/hr/employees").json()["results"]}
    assert api["e1"].post("/api/v1/hr/schedules", {"code": "N", "name": "N", "work_days": [1], "start_time": "08:00", "end_time": "16:00"}).status_code == 403
    assert api["hrm"].post("/api/v1/hr/schedules", {"code": "N", "name": "N", "work_days": [1, 2], "start_time": "08:00", "end_time": "16:00"}).status_code == 201
    assert api["hrm"].post("/api/v1/hr/schedules", {"code": "N2", "name": "N", "work_days": [1], "start_time": "bad", "end_time": "16:00"}).status_code == 400
    assert api["e1"].post("/api/v1/hr/me/check-in", {"work_mode": "REMOTE"}).status_code == 201
    assert api["e1"].post("/api/v1/hr/me/check-in").status_code == 409
    corr = api["e1"].post("/api/v1/hr/attendance/corrections", {"work_date": "2026-03-16", "check_in": "2026-03-16T08:00:00+00:00", "check_out": "2026-03-16T17:00:00+00:00", "reason": "device down"})
    assert corr.status_code == 201
    cid = corr.json()["id"]
    assert api["e1"].post(f"/api/v1/hr/attendance/corrections/{cid}/approve").status_code == 403  # lacks hr.timesheet.approve
    assert api["e2"].get("/api/v1/hr/attendance/corrections").json()["results"] == []
    assert api["dm"].post(f"/api/v1/hr/attendance/corrections/{cid}/approve").json()["status"] == "APPROVED"
    ot = api["e1"].post("/api/v1/hr/overtime", {"work_date": "2026-03-16", "hours": "2", "reason": "deploy"})
    assert ot.status_code == 201
    assert api["dm"].post(f"/api/v1/hr/overtime/{ot.json()['id']}/reject", {"note": "not needed"}).json()["status"] == "REJECTED"
    punches = {"punches": [{"employee_no": "EMP-00002", "timestamp": "2026-03-17T08:00:00+00:00"}]}
    assert api["hro"].post("/api/v1/hr/attendance/import", punches).status_code == 403  # officers cannot import
    assert api["hrm"].post("/api/v1/hr/attendance/import", punches).status_code == 200
    assert api["dm"].get("/api/v1/hr/reports/attendance?from=2026-03-16&to=2026-03-20&group=week").status_code == 200
    assert api["e1"].get(f"/api/v1/hr/employees/{emps['Other Test']}/attendance-summary").status_code == 404
    assert api["e1"].get(f"/api/v1/hr/employees/{emps['Staff Test']}/attendance-summary?date=2026-03-16").json()["status"] in ("PRESENT", "LATE")

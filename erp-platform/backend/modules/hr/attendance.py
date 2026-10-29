"""Work schedules, overtime policy, daily attendance calculation, correction and overtime requests, device import and
attendance reports. Times are stored in UTC and evaluated in the tenant's timezone (setting `locale.timezone`);
overnight shifts belong to the day they start."""
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from modules.hr import models as m
from modules.hr import services as core
from modules.hr.services import _404, _dec, _get, authz, is_hr, is_manager_of
from platform_core.audit.services import record_tenant_event
from platform_core.organizations import models as om
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

ZERO = Decimal("0")
MAX_REPORT_DAYS = 93
MAX_PUNCHES = 5000
BREAK_APPLIES_AFTER_HOURS = Decimal("4")  # the unpaid break is deducted only from shifts longer than this


def seed_defaults():
    m.OvertimePolicy.objects.get_or_create(code="DEFAULT")
    if not m.WorkSchedule.objects.exists():
        m.WorkSchedule.objects.create(code="STANDARD", name="Standard office hours", work_days=[1, 2, 3, 4, 5], start_time=time(8, 0), end_time=time(17, 0), break_minutes=60, grace_minutes=10, is_default=True)


def tenant_tz():
    try:
        return ZoneInfo(str(org.get_setting("locale.timezone", "UTC")))
    except Exception:
        return ZoneInfo("UTC")


def _team_approver(actor_id, employee):
    return authz.has_permission(actor_id, "hr.employee.manage") or (core.acts_as_manager(actor_id, employee) and authz.has_permission(actor_id, "hr.timesheet.approve"))


# ----------------------------------------------------------------------------- schedules and policy
@transaction.atomic
def create_schedule(actor_id, *, code, name, work_days, start_time, end_time, break_minutes=60, grace_minutes=10, is_default=False):
    days = sorted(set(int(d) for d in work_days))
    if not days or any(d < 1 or d > 7 for d in days):
        raise ValidationFailed("work_days must be ISO weekdays 1-7.", code="invalid_schedule")
    if start_time == end_time:
        raise ValidationFailed("Start and end times must differ.", code="invalid_schedule")
    span = (datetime.combine(date.min, end_time) - datetime.combine(date.min, start_time)) % timedelta(days=1)
    if int(break_minutes) < 0 or timedelta(minutes=int(break_minutes)) >= span or int(grace_minutes) < 0:
        raise ValidationFailed("The break must be shorter than the shift and the grace period non-negative.", code="invalid_schedule")
    if m.WorkSchedule.objects.filter(code=code).exists():
        raise DomainError("A schedule with this code exists.", code="code_taken")
    if is_default:
        m.WorkSchedule.objects.filter(is_default=True).update(is_default=False)
    return m.WorkSchedule.objects.create(code=code, name=name, work_days=days, start_time=start_time, end_time=end_time, break_minutes=int(break_minutes), grace_minutes=int(grace_minutes), is_default=is_default)


@transaction.atomic
def assign_schedule(actor_id, employee_id, *, schedule_id, effective_from, effective_to=None):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    sch = _get(m.WorkSchedule, schedule_id, "Schedule")
    if not sch.is_active or (effective_to and effective_to < effective_from):
        raise ValidationFailed("Inactive schedule or invalid dates.", code="invalid_schedule")
    far = date.max
    for a in e.schedule_assignments.all():
        if effective_from <= (a.effective_to or far) and (effective_to or far) >= a.effective_from:
            raise DomainError("The assignment overlaps an existing one.", code="schedule_overlap")
    return m.ScheduleAssignment.objects.create(employee=e, schedule=sch, effective_from=effective_from, effective_to=effective_to)


@transaction.atomic
def update_overtime_policy(actor_id, **values):
    pol, _ = m.OvertimePolicy.objects.get_or_create(code="DEFAULT")
    for key in ("weekday_multiplier", "rest_day_multiplier", "holiday_multiplier", "max_daily_hours", "monthly_hours_divisor"):
        if values.get(key) is not None:
            v = _dec(values[key], key)
            if v <= 0 or (key.endswith("multiplier") and v < 1) or (key == "max_daily_hours" and v > 24):
                raise ValidationFailed(f"Invalid {key}.", code="invalid_policy")
            setattr(pol, key, v)
    pol.save()
    return pol


def schedule_for(employee, on_date):
    a = employee.schedule_assignments.filter(effective_from__lte=on_date).filter(Q(effective_to__isnull=True) | Q(effective_to__gte=on_date)).select_related("schedule").order_by("-effective_from").first()
    return a.schedule if a else m.WorkSchedule.objects.filter(is_default=True, is_active=True).first()


# ----------------------------------------------------------------------------- daily calculation
def _is_holiday(d, branch=None):
    return om.Holiday.objects.filter(holiday_date=d).filter(Q(branch__isnull=True)).exists()


def _hours(delta):
    return (Decimal(delta.total_seconds()) / 3600).quantize(Decimal("0.01"))


def day_type(schedule, d):
    if _is_holiday(d):
        return "HOLIDAY"
    days = schedule.work_days if schedule else org.work_days()
    return "WORKDAY" if d.isoweekday() in days else "REST_DAY"


def summarize_day(employee, d, *, att=None, on_leave=None, schedule=None, today=None):
    """What happened on day `d` for `employee`. `att`/`on_leave`/`schedule` may be preloaded by report code."""
    today = today or timezone.now().date()
    tz = tenant_tz()
    schedule = schedule if schedule is not None else schedule_for(employee, d)
    att = m.Attendance.objects.filter(employee=employee, work_date=d).first() if att is None else (att or None)  # False = preloaded "none"
    on_leave = on_leave if on_leave is not None else m.LeaveRequest.objects.filter(employee=employee, status="APPROVED", start_date__lte=d, end_date__gte=d).exists()
    kind = day_type(schedule, d)
    out = {"date": str(d), "day_type": kind, "scheduled_hours": ZERO, "worked_hours": ZERO, "late_minutes": 0, "early_minutes": 0, "overtime_hours": ZERO, "status": "OFF", "work_mode": None, "exceptions": []}
    employed = employee.hire_date <= d and (employee.termination_date is None or d <= employee.termination_date)
    if not employed:
        return out
    sched_hours = ZERO
    start = end = None
    if schedule and kind == "WORKDAY":
        start = datetime.combine(d, schedule.start_time, tzinfo=tz)
        end = datetime.combine(d if schedule.end_time > schedule.start_time else d + timedelta(days=1), schedule.end_time, tzinfo=tz)
        sched_hours = _hours(end - start - timedelta(minutes=schedule.break_minutes))
        out["scheduled_hours"] = sched_hours
    if att is None:
        if kind == "WORKDAY" and schedule and d <= today:
            out["status"] = "ON_LEAVE" if on_leave else ("ABSENT" if d < today else "PENDING")
            if out["status"] == "ABSENT":
                out["exceptions"].append("ABSENT")
        elif on_leave:
            out["status"] = "ON_LEAVE"
        return out
    out["work_mode"] = att.work_mode
    if att.check_out is None:
        out["status"] = "INCOMPLETE" if att.work_date < today else "PRESENT"
        if att.work_date < today:
            out["exceptions"].append("MISSED_PUNCH")
        return out
    elapsed = att.check_out - att.check_in
    brk = timedelta(minutes=schedule.break_minutes) if schedule and _hours(elapsed) > BREAK_APPLIES_AFTER_HOURS else timedelta(0)
    worked = max(_hours(elapsed - brk), ZERO)
    out["worked_hours"] = worked
    out["status"] = "PRESENT"
    if start is not None:
        late = (att.check_in.astimezone(tz) - (start + timedelta(minutes=schedule.grace_minutes))).total_seconds() / 60
        early = (end - att.check_out.astimezone(tz)).total_seconds() / 60
        out["late_minutes"] = max(int(late), 0)
        out["early_minutes"] = max(int(early), 0)
        if out["late_minutes"]:
            out["status"] = "LATE"
            out["exceptions"].append("LATE")
        if out["early_minutes"]:
            out["exceptions"].append("EARLY_DEPARTURE")
        out["overtime_hours"] = max(worked - sched_hours, ZERO)
    else:
        out["overtime_hours"] = worked  # rest day or holiday: everything counts as overtime
    if out["overtime_hours"] > 0:
        out["exceptions"].append("OVERTIME")
    return out


def _preload(employees, d_from, d_to):
    atts = defaultdict(dict)
    for a in m.Attendance.objects.filter(employee__in=employees, work_date__gte=d_from, work_date__lte=d_to):
        atts[a.employee_id][a.work_date] = a
    leaves = defaultdict(list)
    for l in m.LeaveRequest.objects.filter(employee__in=employees, status="APPROVED", start_date__lte=d_to, end_date__gte=d_from):
        leaves[l.employee_id].append((l.start_date, l.end_date))
    return atts, leaves


def daily_rows(employees, d_from, d_to, today=None):
    if d_to < d_from or (d_to - d_from).days + 1 > MAX_REPORT_DAYS:
        raise ValidationFailed(f"The range must be 1 to {MAX_REPORT_DAYS} days.", code="invalid_range")
    atts, leaves = _preload(employees, d_from, d_to)
    rows = []
    for e in employees:
        d = d_from
        while d <= d_to:
            r = summarize_day(e, d, att=atts[e.id].get(d, False), on_leave=any(a <= d <= b for a, b in leaves[e.id]), today=today)
            if r["status"] != "OFF" or r["worked_hours"]:
                rows.append({"employee": e, **r})
            d += timedelta(days=1)
    return rows


def _period(d, group):
    if group == "week":
        return str(d - timedelta(days=d.weekday()))
    if group == "month":
        return d.strftime("%Y-%m")
    return str(d)


def attendance_report(user_id, d_from, d_to, *, group="day", employee_id=None, today=None):
    """Daily / weekly / monthly attendance per employee among the people the user may see."""
    if group not in ("day", "week", "month"):
        raise ValidationFailed("group must be day, week or month.", code="invalid_group")
    emps = list(core.visible_employees(user_id).exclude(status__in=["ONBOARDING"]).filter(hire_date__lte=d_to))
    if employee_id:
        emps = [e for e in emps if str(e.id) == str(employee_id)]
    out = defaultdict(lambda: {"present_days": 0, "absent_days": 0, "leave_days": 0, "late_count": 0, "late_minutes": 0, "early_count": 0, "worked_hours": ZERO, "overtime_hours": ZERO, "missed_punches": 0})
    names = {}
    for r in daily_rows(emps, d_from, d_to, today=today):
        e = r["employee"]
        names[e.id] = (e.employee_no, e.name)
        row = out[(e.id, _period(date.fromisoformat(r["date"]), group))]
        row["present_days"] += r["status"] in ("PRESENT", "LATE", "INCOMPLETE")
        row["absent_days"] += r["status"] == "ABSENT"
        row["leave_days"] += r["status"] == "ON_LEAVE" and r["day_type"] == "WORKDAY"
        row["late_count"] += r["late_minutes"] > 0
        row["late_minutes"] += r["late_minutes"]
        row["early_count"] += r["early_minutes"] > 0
        row["worked_hours"] += r["worked_hours"]
        row["overtime_hours"] += r["overtime_hours"]
        row["missed_punches"] += "MISSED_PUNCH" in r["exceptions"]
    return [{"employee_no": names[k[0]][0], "name": names[k[0]][1], "period": k[1], **{kk: (str(v) if isinstance(v, Decimal) else v) for kk, v in row.items()}} for k, row in sorted(out.items(), key=lambda kv: (names[kv[0][0]][0], kv[0][1]))]


def exceptions_report(user_id, d_from, d_to, today=None):
    """Days needing attention (late, early, missed punch, absent, overtime) and whether a correction/overtime request exists."""
    emps = list(core.visible_employees(user_id).filter(hire_date__lte=d_to))
    pend = {(c.employee_id, c.work_date): c.status for c in m.AttendanceCorrection.objects.filter(employee__in=emps, work_date__gte=d_from, work_date__lte=d_to).order_by("created_at")}
    ot = {(o.employee_id, o.work_date): o.status for o in m.OvertimeRequest.objects.filter(employee__in=emps, work_date__gte=d_from, work_date__lte=d_to)}
    out = []
    for r in daily_rows(emps, d_from, d_to, today=today):
        if r["exceptions"]:
            e, d = r["employee"], date.fromisoformat(r["date"])
            out.append({"employee_no": e.employee_no, "name": e.name, "date": r["date"], "exceptions": r["exceptions"], "correction_status": pend.get((e.id, d)), "overtime_request_status": ot.get((e.id, d))})
    return out


# ----------------------------------------------------------------------------- corrections
@transaction.atomic
def request_correction(actor_id, employee_id, *, work_date, check_in, check_out=None, reason, work_mode="OFFICE"):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if e.user_id != actor_id and not authz.has_permission(actor_id, "hr.employee.manage"):
        raise _404("Employee")
    if work_date > timezone.now().date() or (check_out and check_out <= check_in) or not (reason or "").strip():
        raise ValidationFailed("Provide a past date, a consistent time range and a reason.", code="invalid_correction")
    if work_mode not in core.WORK_MODES:
        raise ValidationFailed("Invalid work mode.", code="invalid_work_mode")
    if m.AttendanceCorrection.objects.filter(employee=e, work_date=work_date, status="PENDING").exists():
        raise DomainError("A correction for this day is already pending.", code="request_open")
    return m.AttendanceCorrection.objects.create(employee=e, work_date=work_date, check_in=check_in, check_out=check_out, work_mode=work_mode, reason=reason[:300])


@transaction.atomic
def decide_correction(actor_id, correction_id, *, approve, note=""):
    c = m.AttendanceCorrection.objects.select_for_update(of=("self",)).select_related("employee", "employee__manager").filter(pk=correction_id).first()
    if c is None or not _team_approver(actor_id, c.employee):
        raise _404("Correction")
    if c.status != "PENDING":
        raise DomainError("This request was already decided.", code="invalid_state_transition")
    if c.employee.user_id == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own correction.", code="separation_of_duties", status_code=403)
    if not approve and not note.strip():
        raise ValidationFailed("A note is required when rejecting.", code="reason_required")
    c.status, c.decided_by, c.decision_note = ("APPROVED" if approve else "REJECTED"), actor_id, note[:300]
    c.save()
    if approve:
        core.record_attendance(actor_id, c.employee_id, work_date=c.work_date, check_in=c.check_in, check_out=c.check_out, work_mode=c.work_mode, source="CORRECTION")
    return c


# ----------------------------------------------------------------------------- overtime
@transaction.atomic
def request_overtime(actor_id, employee_id, *, work_date, hours, reason):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if e.user_id != actor_id and not authz.has_permission(actor_id, "hr.employee.manage"):
        raise _404("Employee")
    hours = _dec(hours, "hours")
    pol, _ = m.OvertimePolicy.objects.get_or_create(code="DEFAULT")
    if work_date > timezone.now().date() or hours <= 0 or hours > pol.max_daily_hours or not (reason or "").strip():
        raise ValidationFailed(f"Provide a past or current date, a reason and hours up to {pol.max_daily_hours}.", code="invalid_overtime")
    if m.OvertimeRequest.objects.filter(employee=e, work_date=work_date).exclude(status="REJECTED").exists():
        raise DomainError("An overtime request already exists for this day.", code="request_open")
    return m.OvertimeRequest.objects.create(employee=e, work_date=work_date, hours=hours, reason=reason[:300])


@transaction.atomic
def decide_overtime(actor_id, request_id, *, approve, note=""):
    o = m.OvertimeRequest.objects.select_for_update(of=("self",)).select_related("employee", "employee__manager").filter(pk=request_id).first()
    if o is None or not _team_approver(actor_id, o.employee):
        raise _404("Overtime request")
    if o.status != "PENDING":
        raise DomainError("This request was already decided.", code="invalid_state_transition")
    if o.employee.user_id == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own overtime.", code="separation_of_duties", status_code=403)
    if not approve and not note.strip():
        raise ValidationFailed("A note is required when rejecting.", code="reason_required")
    o.status, o.decided_by, o.decision_note = ("APPROVED" if approve else "REJECTED"), actor_id, note[:300]
    o.save()
    return o


def payable_overtime(employee, d_from, d_to):
    """Approved, unpaid overtime in the range as (request, payable_hours, multiplier). Payable hours never exceed
    what the attendance record shows was actually worked beyond schedule."""
    pol, _ = m.OvertimePolicy.objects.get_or_create(code="DEFAULT")
    out = []
    for o in m.OvertimeRequest.objects.filter(employee=employee, status="APPROVED", payroll_run__isnull=True, work_date__gte=d_from, work_date__lte=d_to).order_by("work_date"):
        s = summarize_day(employee, o.work_date)
        hours = min(o.hours, s["overtime_hours"])
        if hours > 0:
            mult = {"WORKDAY": pol.weekday_multiplier, "REST_DAY": pol.rest_day_multiplier, "HOLIDAY": pol.holiday_multiplier}[s["day_type"]]
            out.append((o, hours, mult))
    return out


# ----------------------------------------------------------------------------- device / external import
@transaction.atomic
def import_punches(actor_id, punches, *, source="DEVICE"):
    """Idempotent import of raw punches ({employee_no, timestamp}). The earliest punch of a day is the check-in and
    the latest the check-out. Manual and approved-correction records are never overwritten."""
    if len(punches) > MAX_PUNCHES:
        raise ValidationFailed(f"At most {MAX_PUNCHES} punches per call.", code="too_many_rows")
    tz = tenant_tz()
    emps = {e.employee_no: e for e in m.Employee.objects.filter(employee_no__in={p.get("employee_no") for p in punches})}
    per = defaultdict(list)
    unknown, invalid = set(), 0
    for p in punches:
        e = emps.get(p.get("employee_no"))
        ts = parse_datetime(str(p.get("timestamp") or ""))
        if e is None:
            unknown.add(p.get("employee_no"))
            continue
        if ts is None or ts.tzinfo is None:
            invalid += 1
            continue
        local = ts.astimezone(tz)
        d = local.date()
        sch = schedule_for(e, d)
        if sch and sch.end_time < sch.start_time and local.time() <= (datetime.combine(d, sch.end_time) + timedelta(hours=2)).time():
            d -= timedelta(days=1)  # the tail of last night's overnight shift
        per[(e.id, d)].append(ts)
    created = updated = skipped = 0
    for (eid, d), times in per.items():
        times.sort()
        first, last = times[0], times[-1] if len(times) > 1 and (times[-1] - times[0]) >= timedelta(minutes=1) else None
        a = m.Attendance.objects.select_for_update().filter(employee_id=eid, work_date=d).first()
        if a is None:
            m.Attendance.objects.create(employee_id=eid, work_date=d, check_in=first, check_out=last, work_mode="OFFICE", source=source)
            created += 1
        elif a.source in ("MANUAL", "CORRECTION"):
            skipped += 1
        else:
            allt = sorted(times + [a.check_in] + ([a.check_out] if a.check_out else []))
            new_in, new_out = allt[0], (allt[-1] if allt[-1] - allt[0] >= timedelta(minutes=1) else None)
            if (new_in, new_out) != (a.check_in, a.check_out):
                a.check_in, a.check_out = new_in, new_out
                a.save(update_fields=["check_in", "check_out", "updated_at"])
                updated += 1
            else:
                skipped += 1
    record_tenant_event(current_tenant(), "hr.attendance.imported", actor_user_id=actor_id, target_type="Attendance", metadata={"created": created, "updated": updated, "source": source})
    return {"created": created, "updated": updated, "skipped": skipped, "unknown_employees": sorted(x for x in unknown if x), "invalid_rows": invalid}

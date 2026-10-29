from datetime import date, timedelta

from django.utils import timezone
from django.utils.dateparse import parse_datetime, parse_time
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm.views import _date
from modules.hr import attendance as att
from modules.hr import models as m
from modules.hr import services
from modules.hr.views import _req_date, _s, perm
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate


def _dt(v, field):
    d = parse_datetime(str(v or ""))
    if d is None or d.tzinfo is None:
        raise ValidationFailed(f"{field} must be an ISO datetime with a timezone.", code="invalid_time")
    return d


def _sch(s):
    return {"id": str(s.id), "code": s.code, "name": s.name, "work_days": s.work_days, "start_time": str(s.start_time), "end_time": str(s.end_time), "break_minutes": s.break_minutes, "grace_minutes": s.grace_minutes, "is_default": s.is_default}


def _pol(p):
    return {"weekday_multiplier": str(p.weekday_multiplier), "rest_day_multiplier": str(p.rest_day_multiplier), "holiday_multiplier": str(p.holiday_multiplier), "max_daily_hours": str(p.max_daily_hours), "monthly_hours_divisor": str(p.monthly_hours_divisor)}


def _corr(c):
    return {"id": str(c.id), "employee": str(c.employee_id), "work_date": str(c.work_date), "check_in": c.check_in, "check_out": c.check_out, "work_mode": c.work_mode, "reason": c.reason, "status": c.status, "decision_note": c.decision_note}


def _ot(o):
    return {"id": str(o.id), "employee": str(o.employee_id), "work_date": str(o.work_date), "hours": str(o.hours), "reason": o.reason, "status": o.status, "decision_note": o.decision_note}


class Schedules(APIView):
    def get_permissions(self):
        return perm("hr.config.manage" if self.request.method == "POST" else "hr.self")

    def get(self, request):
        return Response([_sch(s) for s in m.WorkSchedule.objects.filter(is_active=True)])

    def post(self, request):
        b = request.data
        st, en = parse_time(str(b.get("start_time") or "")), parse_time(str(b.get("end_time") or ""))
        if st is None or en is None:
            raise ValidationFailed("start_time and end_time must be HH:MM.", code="invalid_schedule")
        return Response(_sch(att.create_schedule(request.user.id, code=b.get("code", ""), name=b.get("name", ""), work_days=b.get("work_days") or [], start_time=st, end_time=en, break_minutes=b.get("break_minutes", 60), grace_minutes=b.get("grace_minutes", 10), is_default=bool(b.get("is_default")))), status=201)


class ScheduleAssign(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage")

    def post(self, request, pk):
        b = request.data
        a = att.assign_schedule(request.user.id, pk, schedule_id=b.get("schedule"), effective_from=_req_date(b.get("effective_from"), "effective_from"), effective_to=_date(b.get("effective_to"), "effective_to"))
        return Response({"id": str(a.id)}, status=201)


class OvertimePolicyView(APIView):
    def get_permissions(self):
        return perm("hr.config.manage" if self.request.method == "PUT" else "hr.self")

    def get(self, request):
        return Response(_pol(m.OvertimePolicy.objects.get_or_create(code="DEFAULT")[0]))

    def put(self, request):
        return Response(_pol(att.update_overtime_policy(request.user.id, **{k: request.data.get(k) for k in ("weekday_multiplier", "rest_day_multiplier", "holiday_multiplier", "max_daily_hours", "monthly_hours_divisor")})))


class CheckInMode(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request):
        a = services.check_in(request.user.id, work_mode=request.data.get("work_mode", "OFFICE"))
        return Response({"id": str(a.id), "work_date": str(a.work_date), "check_in": a.check_in, "work_mode": a.work_mode}, status=201)


class DailySummary(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request, pk):
        e = services.employee_visible(request.user.id, pk)
        d = _date(request.query_params.get("date"), "date") or timezone.now().date()
        r = att.summarize_day(e, d)
        return Response({k: (str(v) if not isinstance(v, (str, int, list, type(None))) else v) for k, v in r.items()})


class AttendanceReport(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        q = request.query_params
        today = timezone.now().date()
        return Response(att.attendance_report(request.user.id, _date(q.get("from"), "from") or today.replace(day=1), _date(q.get("to"), "to") or today, group=q.get("group", "day"), employee_id=q.get("employee")))


class AttendanceExceptions(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        q = request.query_params
        today = timezone.now().date()
        return Response(att.exceptions_report(request.user.id, _date(q.get("from"), "from") or today.replace(day=1), _date(q.get("to"), "to") or today))


class Corrections(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        from modules.hr.views import _scoped

        return paginate(request, _scoped(m.AttendanceCorrection.objects.all(), request.user.id), _corr)

    def post(self, request):
        b = request.data
        emp = b.get("employee") or str(services.employee_for(request.user.id).id)
        c = att.request_correction(request.user.id, emp, work_date=_req_date(b.get("work_date"), "work_date"), check_in=_dt(b.get("check_in"), "check_in"), check_out=_dt(b["check_out"], "check_out") if b.get("check_out") else None, reason=b.get("reason", ""), work_mode=b.get("work_mode", "OFFICE"))
        return Response(_corr(c), status=201)


class CorrectionDecide(APIView):
    def get_permissions(self):
        return perm("hr.timesheet.approve")

    def post(self, request, pk, decision):
        return Response(_corr(att.decide_correction(request.user.id, pk, approve=decision == "approve", note=request.data.get("note", ""))))


class OvertimeRequests(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        from modules.hr.views import _scoped

        return paginate(request, _scoped(m.OvertimeRequest.objects.all(), request.user.id), _ot)

    def post(self, request):
        b = request.data
        emp = b.get("employee") or str(services.employee_for(request.user.id).id)
        return Response(_ot(att.request_overtime(request.user.id, emp, work_date=_req_date(b.get("work_date"), "work_date"), hours=b.get("hours"), reason=b.get("reason", ""))), status=201)


class OvertimeDecide(APIView):
    def get_permissions(self):
        return perm("hr.timesheet.approve")

    def post(self, request, pk, decision):
        return Response(_ot(att.decide_overtime(request.user.id, pk, approve=decision == "approve", note=request.data.get("note", ""))))


class PunchImport(APIView):
    def get_permissions(self):
        return perm("hr.attendance.import")

    def post(self, request):
        return Response(att.import_punches(request.user.id, request.data.get("punches") or []))


# ----------------------------------------------------------------------------- leave policy
def _lt(t):
    return {"code": t.code, "name": t.name, "is_paid": t.is_paid, "annual_days": str(t.annual_days), "grant_mode": t.grant_mode, "eligibility_months": t.eligibility_months, "eligible_employment_types": t.eligible_employment_types, "max_carryover_days": str(t.max_carryover_days), "carryover_expiry_months": t.carryover_expiry_months, "allow_half_day": t.allow_half_day, "max_consecutive_days": t.max_consecutive_days, "min_notice_days": t.min_notice_days, "is_active": t.is_active}


class LeaveTypeConfig(APIView):
    def get_permissions(self):
        return perm("hr.config.manage" if self.request.method == "PUT" else "hr.self")

    def get(self, request, code):
        t = m.LeaveType.objects.filter(code=code).first()
        if t is None:
            from shared.api.errors import DomainError

            raise DomainError("Leave type not found.", code="not_found", status_code=404)
        return Response(_lt(t))

    def put(self, request, code):
        from modules.hr import leave_policy

        keys = ("name", "is_paid", "annual_days", "grant_mode", "eligibility_months", "eligible_employment_types", "max_carryover_days", "carryover_expiry_months", "allow_half_day", "max_consecutive_days", "min_notice_days", "is_active")
        return Response(_lt(leave_policy.configure_leave_type(request.user.id, code, **{k: request.data.get(k) for k in keys})))


class LeaveRun(APIView):
    """HR can trigger the (idempotent) scheduled jobs on demand."""

    def get_permissions(self):
        return perm("hr.config.manage")

    def post(self, request, job):
        from modules.hr import leave_policy

        if job == "accrue":
            return Response({"created": leave_policy.accrue_leave(_date(request.data.get("on_date"), "on_date"))})
        if job == "year-end":
            return Response({"created": leave_policy.process_year_end(int(request.data.get("year", timezone.now().year - 1)))})
        raise ValidationFailed("Unknown job.", code="invalid_job")


class Delegations(APIView):
    def get_permissions(self):
        return perm("hr.leave.approve")

    def post(self, request):
        from modules.hr import leave_policy

        b = request.data
        d = leave_policy.delegate_approvals(request.user.id, b.get("delegate"), start_date=_req_date(b.get("start_date"), "start_date"), end_date=_req_date(b.get("end_date"), "end_date"))
        return Response({"id": str(d.id), "delegate": str(d.delegate_id), "start_date": str(d.start_date), "end_date": str(d.end_date)}, status=201)


class DelegationRevoke(APIView):
    def get_permissions(self):
        return perm("hr.leave.approve")

    def post(self, request, pk):
        from modules.hr import leave_policy

        leave_policy.revoke_delegation(request.user.id, pk)
        return Response({"ok": True})


class LeaveCalendar(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        from modules.hr import leave_policy

        q = request.query_params
        today = timezone.now().date()
        d_from = _date(q.get("from"), "from") or today.replace(day=1)
        d_to = _date(q.get("to"), "to") or d_from + timedelta(days=30)
        return Response(leave_policy.leave_calendar(request.user.id, d_from, d_to, department_id=q.get("department")))


class LeaveReport(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        from modules.hr import leave_policy

        q = request.query_params
        year = int(q.get("year", timezone.now().year))
        if q.get("kind") == "absence":
            return Response(leave_policy.absence_summary(request.user.id, year))
        return Response(leave_policy.leave_report(request.user.id, year, group=q.get("group", "employee")))

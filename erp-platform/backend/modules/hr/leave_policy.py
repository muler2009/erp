"""Leave policy engine: accruals, year-end carry-over with expiry, delegated approvals, calendars and utilization."""
from collections import defaultdict
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from modules.hr import models as m
from modules.hr import services as core
from modules.hr.services import _404, _dec, _get, add_months, authz, is_hr
from platform_core.organizations import models as om
from shared.api.errors import DomainError, ValidationFailed

ZERO = Decimal("0")
TWO = Decimal("0.01")


def _eligible(e, lt, on_date):
    try:
        core.check_eligibility(e, lt, on_date)
        return True
    except DomainError:
        return False


@transaction.atomic
def configure_leave_type(actor_id, code, **values):
    """Create or update a leave type (policy configuration)."""
    lt = m.LeaveType.objects.select_for_update().filter(code=code).first() or m.LeaveType(code=code)
    if values.get("grant_mode") is not None and values["grant_mode"] not in m.LeaveType.Grant.values:
        raise ValidationFailed("Invalid grant mode.", code="invalid_leave_type")
    for key in ("annual_days", "max_carryover_days"):
        if values.get(key) is not None and _dec(values[key], key) < 0:
            raise ValidationFailed(f"{key} must be non-negative.", code="invalid_leave_type")
    types = values.get("eligible_employment_types")
    if types is not None and any(t not in m.Employee.EmploymentType.values for t in types):
        raise ValidationFailed("Unknown employment type.", code="invalid_leave_type")
    for key in ("name", "is_paid", "annual_days", "grant_mode", "eligibility_months", "eligible_employment_types", "max_carryover_days", "carryover_expiry_months", "allow_half_day", "max_consecutive_days", "min_notice_days", "is_active"):
        if values.get(key) is not None:
            setattr(lt, key, values[key])
    if not lt.name:
        raise ValidationFailed("A name is required.", code="invalid_leave_type")
    lt.save()
    lt.refresh_from_db()
    return lt


def accrue_leave(on_date=None):
    """Create the entitlement entries due up to `on_date` (idempotent; safe to run daily or to catch up).
    ACCRUAL types earn annual_days/12 per month (the hire month prorated by days); UPFRONT types get the year's
    days at the start of the year (prorated by remaining months in the hire year). Returns the number of new entries."""
    on_date = on_date or timezone.now().date()
    created = 0
    types = list(m.LeaveType.objects.filter(is_active=True, grant_mode__in=["ACCRUAL", "UPFRONT"], annual_days__gt=0))
    emps = m.Employee.objects.filter(status__in=["ACTIVE", "OFFBOARDING"], hire_date__lte=on_date)
    for e in emps:
        for lt in types:
            start = max(e.hire_date, date(on_date.year, 1, 1))
            if not _eligible(e, lt, on_date):
                continue
            if lt.grant_mode == "UPFRONT":
                first_month = e.hire_date.month if e.hire_date.year == on_date.year else 1
                days = (lt.annual_days * (13 - first_month) / 12).quantize(TWO, rounding=ROUND_HALF_UP)
                _, new = m.LeaveAllocation.objects.get_or_create(employee=e, leave_type=lt, year=on_date.year, kind="ACCRUAL", period=str(on_date.year), defaults={"days": days})
                created += new
                continue
            mth = start.month
            while mth <= on_date.month:
                month_start = date(on_date.year, mth, 1)
                month_days = ((date(on_date.year + (mth == 12), (mth % 12) + 1, 1)) - month_start).days
                share = Decimal(1)
                if e.hire_date.year == on_date.year and e.hire_date.month == mth:
                    share = Decimal(month_days - e.hire_date.day + 1) / month_days
                if e.termination_date and e.termination_date.year == on_date.year and e.termination_date.month < mth:
                    mth += 1
                    continue
                days = (lt.annual_days / 12 * share).quantize(TWO, rounding=ROUND_HALF_UP)
                _, new = m.LeaveAllocation.objects.get_or_create(employee=e, leave_type=lt, year=on_date.year, kind="ACCRUAL", period=f"{on_date.year}-{mth:02d}", defaults={"days": days})
                created += new
                mth += 1
    return created


def process_year_end(year):
    """Carry unused days from `year` into year+1, up to each type's cap, expiring after the configured months.
    Idempotent. Returns the number of carry-over entries created."""
    created = 0
    for lt in m.LeaveType.objects.filter(is_active=True, max_carryover_days__gt=0):
        for e in m.Employee.objects.exclude(status="TERMINATED").filter(hire_date__lte=date(year, 12, 31)):
            bal = core.leave_balance(e, lt, year, as_of=date(year, 12, 31), request_end=date(year, 12, 31))
            carry = min(bal["remaining"], lt.max_carryover_days)
            if carry <= 0:
                continue
            expires = (add_months(date(year + 1, 1, 1), lt.carryover_expiry_months) - timedelta(days=1)) if lt.carryover_expiry_months else None
            _, new = m.LeaveAllocation.objects.get_or_create(employee=e, leave_type=lt, year=year + 1, kind="CARRYOVER", period=str(year), defaults={"days": carry, "expires_on": expires})
            created += new
    return created


# ----------------------------------------------------------------------------- delegation
@transaction.atomic
def delegate_approvals(actor_id, delegate_id, *, start_date, end_date):
    if not authz.has_permission(actor_id, "hr.leave.approve"):
        raise DomainError("Only approvers can delegate approvals.", code="permission_denied", status_code=403)
    if actor_id == delegate_id or end_date < start_date:
        raise ValidationFailed("Pick someone else and a valid period.", code="invalid_delegation")
    if not authz.has_permission(delegate_id, "hr.leave.approve") or not core._active_member(delegate_id):
        raise ValidationFailed("The delegate must be an active member who can approve leave.", code="invalid_delegate")
    return m.LeaveDelegation.objects.create(delegator_id=actor_id, delegate_id=delegate_id, start_date=start_date, end_date=end_date)


@transaction.atomic
def revoke_delegation(actor_id, delegation_id):
    d = m.LeaveDelegation.objects.select_for_update().filter(pk=delegation_id, delegator_id=actor_id, revoked_at__isnull=True).first()
    if d is None:
        raise _404("Delegation")
    d.revoked_at = timezone.now()
    d.save(update_fields=["revoked_at", "updated_at"])
    return d


# ----------------------------------------------------------------------------- calendar and reports
def leave_calendar(user_id, d_from, d_to, *, department_id=None, include_pending=True):
    if d_to < d_from or (d_to - d_from).days > 190:
        raise ValidationFailed("The range must be between 1 and 190 days.", code="invalid_range")
    emps = core.visible_employees(user_id)
    if department_id:
        emps = emps.filter(department_id=department_id)
    statuses = ["APPROVED", "PENDING"] if include_pending else ["APPROVED"]
    leaves = m.LeaveRequest.objects.filter(employee__in=emps, status__in=statuses, start_date__lte=d_to, end_date__gte=d_from).select_related("employee", "leave_type").order_by("start_date")
    holidays = [{"date": str(h.holiday_date), "name": h.name} for h in om.Holiday.objects.filter(holiday_date__gte=d_from, holiday_date__lte=d_to, branch__isnull=True).order_by("holiday_date")]
    return {"leaves": [{"employee_no": l.employee.employee_no, "name": l.employee.name, "department": l.employee.department.name if l.employee.department_id else None, "type": l.leave_type.code, "start_date": str(l.start_date), "end_date": str(l.end_date), "days": str(l.days), "status": l.status} for l in leaves], "holidays": holidays}


def leave_report(user_id, year, *, group="employee"):
    """Entitlement, usage and utilization for a year, per employee / department / leave type."""
    if group not in ("employee", "department", "type"):
        raise ValidationFailed("group must be employee, department or type.", code="invalid_group")
    emps = list(core.visible_employees(user_id).exclude(status="ONBOARDING"))
    rows = defaultdict(lambda: {"allocated": ZERO, "used": ZERO, "expired": ZERO, "remaining": ZERO, "pending": ZERO})
    types = list(m.LeaveType.objects.filter(is_active=True))
    pending = defaultdict(lambda: ZERO)
    for r in m.LeaveRequest.objects.filter(employee__in=emps, start_date__year=year, status="PENDING"):
        pending[(r.employee_id, r.leave_type_id)] += r.days
    for e in emps:
        for lt in types:
            b = core.leave_balance(e, lt, year, as_of=date(year, 12, 31), request_end=date(year, 12, 31)) if year < timezone.now().year else core.leave_balance(e, lt, year)
            if not (b["allocated"] or b["used"]):
                continue
            key = {"employee": (e.employee_no, e.name, lt.code), "department": (e.department.name if e.department_id else "-", lt.code), "type": (lt.code,)}[group]
            row = rows[key]
            for k in ("allocated", "used", "expired", "remaining"):
                row[k] += b[k]
            row["pending"] += pending[(e.id, lt.id)]
    out = []
    for key, v in sorted(rows.items()):
        entry = {"key": list(key), **{k: str(x) for k, x in v.items()}, "utilization_percent": str((v["used"] / v["allocated"] * 100).quantize(TWO)) if v["allocated"] else None}
        out.append(entry)
    return out


def absence_summary(user_id, year):
    """Approved leave days per month and leave type (all visible employees)."""
    emps = core.visible_employees(user_id)
    out = defaultdict(lambda: ZERO)
    for r in m.LeaveRequest.objects.filter(employee__in=emps, status="APPROVED", start_date__year=year).select_related("leave_type"):
        out[(f"{r.start_date:%Y-%m}", r.leave_type.code)] += r.days
    return [{"month": k[0], "type": k[1], "days": str(v)} for k, v in sorted(out.items())]

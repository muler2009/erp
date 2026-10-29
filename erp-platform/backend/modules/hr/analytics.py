"""HR analytics. All figures are computed from the transactional records on demand; access needs hr.analytics.view."""
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Count, Q, Sum

from modules.hr import models as m
from modules.hr import services as core
from modules.hr.services import authz
from shared.api.errors import DomainError, ValidationFailed

ZERO = Decimal("0")
TWO = Decimal("0.01")


def _need(user_id):
    if not authz.has_permission(user_id, "hr.analytics.view"):
        raise DomainError("You do not have permission for this action.", code="permission_denied", status_code=403)


def _headcount_on(d):
    return m.Employee.objects.filter(hire_date__lte=d).exclude(status="ONBOARDING").filter(Q(termination_date__isnull=True) | Q(termination_date__gt=d)).count()


def headcount(user_id, as_of=None):
    _need(user_id)
    d = as_of or date.today()
    base = m.Employee.objects.filter(hire_date__lte=d).exclude(status="ONBOARDING").filter(Q(termination_date__isnull=True) | Q(termination_date__gt=d))
    return {"as_of": str(d), "total": base.count(), "by_department": {(r["department__name"] or "-"): r["n"] for r in base.values("department__name").annotate(n=Count("id"))}, "by_employment_type": {r["employment_type"]: r["n"] for r in base.values("employment_type").annotate(n=Count("id"))}}


def turnover(user_id, year):
    """Leavers in the year over average headcount (start and end of year), by separation type."""
    _need(user_id)
    start, end = date(year, 1, 1), date(year, 12, 31)
    leavers = m.Employee.objects.filter(status="TERMINATED", termination_date__gte=start, termination_date__lte=end)
    avg = Decimal(_headcount_on(start - timedelta(days=1)) + _headcount_on(end)) / 2
    n = leavers.count()
    return {"year": year, "leavers": n, "average_headcount": str(avg), "turnover_percent": str((Decimal(n) / avg * 100).quantize(TWO)) if avg else None, "by_type": {r["separation_type"] or "-": r["c"] for r in leavers.values("separation_type").annotate(c=Count("id"))}}


def tenure_bands(user_id, as_of=None):
    _need(user_id)
    d = as_of or date.today()
    bands = {"<1y": 0, "1-3y": 0, "3-5y": 0, "5y+": 0}
    for e in m.Employee.objects.filter(status="ACTIVE", hire_date__lte=d):
        yrs = (d - e.hire_date).days / 365.25
        bands["<1y" if yrs < 1 else "1-3y" if yrs < 3 else "3-5y" if yrs < 5 else "5y+"] += 1
    return bands


def payroll_cost(user_id, year):
    _need(user_id)
    if not authz.has_permission(user_id, "hr.payroll.view"):
        raise DomainError("Payroll cost needs payroll access.", code="permission_denied", status_code=403)
    rows = m.PayrollRun.objects.filter(period_start__year=year, status__in=["APPROVED", "POSTED", "PAID"]).order_by("period_start")
    return [{"month": f"{r.period_start:%Y-%m}", "gross": str(r.gross_total), "employer_pension": str(r.pension_employer_total), "employer_cost": str(r.gross_total + r.pension_employer_total), "net": str(r.net_total)} for r in rows]


def absenteeism(user_id, year):
    """Approved leave days per month over scheduled working days of the active headcount (unpaid + paid, excl. holidays)."""
    _need(user_id)
    days = defaultdict(lambda: ZERO)
    for r in m.LeaveRequest.objects.filter(status="APPROVED", start_date__year=year):
        days[f"{r.start_date:%Y-%m}"] += r.days
    return [{"month": k, "leave_days": str(v)} for k, v in sorted(days.items())]


def recruitment(user_id):
    _need(user_id)
    funnel = {s: 0 for s in m.Candidate.Stage.values}
    for s in m.Candidate.objects.values_list("stage", flat=True):
        funnel[s] += 1
    return {"open_requisitions": m.JobRequisition.objects.filter(status="APPROVED").count(), "funnel": funnel}


def performance(user_id, cycle_id):
    _need(user_id)
    qs = m.PerformanceReview.objects.filter(cycle_id=cycle_id)
    dist = {i: 0 for i in range(1, 6)}
    for r in qs.exclude(manager_rating__isnull=True).values_list("manager_rating", flat=True):
        dist[r] += 1
    return {"reviews": qs.count(), "completed": qs.filter(status__in=["COMPLETED", "ACKNOWLEDGED"]).count(), "rating_distribution": dist}


def dashboard(user_id, year=None):
    _need(user_id)
    year = year or date.today().year
    out = {"headcount": headcount(user_id), "turnover": turnover(user_id, year), "tenure": tenure_bands(user_id), "absenteeism": absenteeism(user_id, year), "recruitment": recruitment(user_id)}
    out["payroll_cost"] = payroll_cost(user_id, year) if authz.has_permission(user_id, "hr.payroll.view") else None
    return out

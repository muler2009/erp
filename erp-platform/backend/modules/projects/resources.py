"""Resource load across projects: allocation percentages and planned task hours against capacity."""
from datetime import timedelta
from decimal import Decimal

from django.db.models import Q, Sum

from modules.projects import models as m
from shared.api.errors import ValidationFailed

ZERO = Decimal("0")
LIVE = ("PLANNING", "ACTIVE", "ON_HOLD")


def committed_allocation(user_id, start_on, end_on, exclude_project=None):
    qs = m.ProjectMember.objects.filter(user_id=user_id, is_active=True, project__status__in=LIVE, project__start_on__lte=end_on, project__end_on__gte=start_on)
    if exclude_project:
        qs = qs.exclude(project_id=exclude_project)
    return qs.aggregate(s=Sum("allocation_percent"))["s"] or ZERO


def resource_load(date_from, date_to, weekly_hours=40):
    """Per person: allocation committed over the period, and planned task hours against the capacity of the period."""
    if date_to < date_from:
        raise ValidationFailed("The period is back to front.", code="invalid_dates")
    weeks = Decimal((date_to - date_from).days + 1) / 7
    capacity = weeks * Decimal(str(weekly_hours))
    out = {}
    members = m.ProjectMember.objects.filter(is_active=True, project__status__in=LIVE, project__start_on__lte=date_to, project__end_on__gte=date_from).select_related("project")
    for mem in members:
        r = out.setdefault(str(mem.user_id), {"user_id": str(mem.user_id), "allocation_percent": ZERO, "projects": [], "planned_hours": ZERO})
        r["allocation_percent"] += mem.allocation_percent
        r["projects"].append(mem.project.code)
    parents = set(m.Task.objects.filter(parent__isnull=False).values_list("parent_id", flat=True))
    for t in m.Task.objects.filter(assignee_id__isnull=False, planned_start__lte=date_to, planned_end__gte=date_from, project__status__in=LIVE).exclude(status__in=("DONE", "CANCELLED")):
        if t.id in parents or str(t.assignee_id) not in out:
            continue
        total_days = (t.planned_end - t.planned_start).days + 1
        overlap = (min(t.planned_end, date_to) - max(t.planned_start, date_from)).days + 1
        out[str(t.assignee_id)]["planned_hours"] += t.planned_hours * Decimal(overlap) / Decimal(total_days)
    rows = []
    for r in sorted(out.values(), key=lambda r: r["user_id"]):
        util = (r["planned_hours"] / capacity * 100).quantize(Decimal("0.01")) if capacity else ZERO
        rows.append({"user_id": r["user_id"], "projects": sorted(r["projects"]), "allocation_percent": str(r["allocation_percent"]), "over_allocated": r["allocation_percent"] > 100, "planned_hours": str(r["planned_hours"].quantize(Decimal("0.01"))), "capacity_hours": str(capacity.quantize(Decimal("0.01"))), "load_percent": str(util), "overloaded": util > 100})
    return rows

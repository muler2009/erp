"""Allocation of assets to projects/departments/cost centres, usage hours and utilization analysis."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Q, Sum

from modules.assets import models as m
from modules.assets import services as svc
from shared.api.errors import DomainError, ValidationFailed

ZERO = Decimal("0")
KINDS = ("PROJECT", "DEPARTMENT", "COST_CENTER")
IN_SERVICE = ("AVAILABLE", "ASSIGNED", "IN_USE", "UNDER_MAINTENANCE", "TRANSFERRED")


@transaction.atomic
def allocate(actor_id, asset_id, *, target_kind, target_id, start_on, end_on=None, share_percent=100, notes=""):
    a = svc._get(asset_id, lock=True)  # serialises concurrent allocations of one asset
    if target_kind not in KINDS or not target_id:
        raise ValidationFailed("Allocate to a PROJECT, DEPARTMENT or COST_CENTER.", code="invalid_target")
    if a.status not in IN_SERVICE:
        raise DomainError("Only an asset in service can be allocated.", code="asset_not_allocatable")
    if target_kind == "PROJECT":
        from modules.projects.models import Project

        pr = Project.objects.filter(pk=target_id).first()
        if pr is None or pr.status not in ("PLANNING", "ACTIVE", "ON_HOLD"):
            raise ValidationFailed("The project does not exist or is closed.", code="invalid_target")
    if end_on and end_on < start_on:
        raise ValidationFailed("The allocation cannot end before it starts.", code="invalid_dates")
    share = svc._dec(share_percent, "share_percent")
    if not (0 < share <= 100):
        raise ValidationFailed("The share must be between 0 and 100 percent.", code="invalid_share")
    far = end_on or start_on + timedelta(days=36500)
    overlap = m.AssetAllocation.objects.filter(asset=a, status="ACTIVE", start_on__lte=far).filter(Q(end_on__isnull=True) | Q(end_on__gte=start_on))
    if overlap.filter(target_kind=target_kind, target_id=target_id).exists():
        raise DomainError("The asset is already allocated to this target for these dates.", code="already_pending")
    used = overlap.aggregate(s=Sum("share_percent"))["s"] or ZERO
    if used + share > 100:
        raise DomainError(f"The asset is already allocated {used}% in this period; only {100 - used}% is left to share.", code="over_allocated")
    row = m.AssetAllocation.objects.create(asset=a, target_kind=target_kind, target_id=target_id, start_on=start_on, end_on=end_on, share_percent=share, notes=notes[:300])
    svc.log(a, "ALLOCATED", actor_id=actor_id, target=target_kind, share=share)
    return row


@transaction.atomic
def end_allocation(actor_id, allocation_id, ended_on):
    r = m.AssetAllocation.objects.select_for_update(of=("self",)).select_related("asset").filter(pk=allocation_id).first()
    if r is None:
        raise DomainError("Allocation not found.", code="not_found", status_code=404)
    if r.status != "ACTIVE":
        raise DomainError("This allocation has already ended.", code="invalid_state")
    if ended_on < r.start_on:
        raise ValidationFailed("It cannot end before it starts.", code="invalid_dates")
    r.status, r.end_on = "ENDED", ended_on
    r.save()
    svc.log(r.asset, "ALLOCATION_ENDED", actor_id=actor_id, target=r.target_kind)
    return r


def end_all_for_asset(actor_id, asset_id, on):
    """Used when an asset is disposed or retired: it can no longer serve any project."""
    n = 0
    for r in m.AssetAllocation.objects.filter(asset_id=asset_id, status="ACTIVE"):
        end_allocation(actor_id, r.id, max(on, r.start_on))
        n += 1
    return n


@transaction.atomic
def log_usage(actor_id, asset_id, *, logged_on, hours, allocation_id=None):
    a = svc._get(asset_id, lock=True)
    h = svc._dec(hours, "hours")
    if not (0 < h <= 24):
        raise ValidationFailed("Hours must be above 0 and at most 24.", code="invalid_hours")
    if a.status not in IN_SERVICE:
        raise DomainError("Usage can only be logged for an asset in service.", code="asset_not_allocatable")
    if allocation_id:
        al = m.AssetAllocation.objects.filter(pk=allocation_id, asset=a).first()
        if al is None:
            raise ValidationFailed("The allocation belongs to another asset.", code="invalid_allocation")
        if logged_on < al.start_on or (al.end_on and logged_on > al.end_on):
            raise DomainError("The date is outside the allocation period.", code="outside_allocation")
    day = m.UsageLog.objects.filter(asset=a, logged_on=logged_on).aggregate(s=Sum("hours"))["s"] or ZERO
    if day + h > 24:
        raise DomainError(f"An asset cannot be used more than 24 hours a day ({day} already logged).", code="over_24_hours")
    return m.UsageLog.objects.create(asset=a, allocation_id=allocation_id, logged_on=logged_on, hours=h, recorded_by=actor_id)


def utilization_report(date_from, date_to, *, daily_hours=8, underused_below=20):
    """Per asset in service: hours used against available hours; flags idle and underutilized assets."""
    if date_to < date_from:
        raise ValidationFailed("The period is back to front.", code="invalid_dates")
    avail = Decimal((date_to - date_from).days + 1) * Decimal(str(daily_hours))
    used = {r["asset_id"]: r["s"] for r in m.UsageLog.objects.filter(logged_on__range=(date_from, date_to)).values("asset_id").annotate(s=Sum("hours"))}
    rows = []
    for a in m.Asset.objects.filter(status__in=IN_SERVICE).select_related("category").order_by("number"):
        h = used.get(a.id, ZERO)
        pct = (h / avail * 100).quantize(Decimal("0.01")) if avail else ZERO
        rows.append({"asset": a.number, "name": a.name, "category": a.category.code, "hours": str(h), "available_hours": str(avail), "utilization_percent": str(pct), "idle": h == 0, "underutilized": 0 < pct < Decimal(underused_below)})
    return {"rows": rows, "idle": sum(r["idle"] for r in rows), "underutilized": sum(r["underutilized"] for r in rows)}


def project_usage(date_from, date_to):
    """Hours consumed per allocation target (project, department or cost centre)."""
    qs = m.UsageLog.objects.filter(logged_on__range=(date_from, date_to), allocation__isnull=False).values("allocation__target_kind", "allocation__target_id").annotate(h=Sum("hours"))
    return sorted(({"target_kind": r["allocation__target_kind"], "target_id": str(r["allocation__target_id"]), "hours": str(r["h"])} for r in qs), key=lambda r: (r["target_kind"], r["target_id"]))


def allocations_for(asset_id=None, target_id=None, on=None):
    qs = m.AssetAllocation.objects.filter(status="ACTIVE").select_related("asset")
    if asset_id:
        qs = qs.filter(asset_id=asset_id)
    if target_id:
        qs = qs.filter(target_id=target_id)
    if on:
        qs = qs.filter(start_on__lte=on).filter(Q(end_on__isnull=True) | Q(end_on__gte=on))
    return qs.order_by("start_on")

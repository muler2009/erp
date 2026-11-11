"""Replacement planning and capital budgeting, plus the asset dashboard that pulls the slices together."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Sum
from django.utils import timezone

from modules.assets import models as m
from modules.assets import services as svc
from shared.api.errors import DomainError, ValidationFailed

ZERO = Decimal("0")
IN_SERVICE = ("AVAILABLE", "ASSIGNED", "IN_USE", "UNDER_MAINTENANCE", "TRANSFERRED")


def _org():
    from platform_core.organizations import services as org

    return org


def replacement_candidates(today=None):
    """Assets that should be considered for replacement, with the reasons (rules are tenant settings)."""
    today = today or timezone.now().date()
    pct = Decimal(str(_org().get_setting("assets.replacement_maintenance_percent", 50)))
    n_bd = int(_org().get_setting("assets.replacement_breakdowns", 3))
    since = today - timedelta(days=365)
    out = []
    for a in m.Asset.objects.filter(status__in=IN_SERVICE).select_related("category").order_by("number"):
        reasons = []
        if a.is_capitalized and a.useful_life_months and a.depreciated_months >= a.useful_life_months:
            reasons.append("END_OF_LIFE")
        if a.condition in ("POOR", "DAMAGED"):
            reasons.append("CONDITION_" + a.condition)
        bds = m.Breakdown.objects.filter(asset=a, reported_at__date__gte=since).count()
        if bds >= n_bd:
            reasons.append("REPEATED_BREAKDOWNS")
        cost = sum((w.total_cost for w in m.WorkOrder.objects.filter(asset=a, status="VERIFIED", completed_on__gte=since)), ZERO)
        if a.gross_value > 0 and cost * 100 >= a.gross_value * pct:
            reasons.append("MAINTENANCE_COST_HIGH")
        if reasons:
            out.append({"asset": a.number, "name": a.name, "category": a.category.code, "reasons": reasons, "gross_value": str(a.gross_value), "maintenance_cost_12m": str(cost), "breakdowns_12m": bds, "already_planned": m.ReplacementItem.objects.filter(asset=a, status__in=("PLANNED", "APPROVED")).exists()})
    return out


@transaction.atomic
def plan_replacement(actor_id, asset_id, *, planned_year, estimated_cost, reason):
    a = svc._get(asset_id)
    if a.status not in IN_SERVICE + ("RETIRED",):
        raise DomainError("Only an asset in the register can be planned for replacement.", code="asset_not_disposable")
    cost = svc._dec(estimated_cost, "estimated_cost")
    if cost <= 0:
        raise ValidationFailed("The estimated cost must be positive.", code="invalid_amount")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    if m.ReplacementItem.objects.filter(asset=a, status__in=("PLANNED", "APPROVED")).exists():
        raise DomainError("This asset is already in the replacement plan.", code="already_pending")
    return m.ReplacementItem.objects.create(asset=a, planned_year=planned_year, estimated_cost=cost, reason=reason[:300], requested_by=actor_id)


def _decide(row, actor_id, approve, note, ok, bad, what):
    if row.status not in (("PLANNED",) if what == "item" else ("PROPOSED",)):
        raise DomainError("This entry has already been decided.", code="invalid_state")
    if row.requested_by == actor_id:
        raise DomainError("Separation of duties: someone else must approve this.", code="separation_of_duties", status_code=403)
    if not approve and not (note or "").strip():
        raise ValidationFailed("A reason is required to reject.", code="reason_required")
    row.status, row.decided_by = (ok if approve else bad), actor_id
    row.save()
    return row


@transaction.atomic
def decide_replacement(actor_id, item_id, *, approve, note=""):
    r = m.ReplacementItem.objects.select_for_update(of=("self",)).filter(pk=item_id).first()
    if r is None:
        raise DomainError("Item not found.", code="not_found", status_code=404)
    return _decide(r, actor_id, approve, note, "APPROVED", "CANCELLED", "item")


@transaction.atomic
def propose_budget(actor_id, *, year, amount, category_id=None, notes=""):
    amt = svc._dec(amount, "amount")
    if amt <= 0:
        raise ValidationFailed("The budget must be positive.", code="invalid_amount")
    if m.CapexBudget.objects.filter(year=year, category_id=category_id, status__in=("PROPOSED", "APPROVED")).exists():
        raise DomainError("A budget for this year and category already exists.", code="already_pending")
    return m.CapexBudget.objects.create(year=year, category_id=category_id, amount=amt, notes=notes[:300], requested_by=actor_id)


@transaction.atomic
def decide_budget(actor_id, budget_id, *, approve, note=""):
    b = m.CapexBudget.objects.select_for_update(of=("self",)).filter(pk=budget_id).first()
    if b is None:
        raise DomainError("Budget not found.", code="not_found", status_code=404)
    return _decide(b, actor_id, approve, note, "APPROVED", "REJECTED", "budget")


def budget_report(year):
    """Approved capex budget against actual capitalized spend (acquisitions and improvements) and approved replacements."""
    rows = []
    cats = {c.id: c.code for c in m.AssetCategory.objects.all()}
    actual = {}
    for r in m.AssetValueEntry.objects.filter(kind__in=("CAPITALIZATION", "IMPROVEMENT"), entry_date__year=year).values("asset__category_id").annotate(s=Sum("gross_delta")):
        actual[r["asset__category_id"]] = r["s"] or ZERO
    planned = {}
    for r in m.ReplacementItem.objects.filter(planned_year=year, status__in=("PLANNED", "APPROVED")).values("asset__category_id").annotate(s=Sum("estimated_cost")):
        planned[r["asset__category_id"]] = r["s"] or ZERO
    budgets = {b.category_id: b for b in m.CapexBudget.objects.filter(year=year, status="APPROVED")}
    for cid in sorted(set(budgets) | set(actual) | set(planned), key=lambda c: cats.get(c, "")):
        b = budgets[cid].amount if cid in budgets else ZERO
        a = actual.get(cid, ZERO)
        rows.append({"category": cats.get(cid, "ALL"), "budget": str(b), "actual": str(a), "planned_replacements": str(planned.get(cid, ZERO)), "remaining": str(b - a), "over_budget": a > b > 0})
    return {"year": year, "rows": rows}


def dashboard(today=None):
    from modules.assets import allocation, disposal, fleet, inspections, maintenance, warranty
    from modules.assets import custody, depreciation

    today = today or timezone.now().date()
    status = {r["status"]: r["n"] for r in m.Asset.objects.values("status").annotate(n=Count("id"))}
    val = depreciation.valuation_report()["totals"]
    exp = warranty.expiring(30, today)
    util = allocation.utilization_report(today - timedelta(days=29), today, underused_below=int(_org().get_setting("assets.underutilized_percent", 20)))
    return {
        "assets_by_status": status,
        "value": val,
        "reconciled": depreciation.reconcile()["reconciled"],
        "maintenance": {"open_work_orders": m.WorkOrder.objects.filter(status__in=maintenance.OPEN_WO).count(), "overdue": m.WorkOrder.objects.filter(status__in=("OPEN", "IN_PROGRESS"), due_on__lt=today).count(), "unavailable_assets": status.get("UNDER_MAINTENANCE", 0), "open_breakdowns": m.Breakdown.objects.exclude(status__in=("RESTORED", "CLOSED")).count()},
        "inspections": {"overdue": len(inspections.overdue(today)), "open_findings": m.InspectionFinding.objects.filter(status="OPEN").count()},
        "expiring_30_days": {"warranties": len(exp["warranties"]), "policies": len(exp["policies"]), "vehicles": len(fleet.expiries(30, today))},
        "uninsured_required": len(warranty.uninsured_assets(today)),
        "custody": {"unreturned": len(custody.unreturned(today)), "unacknowledged": len(custody.unacknowledged())},
        "utilization_30d": {"idle": util["idle"], "underutilized": util["underutilized"]},
        "open_disposals": m.AssetDisposal.objects.filter(status__in=("REQUESTED", "APPROVED")).count(),
        "open_counts": m.VerificationCount.objects.filter(status__in=("OPEN", "IN_REVIEW")).count(),
        "replacement_candidates": len([c for c in replacement_candidates(today) if not c["already_planned"]]),
    }

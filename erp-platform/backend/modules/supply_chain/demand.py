"""Demand management for demand that is not already visible as a sales order or a production plan (project, customer forecast,
departmental or manual demand). Approved demand feeds replenishment; revisions are kept; impact shows what a change does to supply."""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction

from modules.inventory import models as im
from modules.manufacturing import mrp
from modules.supply_chain import models as m
from modules.supply_chain.logistics import audit, dec
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed

SOURCES = ("CUSTOMER_FORECAST", "PROJECT", "MANUFACTURING", "DEPARTMENT", "MANUAL")


def _get(pk, lock=True):
    qs = m.Demand.objects.select_for_update() if lock else m.Demand.objects
    d = qs.filter(pk=pk).first()
    if d is None:
        raise DomainError("Demand not found.", code="not_found", status_code=404)
    return d


@transaction.atomic
def create_demand(actor, *, product_id, quantity, required_date, source, source_ref="", customer="", kind="CONFIRMED", priority=3, warehouse_id=None):
    if source == "SALES_ORDER":
        raise ValidationFailed("Sales-order demand is read directly from the orders; entering it here would count it twice.", code="double_counting")
    if source not in SOURCES or kind not in ("CONFIRMED", "FORECAST") or not 1 <= int(priority) <= 5:
        raise ValidationFailed("A valid source, kind and priority (1-5) are required.", code="invalid_fields")
    p = im.Product.objects.filter(pk=product_id, is_active=True).first()
    q = dec(quantity, "quantity")
    if p is None or q <= 0:
        raise ValidationFailed("A valid product and a positive quantity are required.", code="invalid_fields")
    if warehouse_id and not im.Warehouse.objects.filter(pk=warehouse_id).exists():
        raise ValidationFailed("Unknown warehouse.", code="invalid_warehouse")
    try:
        with transaction.atomic():
            d = m.Demand.objects.create(product=p, quantity=q, required_date=required_date, source=source, source_ref=source_ref[:64], customer=customer[:200], kind=kind, priority=int(priority), warehouse_id=warehouse_id or None, created_by=actor)
    except IntegrityError:
        raise DomainError("This source reference is already recorded as demand.", code="duplicate_demand")
    audit("supply_chain.demand.created", actor, "Demand", d.id, source=source)
    return d


@transaction.atomic
def revise_demand(actor, pk, *, reason, quantity=None, required_date=None, priority=None):
    d = _get(pk)
    if d.status == "CANCELLED":
        raise DomainError("A cancelled demand cannot be revised.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    m.DemandRevision.objects.create(demand=d, revision=d.revision, old_quantity=d.quantity, old_required_date=d.required_date, old_priority=d.priority, reason=reason[:300], changed_by=actor)
    if quantity is not None:
        d.quantity = dec(quantity, "quantity")
        if d.quantity <= 0:
            raise ValidationFailed("quantity must be positive.", code="invalid_amount")
    if required_date is not None:
        d.required_date = required_date
    if priority is not None:
        if not 1 <= int(priority) <= 5:
            raise ValidationFailed("priority must be 1-5.", code="invalid_fields")
        d.priority = int(priority)
    d.revision += 1
    d.status, d.approved_by = "DRAFT", None  # a revised demand has to be approved again
    d.save()
    audit("supply_chain.demand.revised", actor, "Demand", d.id, revision=d.revision)
    return d


@transaction.atomic
def approve_demand(actor, pk):
    d = _get(pk)
    if d.status != "DRAFT":
        raise DomainError(f"A {d.status} demand cannot be approved.", code="invalid_state_transition")
    if d.created_by == actor or d.revisions.filter(changed_by=actor).exists():
        raise DomainError("You cannot approve demand you created or revised.", code="separation_of_duties", status_code=403)
    d.status, d.approved_by = "APPROVED", actor
    d.save()
    audit("supply_chain.demand.approved", actor, "Demand", d.id)
    return d


@transaction.atomic
def cancel_demand(actor, pk, *, reason):
    d = _get(pk)
    if d.status == "CANCELLED":
        raise DomainError("Already cancelled.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    d.status, d.cancel_reason = "CANCELLED", reason[:300]
    d.save()
    audit("supply_chain.demand.cancelled", actor, "Demand", d.id)
    return d


def consolidated(date_from, date_to):
    """Approved demand grouped by product, location and month, split into confirmed and forecast."""
    rows = defaultdict(lambda: {"CONFIRMED": Decimal(0), "FORECAST": Decimal(0)})
    for d in m.Demand.objects.filter(status="APPROVED", required_date__gte=date_from, required_date__lte=date_to).select_related("product", "warehouse"):
        rows[(d.product.sku, d.warehouse.code if d.warehouse else "(any)", d.required_date.strftime("%Y-%m"))][d.kind] += d.quantity
    return [{"product": k[0], "warehouse": k[1], "month": k[2], "confirmed": str(v["CONFIRMED"]), "forecast": str(v["FORECAST"])} for k, v in sorted(rows.items())]


def impact(demand_id, today):
    """What this demand changes in the supply plan: suggestions with it included against the same run without it."""
    from modules.supply_chain import planning as pl
    d = _get(demand_id, lock=False)
    horizon = int(org.get_setting("supply_chain.planning_horizon_days", 30))
    entry = (d.product_id, d.quantity, max(d.required_date, today))
    current = pl._demands(today, horizon)
    if d.status == "APPROVED":
        with_d, without = current, list(current)
        if entry in without:
            without.remove(entry)
    else:
        without, with_d = current, current + ([entry] if d.status == "DRAFT" and d.required_date <= today + timedelta(days=horizon) else [])
    a = {(s["sku"], s["action"]): s["quantity"] for s in mrp.plan(with_d, today)}
    b = {(s["sku"], s["action"]): s["quantity"] for s in mrp.plan(without, today)}
    return [{"product": k[0], "action": k[1], "quantity_without": str(b.get(k, Decimal(0))), "quantity_with": str(a.get(k, Decimal(0))), "change": str(a.get(k, Decimal(0)) - b.get(k, Decimal(0)))}
            for k in sorted(set(a) | set(b)) if a.get(k, Decimal(0)) != b.get(k, Decimal(0))]

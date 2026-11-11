"""Stock availability, reservations, alerts and ageing.

available = on hand - quarantined/blocked - in transit - reserved (manual holds + sales-order allocations).
"""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone

from modules.inventory import models as m
from modules.inventory import services as svc
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

ZERO = Decimal("0")


def _sum(qs, field="quantity"):
    return qs.aggregate(t=Sum(field))["t"] or ZERO


def _order_allocations(product_id, warehouse_id=None):
    """Sales-order allocations (product level). Imported lazily: inventory must not depend on sales at import time."""
    from modules.sales.models import OrderReservation

    return _sum(OrderReservation.objects.filter(product_id=product_id))


def availability(product_id, warehouse_id=None):
    lv = m.StockLevel.objects.filter(product_id=product_id)
    if warehouse_id:
        lv = lv.filter(location__warehouse_id=warehouse_id)
    on_hand = _sum(lv)
    held = _sum(lv.filter(Q(location__kind="QUARANTINE") | Q(location__is_blocked=True)))
    transit = _sum(lv.filter(location__kind="TRANSIT", location__is_blocked=False))
    hold = m.StockReservation.objects.filter(product_id=product_id, status="ACTIVE")
    if warehouse_id:
        hold = hold.filter(Q(warehouse_id=warehouse_id) | Q(warehouse__isnull=True))
    reserved = _sum(hold)
    allocated = _order_allocations(product_id, warehouse_id) if not warehouse_id else ZERO
    available = max(ZERO, on_hand - held - transit - reserved - allocated)
    f4 = lambda d: str(Decimal(d).quantize(Decimal("0.0001")))  # noqa: E731
    return {"on_hand": f4(on_hand), "quarantined": f4(held), "in_transit": f4(transit), "reserved": f4(reserved), "allocated": f4(allocated), "available": f4(available)}


def _available(product_id, warehouse_id=None):
    return Decimal(availability(product_id, warehouse_id)["available"])


@transaction.atomic
def reserve(actor_id, *, product_id, quantity, warehouse_id=None, ref_type="", ref_id="", note="", expires_on=None):
    try:
        qty = Decimal(str(quantity))
    except Exception:
        raise ValidationFailed("quantity must be a number.", code="invalid_amount")
    if qty <= 0:
        raise ValidationFailed("quantity must be positive.", code="invalid_amount")
    product = svc._product(product_id)
    if not product.is_stocked:
        raise ValidationFailed("Non-stock items cannot be reserved.", code="not_stocked")
    svc._cost_row(product)  # per-product lock serialises concurrent reservations
    if warehouse_id:
        svc._get(m.Warehouse, warehouse_id, "Warehouse")
    avail = _available(product.id, warehouse_id)
    if qty > avail:
        raise DomainError(f"Only {avail} available to reserve.", code="insufficient_available")
    r = m.StockReservation.objects.create(product=product, warehouse_id=warehouse_id, quantity=qty, ref_type=ref_type, ref_id=str(ref_id), note=note[:300], expires_on=expires_on, reserved_by=actor_id)
    record_tenant_event(current_tenant(), "inventory.reservation.created", actor_user_id=actor_id, target_type="StockReservation", target_id=r.id, metadata={"sku": product.sku, "quantity": str(qty)})
    return r


@transaction.atomic
def release(actor_id, reservation_id, *, status="RELEASED"):
    r = m.StockReservation.objects.select_for_update().filter(pk=reservation_id).first()
    if not r:
        raise DomainError("Reservation not found.", code="not_found", status_code=404)
    if r.status != "ACTIVE":
        raise DomainError("Only an active reservation can be released.", code="not_active")
    r.status = status
    r.save(update_fields=["status", "updated_at"])
    return r


def release_by_ref(actor_id, ref_type, ref_id, *, status="CONSUMED"):
    n = 0
    for r in m.StockReservation.objects.filter(ref_type=ref_type, ref_id=str(ref_id), status="ACTIVE"):
        release(actor_id, r.id, status=status)
        n += 1
    return n


def expire_reservations(today=None):
    today = today or timezone.now().date()
    n = 0
    for r in m.StockReservation.objects.filter(status="ACTIVE", expires_on__lt=today):
        release(None, r.id, status="EXPIRED")
        n += 1
    return n


def alerts(today=None):
    """Stock-level, expiry and obsolescence alerts across the catalogue."""
    today = today or timezone.now().date()
    out = []
    for p in m.Product.objects.filter(is_stocked=True).exclude(status="INACTIVE"):
        have = svc.on_hand(p.id)
        base = {"sku": p.sku, "name": p.name, "on_hand": str(have)}
        if have <= 0 and (p.min_stock or p.reorder_level):
            out.append({**base, "alert": "OUT_OF_STOCK"})
        elif p.safety_stock is not None and have < p.safety_stock:
            out.append({**base, "alert": "BELOW_SAFETY", "threshold": str(p.safety_stock)})
        elif p.min_stock is not None and have < p.min_stock:
            out.append({**base, "alert": "BELOW_MINIMUM", "threshold": str(p.min_stock)})
        elif p.reorder_level is not None and have <= p.reorder_level:
            out.append({**base, "alert": "REORDER", "threshold": str(p.reorder_level)})
        if p.max_stock is not None and have > p.max_stock:
            out.append({**base, "alert": "ABOVE_MAXIMUM", "threshold": str(p.max_stock)})
        if p.status == "DISCONTINUED" and have > 0:
            out.append({**base, "alert": "DISCONTINUED_STOCK"})
    soon = today + timedelta(days=30)
    for lv in m.StockLevel.objects.select_related("product", "lot", "location").filter(quantity__gt=0, lot__expiry_date__isnull=False, lot__expiry_date__lte=soon):
        out.append({"sku": lv.product.sku, "name": lv.product.name, "lot": lv.lot.code, "location": lv.location.code, "quantity": str(lv.quantity), "expiry_date": str(lv.lot.expiry_date), "alert": "EXPIRED" if lv.lot.expiry_date < today else "EXPIRING_SOON"})
    return out


def ageing(today=None, buckets=(30, 60, 90)):
    """Age of stock on hand: the on-hand quantity is attributed to the most recent receipts first (so old stock is what remains)."""
    today = today or timezone.now().date()
    names = [f"0-{buckets[0]}"] + [f"{a + 1}-{b}" for a, b in zip(buckets, buckets[1:])] + [f"{buckets[-1]}+"]
    rows = []
    for p in m.Product.objects.filter(is_stocked=True):
        remaining = svc.on_hand(p.id)
        if remaining <= 0:
            continue
        row = {n: ZERO for n in names}
        oldest = None
        for mv in m.StockMovement.objects.filter(product=p, quantity__gt=0, movement_type__in=("RECEIPT", "ADJUSTMENT")).order_by("-created_at"):
            if remaining <= 0:
                break
            take = min(remaining, mv.quantity)
            remaining -= take
            age = (today - mv.created_at.date()).days
            oldest = age if oldest is None else max(oldest, age)
            idx = next((i for i, b in enumerate(buckets) if age <= b), len(buckets))
            row[names[idx]] += take
        if remaining > 0:  # opening stock with no recorded receipt counts as oldest
            row[names[-1]] += remaining
        rows.append({"sku": p.sku, "name": p.name, "buckets": {k: str(v) for k, v in row.items()}, "oldest_days": oldest})
    return rows


def slow_moving(days=90, today=None):
    """Stocked items with stock on hand and no issue within `days` (slow-moving), or never issued (obsolete candidates)."""
    today = today or timezone.now().date()
    since = timezone.now() - timedelta(days=days)
    out = []
    for p in m.Product.objects.filter(is_stocked=True):
        have = svc.on_hand(p.id)
        if have <= 0:
            continue
        last = m.StockMovement.objects.filter(product=p, movement_type="ISSUE").order_by("-created_at").values_list("created_at", flat=True).first()
        if last is None or last < since:
            cost = m.ProductCost.objects.filter(product=p).first()
            out.append({"sku": p.sku, "name": p.name, "on_hand": str(have), "last_issue": None if last is None else str(last.date()), "value": str(cost.total_value) if cost else "0", "classification": "OBSOLETE_CANDIDATE" if p.status == "DISCONTINUED" or last is None else "SLOW_MOVING"})
    return out


def excess(cover_days=180, today=None):
    """Stock above the maximum level, or above `cover_days` of trailing 90-day usage."""
    out = []
    since = timezone.now() - timedelta(days=90)
    for p in m.Product.objects.filter(is_stocked=True):
        have = svc.on_hand(p.id)
        if have <= 0:
            continue
        used = -(m.StockMovement.objects.filter(product=p, movement_type="ISSUE", created_at__gte=since).aggregate(t=Sum("quantity"))["t"] or ZERO)
        daily = used / 90
        reason = None
        if p.max_stock is not None and have > p.max_stock:
            reason = "ABOVE_MAXIMUM"
            excess_qty = have - p.max_stock
        elif daily > 0 and have / daily > cover_days:
            reason = "COVER_EXCEEDED"
            excess_qty = have - daily * cover_days
        if reason:
            out.append({"sku": p.sku, "name": p.name, "on_hand": str(have), "excess_quantity": str(excess_qty.quantize(Decimal("0.0001"))), "reason": reason})
    return out

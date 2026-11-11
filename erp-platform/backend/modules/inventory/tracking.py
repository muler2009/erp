"""Lot status/expiry guards, FEFO/FIFO picking, serial numbers and recall traceability."""
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from modules.inventory import models as m
from shared.api.errors import DomainError, ValidationFailed

ZERO = Decimal("0")
LOT_STATUSES = {"AVAILABLE", "QUARANTINED", "BLOCKED", "RECALLED"}


# ------------------------------------------------------------------ lots
def check_lot_issuable(lot, on_date=None, allow_expired=False):
    if lot is None:
        return
    if lot.status != "AVAILABLE":
        raise DomainError(f"Lot {lot.code} is {lot.status.lower()} and cannot be issued.", code="lot_not_issuable")
    if not allow_expired and lot.expiry_date and lot.expiry_date < (on_date or timezone.now().date()):
        raise DomainError(f"Lot {lot.code} expired on {lot.expiry_date}.", code="lot_expired")


def set_lot_status(actor_id, product_id, lot_code, status, note=""):
    if status not in LOT_STATUSES:
        raise ValidationFailed("Invalid lot status.", code="invalid_lot_status")
    lot = m.Lot.objects.select_for_update().filter(product_id=product_id, code=lot_code).first()
    if not lot:
        raise DomainError("Lot not found.", code="not_found", status_code=404)
    if status != "AVAILABLE" and not (note or "").strip():
        raise ValidationFailed("A note is required when holding a lot.", code="note_required")
    lot.status, lot.status_note = status, note[:300]
    lot.save(update_fields=["status", "status_note", "updated_at"])
    from platform_core.audit.services import record_tenant_event
    from shared.tenancy import current_tenant
    record_tenant_event(current_tenant(), "inventory.lot.status", actor_user_id=actor_id, target_type="Lot", target_id=lot.id, metadata={"lot": lot.code, "status": status})
    return lot


def pick(product_id, warehouse_id, quantity, policy="FEFO"):
    """Allocate `quantity` across lots: FEFO = earliest expiry first, FIFO = oldest lot first. Skips held/expired lots and non-issuable locations."""
    need, picks = Decimal(str(quantity)), []
    today = timezone.now().date()
    qs = m.StockLevel.objects.select_related("lot", "location").filter(product_id=product_id, quantity__gt=0, lot__isnull=False, lot__status="AVAILABLE", location__warehouse_id=warehouse_id, location__is_blocked=False, location__kind__in=("STORAGE",))
    qs = qs.exclude(lot__expiry_date__lt=today)
    order = ("lot__expiry_date", "lot__created_at") if policy == "FEFO" else ("lot__created_at",)
    levels = sorted(qs, key=lambda l: ((l.lot.expiry_date is None, l.lot.expiry_date or today, l.lot.created_at) if policy == "FEFO" else (l.lot.created_at,)))
    for l in levels:
        if need <= 0:
            break
        take = min(need, l.quantity)
        picks.append({"location": str(l.location_id), "lot_code": l.lot.code, "quantity": str(take), "expiry_date": None if not l.lot.expiry_date else str(l.lot.expiry_date)})
        need -= take
    if need > 0:
        raise DomainError(f"Only {Decimal(str(quantity)) - need} issuable from lots in this warehouse.", code="insufficient_stock")
    return picks


@transaction.atomic
def issue_picked(actor_id, *, product_id, warehouse_id, quantity, policy=None, reason="", ref_type="", ref_id="", on_date=None):
    """Issue a lot-tracked product choosing lots automatically (policy defaults to the warehouse's picking policy, else FEFO)."""
    from modules.inventory import services as svc

    wh = svc._get(m.Warehouse, warehouse_id, "Warehouse")
    policy = policy or (wh.policies or {}).get("picking") or "FEFO"
    out = []
    for p in pick(product_id, warehouse_id, quantity, policy):
        out.append(svc.issue_stock(actor_id, product_id=product_id, location_id=p["location"], quantity=p["quantity"], lot_code=p["lot_code"], reason=reason, ref_type=ref_type, ref_id=ref_id, on_date=on_date))
    return out


def expired_stock(today=None):
    today = today or timezone.now().date()
    return [{"sku": l.product.sku, "lot": l.lot.code, "location": l.location.code, "quantity": str(l.quantity), "expiry_date": str(l.lot.expiry_date)} for l in m.StockLevel.objects.select_related("product", "lot", "location").filter(quantity__gt=0, lot__expiry_date__lt=today)]


# ------------------------------------------------------------------ serials
def _clean_serials(serials, qty):
    if not serials or not isinstance(serials, (list, tuple)):
        raise ValidationFailed("This product is serial-tracked: provide the serial numbers.", code="serials_required")
    ser = [str(s).strip() for s in serials]
    if any(not s for s in ser) or len(set(ser)) != len(ser):
        raise ValidationFailed("Serial numbers must be non-empty and unique.", code="invalid_serials")
    if qty != len(ser) or qty != qty.to_integral_value():
        raise ValidationFailed("The quantity must equal the number of serial numbers (whole units).", code="serial_quantity_mismatch")
    return ser


def on_receive(product, loc, qty, serials, ref, warranty_until=None):
    if product.tracking != "SERIAL":
        if serials:
            raise ValidationFailed("This product is not serial-tracked.", code="serials_not_allowed")
        return
    for s in _clean_serials(serials, qty):
        row = m.SerialNumber.objects.filter(product=product, serial=s).first()
        if row and row.status == "IN_STOCK":
            raise DomainError(f"Serial {s} is already in stock.", code="serial_exists")
        if row:  # a returned unit coming back
            row.status, row.location, row.received_ref = "IN_STOCK", loc, ref
            row.save(update_fields=["status", "location", "received_ref", "updated_at"])
        else:
            m.SerialNumber.objects.create(product=product, serial=s, location=loc, received_ref=ref, warranty_until=warranty_until)


def on_issue(product, loc, qty, serials, ref):
    if product.tracking != "SERIAL":
        if serials:
            raise ValidationFailed("This product is not serial-tracked.", code="serials_not_allowed")
        return
    for s in _clean_serials(serials, qty):
        row = m.SerialNumber.objects.select_for_update().filter(product=product, serial=s).first()
        if not row or row.status != "IN_STOCK" or row.location_id != loc.id:
            raise DomainError(f"Serial {s} is not in stock at {loc.code}.", code="serial_not_available")
        row.status, row.location, row.issued_ref = "ISSUED", None, ref
        row.save(update_fields=["status", "location", "issued_ref", "updated_at"])


def on_transfer(product, src, dst, qty, serials):
    if product.tracking != "SERIAL":
        return
    for s in _clean_serials(serials, qty):
        row = m.SerialNumber.objects.select_for_update().filter(product=product, serial=s).first()
        if not row or row.status != "IN_STOCK" or row.location_id != src.id:
            raise DomainError(f"Serial {s} is not in stock at {src.code}.", code="serial_not_available")
        row.location = dst
        row.save(update_fields=["location", "updated_at"])


def reconcile_serials(product_id, location_id, counted_serials):
    """Compare a scanned list against the system for one location (serial items are reconciled by identity, not by quantity)."""
    system = set(m.SerialNumber.objects.filter(product_id=product_id, location_id=location_id, status="IN_STOCK").values_list("serial", flat=True))
    counted = {str(s).strip() for s in counted_serials}
    return {"missing": sorted(system - counted), "unexpected": sorted(counted - system), "matched": len(system & counted)}


def serial_history(product_id, serial):
    row = m.SerialNumber.objects.select_related("location").filter(product_id=product_id, serial=serial).first()
    if not row:
        raise DomainError("Serial number not found.", code="not_found", status_code=404)
    return {"serial": row.serial, "status": row.status, "location": None if not row.location else row.location.code, "received_ref": row.received_ref, "issued_ref": row.issued_ref, "warranty_until": None if not row.warranty_until else str(row.warranty_until)}


# ------------------------------------------------------------------ traceability
def trace_lot(product_id, lot_code):
    """Forward and backward trace for recalls: where the lot came from, where it is now, and every document it left on."""
    lot = m.Lot.objects.filter(product_id=product_id, code=lot_code).first()
    if not lot:
        raise DomainError("Lot not found.", code="not_found", status_code=404)
    moves = m.StockMovement.objects.select_related("location").filter(lot=lot).order_by("created_at")
    return {"lot": lot.code, "status": lot.status, "expiry_date": None if not lot.expiry_date else str(lot.expiry_date),
            "received": [{"ref_type": x.ref_type, "ref_id": x.ref_id, "quantity": str(x.quantity), "location": x.location.code} for x in moves if x.movement_type == "RECEIPT"],
            "on_hand": [{"location": l.location.code, "quantity": str(l.quantity)} for l in m.StockLevel.objects.select_related("location").filter(lot=lot, quantity__gt=0)],
            "issued": [{"ref_type": x.ref_type, "ref_id": x.ref_id, "quantity": str(-x.quantity), "at": x.created_at} for x in moves if x.movement_type == "ISSUE"]}

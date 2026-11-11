"""Inter-warehouse transfer orders with an in-transit stage, partial receipt, and rejection/damage handling."""
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from modules.inventory import models as m
from modules.inventory import services as svc
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")
TRANSIT_CODE, DAMAGED_CODE = "IN-TRANSIT", "DAMAGED"


def _dec(v, name):
    try:
        return Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")


def _order(order_id, lock=False):
    qs = m.TransferOrder.objects.select_for_update(of=("self",)) if lock else m.TransferOrder.objects
    o = qs.select_related("from_warehouse", "to_warehouse").filter(pk=order_id).first()
    if not o:
        raise DomainError("Transfer not found.", code="not_found", status_code=404)
    return o


def _special_location(warehouse, code, kind):
    loc, _ = m.Location.objects.get_or_create(warehouse=warehouse, code=code, defaults={"kind": kind, "name": code.title()})
    return loc


@transaction.atomic
def create(actor_id, *, from_warehouse_id, to_warehouse_id, lines, reason="", expected_date=None):
    src, dst = svc._get(m.Warehouse, from_warehouse_id, "Source warehouse"), svc._get(m.Warehouse, to_warehouse_id, "Destination warehouse")
    if src.pk == dst.pk:
        raise ValidationFailed("Source and destination warehouses must differ.", code="same_warehouse")
    if not lines:
        raise ValidationFailed("A transfer needs at least one line.", code="no_lines")
    o = m.TransferOrder.objects.create(number=sequences.next_number("inventory.transfer", for_type="TransferOrder"), from_warehouse=src, to_warehouse=dst, reason=reason[:300], expected_date=expected_date, requested_by=actor_id)
    for ln in lines:
        product, loc = svc._product(ln.get("product")), svc._location(ln.get("from_location"))
        qty = _dec(ln.get("quantity"), "quantity")
        if qty <= 0:
            raise ValidationFailed("Line quantity must be positive.", code="invalid_amount")
        if loc.warehouse_id != src.pk:
            raise ValidationFailed("A line's source location must belong to the source warehouse.", code="wrong_warehouse")
        if not product.is_stocked:
            raise ValidationFailed("Non-stock items cannot be transferred.", code="not_stocked")
        m.TransferLine.objects.create(order=o, product=product, from_location=loc, lot_code=ln.get("lot_code") or "", quantity=qty)
    return o


@transaction.atomic
def submit(actor_id, order_id):
    o = _order(order_id, lock=True)
    if o.status != "DRAFT":
        raise DomainError("Only a draft transfer can be submitted.", code="invalid_state")
    o.status = "REQUESTED"
    o.save(update_fields=["status", "updated_at"])
    return o


@transaction.atomic
def approve(actor_id, order_id, *, note=""):
    o = _order(order_id, lock=True)
    if o.status != "REQUESTED":
        raise DomainError("Only a requested transfer can be approved.", code="invalid_state")
    if o.requested_by and o.requested_by == actor_id:
        raise DomainError("You cannot approve your own transfer request.", code="self_approval", status_code=403)
    o.status, o.approved_by, o.decision_note = "APPROVED", actor_id, note[:300]
    o.save(update_fields=["status", "approved_by", "decision_note", "updated_at"])
    record_tenant_event(current_tenant(), "inventory.transfer.approved", actor_user_id=actor_id, target_type="TransferOrder", target_id=o.id, metadata={"number": o.number})
    return o


@transaction.atomic
def reject(actor_id, order_id, *, note):
    o = _order(order_id, lock=True)
    if o.status != "REQUESTED":
        raise DomainError("Only a requested transfer can be rejected.", code="invalid_state")
    if not (note or "").strip():
        raise ValidationFailed("A reason is required to reject a transfer.", code="note_required")
    o.status, o.decision_note = "REJECTED", note[:300]
    o.save(update_fields=["status", "decision_note", "updated_at"])
    if o.requested_by:
        notify([o.requested_by], "inventory.transfer.rejected", f"Transfer {o.number} rejected", note, ref_type="inventory.transfer", ref_id=str(o.id))
    return o


@transaction.atomic
def cancel(actor_id, order_id):
    o = _order(order_id, lock=True)
    if o.status not in ("DRAFT", "REQUESTED", "APPROVED"):
        raise DomainError("Goods already dispatched: receive or return them instead of cancelling.", code="invalid_state")
    o.status = "CANCELLED"
    o.save(update_fields=["status", "updated_at"])
    return o


@transaction.atomic
def dispatch(actor_id, order_id, *, carrier=""):
    o = _order(order_id, lock=True)
    if o.status != "APPROVED":
        raise DomainError("Only an approved transfer can be dispatched.", code="invalid_state")
    transit = _special_location(o.to_warehouse, TRANSIT_CODE, "TRANSIT")
    for ln in o.lines.select_related("product"):
        svc.transfer_stock(actor_id, product_id=ln.product_id, from_location_id=ln.from_location_id, to_location_id=transit.id, quantity=ln.quantity, lot_code=ln.lot_code or None, reason=f"Transfer {o.number} dispatched")
        ln.dispatched_quantity = ln.quantity
        ln.save(update_fields=["dispatched_quantity"])
    o.status, o.dispatched_at, o.carrier = "IN_TRANSIT", timezone.now(), carrier[:120]
    o.save(update_fields=["status", "dispatched_at", "carrier", "updated_at"])
    record_tenant_event(current_tenant(), "inventory.transfer.dispatched", actor_user_id=actor_id, target_type="TransferOrder", target_id=o.id, metadata={"number": o.number})
    return o


@transaction.atomic
def receive(actor_id, order_id, receipts):
    """receipts: [{line, accepted, rejected, damaged, to_location}]. Accepted stock goes to `to_location`, rejected goes back to the
    line's source location, damaged goes to the destination's DAMAGED quarantine location."""
    o = _order(order_id, lock=True)
    if o.status not in ("IN_TRANSIT", "PARTIALLY_RECEIVED"):
        raise DomainError("This transfer is not in transit.", code="invalid_state")
    transit = _special_location(o.to_warehouse, TRANSIT_CODE, "TRANSIT")
    lines = {str(l.id): l for l in o.lines.select_for_update().select_related("product")}
    for r in receipts:
        ln = lines.get(str(r.get("line")))
        if ln is None:
            raise ValidationFailed("Unknown transfer line.", code="unknown_line")
        acc, rej, dam = (_dec(r.get(k, 0) or 0, k) for k in ("accepted", "rejected", "damaged"))
        if min(acc, rej, dam) < 0 or acc + rej + dam <= 0:
            raise ValidationFailed("Quantities must be non-negative and not all zero.", code="invalid_amount")
        outstanding = ln.dispatched_quantity - ln.received_quantity - ln.rejected_quantity - ln.damaged_quantity
        if acc + rej + dam > outstanding:
            raise DomainError(f"Only {outstanding} still in transit for this line.", code="over_receipt")
        common = dict(product_id=ln.product_id, from_location_id=transit.id, lot_code=ln.lot_code or None)
        if acc:
            dest = svc._location(r.get("to_location"))
            if dest.warehouse_id != o.to_warehouse_id:
                raise ValidationFailed("Accepted stock must go to a location of the destination warehouse.", code="wrong_warehouse")
            svc.transfer_stock(actor_id, to_location_id=dest.id, quantity=acc, reason=f"Transfer {o.number} received", **common)
        if dam:
            svc.transfer_stock(actor_id, to_location_id=_special_location(o.to_warehouse, DAMAGED_CODE, "QUARANTINE").id, quantity=dam, reason=f"Transfer {o.number} received damaged", **common)
        if rej:
            svc.transfer_stock(actor_id, to_location_id=ln.from_location_id, quantity=rej, reason=f"Transfer {o.number} rejected at destination", **common)
        ln.received_quantity += acc
        ln.rejected_quantity += rej
        ln.damaged_quantity += dam
        ln.save(update_fields=["received_quantity", "rejected_quantity", "damaged_quantity"])
    done = all(l.dispatched_quantity == l.received_quantity + l.rejected_quantity + l.damaged_quantity for l in lines.values())
    o.status = "RECEIVED" if done else "PARTIALLY_RECEIVED"
    o.save(update_fields=["status", "updated_at"])
    if o.requested_by:
        notify([o.requested_by], "inventory.transfer.received", f"Transfer {o.number} {o.status.lower().replace('_', ' ')}", "", ref_type="inventory.transfer", ref_id=str(o.id))
    return o


def note(order_id):
    """Printable transfer note."""
    o = _order(order_id)
    return {"id": str(o.id), "number": o.number, "status": o.status, "from": o.from_warehouse.code, "to": o.to_warehouse.code, "reason": o.reason, "carrier": o.carrier, "expected_date": None if not o.expected_date else str(o.expected_date), "requested_by": None if not o.requested_by else str(o.requested_by), "approved_by": None if not o.approved_by else str(o.approved_by),
            "lines": [{"id": str(l.id), "sku": l.product.sku, "name": l.product.name, "from_location": l.from_location.code, "lot": l.lot_code, "quantity": str(l.quantity), "dispatched": str(l.dispatched_quantity), "received": str(l.received_quantity), "rejected": str(l.rejected_quantity), "damaged": str(l.damaged_quantity)} for l in o.lines.select_related("product", "from_location")]}

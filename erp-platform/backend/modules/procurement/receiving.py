"""Receiving: over-receipt tolerance, inspection (accept / reject / quarantine), evidence and receipt queries."""
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from modules.inventory import models as im
from modules.inventory import services as inventory
from modules.procurement import models as m
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.tenancy import current_tenant

ZERO = Decimal("0")


def _dec(v, name="quantity"):
    try:
        return Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")


def over_receipt_percent():
    from platform_core.organizations import services as org

    return Decimal(str(org.get_setting("procurement.over_receipt_percent", 0))) / 100


def check_over_receipt(line, qty, approved):
    """Returns the part of `qty` that exceeds the ordered quantity (0 if none). Within tolerance an explicit approval is required."""
    if qty <= 0:
        raise ValidationFailed("quantity must be positive.", code="invalid_amount")
    new_total = line.received_quantity + qty
    if new_total <= line.quantity:
        return ZERO
    if new_total > line.quantity * (1 + over_receipt_percent()):
        raise ValidationFailed(f"Line {line.line_no}: receiving {qty} exceeds the ordered quantity ({max(line.quantity - line.received_quantity, ZERO)} still open) beyond the allowed over-receipt tolerance.", code="over_receipt")
    if not approved:
        raise DomainError(f"Line {line.line_no}: {new_total - line.quantity} over the ordered quantity is within tolerance but needs over-receipt approval.", code="over_receipt_needs_approval", status_code=403)
    return max(new_total - line.quantity, ZERO) - max(line.received_quantity - line.quantity, ZERO)


def quarantine_for(location):
    q = im.Location.objects.filter(warehouse_id=location.warehouse_id, kind="QUARANTINE", is_blocked=False, is_active=True).order_by("code").first()
    if q is None:
        raise ValidationFailed("This warehouse has no quarantine location to hold goods for inspection.", code="no_quarantine_location")
    return q


def _refresh_order_status(order):
    lines = list(m.PurchaseOrderLine.objects.filter(order=order))
    if all(l.received_quantity >= l.quantity for l in lines):
        status = "RECEIVED"
    elif any(l.received_quantity > 0 for l in lines):
        status = "PARTIALLY_RECEIVED"
    else:
        status = "APPROVED"
    if order.status != status and order.status in ("APPROVED", "PARTIALLY_RECEIVED", "RECEIVED"):
        order.status = status
        order.save(update_fields=["status", "updated_at"])


@transaction.atomic
def inspect_line(actor_id, receipt_line_id, *, accept="0", reject="0", note="", serials=None):
    """Release inspected goods from quarantine to their destination (accept) or send them back to the supplier (reject).
    Rejected goods leave stock, reverse the goods-received accrual and re-open the quantity on the purchase order."""
    line = m.GoodsReceiptLine.objects.select_for_update(of=("self",)).filter(pk=receipt_line_id).select_related("po_line__product", "receipt__order", "quarantine_location", "destination").first()
    if line is None:
        raise DomainError("Receipt line not found.", code="not_found", status_code=404)
    if line.inspection_status not in ("PENDING", "PARTIAL"):
        raise DomainError("This line is not awaiting inspection.", code="invalid_state")
    acc, rej = _dec(accept, "accept"), _dec(reject, "reject")
    if acc < 0 or rej < 0 or acc + rej <= 0:
        raise ValidationFailed("Accept and/or reject a positive quantity.", code="invalid_amount")
    open_qty = line.quantity - line.accepted_quantity - line.rejected_quantity
    if acc + rej > open_qty:
        raise ValidationFailed(f"Only {open_qty} is still awaiting inspection.", code="over_inspection")
    if rej > 0 and not (note or "").strip():
        raise ValidationFailed("A reason is required to reject goods.", code="reason_required")
    if serials and acc and rej:
        raise ValidationFailed("Inspect serial-numbered goods in separate accept and reject steps.", code="serials_ambiguous")
    po_line, receipt = line.po_line, line.receipt
    ref = receipt.number
    if acc > 0:
        inventory.transfer_stock(actor_id, product_id=po_line.product_id, from_location_id=line.quarantine_location_id, to_location_id=line.destination_id, quantity=acc, lot_code=line.lot_code or None, reason=f"Inspection accepted {ref}", serials=serials if not rej else None)
    if rej > 0:
        inventory.issue_stock(actor_id, product_id=po_line.product_id, location_id=line.quarantine_location_id, quantity=rej, lot_code=line.lot_code or None, reason=f"Inspection rejected {ref}: {note[:100]}", ref_type="goods_rejection", ref_id=ref, on_date=timezone.now().date(), serials=serials if not acc else None, allow_expired=True, counter="grni", from_quarantine=True)
        locked = m.PurchaseOrderLine.objects.select_for_update().get(pk=po_line.pk)
        locked.received_quantity -= rej
        locked.save(update_fields=["received_quantity"])
        order = m.PurchaseOrder.objects.select_for_update().get(pk=receipt.order_id)
        _refresh_order_status(order)
    line.accepted_quantity += acc
    line.rejected_quantity += rej
    done = line.accepted_quantity + line.rejected_quantity >= line.quantity
    line.inspection_status = ("REJECTED" if line.accepted_quantity == 0 else "ACCEPTED") if done else "PARTIAL"
    line.inspected_by, line.inspected_at = actor_id, timezone.now()
    line.inspection_note = ((line.inspection_note + " | " if line.inspection_note else "") + note)[:300]
    line.save()
    record_tenant_event(current_tenant(), "procurement.goods_inspected", actor_user_id=actor_id, target_type="GoodsReceiptLine", target_id=line.id, metadata={"receipt": ref, "accepted": str(acc), "rejected": str(rej)})
    if rej > 0:
        from platform_core.authorization.models import RoleAssignment

        ids = list(RoleAssignment.objects.filter(role__name="procurement_manager").values_list("user_id", flat=True).distinct())
        if ids:
            notify(ids, "procurement.goods_rejected", f"Goods rejected on {ref}", f"{rej} rejected: {note[:120]}", ref_type="procurement.receipt", ref_id=str(receipt.id))
    return line


def pending_inspections():
    return [{"line": str(l.id), "receipt": l.receipt.number, "po": l.receipt.order.number, "product": l.po_line.product.sku if l.po_line.product else "", "quantity": str(l.quantity), "open": str(l.quantity - l.accepted_quantity - l.rejected_quantity), "quarantine": l.quarantine_location.code if l.quarantine_location else ""}
            for l in m.GoodsReceiptLine.objects.filter(inspection_status__in=("PENDING", "PARTIAL")).select_related("receipt__order", "po_line__product", "quarantine_location").order_by("receipt__receipt_date")]


def receipt_view(r):
    return {"id": str(r.id), "number": r.number, "po": r.order.number, "kind": r.kind, "receipt_date": str(r.receipt_date), "delivery_note": r.delivery_note, "notes": r.notes,
            "lines": [{"id": str(l.id), "po_line": str(l.po_line_id), "quantity": str(l.quantity), "over_quantity": str(l.over_quantity), "inspection_status": l.inspection_status, "accepted": str(l.accepted_quantity), "rejected": str(l.rejected_quantity), "lot_code": l.lot_code} for l in r.lines.all()]}


def attach_evidence(actor_id, receipt_id, filename, data):
    from shared.files import services as files

    r = m.GoodsReceipt.objects.filter(pk=receipt_id).first()
    if r is None:
        raise DomainError("Receipt not found.", code="not_found", status_code=404)
    return files.upload(actor_id, filename, data, ref_type="procurement.receipt", ref_id=str(r.id))


def can_read_evidence(user_id, ref_id):
    from platform_core.authorization import services as authz

    return bool(m.GoodsReceipt.objects.filter(pk=ref_id).exists() and (authz.has_permission(user_id, "procurement.view") or authz.has_permission(user_id, "inventory.goods.receive")))

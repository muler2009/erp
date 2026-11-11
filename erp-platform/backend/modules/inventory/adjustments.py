"""Stock adjustments with a value threshold above which a second person must approve, plus evidence attachments."""
from decimal import Decimal

from django.db import transaction

from modules.inventory import models as m
from modules.inventory import services as svc
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences

REASONS = {"DAMAGE", "LOSS", "THEFT", "FOUND", "EXPIRY", "COUNT", "OTHER"}
KEY = "adjustment_threshold"


def get_threshold():
    row = m.InventorySetting.objects.filter(key=KEY).first()
    v = (row.value or {}).get("amount") if row else None
    return None if v in (None, "") else Decimal(str(v))


def set_threshold(actor_id, amount):
    if amount in (None, ""):
        m.InventorySetting.objects.filter(key=KEY).delete()
        return None
    amt = svc._dec(amount, "amount")
    if amt < 0:
        raise ValidationFailed("The threshold cannot be negative.", code="invalid_amount")
    m.InventorySetting.objects.update_or_create(key=KEY, defaults={"value": {"amount": str(amt)}})
    return amt


def _estimate(change, unit_cost, cost):
    each = svc._dec(unit_cost, "unit_cost") if (unit_cost is not None and change > 0) else cost.average
    return abs(change) * each


def enforce_threshold(change, unit_cost, cost):
    t = get_threshold()
    if t is not None and _estimate(change, unit_cost, cost) > t:
        raise DomainError("This adjustment exceeds the approval threshold: submit an adjustment request for approval.", code="approval_required")


@transaction.atomic
def request(actor_id, *, product_id, location_id, delta=None, counted_quantity=None, lot_code=None, unit_cost=None, reason_code="OTHER", reason):
    """Post immediately when the value is within the threshold; otherwise queue it as PENDING."""
    if reason_code not in REASONS:
        raise ValidationFailed("Invalid reason code.", code="invalid_reason_code")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required for stock adjustments.", code="reason_required")
    if (delta is None) == (counted_quantity is None):
        raise ValidationFailed("Provide exactly one of delta or counted_quantity.", code="invalid_amount")
    product, loc = svc._product(product_id), svc._location(location_id)
    lot = svc._lot(product, lot_code, create=False) if product.tracking == "LOT" and lot_code else None
    cost = svc._cost_row(product)
    if delta is None:
        have = sum((l.quantity for l in m.StockLevel.objects.filter(product=product, location=loc, lot=lot)), Decimal("0"))
        change = svc._dec(counted_quantity, "counted_quantity") - have
    else:
        change = svc._dec(delta, "delta")
    if change == 0:
        raise DomainError("Nothing to adjust.", code="no_difference")
    est = _estimate(change, unit_cost, cost)
    t = get_threshold()
    req = m.AdjustmentRequest.objects.create(number=sequences.next_number("inventory.adjustment", for_type="AdjustmentRequest"), product=product, location=loc, lot_code=lot_code or "", delta=change, unit_cost=None if unit_cost is None else svc._dec(unit_cost, "unit_cost"), estimated_value=est, reason_code=reason_code, reason=reason[:300], requested_by=actor_id)
    if t is None or est <= t:
        _post(actor_id, req)
    else:
        from platform_core.authorization.models import RoleAssignment
        ids = [i for i in RoleAssignment.objects.filter(role__name="inventory_manager").values_list("user_id", flat=True).distinct() if i != actor_id]
        if ids:
            notify(ids, "inventory.adjustment.pending", f"Adjustment {req.number} awaits approval", f"{product.sku} {change}", ref_type="inventory.adjustment", ref_id=str(req.id))
    return req


def _post(actor_id, req):
    mv = svc.adjust_stock(actor_id, product_id=req.product_id, location_id=req.location_id, delta=req.delta, lot_code=req.lot_code or None, unit_cost=req.unit_cost, reason=f"[{req.reason_code}] {req.reason} ({req.number})", approved=True)
    req.status, req.movement_id, req.decided_by = "POSTED", mv.id, actor_id
    req.save(update_fields=["status", "movement_id", "decided_by", "updated_at"])


@transaction.atomic
def approve(actor_id, request_id, *, note=""):
    req = m.AdjustmentRequest.objects.select_for_update().filter(pk=request_id).first()
    if not req:
        raise DomainError("Adjustment request not found.", code="not_found", status_code=404)
    if req.status != "PENDING":
        raise DomainError("This request has already been decided.", code="invalid_state")
    if req.requested_by == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own adjustment.", code="separation_of_duties", status_code=403)
    req.decision_note = note[:300]
    _post(actor_id, req)
    return req


@transaction.atomic
def reject(actor_id, request_id, *, note):
    req = m.AdjustmentRequest.objects.select_for_update().filter(pk=request_id).first()
    if not req:
        raise DomainError("Adjustment request not found.", code="not_found", status_code=404)
    if req.status != "PENDING":
        raise DomainError("This request has already been decided.", code="invalid_state")
    if not (note or "").strip():
        raise ValidationFailed("A reason is required.", code="note_required")
    req.status, req.decided_by, req.decision_note = "REJECTED", actor_id, note[:300]
    req.save(update_fields=["status", "decided_by", "decision_note", "updated_at"])
    return req


def attach_evidence(actor_id, request_id, filename, data):
    from shared.files import services as files

    req = m.AdjustmentRequest.objects.filter(pk=request_id).first()
    if not req:
        raise DomainError("Adjustment request not found.", code="not_found", status_code=404)
    return files.upload(actor_id, filename, data, ref_type="inventory.adjustment", ref_id=str(req.id))


def _can_read_evidence(user_id, ref_id):
    from platform_core.authorization import services as authz

    return authz.has_permission(user_id, "inventory.stock.adjust") or authz.has_permission(user_id, "inventory.adjustment.approve")


def serialize(r):
    return {"id": str(r.id), "number": r.number, "sku": r.product.sku, "location": r.location.code, "delta": str(r.delta), "estimated_value": str(r.estimated_value), "reason_code": r.reason_code, "reason": r.reason, "status": r.status, "requested_by": None if not r.requested_by else str(r.requested_by), "decided_by": None if not r.decided_by else str(r.decided_by)}

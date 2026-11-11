"""Quality holds. A held product or lot cannot leave stock; only a user with quality.hold.release may lift the hold."""
from django.db import transaction
from django.utils import timezone

from modules.quality import core, models as m
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.notifications.services import notify

DISPOSITIONS = ("ACCEPT", "REJECT", "REWORK", "REPAIR", "SCRAP", "CONDITIONAL")


def guard_stock(product, lot, purpose):
    """Inventory calls this before any issue or transfer. A hold on the whole product or on this lot blocks the movement."""
    qs = m.Hold.objects.filter(product_id=product.id, status="ACTIVE")
    code = getattr(lot, "code", "") if lot is not None else ""
    for h in qs:
        if not h.lot_number or (code and h.lot_number == code):
            raise DomainError(f"Stock is on quality hold {h.number}: {h.reason[:120]}", code="quality_hold", status_code=409)


def hold_dict(h):
    return {"id": str(h.id), "number": h.number, "product_id": str(h.product_id), "lot_number": h.lot_number, "quantity": str(h.quantity), "reason": h.reason,
            "source_type": h.source_type, "source_id": str(h.source_id) if h.source_id else None, "status": h.status, "placed_by": str(h.placed_by),
            "released_by": str(h.released_by) if h.released_by else None, "released_at": h.released_at.isoformat() if h.released_at else None,
            "disposition": h.disposition, "disposition_note": h.disposition_note, "reinspection_id": str(h.reinspection_id) if h.reinspection_id else None,
            "created_at": h.created_at.isoformat()}


@transaction.atomic
def place_hold(actor, *, product_id, reason, lot_number="", quantity=0, source_type="", source_id=None):
    from modules.inventory.models import Product
    if not reason:
        raise ValidationFailed("Give the reason for the hold.", code="invalid_fields")
    if not Product.objects.filter(pk=product_id).exists():
        raise core.nf("Product")
    dup = m.Hold.objects.filter(product_id=product_id, lot_number=lot_number, status="ACTIVE", source_type=source_type, source_id=source_id).first()
    if dup:
        return dup
    h = m.Hold.objects.create(number=core.number("quality.hold"), product_id=product_id, lot_number=lot_number, quantity=quantity or 0, reason=reason[:500],
                              source_type=source_type, source_id=source_id, placed_by=actor)
    core.event("hold", h.id, "PLACED", actor, to_status="ACTIVE", note=reason)
    events.emit("quality.hold.placed", {"hold": str(h.id), "product": str(product_id), "lot": lot_number}, dedup_key=f"hold-placed:{h.id}")
    notify(list(core.users_with_permission("quality.hold.release") - {actor}), "quality.hold_placed", f"Quality hold {h.number}", reason[:200], ref_type="quality.hold", ref_id=str(h.id))
    return h


def _hold(pk):
    return core.lock(m.Hold, pk, "Hold")


@transaction.atomic
def decide_disposition(actor, hold_id, *, disposition, note=""):
    """Record what is to be done with held goods. Accept or conditional use needs the release permission."""
    h = _hold(hold_id)
    if h.status != "ACTIVE":
        raise core.bad_state("The hold is no longer active.")
    if disposition not in DISPOSITIONS:
        raise ValidationFailed("Unknown disposition.", code="invalid_fields")
    if h.placed_by == actor and disposition in ("ACCEPT", "CONDITIONAL"):
        raise DomainError("The person who placed the hold cannot accept the goods.", code="separation_of_duties", status_code=403)
    if not note:
        raise ValidationFailed("Give the justification.", code="invalid_fields")
    h.disposition, h.disposition_by, h.disposition_note, h.disposition_at = disposition, actor, note[:500], timezone.now()
    h.save(update_fields=["disposition", "disposition_by", "disposition_note", "disposition_at", "updated_at"])
    core.event("hold", h.id, "DISPOSITION", actor, note=f"{disposition}: {note}")
    return h


@transaction.atomic
def release_hold(actor, hold_id, *, note=""):
    h = _hold(hold_id)
    if h.status != "ACTIVE":
        raise core.bad_state("The hold is no longer active.")
    if not note:
        raise ValidationFailed("Give a reason for releasing the stock.", code="invalid_fields")
    if h.placed_by == actor:
        raise DomainError("The person who placed the hold cannot release it.", code="separation_of_duties", status_code=403)
    if h.disposition not in ("ACCEPT", "CONDITIONAL", "REWORK", "REPAIR"):
        raise DomainError("Record an accepting disposition (accept, conditional, rework or repair) before releasing.", code="disposition_required", status_code=409)
    if h.reinspection_id:
        from modules.quality.inspections import is_passed
        if not is_passed(h.reinspection_id) and h.disposition in ("ACCEPT",):
            raise DomainError("The re-inspection of these goods has not passed.", code="reinspection_not_passed", status_code=409)
    h.status, h.released_by, h.released_at, h.release_note = "RELEASED", actor, timezone.now(), note[:500]
    h.save(update_fields=["status", "released_by", "released_at", "release_note", "updated_at"])
    core.event("hold", h.id, "RELEASED", actor, from_status="ACTIVE", to_status="RELEASED", note=note)
    events.emit("quality.hold.released", {"hold": str(h.id), "product": str(h.product_id), "lot": h.lot_number}, dedup_key=f"hold-released:{h.id}")
    core.audit("quality.hold.released", actor, "quality.hold", h.id, product=h.product_id)
    return h


@transaction.atomic
def reject_hold(actor, hold_id, *, note=""):
    """The goods are not released: the hold stays as the permanent record and the goods are dispositioned REJECT, SCRAP or returned."""
    h = _hold(hold_id)
    if h.status != "ACTIVE":
        raise core.bad_state("The hold is no longer active.")
    if h.disposition not in ("REJECT", "SCRAP"):
        raise DomainError("Record a reject or scrap disposition first.", code="disposition_required", status_code=409)
    h.status = "REJECTED"
    h.release_note = note[:500]
    h.save(update_fields=["status", "release_note", "updated_at"])
    core.event("hold", h.id, "REJECTED", actor, from_status="ACTIVE", to_status="REJECTED", note=note)
    return h


def list_holds(status=None, product_id=None):
    qs = m.Hold.objects.all().order_by("-created_at")
    if status:
        qs = qs.filter(status=status)
    if product_id:
        qs = qs.filter(product_id=product_id)
    return qs


def get_hold(pk):
    h = m.Hold.objects.filter(pk=pk).first()
    if h is None:
        raise core.nf("Hold")
    d = hold_dict(h)
    d["history"] = core.history("hold", h.id)
    return d

"""Shop-floor detail: pause/resume with interruptions, supervisor approval, by-products and recovered material, quality hold and
disposition of finished goods, rework orders, downtime and maintenance requests."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from modules.finance import services as finance
from modules.inventory import models as im
from modules.inventory import services as inv
from modules.manufacturing import models as m
from modules.manufacturing import orders as od
from modules.manufacturing.bom import audit, dec, q4
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify

ZERO = Decimal("0")
REF = od.REF


# ----------------------------------------------------------------------------- pause / resume / approve
@transaction.atomic
def pause_operation(actor, pk, op_id, *, reason):
    o = od._lock(pk)
    od._active(o)
    op = od._op(o, op_id)
    if op.status != "IN_PROGRESS" or op.is_paused:
        raise DomainError("Only a running operation can be paused.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    op.is_paused = True
    op.save(update_fields=["is_paused"])
    return m.Interruption.objects.create(operation=op, reason=reason[:300])


@transaction.atomic
def resume_operation(actor, pk, op_id):
    o = od._lock(pk)
    od._active(o)
    op = od._op(o, op_id)
    it = op.interruptions.filter(ended_at__isnull=True).first()
    if not op.is_paused or it is None:
        raise DomainError("The operation is not paused.", code="invalid_state_transition")
    it.ended_at = timezone.now()
    it.save(update_fields=["ended_at"])
    op.is_paused = False
    op.save(update_fields=["is_paused"])
    return op


@transaction.atomic
def approve_operation(actor, pk, op_id):
    """Supervisor sign-off of a completed operation; cannot be the person who completed it."""
    o = od._lock(pk)
    op = od._op(o, op_id)
    if op.status != "DONE":
        raise DomainError("Only a completed operation can be approved.", code="invalid_state_transition")
    if op.approved_by:
        raise DomainError("Already approved.", code="invalid_state_transition")
    if op.completed_by == actor or op.operator_id == actor:
        raise DomainError("The operator or completer cannot approve the operation.", code="separation_of_duties", status_code=403)
    op.approved_by = actor
    op.save(update_fields=["approved_by"])
    audit("manufacturing.order.operation_approved", actor, "ProductionOrder", o.id, sequence=op.sequence)
    return op


# ----------------------------------------------------------------------------- by-products and recovered material
@transaction.atomic
def record_byproduct(actor, pk, *, product_id, quantity, unit_cost=0, kind="BYPRODUCT", decision="REUSE", lot_code=None):
    """Receive a by-product (or recovered material) into stock at the given value, taking that value out of the order's WIP."""
    o = od._lock(pk)
    od._active(o)
    qty, cost = dec(quantity), dec(unit_cost, "unit_cost")
    if qty <= 0 or cost < 0 or kind not in ("BYPRODUCT", "RECOVERED") or decision not in ("REUSE", "RECYCLE", "DISPOSE"):
        raise ValidationFailed("A positive quantity, non-negative cost, valid kind and decision are required.", code="invalid_fields")
    if not im.Product.objects.filter(pk=product_id, is_active=True).exists():
        raise ValidationFailed("Unknown product.", code="invalid_product")
    if decision != "DISPOSE":
        inv.receive_stock(actor, product_id=product_id, location_id=o.location_id, quantity=qty, unit_cost=cost, lot_code=lot_code, reason=f"{kind.title()} from {o.number}", ref_type=REF, ref_id=str(o.id), counter="wip")
        o.received_value += q4(qty * cost)
        o.save(update_fields=["received_value", "updated_at"])
    return m.ByproductRecord.objects.create(order=o, product_id=product_id, kind=kind, quantity=qty, unit_cost=cost, decision=decision, recorded_by=actor)


# ----------------------------------------------------------------------------- quality hold and disposition
@transaction.atomic
def dispose_receipt(actor, receipt_id, *, decision, note="", release_location_id=None):
    """Decide what happens to goods on quality hold. RELEASE moves them to available stock, SCRAP writes them off,
    REWORK opens a rework order. Must be someone other than the person who received them."""
    rec = m.ProductionReceipt.objects.select_for_update().filter(pk=receipt_id).first()
    if rec is None:
        raise DomainError("Receipt not found.", code="not_found", status_code=404)
    if rec.status != "ON_HOLD":
        raise DomainError("Only goods on quality hold need a disposition.", code="invalid_state_transition")
    if decision not in ("RELEASE", "SCRAP", "REWORK") or not (note or "").strip():
        raise ValidationFailed("decision (RELEASE / SCRAP / REWORK) and a note are required.", code="invalid_fields")
    if rec.received_by == actor:
        raise DomainError("The person who received the goods cannot approve their disposition.", code="separation_of_duties", status_code=403)
    o = rec.order
    lot = rec.lot_code or None
    if decision == "RELEASE":
        dest = im.Location.objects.filter(pk=release_location_id).first() if release_location_id else o.location
        if dest is None or dest.kind in ("QUARANTINE", "TRANSIT"):
            raise ValidationFailed("Choose a normal storage location to release into.", code="invalid_location")
        inv.transfer_stock(actor, product_id=o.product_id, from_location_id=rec.location_id, to_location_id=dest.id, quantity=rec.quantity, lot_code=lot, reason=f"Quality release {o.number}")
        rec.status, rec.location = "RELEASED", dest
    elif decision == "SCRAP":
        inv.issue_stock(actor, product_id=o.product_id, location_id=rec.location_id, quantity=rec.quantity, lot_code=lot, reason=f"Quality scrap {o.number}", ref_type=REF, ref_id=str(o.id), counter="scrap_loss", from_quarantine=True)
        rec.status = "SCRAPPED"
        o.scrapped_quantity += rec.quantity
        o.produced_quantity -= rec.quantity
        o.save(update_fields=["scrapped_quantity", "produced_quantity", "updated_at"])
        m.ScrapRecord.objects.create(order=o, product=o.product, kind="OUTPUT", quantity=rec.quantity, cost=q4(rec.quantity * rec.unit_cost), reason=f"Rejected at quality hold: {note}"[:300], reported_by=actor)
        # the goods were credited to WIP at standard cost when received; the write-off above debited scrap loss directly, so WIP stays balanced
    else:
        rec.status = "REWORK"
        rec.disposition_note = note[:300]
        rec.disposition_by = actor
        rec.save()
        return create_rework(actor, rec.id, note=note)
    rec.disposition_by, rec.disposition_note = actor, note[:300]
    rec.save()
    audit("manufacturing.order.disposition", actor, "ProductionOrder", o.id, decision=decision, quantity=rec.quantity)
    return rec


@transaction.atomic
def create_rework(actor, receipt_id, *, note=""):
    rec = m.ProductionReceipt.objects.select_for_update().filter(pk=receipt_id).first()
    o = rec.order
    today = timezone.now().date()
    ro = od.m.ProductionOrder(number=od.sequences.next_number(REF, on_date=today, for_type="Production order"), product=o.product, bom=o.bom, quantity=rec.quantity, location=o.location, planned_start=today, planned_end=today,
                              created_by=actor, status="RELEASED", released_by=actor, rework_of=o, rework_receipt_id=rec.id, instructions=f"Rework: {note}"[:1000], priority=1)
    ro.save()
    audit("manufacturing.order.rework_created", actor, "ProductionOrder", ro.id, source=o.number)
    return ro


@transaction.atomic
def book_time(actor, pk, *, work_center_id, hours):
    """Labour and machine time on a rework order (ordinary orders book time through their operations)."""
    o = od._lock(pk)
    od._active(o)
    if not o.rework_of_id:
        raise DomainError("Time is booked through operations on ordinary orders.", code="not_rework")
    wc = m.WorkCenter.objects.filter(pk=work_center_id, is_active=True).first()
    h = dec(hours, "hours")
    if wc is None or h <= 0:
        raise ValidationFailed("An active work center and positive hours are required.", code="invalid_fields")
    cost = q4(h * wc.hourly_cost)
    finance.post_system_journal(actor, timezone.now().date(), f"Rework time {o.number}", "manufacturing", f"mo:{o.id}:t{o.operations.count() + 1}", [("wip", "debit", cost), ("production_absorbed", "credit", cost)])
    o.conversion_cost += cost
    o.status = "IN_PROGRESS"
    o.save()
    m.Operation.objects.create(order=o, sequence=o.operations.count() + 1, name="Rework", work_center=wc, planned_hours=h, actual_hours=h, status="DONE", absorbed_cost=cost, labor_cost=q4(h * wc.labor_rate), machine_cost=q4(h * wc.machine_rate), overhead_cost=q4(h * wc.overhead_rate), completed_by=actor)
    return o


@transaction.atomic
def finish_rework(actor, pk):
    """Rework cost is a quality cost: it is expensed to Scrap Loss, and the reworked goods are released to available stock."""
    o = od._lock(pk)
    od._active(o)
    if not o.rework_of_id:
        raise DomainError("This is not a rework order.", code="not_rework")
    rec = m.ProductionReceipt.objects.select_for_update().get(pk=o.rework_receipt_id)
    cost = q4(o.material_cost + o.conversion_cost)
    if cost > 0:
        finance.post_system_journal(actor, timezone.now().date(), f"Rework cost {o.number}", "manufacturing", f"mo:{o.id}:rework", [("scrap_loss", "debit", cost), ("wip", "credit", cost)])
    o.scrap_cost, o.variance, o.status, o.actual_end, o.closed_by = cost, cost, "CLOSED", timezone.now().date(), actor
    o.save()
    od._release_reservations(actor, o)
    dest = o.rework_of.location
    inv.transfer_stock(actor, product_id=o.product_id, from_location_id=rec.location_id, to_location_id=dest.id, quantity=rec.quantity, lot_code=rec.lot_code or None, reason=f"Rework complete {o.number}")
    rec.status, rec.location = "RELEASED", dest
    rec.save()
    audit("manufacturing.order.rework_finished", actor, "ProductionOrder", o.id, cost=cost)
    return o


# ----------------------------------------------------------------------------- downtime and maintenance
@transaction.atomic
def record_downtime(actor, *, work_center_id, category, reason, started_at, ended_at=None, order_id=None):
    wc = m.WorkCenter.objects.filter(pk=work_center_id).first()
    if wc is None or category not in ("BREAKDOWN", "MAINTENANCE", "SETUP", "NO_MATERIAL", "NO_OPERATOR", "OTHER") or not (reason or "").strip():
        raise ValidationFailed("A work center, a valid category and a reason are required.", code="invalid_fields")
    if ended_at and ended_at < started_at:
        raise ValidationFailed("ended_at cannot be before started_at.", code="invalid_dates")
    d = m.Downtime.objects.create(work_center=wc, category=category, reason=reason[:300], started_at=started_at, ended_at=ended_at, order_id=order_id, reported_by=actor)
    audit("manufacturing.downtime.recorded", actor, "WorkCenter", wc.id, category=category)
    return d


@transaction.atomic
def end_downtime(actor, pk, ended_at=None):
    d = m.Downtime.objects.select_for_update().filter(pk=pk).first()
    if d is None:
        raise DomainError("Downtime not found.", code="not_found", status_code=404)
    if d.ended_at:
        raise DomainError("Already ended.", code="invalid_state_transition")
    end = ended_at or timezone.now()
    if end < d.started_at:
        raise ValidationFailed("ended_at cannot be before the start.", code="invalid_dates")
    d.ended_at = end
    d.save(update_fields=["ended_at", "updated_at"])
    return d


@transaction.atomic
def request_maintenance(actor, *, work_center_id, symptoms, severity="MEDIUM", order_id=None):
    """Raise a breakdown on the machine behind the work center (Asset Management owns the repair) and log the production downtime against it."""
    from modules.assets import maintenance
    wc = m.WorkCenter.objects.filter(pk=work_center_id).first()
    if wc is None:
        raise DomainError("Work center not found.", code="not_found", status_code=404)
    if not wc.asset_id:
        raise DomainError("This work center has no machine (asset) registered.", code="no_asset")
    bd = maintenance.report_breakdown(actor, wc.asset_id, symptoms=symptoms, severity=severity)
    d = m.Downtime.objects.create(work_center=wc, category="BREAKDOWN", reason=symptoms[:300], started_at=timezone.now(), order_id=order_id, breakdown_id=bd.id, reported_by=actor)
    return d, bd


def downtime_for_asset_closure(breakdown_id):
    """Close the production downtime when the breakdown it was raised for is restored."""
    from modules.assets.models import Breakdown
    bd = Breakdown.objects.filter(pk=breakdown_id).first()
    d = m.Downtime.objects.filter(breakdown_id=breakdown_id, ended_at__isnull=True).first()
    if bd and d and bd.restored_at:
        d.ended_at = bd.restored_at
        d.save(update_fields=["ended_at", "updated_at"])
    return d


def affected_orders(work_center_id):
    """Open orders with operations still to run on a work center (candidates to reschedule after downtime)."""
    return list(m.ProductionOrder.objects.filter(operations__work_center_id=work_center_id, operations__status__in=("PENDING", "IN_PROGRESS"), status__in=("PLANNED", "APPROVED", "RELEASED", "IN_PROGRESS", "ON_HOLD")).distinct())

"""Production orders: planning, release, material issue/return, operations, quality checks, scrap, output receipt, completion and closing."""
import math
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.finance import services as finance
from modules.inventory import models as im
from modules.inventory import services as inv
from modules.manufacturing import bom as bomsvc
from modules.manufacturing import models as m
from modules.manufacturing.bom import audit, dec, q4
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.sequences import services as sequences

ZERO = Decimal("0")
REF = "manufacturing.order"
OPEN = ("RELEASED", "IN_PROGRESS")


def _enabled():
    if not org.get_setting("manufacturing.enabled", True):
        raise DomainError("Manufacturing is switched off for this company.", code="manufacturing_disabled")


def _lock(pk):
    o = m.ProductionOrder.objects.select_for_update().filter(pk=pk).first()
    if o is None:
        raise DomainError("Production order not found.", code="not_found", status_code=404)
    return o


def _pct(key):
    return Decimal(str(org.get_setting(key, 0)))


# ----------------------------------------------------------------------------- planning
def next_working_day(wc, d):
    days = set(wc.working_days or [0, 1, 2, 3, 4])
    for _ in range(14):
        if d.weekday() in days:
            return d
        d += timedelta(days=1)
    return d


def schedule_operations(ops, start):
    """Forward-schedule sequential operations by work-center capacity, skipping the work center's non-working days. Returns the finish date."""
    cur = start
    for op in ops:
        days_needed = max(1, math.ceil(op.planned_hours / op.work_center.capacity_hours_per_day)) if op.planned_hours > 0 else 1
        d = next_working_day(op.work_center, cur)
        op.planned_start, left = d, days_needed - 1
        while left > 0:
            d = next_working_day(op.work_center, d + timedelta(days=1))
            left -= 1
        op.planned_end = d
        cur = d + timedelta(days=1)
    return ops[-1].planned_end if ops else start


def lead_days(bom, quantity):
    """Calendar days a production run of `quantity` takes, from the routing (1 when there is none)."""
    total = 0
    for s in bom.steps.select_related("work_center"):
        hours = (s.setup_hours + s.run_hours * dec(quantity) / bom.quantity) / (s.work_center.efficiency_percent / 100)
        total += max(1, math.ceil(hours / s.work_center.capacity_hours_per_day)) if hours > 0 else 1
    return max(total, 1)


@transaction.atomic
def create_order(actor, *, product_id, quantity, location_id, planned_start, planned_end=None, sales_order_id=None, parent_order_id=None, priority=3, instructions="", status="DRAFT", plan_line_id=None):
    _enabled()
    qty = dec(quantity)
    if qty <= 0:
        raise ValidationFailed("quantity must be positive.", code="invalid_amount")
    bom = bomsvc.active_bom(product_id)
    if bom is None:
        raise DomainError("This product has no approved bill of materials.", code="no_active_bom")
    if bomsvc.active_bom(product_id, planned_start) is None:
        raise DomainError("The approved bill of materials is not effective on the planned start date.", code="bom_not_effective")
    if bomsvc.supply_type(product_id) != "MANUFACTURED":
        raise DomainError("This product is marked as purchased or subcontracted, not manufactured.", code="not_manufactured")
    if not 1 <= int(priority) <= 5:
        raise ValidationFailed("priority must be between 1 and 5.", code="invalid_fields")
    loc = im.Location.objects.filter(pk=location_id).first()
    if loc is None:
        raise ValidationFailed("Unknown location.", code="invalid_location")
    if sales_order_id:
        from modules.sales.models import SalesOrder
        if not SalesOrder.objects.filter(pk=sales_order_id).exists():
            raise ValidationFailed("Unknown sales order.", code="invalid_sales_order")
    if parent_order_id and not m.ProductionOrder.objects.filter(pk=parent_order_id).exists():
        raise ValidationFailed("Unknown parent order.", code="invalid_parent")
    o = m.ProductionOrder(number=sequences.next_number(REF, on_date=planned_start, for_type="Production order"), product=bom.product, bom=bom, quantity=qty, location=loc, planned_start=planned_start, planned_end=planned_start,
                          sales_order_id=sales_order_id or None, parent_order_id=parent_order_id or None, created_by=actor, status=status, priority=int(priority), instructions=instructions, plan_line_id=plan_line_id)
    o.std_material_unit, o.std_conversion_unit = bomsvc.standard_cost_parts(bom)
    o.standard_unit_cost = o.std_material_unit + o.std_conversion_unit
    ops = [m.Operation(sequence=s.sequence, name=s.name, work_center=s.work_center, required_skill=s.required_skill, tools=s.tools,
                       planned_hours=q4((s.setup_hours + s.run_hours * qty / bom.quantity) / (s.work_center.efficiency_percent / 100))) for s in bom.steps.select_related("work_center")]
    end = schedule_operations(ops, planned_start)
    o.planned_end = max(end, planned_end) if planned_end else end
    o.save()
    for op in ops:
        op.order = o
    m.Operation.objects.bulk_create(ops)
    m.OrderComponent.objects.bulk_create([m.OrderComponent(order=o, product=ln.component, required_quantity=q4(qty / bom.quantity * ln.quantity * (1 + ln.scrap_percent / 100))) for ln in bom.lines.select_related("component")])
    audit("manufacturing.order.created", actor, "ProductionOrder", o.id, number=o.number)
    return o


def availability(order):
    """Components short of stock at the order's location: [{product, required, issued, on_hand, short}]."""
    out = []
    for c in order.components.select_related("product"):
        remaining = max(c.required_quantity - c.net_issued, ZERO)
        have = inv.on_hand(c.product_id, location_id=order.location_id)
        out.append({"product": str(c.product_id), "sku": c.product.sku, "required": str(c.required_quantity), "issued": str(c.net_issued), "on_hand": str(have), "short": str(max(remaining - have, ZERO))})
    return out


@transaction.atomic
def approve_order(actor, pk):
    o = _lock(pk)
    if o.status not in ("DRAFT", "PLANNED"):
        raise DomainError(f"A {o.status} order cannot be approved.", code="invalid_state_transition")
    if o.created_by == actor:
        raise DomainError("You cannot approve a production order you created.", code="separation_of_duties", status_code=403)
    o.status, o.approved_by = "APPROVED", actor
    o.save()
    audit("manufacturing.order.approved", actor, "ProductionOrder", o.id)
    return o


def _order_value(o):
    return o.standard_unit_cost * o.quantity


@transaction.atomic
def release_order(actor, pk):
    _enabled()
    o = _lock(pk)
    if o.status not in ("DRAFT", "PLANNED", "APPROVED"):
        raise DomainError(f"A {o.status} order cannot be released.", code="invalid_state_transition")
    limit = Decimal(str(org.get_setting("manufacturing.order_approval_value", 0)))
    if limit > 0 and _order_value(o) >= limit and o.status != "APPROVED":
        raise DomainError("This order is above the approval limit and must be approved first.", code="approval_required")
    if not o.operations.exists() and not o.components.exists():
        raise DomainError("Nothing to produce.", code="empty_order")
    if o.bom.approved_by is None:
        raise DomainError("Only an approved bill of materials can be used for a released order.", code="bom_not_active")
    o.std_material_unit, o.std_conversion_unit = bomsvc.standard_cost_parts(o.bom)
    o.standard_unit_cost = o.std_material_unit + o.std_conversion_unit
    shortages = _reserve_materials(actor, o)
    if shortages and org.get_setting("manufacturing.require_material_on_release", False):
        raise DomainError("Materials are not available: " + ", ".join(f"{k} short {v}" for k, v in shortages.items()), code="material_shortage")
    o.status, o.released_by = "RELEASED", actor
    o.save()
    m.QualityCheck.objects.bulk_create([m.QualityCheck(order=o, name=c.name, step_sequence=c.step_sequence, specification=c.specification, lower_limit=c.lower_limit, upper_limit=c.upper_limit) for c in o.bom.checks.all()])
    audit("manufacturing.order.released", actor, "ProductionOrder", o.id, shortages=len(shortages))
    return o


def _reserve_materials(actor, o):
    """Hold what is available for each component; returns {sku: short quantity}. Reservations shrink as material is issued."""
    from modules.inventory import availability as av
    short = {}
    for c in o.components.select_related("product"):
        need = c.required_quantity - c.net_issued
        if need <= 0 or not c.product.is_stocked:
            continue
        have = Decimal(av.availability(c.product_id, o.location.warehouse_id)["available"])
        take = min(need, have)
        if take > 0:
            av.reserve(actor, product_id=c.product_id, quantity=take, warehouse_id=o.location.warehouse_id, ref_type=REF, ref_id=str(o.id), note=f"Production {o.number}")
        if need > take:
            short[c.product.sku] = q4(need - take)
    return short


def _consume_reservation(actor, o, product_id, qty):
    from modules.inventory import availability as av
    left = qty
    for r in im.StockReservation.objects.select_for_update().filter(ref_type=REF, ref_id=str(o.id), product_id=product_id, status="ACTIVE").order_by("created_at"):
        if left <= 0:
            break
        if r.quantity <= left:
            left -= r.quantity
            av.release(actor, r.id, status="CONSUMED")
        else:
            r.quantity -= left
            r.save(update_fields=["quantity", "updated_at"])
            left = ZERO


def _release_reservations(actor, o, status="RELEASED"):
    from modules.inventory import availability as av
    av.release_by_ref(actor, REF, o.id, status=status)


@transaction.atomic
def hold_order(actor, pk, *, reason):
    o = _lock(pk)
    _active(o)
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    o.prior_status, o.status, o.hold_reason = o.status, "ON_HOLD", reason[:300]
    o.save()
    audit("manufacturing.order.held", actor, "ProductionOrder", o.id, reason=reason[:100])
    return o


@transaction.atomic
def resume_order(actor, pk):
    o = _lock(pk)
    if o.status != "ON_HOLD":
        raise DomainError("The order is not on hold.", code="invalid_state_transition")
    o.status, o.hold_reason = o.prior_status or "RELEASED", ""
    o.save()
    audit("manufacturing.order.resumed", actor, "ProductionOrder", o.id)
    return o


@transaction.atomic
def set_priority(actor, pk, priority):
    o = _lock(pk)
    if o.status in ("COMPLETED", "CLOSED", "CANCELLED"):
        raise DomainError("A finished order cannot be re-prioritised.", code="invalid_state_transition")
    if not 1 <= int(priority) <= 5:
        raise ValidationFailed("priority must be between 1 and 5.", code="invalid_fields")
    o.priority = int(priority)
    o.save(update_fields=["priority", "updated_at"])
    return o


@transaction.atomic
def reschedule_order(actor, pk, new_start):
    """Move an unfinished order (e.g. after a breakdown or a late delivery); only operations not yet started are re-planned."""
    o = _lock(pk)
    if o.status in ("COMPLETED", "CLOSED", "CANCELLED"):
        raise DomainError("A finished order cannot be rescheduled.", code="invalid_state_transition")
    pending = list(o.operations.select_related("work_center").filter(status="PENDING").order_by("sequence"))
    end = schedule_operations(pending, new_start) if pending else o.planned_end
    for op in pending:
        op.save(update_fields=["planned_start", "planned_end"])
    if not pending:
        raise DomainError("All operations have started; there is nothing to reschedule.", code="nothing_to_reschedule")
    o.planned_start, o.planned_end = min(o.planned_start, new_start) if o.actual_start else new_start, max(end, new_start)
    o.save()
    audit("manufacturing.order.rescheduled", actor, "ProductionOrder", o.id, start=new_start)
    return o


@transaction.atomic
def cancel_order(actor, pk):
    o = _lock(pk)
    if o.status not in ("DRAFT", "PLANNED", "APPROVED", "ON_HOLD") + OPEN:
        raise DomainError(f"A {o.status} order cannot be cancelled.", code="invalid_state_transition")
    if any(c.net_issued > 0 for c in o.components.all()) or o.conversion_cost > 0 or o.produced_quantity > 0:
        raise DomainError("Return the issued material and reverse work before cancelling; use short completion instead.", code="order_has_activity")
    o.status = "CANCELLED"
    o.save()
    _release_reservations(actor, o)
    audit("manufacturing.order.cancelled", actor, "ProductionOrder", o.id)
    return o


# ----------------------------------------------------------------------------- execution
def _active(o):
    if o.status not in OPEN:
        raise DomainError(f"The order is {o.status}; it must be released and not yet completed.", code="invalid_state_transition")


@transaction.atomic
def issue_material(actor, pk, *, product_id, quantity, lot_code=None, serials=None, substitute_for=None, additional=False):
    """Issue stock to an order. `substitute_for` uses an approved substitute in place of a component; `additional` records extra,
    unplanned usage. Every issue is kept in the consumption ledger; the planned quantities are never overwritten."""
    o = _lock(pk)
    _active(o)
    qty = dec(quantity)
    if qty <= 0:
        raise ValidationFailed("quantity must be positive.", code="invalid_amount")
    comp, ratio, kind = None, Decimal(1), "ISSUE"
    if substitute_for:
        comp = o.components.select_for_update().filter(product_id=substitute_for).first()
        sub = m.BomSubstitute.objects.filter(line__bom=o.bom, line__component_id=substitute_for, product_id=product_id).first()
        if comp is None or sub is None:
            raise DomainError("This product is not an approved substitute for that component.", code="not_a_substitute")
        ratio, kind = sub.ratio, "SUBSTITUTE"
    elif additional:
        kind = "ADDITIONAL"
    else:
        comp = o.components.select_for_update().filter(product_id=product_id).first()
        if comp is None:
            raise DomainError("This product is not a component of the order.", code="not_a_component")
    if comp is not None:
        eff = qty / ratio  # original-component quantity this issue covers
        limit = comp.required_quantity * (1 + _pct("manufacturing.scrap_tolerance_percent") / 100)
        if comp.net_issued + eff > limit:
            raise DomainError(f"Issue would exceed the required quantity plus tolerance ({q4(limit)}).", code="over_issue")
    mv = inv.issue_stock(actor, product_id=product_id, location_id=o.location_id, quantity=qty, lot_code=lot_code, serials=serials, reason=f"Production {o.number}", ref_type=REF, ref_id=str(o.id), counter="wip")
    value = q4(mv.unit_cost * qty)
    if comp is not None:
        comp.issued_quantity += qty / ratio
        comp.issued_cost += value
        comp.save()
        _consume_reservation(actor, o, comp.product_id, qty / ratio)
    o.material_cost += value
    o.status, o.actual_start = "IN_PROGRESS", o.actual_start or timezone.now().date()
    o.save()
    m.Consumption.objects.create(order=o, component=comp, product_id=product_id, kind=kind, quantity=qty, cost=value, lot_code=lot_code or "", stock_movement_id=mv.id, recorded_by=actor)
    audit("manufacturing.order.material_issued", actor, "ProductionOrder", o.id, product=product_id, quantity=qty, kind=kind)
    return comp


@transaction.atomic
def issue_all(actor, pk):
    """Issue every component's remaining requirement (only what is on hand is rejected as a whole)."""
    o = _lock(pk)
    _active(o)
    for c in o.components.all():
        rem = c.required_quantity - c.net_issued
        if rem > 0:
            issue_material(actor, pk, product_id=c.product_id, quantity=rem)
    return o


@transaction.atomic
def return_material(actor, pk, *, product_id, quantity, lot_code=None):
    o = _lock(pk)
    _active(o)
    qty = dec(quantity)
    comp = o.components.select_for_update().filter(product_id=product_id).first()
    if comp is None or qty <= 0 or qty > comp.net_issued:
        raise DomainError("You can only return material that was issued to this order.", code="invalid_return")
    unit = comp.issued_cost / comp.net_issued
    mv = inv.receive_stock(actor, product_id=product_id, location_id=o.location_id, quantity=qty, unit_cost=unit, lot_code=lot_code, reason=f"Return from {o.number}", ref_type=REF, ref_id=str(o.id), counter="wip")
    value = q4(unit * qty)
    comp.returned_quantity += qty
    comp.issued_cost -= value
    comp.save()
    o.material_cost -= value
    o.save()
    m.Consumption.objects.create(order=o, component=comp, product_id=product_id, kind="RETURN", quantity=qty, cost=value, lot_code=lot_code or "", stock_movement_id=mv.id, recorded_by=actor)
    audit("manufacturing.order.material_returned", actor, "ProductionOrder", o.id, product=product_id, quantity=qty)
    return comp


def _op(o, op_id, lock=True):
    qs = o.operations.select_for_update() if lock else o.operations
    op = qs.filter(pk=op_id).first()
    if op is None:
        raise DomainError("Operation not found.", code="not_found", status_code=404)
    return op


@transaction.atomic
def start_operation(actor, pk, op_id, *, operator_id=None, supervisor_id=None):
    o = _lock(pk)
    _active(o)
    op = _op(o, op_id)
    if op.status != "PENDING":
        raise DomainError(f"A {op.status} operation cannot be started.", code="invalid_state_transition")
    if o.operations.filter(sequence__lt=op.sequence).exclude(status="DONE").exists():
        raise DomainError("Earlier operations must be completed first.", code="operation_sequence")
    op.status, op.started_at, op.operator_id, op.supervisor_id = "IN_PROGRESS", timezone.now(), operator_id or actor, supervisor_id
    op.save()
    o.status, o.actual_start = "IN_PROGRESS", o.actual_start or timezone.now().date()
    o.save()
    return op


@transaction.atomic
def complete_operation(actor, pk, op_id, *, hours, machine_hours=None, good=None, defective=0, rework=0, notes=""):
    o = _lock(pk)
    _active(o)
    op = _op(o, op_id)
    if op.status != "IN_PROGRESS" or op.is_paused:
        raise DomainError("Start (or resume) the operation before completing it.", code="invalid_state_transition")
    h = dec(hours, "hours")
    mh = dec(machine_hours, "machine_hours") if machine_hours is not None else h
    g, d, r = (dec(good, "good") if good is not None else o.quantity), dec(defective, "defective"), dec(rework, "rework")
    if min(h, mh, g, d, r) < 0:
        raise ValidationFailed("hours and quantities cannot be negative.", code="invalid_amount")
    if o.checks.filter(step_sequence=op.sequence).exclude(result__in=("PASS", "CONDITIONAL")).exists():
        raise DomainError("Quality checks for this step have not all passed.", code="quality_check_pending")
    wc = op.work_center
    labor, machine, over = q4(h * wc.labor_rate), q4(mh * wc.machine_rate), q4(h * wc.overhead_rate)
    cost = labor + machine + over
    if cost:
        finance.post_system_journal(actor, timezone.now().date(), f"Conversion {o.number} op {op.sequence}", "manufacturing", f"mo:{o.id}:{op.sequence}", [("wip", "debit", cost), ("production_absorbed", "credit", cost)])
    op.actual_hours, op.absorbed_cost, op.status, op.completed_by, op.finished_at = h, cost, "DONE", actor, timezone.now()
    op.labor_cost, op.machine_cost, op.overhead_cost, op.good_quantity, op.defective_quantity, op.rework_quantity, op.notes = labor, machine, over, g, d, r, notes[:500]
    op.save()
    o.conversion_cost += cost
    o.save()
    audit("manufacturing.order.operation_done", actor, "ProductionOrder", o.id, sequence=op.sequence, hours=h)
    return op


@transaction.atomic
def record_check(actor, pk, check_id, *, result=None, measured="", note=""):
    """Record a check. With tolerance limits, a numeric measurement decides PASS/FAIL; CONDITIONAL acceptance needs a note."""
    o = _lock(pk)
    _active(o)
    c = o.checks.select_for_update().filter(pk=check_id).first()
    if c is None:
        raise DomainError("Check not found.", code="not_found", status_code=404)
    if (c.lower_limit is not None or c.upper_limit is not None) and str(measured).strip():
        try:
            val = Decimal(str(measured))
        except Exception:
            raise ValidationFailed("measured must be a number for a check with tolerance limits.", code="invalid_measurement")
        within = (c.lower_limit is None or val >= c.lower_limit) and (c.upper_limit is None or val <= c.upper_limit)
        if result in ("PASS", "CONDITIONAL") and not within or result == "FAIL" and within:
            if result != "CONDITIONAL":
                raise ValidationFailed("The result contradicts the measurement and tolerance limits.", code="result_contradicts_measurement")
        result = result or ("PASS" if within else "FAIL")
    if result not in ("PASS", "FAIL", "CONDITIONAL"):
        raise ValidationFailed("result must be PASS, FAIL or CONDITIONAL.", code="invalid_result")
    if result in ("FAIL", "CONDITIONAL") and not (note or "").strip():
        raise ValidationFailed("A failed or conditional result needs a note.", code="note_required")
    c.result, c.measured, c.note, c.checked_by, c.checked_at = result, str(measured)[:120], note[:300], actor, timezone.now()
    c.save()
    audit("manufacturing.order.check_recorded", actor, "ProductionOrder", o.id, check=c.name, result=result)
    return c


@transaction.atomic
def report_scrap(actor, pk, *, kind, quantity, reason, product_id=None):
    o = _lock(pk)
    _active(o)
    qty = dec(quantity)
    if kind not in ("OUTPUT", "MATERIAL") or qty <= 0 or not (reason or "").strip():
        raise ValidationFailed("kind (OUTPUT/MATERIAL), a positive quantity and a reason are required.", code="invalid_scrap")
    if kind == "OUTPUT":
        if o.produced_quantity + o.scrapped_quantity + qty > o.quantity * (1 + _pct("manufacturing.over_produce_percent") / 100):
            raise DomainError("Scrap would exceed the order quantity.", code="over_production")
        prod, cost = o.product, q4(qty * o.standard_unit_cost)
        o.scrapped_quantity += qty
    else:
        comp = o.components.filter(product_id=product_id).first()
        if comp is None or comp.net_issued <= 0:
            raise DomainError("Material scrap needs a component that has been issued to the order.", code="not_a_component")
        spent = m.ScrapRecord.objects.filter(order=o, kind="MATERIAL", product_id=product_id).aggregate(s=Sum("quantity"))["s"] or ZERO
        if spent + qty > comp.net_issued:
            raise DomainError("Scrap exceeds the quantity issued.", code="invalid_scrap")
        prod, cost = comp.product, q4(qty * comp.issued_cost / comp.net_issued)
    o.scrap_cost += cost
    o.save()
    rec = m.ScrapRecord.objects.create(order=o, product=prod, kind=kind, quantity=qty, cost=cost, reason=reason[:300], reported_by=actor)
    audit("manufacturing.order.scrap", actor, "ProductionOrder", o.id, kind=kind, quantity=qty)
    _maybe_complete(actor, o)
    return rec


def _maybe_complete(actor, o):
    if o.status in OPEN and o.produced_quantity + o.scrapped_quantity >= o.quantity and not o.operations.exclude(status="DONE").exists():
        _complete(actor, o)


def _complete(actor, o):
    o.status, o.actual_end = "COMPLETED", timezone.now().date()
    o.save()
    _release_reservations(actor, o)
    events.emit("manufacturing.order.completed", {"order": str(o.id), "product": str(o.product_id), "quantity": str(o.produced_quantity)}, dedup_key=f"mo-completed:{o.id}")


@transaction.atomic
def receive_output(actor, pk, *, quantity, lot_code=None, serials=None, expiry_date=None, quarantine_location_id=None):
    """Receive finished goods. Without `quarantine_location_id` the goods enter available stock (final inspection must have passed);
    with it they are placed on quality hold in that quarantine location until `execution.dispose_receipt` is approved."""
    o = _lock(pk)
    _active(o)
    if o.rework_of_id:
        raise DomainError("A rework order does not receive new goods; use finish_rework.", code="rework_order")
    qty = dec(quantity)
    if qty <= 0:
        raise ValidationFailed("quantity must be positive.", code="invalid_amount")
    if o.operations.exclude(status="DONE").exists():
        raise DomainError("All operations must be completed before finished goods are received.", code="operations_pending")
    if org.get_setting("manufacturing.operation_approval_required", False) and o.operations.filter(approved_by__isnull=True).exists():
        raise DomainError("A supervisor must approve every completed operation first.", code="operation_approval_pending")
    loc, status = o.location, "ACCEPTED"
    if quarantine_location_id:
        loc = im.Location.objects.filter(pk=quarantine_location_id, kind="QUARANTINE").first()
        if loc is None:
            raise ValidationFailed("quarantine_location must be a quarantine location.", code="invalid_location")
        status = "ON_HOLD"
    elif o.checks.filter(step_sequence__isnull=True).exclude(result__in=("PASS", "CONDITIONAL")).exists():
        raise DomainError("The final inspection has not passed.", code="quality_check_pending")
    if o.produced_quantity + o.scrapped_quantity + qty > o.quantity * (1 + _pct("manufacturing.over_produce_percent") / 100):
        raise DomainError("Receipt would exceed the order quantity plus over-production tolerance.", code="over_production")
    mv = inv.receive_stock(actor, product_id=o.product_id, location_id=loc.id, quantity=qty, unit_cost=o.standard_unit_cost, lot_code=lot_code, serials=serials, expiry_date=expiry_date, reason=f"Production {o.number}", ref_type=REF, ref_id=str(o.id), counter="wip")
    value = q4(qty * o.standard_unit_cost)
    rec = m.ProductionReceipt.objects.create(order=o, quantity=qty, unit_cost=o.standard_unit_cost, lot_code=lot_code or "", received_by=actor, stock_movement_id=mv.id, status=status, location=loc)
    o.produced_quantity += qty
    o.received_value += value
    o.save()
    audit("manufacturing.order.output_received", actor, "ProductionOrder", o.id, quantity=qty, status=status)
    _maybe_complete(actor, o)
    return rec


@transaction.atomic
def complete_short(actor, pk):
    """Close the run at what was actually produced."""
    o = _lock(pk)
    _active(o)
    if o.produced_quantity <= 0:
        raise DomainError("Nothing has been produced yet; cancel the order instead.", code="nothing_produced")
    if o.operations.exclude(status="DONE").exists():
        raise DomainError("Finish or complete all operations first.", code="operations_pending")
    _complete(actor, o)
    return o


@transaction.atomic
def close_order(actor, pk):
    """Release what is left in WIP: scrap up to the recorded scrap cost, the rest as a production variance."""
    o = _lock(pk)
    if o.status != "COMPLETED":
        raise DomainError("Only a completed order can be closed.", code="invalid_state_transition")
    if o.created_by == actor:
        raise DomainError("The person who created an order cannot close it.", code="separation_of_duties", status_code=403)
    if o.receipts.filter(status__in=("ON_HOLD", "REWORK")).exists():
        raise DomainError("Goods on quality hold or in rework need a disposition before the order can be closed.", code="goods_on_hold")
    if o.rework_orders.exclude(status__in=("CLOSED", "CANCELLED")).exists():
        raise DomainError("A rework order is still open.", code="rework_open")
    residual = q4(o.material_cost + o.conversion_cost - o.received_value)
    today = timezone.now().date()
    if residual > 0:
        scrap = min(residual, o.scrap_cost)
        finance.post_system_journal(actor, today, f"Close {o.number}", "manufacturing", f"mo:{o.id}:close", [("scrap_loss", "debit", scrap), ("production_variance", "debit", residual - scrap), ("wip", "credit", residual)])
    elif residual < 0:
        finance.post_system_journal(actor, today, f"Close {o.number}", "manufacturing", f"mo:{o.id}:close", [("wip", "debit", -residual), ("production_variance", "credit", -residual)])
    o.variance, o.status, o.closed_by = residual, "CLOSED", actor
    o.save()
    events.emit("manufacturing.order.closed", {"order": str(o.id), "variance": str(residual)}, dedup_key=f"mo-closed:{o.id}")
    audit("manufacturing.order.closed", actor, "ProductionOrder", o.id, variance=residual)
    return o

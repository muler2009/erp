"""Maintenance plans, work orders, spare parts, breakdowns and repairs, with downtime and cost analysis."""
import uuid
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, F, Sum
from django.utils import timezone

from modules.assets import models as m
from modules.assets import services as svc
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")
OPEN_WO = ("AWAITING_APPROVAL", "OPEN", "IN_PROGRESS")
SEVERITIES = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
WO_KINDS = ("PREVENTIVE", "CORRECTIVE", "REPAIR", "INSPECTION")
SYSTEM = uuid.UUID(int=0)  # requester recorded for plan-generated work orders
OPERATIONAL = ("AVAILABLE", "ASSIGNED", "IN_USE")


def _org():
    from platform_core.organizations import services as org

    return org


def _wo(pk, lock=True):
    qs = m.WorkOrder.objects.select_for_update(of=("self",)) if lock else m.WorkOrder.objects
    w = qs.select_related("asset", "plan", "breakdown").filter(pk=pk).first()
    if w is None:
        raise DomainError("Work order not found.", code="not_found", status_code=404)
    return w


def _staff_user_ids():
    from platform_core.authorization.models import RoleAssignment

    return list(RoleAssignment.objects.filter(role__name__in=["asset_manager", "maintenance_technician"]).values_list("user_id", flat=True).distinct())


def _employee_user(employee_id):
    if not employee_id:
        return None
    from modules.hr.models import Employee

    e = Employee.objects.filter(pk=employee_id).first()
    return e.user_id if e else None


# ----------------------------------------------------------------------------- meters and plans
@transaction.atomic
def record_meter(actor_id, asset_id, reading, read_on):
    a = svc._get(asset_id, lock=True)
    r = svc._dec(reading, "reading")
    if r < a.meter_reading:
        raise ValidationFailed(f"A meter cannot go backwards (last reading {a.meter_reading}).", code="meter_backwards")
    m.MeterReading.objects.create(asset=a, reading=r, read_on=read_on, recorded_by=actor_id)
    a.meter_reading = r
    a.save(update_fields=["meter_reading", "updated_at"])
    return a


@transaction.atomic
def create_plan(actor_id, asset_id, *, name, trigger="TIME", kind="PREVENTIVE", interval_days=None, interval_usage=None, first_due_on=None, lead_days=None, lead_usage=0, checklist="", estimated_cost=0, assigned_to_id=None, provider_supplier_id=None):
    a = svc._get(asset_id)
    if kind not in ("PREVENTIVE", "INSPECTION") or trigger not in ("TIME", "USAGE"):
        raise ValidationFailed("kind must be PREVENTIVE or INSPECTION and trigger TIME or USAGE.", code="invalid_plan")
    today = timezone.now().date()
    if trigger == "TIME":
        if not interval_days or int(interval_days) <= 0:
            raise ValidationFailed("A time-based plan needs an interval in days.", code="interval_required")
        due_on, due_meter = first_due_on or today + timedelta(days=int(interval_days)), None
    else:
        iu = svc._dec(interval_usage, "interval_usage") if interval_usage else ZERO
        if iu <= 0:
            raise ValidationFailed("A usage-based plan needs a positive interval (hours or kilometres).", code="interval_required")
        interval_usage, due_on, due_meter = iu, None, a.meter_reading + iu
    if lead_days is None:
        lead_days = int(_org().get_setting("assets.maintenance_lead_days", 7))
    return m.MaintenancePlan.objects.create(asset=a, name=name[:160], kind=kind, trigger=trigger, interval_days=interval_days, interval_usage=interval_usage, lead_days=lead_days, lead_usage=lead_usage, checklist=checklist, estimated_cost=estimated_cost, assigned_to_id=assigned_to_id, provider_supplier_id=provider_supplier_id, next_due_on=due_on, next_due_meter=due_meter)


def plan_due(plan, today):
    if not plan.is_active:
        return False
    if plan.trigger == "TIME":
        return plan.next_due_on is not None and plan.next_due_on - timedelta(days=plan.lead_days) <= today
    return plan.next_due_meter is not None and plan.asset.meter_reading >= plan.next_due_meter - plan.lead_usage


@transaction.atomic
def generate_due(actor_id=None, today=None):
    """Create a preventive work order for every plan that has come due and has none open. Idempotent."""
    today = today or timezone.now().date()
    created = []
    for p in m.MaintenancePlan.objects.select_for_update(of=("self",)).filter(is_active=True).select_related("asset"):
        if p.asset.status in ("DISPOSED", "RETIRED") or not plan_due(p, today):
            continue
        if m.WorkOrder.objects.filter(plan=p, status__in=OPEN_WO).exists():
            continue
        due = p.next_due_on or today
        wo = create_work_order(actor_id, p.asset_id, kind=p.kind, description=f"{p.name}\n{p.checklist}".strip(), plan_id=p.id, scheduled_on=due, due_on=due, estimated_cost=p.estimated_cost, assigned_to_id=p.assigned_to_id, provider_supplier_id=p.provider_supplier_id, _system=True)
        created.append(wo.number)
    return created


# ----------------------------------------------------------------------------- work orders
@transaction.atomic
def create_work_order(actor_id, asset_id, *, kind, description, plan_id=None, breakdown_id=None, scheduled_on=None, due_on=None, estimated_cost=0, priority="MEDIUM", assigned_to_id=None, provider_supplier_id=None, _system=False):
    a = svc._get(asset_id)
    if kind not in WO_KINDS:
        raise ValidationFailed("Unknown work order kind.", code="invalid_kind")
    if a.status in ("DISPOSED", "RETIRED", "REQUESTED", "ORDERED", "RECEIVED"):
        raise DomainError("Only an asset in the register can be maintained.", code="asset_not_maintainable")
    if not (description or "").strip():
        raise ValidationFailed("Describe the work.", code="description_required")
    est = svc._dec(estimated_cost, "estimated_cost")
    threshold = Decimal(str(_org().get_setting("assets.repair_approval_threshold", 1000)))
    needs_approval = kind in ("CORRECTIVE", "REPAIR") and est > threshold
    wo = m.WorkOrder.objects.create(number=sequences.next_number("assets.work_order", on_date=scheduled_on, for_type="WorkOrder"), asset=a, plan_id=plan_id, breakdown_id=breakdown_id, kind=kind, description=description, scheduled_on=scheduled_on, due_on=due_on, estimated_cost=est, priority=priority, assigned_to_id=assigned_to_id, provider_supplier_id=provider_supplier_id,
                                    status="AWAITING_APPROVAL" if needs_approval else "OPEN", requested_by=actor_id or SYSTEM)
    svc.log(a, "WORK_ORDER_CREATED", actor_id=actor_id, number=wo.number, kind=kind, status=wo.status)
    return wo


@transaction.atomic
def approve_work_order(actor_id, wo_id, *, approve, note=""):
    w = _wo(wo_id)
    if w.status != "AWAITING_APPROVAL":
        raise DomainError("Only a work order awaiting approval can be decided.", code="invalid_state")
    if w.requested_by == actor_id:
        raise DomainError("Separation of duties: someone else must approve this repair.", code="separation_of_duties", status_code=403)
    if approve:
        w.status, w.approved_by = "OPEN", actor_id
    else:
        if not (note or "").strip():
            raise ValidationFailed("A reason is required to reject.", code="reason_required")
        w.status, w.approved_by = "CANCELLED", actor_id
        w.verification_notes = note[:300]
    w.save()
    return w


@transaction.atomic
def assign(actor_id, wo_id, *, assigned_to_id=None, provider_supplier_id=None, scheduled_on=None):
    w = _wo(wo_id)
    if w.status not in ("OPEN", "AWAITING_APPROVAL"):
        raise DomainError("Only a work order that has not started can be reassigned.", code="invalid_state")
    if not (assigned_to_id or provider_supplier_id):
        raise ValidationFailed("Assign a technician or a service provider.", code="assignee_required")
    w.assigned_to_id, w.provider_supplier_id = assigned_to_id or w.assigned_to_id, provider_supplier_id or w.provider_supplier_id
    if scheduled_on:
        w.scheduled_on = scheduled_on
    w.save()
    return w


def _others_open(asset_id, exclude_wo=None, exclude_bd=None):
    wos = m.WorkOrder.objects.filter(asset_id=asset_id, status="IN_PROGRESS")
    if exclude_wo:
        wos = wos.exclude(pk=exclude_wo)
    bds = m.Breakdown.objects.filter(asset_id=asset_id).exclude(status__in=("RESTORED", "CLOSED"))
    if exclude_bd:
        bds = bds.exclude(pk=exclude_bd)
    return wos.exists() or bds.exists()


def _make_unavailable(actor_id, asset, reason):
    if asset.status in OPERATIONAL:
        prior = asset.status
        svc.set_status(actor_id, asset.id, "UNDER_MAINTENANCE", reason=reason)
        return prior
    return ""


def _restore(actor_id, asset_id, prior, reason, exclude_wo=None, exclude_bd=None):
    asset = svc._get(asset_id, lock=True)
    if asset.status != "UNDER_MAINTENANCE" or _others_open(asset_id, exclude_wo, exclude_bd):
        return asset
    target = prior if prior in ("ASSIGNED", "IN_USE") else "AVAILABLE"
    if target in ("ASSIGNED", "IN_USE") and not m.AssetAssignment.objects.filter(asset=asset, status="ACTIVE").exists():
        target = "AVAILABLE"
    return svc.set_status(actor_id, asset_id, target, reason=reason)


@transaction.atomic
def start(actor_id, wo_id):
    w = _wo(wo_id)
    if w.status != "OPEN":
        raise DomainError("Only an approved, open work order can be started.", code="invalid_state" if w.status != "AWAITING_APPROVAL" else "approval_required")
    asset = svc._get(w.asset_id, lock=True)
    w.prior_status = _make_unavailable(actor_id, asset, f"Work order {w.number} started") or (m.Breakdown.objects.filter(pk=w.breakdown_id).values_list("prior_status", flat=True).first() if w.breakdown_id else "")
    w.status, w.started_at = "IN_PROGRESS", timezone.now()
    w.save()
    if w.breakdown_id:
        m.Breakdown.objects.filter(pk=w.breakdown_id, status__in=("REPORTED", "DIAGNOSED")).update(status="IN_REPAIR")
    return w


def _in_progress(w):
    if w.status != "IN_PROGRESS":
        raise DomainError("Costs and activities are recorded while the work order is in progress.", code="invalid_state")


@transaction.atomic
def add_labor(actor_id, wo_id, *, hours, rate):
    w = _wo(wo_id)
    _in_progress(w)
    h, r = svc._dec(hours, "hours"), svc._dec(rate, "rate")
    if h <= 0 or r < 0:
        raise ValidationFailed("Hours must be positive and the rate cannot be negative.", code="invalid_amount")
    w.labor_hours += h
    w.labor_cost += h * r
    w.save(update_fields=["labor_hours", "labor_cost", "updated_at"])
    return w


@transaction.atomic
def add_material(actor_id, wo_id, *, product_id, location_id, quantity, lot_code=None):
    """Consume a spare part from stock: an inventory issue expensed to maintenance, so stock and ledger stay consistent."""
    from modules.inventory import services as inventory

    w = _wo(wo_id)
    _in_progress(w)
    q = svc._dec(quantity, "quantity")
    if q <= 0:
        raise ValidationFailed("Quantity must be positive.", code="invalid_amount")
    product = inventory._product(product_id)
    mv = inventory.issue_stock(actor_id, product_id=product_id, location_id=location_id, quantity=q, lot_code=lot_code, reason=f"Maintenance {w.number}", ref_type="work_order", ref_id=w.number, on_date=timezone.now().date(), counter="maintenance_expense")
    from modules.finance import models as fm

    value = sum((l.debit for l in fm.JournalLine.objects.filter(entry_id=mv.journal_entry_id)), ZERO) if mv.journal_entry_id else mv.unit_cost * q
    row = m.WorkOrderMaterial.objects.create(work_order=w, product_id=product.id, description=product.name[:200], quantity=q, unit_cost=mv.unit_cost, stock_movement_id=mv.id)
    w.material_cost += value
    w.save(update_fields=["material_cost", "updated_at"])
    return row


@transaction.atomic
def add_external_cost(actor_id, wo_id, *, amount, invoice_id=None, description=""):
    w = _wo(wo_id)
    _in_progress(w)
    amt = svc._dec(amount, "amount")
    if amt <= 0:
        raise ValidationFailed("The amount must be positive.", code="invalid_amount")
    if invoice_id:
        from modules.finance import models as fm

        if not fm.Invoice.objects.filter(pk=invoice_id, kind="SUPPLIER_INVOICE").exclude(status="VOID").exists():
            raise ValidationFailed("Supplier invoice not found.", code="invalid_invoice")
    w.external_cost += amt
    w.external_invoice_id = invoice_id or w.external_invoice_id
    w.save(update_fields=["external_cost", "external_invoice_id", "updated_at"])
    svc.log(w.asset, "MAINTENANCE_COST", actor_id=actor_id, number=w.number, amount=amt, note=description)
    return w


@transaction.atomic
def complete(actor_id, wo_id, *, notes, completed_on=None):
    w = _wo(wo_id)
    if w.status != "IN_PROGRESS":
        raise DomainError("Only a work order in progress can be completed.", code="invalid_state")
    if not (notes or "").strip():
        raise ValidationFailed("Record what was done.", code="notes_required")
    w.completion_notes, w.completed_by, w.completed_on = notes, actor_id, completed_on or timezone.now().date()
    if w.kind in ("CORRECTIVE", "REPAIR"):
        w.status = "COMPLETED"  # the asset stays out of service until someone else verifies the repair
        w.save()
        svc.log(w.asset, "REPAIR_COMPLETED", actor_id=actor_id, number=w.number, cost=w.total_cost)
        return w
    w.status = "VERIFIED"
    w.verified_by, w.verified_at = actor_id, timezone.now()
    w.save()
    _after_preventive(w)
    _restore(actor_id, w.asset_id, w.prior_status, f"Work order {w.number} completed", exclude_wo=w.id)
    svc.log(w.asset, "MAINTENANCE_COMPLETED", actor_id=actor_id, number=w.number, cost=w.total_cost)
    return w


def _after_preventive(w):
    p = w.plan
    if p is None:
        return
    a = svc._get(w.asset_id)
    p.last_done_on, p.last_done_meter = w.completed_on, a.meter_reading
    if p.trigger == "TIME":
        p.next_due_on = w.completed_on + timedelta(days=p.interval_days)
    else:
        p.next_due_meter = a.meter_reading + p.interval_usage
    p.save()


@transaction.atomic
def verify_return_to_service(actor_id, wo_id, *, notes, passed=True):
    w = _wo(wo_id)
    if w.status != "COMPLETED":
        raise DomainError("Only a completed repair can be verified.", code="invalid_state")
    if w.completed_by == actor_id:
        raise DomainError("Separation of duties: the repair must be verified by someone other than who carried it out.", code="separation_of_duties", status_code=403)
    if not (notes or "").strip():
        raise ValidationFailed("Record the verification result.", code="notes_required")
    w.verified_by, w.verified_at, w.verification_notes = actor_id, timezone.now(), notes[:300]
    if not passed:
        w.status = "IN_PROGRESS"  # sent back to the technician
        w.save()
        svc.log(w.asset, "REPAIR_REJECTED", actor_id=actor_id, number=w.number, note=notes)
        return w
    w.status = "VERIFIED"
    w.save()
    if w.breakdown_id:
        b = m.Breakdown.objects.select_for_update().get(pk=w.breakdown_id)
        now = timezone.now()
        b.status, b.restored_at = "RESTORED", now
        b.downtime_hours = (Decimal((now - b.reported_at).total_seconds()) / Decimal(3600)).quantize(Decimal("0.0001"))
        b.save()
    _restore(actor_id, w.asset_id, w.prior_status, f"Repair {w.number} verified", exclude_wo=w.id, exclude_bd=w.breakdown_id)
    svc.log(w.asset, "RETURNED_TO_SERVICE", actor_id=actor_id, number=w.number, cost=w.total_cost)
    record_tenant_event(current_tenant(), "assets.repair.verified", actor_user_id=actor_id, target_type="WorkOrder", target_id=w.id, metadata={"number": w.number, "cost": str(w.total_cost)})
    return w


@transaction.atomic
def cancel_work_order(actor_id, wo_id, *, reason=""):
    w = _wo(wo_id)
    if w.status not in OPEN_WO:
        raise DomainError("Only an unfinished work order can be cancelled.", code="invalid_state")
    was_running = w.status == "IN_PROGRESS"
    w.status, w.verification_notes = "CANCELLED", reason[:300]
    w.save()
    if was_running:
        _restore(actor_id, w.asset_id, w.prior_status, f"Work order {w.number} cancelled", exclude_wo=w.id)
    return w


# ----------------------------------------------------------------------------- breakdowns
@transaction.atomic
def report_breakdown(actor_id, asset_id, *, symptoms, severity="MEDIUM", reported_at=None, failure_code=""):
    a = svc._get(asset_id, lock=True)
    if severity not in SEVERITIES:
        raise ValidationFailed("Severity must be LOW, MEDIUM, HIGH or CRITICAL.", code="invalid_severity")
    if not (symptoms or "").strip():
        raise ValidationFailed("Describe the symptoms.", code="description_required")
    if a.status in ("DISPOSED", "RETIRED", "REQUESTED", "ORDERED", "RECEIVED"):
        raise DomainError("Only an asset in service can break down.", code="asset_not_maintainable")
    at = reported_at or timezone.now()
    prior = _make_unavailable(actor_id, a, "Breakdown reported")
    b = m.Breakdown.objects.create(number=sequences.next_number("assets.breakdown", on_date=at.date(), for_type="Breakdown"), asset=a, reported_at=at, reported_by=actor_id, symptoms=symptoms, severity=severity, failure_code=failure_code[:40], prior_status=prior)
    svc.log(a, "BREAKDOWN_REPORTED", actor_id=actor_id, number=b.number, severity=severity)
    if severity in ("HIGH", "CRITICAL"):
        notify(_staff_user_ids(), "assets.breakdown", f"{severity} breakdown on {a.number}", symptoms[:200], ref_type="assets.breakdown", ref_id=str(b.id))
    return b


@transaction.atomic
def diagnose(actor_id, breakdown_id, *, cause, failure_code=""):
    b = m.Breakdown.objects.select_for_update().filter(pk=breakdown_id).first()
    if b is None:
        raise DomainError("Breakdown not found.", code="not_found", status_code=404)
    if b.status not in ("REPORTED", "DIAGNOSED"):
        raise DomainError("The breakdown is already being repaired or closed.", code="invalid_state")
    if not (cause or "").strip():
        raise ValidationFailed("Record the cause.", code="notes_required")
    b.cause, b.status = cause, "DIAGNOSED"
    if failure_code:
        b.failure_code = failure_code[:40]
    b.save()
    return b


@transaction.atomic
def open_repair(actor_id, breakdown_id, *, description, estimated_cost=0, assigned_to_id=None, provider_supplier_id=None):
    b = m.Breakdown.objects.select_for_update().filter(pk=breakdown_id).first()
    if b is None:
        raise DomainError("Breakdown not found.", code="not_found", status_code=404)
    if b.status in ("RESTORED", "CLOSED"):
        raise DomainError("This breakdown is already resolved.", code="invalid_state")
    if m.WorkOrder.objects.filter(breakdown=b, status__in=OPEN_WO + ("COMPLETED",)).exists():
        raise DomainError("A repair is already open for this breakdown.", code="already_pending")
    return create_work_order(actor_id, b.asset_id, kind="REPAIR", description=description, breakdown_id=b.id, estimated_cost=estimated_cost, assigned_to_id=assigned_to_id, provider_supplier_id=provider_supplier_id, priority="HIGH" if b.severity in ("HIGH", "CRITICAL") else "MEDIUM")


@transaction.atomic
def close_breakdown(actor_id, breakdown_id):
    b = m.Breakdown.objects.select_for_update().filter(pk=breakdown_id).first()
    if b is None:
        raise DomainError("Breakdown not found.", code="not_found", status_code=404)
    if b.status != "RESTORED":
        raise DomainError("Only a restored breakdown can be closed.", code="invalid_state")
    b.status = "CLOSED"
    b.save(update_fields=["status", "updated_at"])
    return b


# ----------------------------------------------------------------------------- reports and daily job
def unavailable_assets():
    return [{"asset": a.number, "name": a.name, "since": str(a.updated_at.date()), "open_work_orders": list(m.WorkOrder.objects.filter(asset=a, status__in=OPEN_WO + ("COMPLETED",)).values_list("number", flat=True))} for a in m.Asset.objects.filter(status="UNDER_MAINTENANCE").order_by("number")]


def maintenance_costs(date_from, date_to, group_by="asset"):
    qs = m.WorkOrder.objects.filter(status="VERIFIED", completed_on__gte=date_from, completed_on__lte=date_to)
    key = {"asset": "asset__number", "category": "asset__category__code", "kind": "kind"}.get(group_by)
    if key is None:
        raise ValidationFailed("group_by must be asset, category or kind.", code="invalid_group")
    rows = qs.values(k=F(key)).annotate(n=Count("id"), labor=Sum("labor_cost"), material=Sum("material_cost"), external=Sum("external_cost"))
    return sorted(({"key": r["k"], "work_orders": r["n"], "labor": str(r["labor"]), "material": str(r["material"]), "external": str(r["external"]), "total": str(r["labor"] + r["material"] + r["external"])} for r in rows), key=lambda r: r["key"])


def breakdown_analysis(date_from, date_to, min_repeats=2):
    """Per asset: failures, total downtime, MTTR and MTBF; flags assets with repeated failures of the same code."""
    out = []
    qs = m.Breakdown.objects.filter(reported_at__date__gte=date_from, reported_at__date__lte=date_to).select_related("asset")
    per = {}
    for b in qs:
        per.setdefault(b.asset_id, []).append(b)
    days = max((date_to - date_from).days + 1, 1)
    for aid, rows in per.items():
        done = [r for r in rows if r.downtime_hours is not None]
        down = sum((r.downtime_hours for r in done), ZERO)
        codes = {}
        for r in rows:
            if r.failure_code:
                codes[r.failure_code] = codes.get(r.failure_code, 0) + 1
        repeated = sorted(c for c, n in codes.items() if n >= min_repeats)
        mttr = (down / len(done)).quantize(Decimal("0.01")) if done else None
        mtbf = ((Decimal(days * 24) - down) / len(rows)).quantize(Decimal("0.01"))
        out.append({"asset": rows[0].asset.number, "name": rows[0].asset.name, "breakdowns": len(rows), "downtime_hours": str(down.quantize(Decimal("0.01"))), "mttr_hours": None if mttr is None else str(mttr), "mtbf_hours": str(mtbf), "repeated_failure_codes": repeated, "recurring": len(rows) >= min_repeats})
    return sorted(out, key=lambda r: (-r["breakdowns"], r["asset"]))


def schedule(days=30, today=None):
    today = today or timezone.now().date()
    return [{"plan": p.name, "asset": p.asset.number, "trigger": p.trigger, "next_due_on": None if not p.next_due_on else str(p.next_due_on), "next_due_meter": None if p.next_due_meter is None else str(p.next_due_meter), "meter": str(p.asset.meter_reading)}
            for p in m.MaintenancePlan.objects.filter(is_active=True).select_related("asset").order_by("next_due_on") if (p.trigger == "TIME" and p.next_due_on and p.next_due_on <= today + timedelta(days=days)) or (p.trigger == "USAGE" and p.next_due_meter is not None and p.asset.meter_reading >= p.next_due_meter - p.lead_usage)]


@transaction.atomic
def run_daily(today=None):
    """Create due preventive work orders and remind about overdue ones (at most weekly each)."""
    today = today or timezone.now().date()
    created = generate_due(None, today)
    reminded = 0
    for w in m.WorkOrder.objects.select_for_update(of=("self",)).filter(status__in=("OPEN", "IN_PROGRESS"), due_on__lt=today).select_related("asset"):
        if w.last_reminder_on and (today - w.last_reminder_on).days < 7:
            continue
        ids = set(_staff_user_ids())
        u = _employee_user(w.assigned_to_id)
        if u:
            ids.add(u)
        notify(list(ids), "assets.work_order_overdue", f"{w.number} for {w.asset.number} was due {w.due_on}", w.description[:150], ref_type="assets.work_order", ref_id=str(w.id))
        w.last_reminder_on = today
        w.save(update_fields=["last_reminder_on", "updated_at"])
        reminded += 1
    return {"created": created, "reminded": reminded}

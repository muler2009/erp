"""Production plans: lines for a period, material and capacity checks, approval with revision history, release into planned orders."""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum

from modules.inventory import models as im
from modules.manufacturing import bom as bomsvc
from modules.manufacturing import models as m
from modules.manufacturing import mrp
from modules.manufacturing import orders as od
from modules.manufacturing.bom import audit, dec, q4
from shared.api.errors import DomainError, ValidationFailed
from shared.sequences import services as sequences

ZERO = Decimal("0")


def _lines(plan, lines):
    seen = set()
    for i, ln in enumerate(lines, 1):
        p = im.Product.objects.filter(pk=ln.get("product"), is_active=True).first()
        qty = dec(ln.get("quantity"), "quantity")
        rd = ln.get("required_date")
        if p is None or qty <= 0 or rd is None or not (plan.period_start <= rd <= plan.period_end):
            raise ValidationFailed(f"Line {i}: a product, a positive quantity and a required date inside the plan period are needed.", code="invalid_line")
        if bomsvc.active_bom(p.id) is None:
            raise ValidationFailed(f"Line {i}: {p.sku} has no approved bill of materials.", code="no_active_bom")
        pr = int(ln.get("priority", 3))
        if not 1 <= pr <= 5:
            raise ValidationFailed(f"Line {i}: priority must be 1-5.", code="invalid_line")
        m.PlanLine.objects.create(plan=plan, product=p, quantity=qty, required_date=rd, priority=pr, sales_order_id=ln.get("sales_order") or None)


@transaction.atomic
def create_plan(actor, *, name, period_start, period_end, lines):
    if period_end < period_start or not (name or "").strip():
        raise ValidationFailed("A name and a valid period are required.", code="invalid_fields")
    plan = m.ProductionPlan.objects.create(number=sequences.next_number("manufacturing.plan", on_date=period_start, for_type="Production plan"), name=name[:200], period_start=period_start, period_end=period_end, created_by=actor)
    _lines(plan, lines or [])
    audit("manufacturing.plan.created", actor, "ProductionPlan", plan.id, number=plan.number)
    return plan


@transaction.atomic
def revise_plan(actor, pk, *, lines, reason):
    """Replace a plan's lines. The previous lines are kept in the revision history and an approved plan goes back to draft for re-approval."""
    plan = m.ProductionPlan.objects.select_for_update().filter(pk=pk).first()
    if plan is None:
        raise DomainError("Plan not found.", code="not_found", status_code=404)
    if plan.status in ("RELEASED", "CANCELLED"):
        raise DomainError("A released or cancelled plan cannot be revised; create a new plan.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    snap = [{"product": str(x.product_id), "quantity": str(x.quantity), "required_date": str(x.required_date), "priority": x.priority} for x in plan.lines.all()]
    m.PlanRevision.objects.create(plan=plan, revision=plan.revision, changed_by=actor, reason=reason[:300], snapshot=snap)
    plan.lines.all().delete()
    _lines(plan, lines or [])
    plan.revision += 1
    plan.status, plan.approved_by = "DRAFT", None
    plan.save()
    audit("manufacturing.plan.revised", actor, "ProductionPlan", plan.id, revision=plan.revision)
    return plan


def check_plan(plan):
    """Material availability (raw requirements against stock minus reservations and inbound supply) and work-center capacity for the period."""
    need = defaultdict(lambda: ZERO)
    hours = defaultdict(lambda: ZERO)
    for ln in plan.lines.select_related("product"):
        for r in bomsvc.explode(ln.product_id, ln.quantity):
            if not r["make"]:
                need[r["product"]] += Decimal(r["quantity"])
        bom = bomsvc.active_bom(ln.product_id)
        for s in bom.steps.select_related("work_center"):
            hours[s.work_center_id] += (s.setup_hours + s.run_hours * ln.quantity / bom.quantity) / (s.work_center.efficiency_percent / 100)
    stock = mrp._stock()
    reserved = mrp._reserved()
    supply = mrp.open_supply(plan.period_start)
    shortages = []
    for pid, qty in need.items():
        avail = stock.get(pid, ZERO) - reserved.get(pid, ZERO) + supply.get(pid, ZERO)
        if qty > avail:
            shortages.append({"product": pid, "sku": im.Product.objects.get(pk=pid).sku, "required": str(q4(qty)), "available": str(q4(max(avail, ZERO))), "short": str(q4(qty - max(avail, ZERO)))})
    days = (plan.period_end - plan.period_start).days + 1
    capacity = []
    for wc in m.WorkCenter.objects.filter(pk__in=list(hours)):
        working = sum(1 for i in range(days) if (plan.period_start + timedelta(days=i)).weekday() in set(wc.working_days or [0, 1, 2, 3, 4]))
        cap = wc.capacity_hours_per_day * working
        committed = m.Operation.objects.filter(order__status__in=("PLANNED", "APPROVED", "RELEASED", "IN_PROGRESS"), status__in=("PENDING", "IN_PROGRESS"), work_center=wc, planned_start__lte=plan.period_end, planned_end__gte=plan.period_start).aggregate(h=Sum("planned_hours"))["h"] or ZERO
        total = hours[wc.id] + committed
        capacity.append({"work_center": wc.code, "plan_hours": str(q4(hours[wc.id])), "already_committed_hours": str(committed), "capacity_hours": str(cap), "utilization_percent": str(q4(total * 100 / cap)) if cap else None, "bottleneck": total > cap})
    return {"plan": plan.number, "feasible": not shortages and not any(c["bottleneck"] for c in capacity), "material_shortages": shortages, "capacity": capacity}


@transaction.atomic
def approve_plan(actor, pk):
    plan = m.ProductionPlan.objects.select_for_update().filter(pk=pk).first()
    if plan is None:
        raise DomainError("Plan not found.", code="not_found", status_code=404)
    if plan.status != "DRAFT" or not plan.lines.exists():
        raise DomainError("Only a draft plan with lines can be approved.", code="invalid_state_transition")
    if plan.created_by == actor:
        raise DomainError("You cannot approve a plan you created.", code="separation_of_duties", status_code=403)
    plan.status, plan.approved_by = "APPROVED", actor
    plan.save()
    audit("manufacturing.plan.approved", actor, "ProductionPlan", plan.id, revision=plan.revision)
    return plan


@transaction.atomic
def release_plan(actor, pk, *, location_id):
    """Create a PLANNED production order for every line (highest priority first), each starting early enough to meet its required date."""
    plan = m.ProductionPlan.objects.select_for_update().filter(pk=pk).first()
    if plan is None:
        raise DomainError("Plan not found.", code="not_found", status_code=404)
    if plan.status != "APPROVED":
        raise DomainError("Only an approved plan can be released.", code="invalid_state_transition")
    out = []
    for ln in plan.lines.select_for_update().order_by("priority", "required_date"):
        bom = bomsvc.active_bom(ln.product_id)
        lead = od.lead_days(bom, ln.quantity)
        start = max(plan.period_start, ln.required_date - timedelta(days=lead))
        o = od.create_order(actor, product_id=ln.product_id, quantity=ln.quantity, location_id=location_id, planned_start=start, sales_order_id=ln.sales_order_id, priority=ln.priority, status="PLANNED", plan_line_id=ln.id)
        ln.order = o
        ln.save(update_fields=["order"])
        out.append(o)
    plan.status = "RELEASED"
    plan.save()
    audit("manufacturing.plan.released", actor, "ProductionPlan", plan.id, orders=len(out))
    return out


@transaction.atomic
def cancel_plan(actor, pk, *, reason):
    plan = m.ProductionPlan.objects.select_for_update().filter(pk=pk).first()
    if plan is None:
        raise DomainError("Plan not found.", code="not_found", status_code=404)
    if plan.status == "RELEASED" or plan.status == "CANCELLED":
        raise DomainError("A released or cancelled plan cannot be cancelled.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    plan.status = "CANCELLED"
    plan.save()
    return plan


def suggest_lines(period_start, period_end):
    """Plan lines proposed from confirmed customer orders (net of stock and open supply): what MRP says must be made."""
    out = []
    dem = [(p, q, d) for p, q, d in mrp.sales_demand() if period_start <= d <= period_end]
    for s in mrp.plan(dem, period_start):
        if s["action"] == "MAKE":
            out.append({"product": s["product"], "sku": s["sku"], "quantity": str(s["quantity"]), "required_date": str(s["need_by"])})
    return out


def conflicts(date_from, date_to):
    """Work-center days where the planned operations (spread evenly over their days) exceed the day's capacity."""
    load = defaultdict(lambda: ZERO)
    names = {}
    for op in m.Operation.objects.filter(order__status__in=("DRAFT", "PLANNED", "APPROVED", "RELEASED", "IN_PROGRESS"), status__in=("PENDING", "IN_PROGRESS"), planned_start__lte=date_to, planned_end__gte=date_from).select_related("work_center", "order"):
        n = (op.planned_end - op.planned_start).days + 1
        per = op.planned_hours / n
        for i in range(n):
            d = op.planned_start + timedelta(days=i)
            if date_from <= d <= date_to:
                load[(op.work_center_id, d)] += per
                names[op.work_center_id] = op.work_center
    out = []
    for (wid, d), h in sorted(load.items(), key=lambda x: (str(x[0][0]), x[0][1])):
        wc = names[wid]
        if h > wc.capacity_hours_per_day:
            out.append({"work_center": wc.code, "date": str(d), "planned_hours": str(q4(h)), "capacity_hours": str(wc.capacity_hours_per_day)})
    return out

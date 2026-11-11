"""Demand forecasting and replenishment planning (nets demand against stock and open supply through manufacturing.mrp)."""
import uuid
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.inventory import models as im
from modules.manufacturing import mrp
from modules.manufacturing import orders as mfg
from modules.supply_chain import models as m
from modules.supply_chain.logistics import audit, dec
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.sequences import services as sequences

ZERO = Decimal("0")


def month_start(d):
    return d.replace(day=1)


def add_months(d, n):
    y, mo = divmod(d.month - 1 + n, 12)
    return date(d.year + y, mo + 1, 1)


# ----------------------------------------------------------------------------- forecasts
@transaction.atomic
def set_forecast(actor, *, product_id, period_start, quantity, method="MANUAL"):
    product = im.Product.objects.filter(pk=product_id, is_active=True).first()
    qty = dec(quantity, "quantity")
    if product is None or qty < 0:
        raise ValidationFailed("A valid product and a non-negative quantity are required.", code="invalid_fields")
    ps = month_start(period_start)
    f = m.DemandForecast.objects.select_for_update().filter(product=product, period_start=ps).first()
    if f is not None and f.status == "APPROVED":
        raise DomainError("An approved forecast cannot be changed; ask the approver to revoke it first.", code="forecast_approved")
    if f is None:
        f = m.DemandForecast(product=product, period_start=ps, created_by=actor)
    f.quantity, f.method, f.status, f.approved_by = qty, method, "DRAFT", None
    f.save()
    return f


@transaction.atomic
def approve_forecast(actor, pk):
    f = m.DemandForecast.objects.select_for_update().filter(pk=pk).first()
    if f is None:
        raise DomainError("Forecast not found.", code="not_found", status_code=404)
    if f.status != "DRAFT":
        raise DomainError("Only a draft forecast can be approved.", code="invalid_state_transition")
    if f.created_by == actor:
        raise DomainError("You cannot approve a forecast you created.", code="separation_of_duties", status_code=403)
    f.status, f.approved_by = "APPROVED", actor
    f.save()
    audit("supply_chain.forecast.approved", actor, "DemandForecast", f.id)
    return f


@transaction.atomic
def revoke_forecast(actor, pk):
    f = m.DemandForecast.objects.select_for_update().filter(pk=pk).first()
    if f is None:
        raise DomainError("Forecast not found.", code="not_found", status_code=404)
    f.status, f.approved_by = "DRAFT", None
    f.save()
    return f


def history(product_id, months, today):
    """Delivered quantity per full calendar month before `today`, oldest first."""
    from modules.sales.models import DeliveryLine
    first = add_months(month_start(today), -months)
    rows = defaultdict(lambda: ZERO)
    for ln in DeliveryLine.objects.filter(order_line__product_id=product_id, delivery__delivery_date__gte=first, delivery__delivery_date__lt=month_start(today)).exclude(delivery__status="FAILED").select_related("delivery"):
        rows[month_start(ln.delivery.delivery_date)] += ln.quantity
    return [(add_months(first, i), rows[add_months(first, i)]) for i in range(months)]


@transaction.atomic
def generate_from_history(actor, *, product_ids=None, today=None):
    """Draft a moving-average forecast for each of the next N months from the last N months of deliveries. Approved months are left alone."""
    today = today or timezone.now().date()
    n = int(org.get_setting("supply_chain.forecast_months", 3))
    products = im.Product.objects.filter(is_active=True, is_stocked=True)
    if product_ids:
        products = products.filter(pk__in=product_ids)
    made = []
    for p in products:
        hist = history(p.id, n, today)
        if not any(q for _, q in hist):
            continue
        avg = (sum((q for _, q in hist), ZERO) / n).quantize(Decimal("0.0001"))
        for i in range(n):
            ps = add_months(month_start(today), i + 1)
            ex = m.DemandForecast.objects.filter(product=p, period_start=ps).first()
            if ex is not None and ex.status == "APPROVED":
                continue
            made.append(set_forecast(actor, product_id=p.id, period_start=ps, quantity=avg, method="HISTORY"))
    return made


def forecast_accuracy(months, today):
    """Compare approved forecasts with what was delivered, for the last `months` full months."""
    out = []
    first = add_months(month_start(today), -months)
    for f in m.DemandForecast.objects.filter(status="APPROVED", period_start__gte=first, period_start__lt=month_start(today)).select_related("product"):
        actual = history_one(f.product_id, f.period_start)
        err = abs(actual - f.quantity)
        out.append({"product": f.product.sku, "period": str(f.period_start), "forecast": str(f.quantity), "actual": str(actual), "error_pct": str((err * 100 / actual).quantize(Decimal("0.01"))) if actual else None})
    return out


def history_one(product_id, ps):
    from modules.sales.models import DeliveryLine
    return DeliveryLine.objects.filter(order_line__product_id=product_id, delivery__delivery_date__gte=ps, delivery__delivery_date__lt=add_months(ps, 1)).exclude(delivery__status="FAILED").aggregate(s=Sum("quantity"))["s"] or ZERO


# ----------------------------------------------------------------------------- replenishment
def _demands(today, horizon_days):
    horizon = today + timedelta(days=horizon_days)
    dem = list(mrp.sales_demand())
    sales_by_month = defaultdict(lambda: ZERO)
    for pid, q, d in dem:
        sales_by_month[(str(pid), month_start(d))] += q
    for f in m.DemandForecast.objects.filter(status="APPROVED", period_start__lte=horizon, period_start__gte=month_start(today)):
        net = f.quantity - sales_by_month[(str(f.product_id), f.period_start)]  # confirmed orders consume the forecast
        if net > 0:
            dem.append((f.product_id, net, max(f.period_start, today)))
    for d in m.Demand.objects.filter(status="APPROVED", required_date__lte=horizon):
        dem.append((d.product_id, d.quantity, max(d.required_date, today)))  # sales orders and production plans are read live above, never entered here
    for pid, q in mrp.committed_component_demand().items():
        dem.append((pid, q, today))
    safety = defaultdict(lambda: ZERO)
    for r in im.ReorderRule.objects.all():
        safety[str(r.product_id)] += r.min_quantity
    for pid, q in safety.items():
        if q > 0:
            dem.append((pid, q, today))
    return dem


def balance(demands, today):
    """Planned demand against supply per product: stock (net of reservations), inbound supply, projected balance, shortage and surplus."""
    demand = defaultdict(lambda: ZERO)
    for pid, q, _ in demands:
        demand[str(pid)] += Decimal(str(q))
    stock, reserved, supply = mrp._stock(), mrp._reserved(), mrp.open_supply(today)
    out = []
    for pid in sorted(set(demand) | {k for k, v in stock.items() if v > 0}):
        p = im.Product.objects.filter(pk=pid).first()
        if p is None or not p.is_stocked:
            continue
        avail = stock.get(pid, ZERO) - reserved.get(pid, ZERO)
        proj = avail + supply.get(pid, ZERO) - demand[pid]
        surplus = max(proj - p.max_stock, ZERO) if p.max_stock is not None else ZERO
        if demand[pid] or proj < 0 or surplus:
            out.append({"product": pid, "sku": p.sku, "available": str(avail), "inbound": str(supply.get(pid, ZERO)), "demand": str(demand[pid]), "projected": str(proj), "shortage": str(max(-proj, ZERO)), "surplus": str(surplus)})
    return out


@transaction.atomic
def run_replenishment(actor, *, today=None):
    today = today or timezone.now().date()
    horizon = int(org.get_setting("supply_chain.planning_horizon_days", 30))
    demands = _demands(today, horizon)
    result = mrp.plan(demands, today)
    reorder_qty = defaultdict(lambda: ZERO)
    for r in im.ReorderRule.objects.all():
        reorder_qty[str(r.product_id)] += r.reorder_quantity
    m.ReplenishmentSuggestion.objects.filter(status="OPEN").update(status="SUPERSEDED")
    m.SupplyPlan.objects.filter(status__in=("DRAFT", "APPROVED")).update(status="SUPERSEDED")
    run = uuid.uuid4()
    plan = m.SupplyPlan.objects.create(number=sequences.next_number("supply_chain.plan", on_date=today, for_type="Supply plan"), run_id=run, plan_date=today, created_by=actor, balance={"items": balance(demands, today)})
    rows = []
    for s in result:
        qty = max(s["quantity"], reorder_qty.get(s["product"], ZERO))
        rows.append(m.ReplenishmentSuggestion.objects.create(plan=plan, run_id=run, product_id=uuid.UUID(s["product"]), action=s["action"], quantity=qty, need_by=s["need_by"], start_by=s["start_by"],
                                                              lead_days=s["lead_days"], supplier_id=uuid.UUID(str(s["supplier_id"])) if s["supplier_id"] else None, run_by=actor, note="Past due: start now" if s["start_by"] < today else ""))
    audit("supply_chain.replenishment.run", actor, "SupplyPlan", plan.id, suggestions=len(rows))
    return run, rows


def run_preview(today):
    """The suggestions a run would produce today, without saving anything."""
    return mrp.plan(_demands(today, int(org.get_setting("supply_chain.planning_horizon_days", 30))), today)


@transaction.atomic
def adjust_suggestion(actor, pk, *, quantity=None, need_by=None, reason):
    """Manual adjustment by a planner. It is logged in the plan's revision history and an approved plan returns to draft."""
    s = m.ReplenishmentSuggestion.objects.select_for_update().filter(pk=pk).first()
    if s is None:
        raise DomainError("Suggestion not found.", code="not_found", status_code=404)
    if s.status != "OPEN" or s.plan is None or s.plan.status == "SUPERSEDED":
        raise DomainError("Only an open suggestion of the current plan can be adjusted.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    plan = m.SupplyPlan.objects.select_for_update().get(pk=s.plan_id)
    changes = []
    if quantity is not None:
        q = dec(quantity, "quantity")
        if q <= 0:
            raise ValidationFailed("quantity must be positive.", code="invalid_amount")
        changes.append(("quantity", str(s.quantity), str(q)))
        s.quantity = q
    if need_by is not None:
        changes.append(("need_by", str(s.need_by), str(need_by)))
        s.start_by = s.start_by + (need_by - s.need_by)
        s.need_by = need_by
    if not changes:
        raise ValidationFailed("Nothing to change.", code="invalid_fields")
    s.save()
    plan.revision += 1
    plan.status, plan.approved_by = "DRAFT", None
    plan.save()
    for f, old, new in changes:
        m.PlanChange.objects.create(plan=plan, revision=plan.revision, suggestion_id=s.id, field=f, old_value=old, new_value=new, reason=reason[:300], changed_by=actor)
    audit("supply_chain.plan.adjusted", actor, "SupplyPlan", plan.id, revision=plan.revision)
    return s


@transaction.atomic
def approve_supply_plan(actor, pk):
    plan = m.SupplyPlan.objects.select_for_update().filter(pk=pk).first()
    if plan is None:
        raise DomainError("Plan not found.", code="not_found", status_code=404)
    if plan.status != "DRAFT":
        raise DomainError(f"A {plan.status} plan cannot be approved.", code="invalid_state_transition")
    involved = {plan.created_by} | set(plan.changes.values_list("changed_by", flat=True))
    if actor in involved:
        raise DomainError("The planner who produced or adjusted a plan cannot approve it.", code="separation_of_duties", status_code=403)
    plan.status, plan.approved_by = "APPROVED", actor
    plan.save()
    audit("supply_chain.plan.approved", actor, "SupplyPlan", plan.id, revision=plan.revision)
    return plan


@transaction.atomic
def dismiss(actor, pk, *, note):
    s = m.ReplenishmentSuggestion.objects.select_for_update().filter(pk=pk).first()
    if s is None:
        raise DomainError("Suggestion not found.", code="not_found", status_code=404)
    if s.status != "OPEN":
        raise DomainError(f"A {s.status} suggestion cannot be dismissed.", code="invalid_state_transition")
    if not (note or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    s.status, s.decided_by, s.note = "DISMISSED", actor, note[:300]
    s.save()
    return s


@transaction.atomic
def convert(actor, pk, *, location_id=None):
    s = m.ReplenishmentSuggestion.objects.select_for_update().filter(pk=pk).first()
    if s is None:
        raise DomainError("Suggestion not found.", code="not_found", status_code=404)
    if s.status != "OPEN":
        raise DomainError(f"A {s.status} suggestion cannot be converted.", code="invalid_state_transition")
    today = timezone.now().date()
    if org.get_setting("supply_chain.plan_approval_required", False) and (s.plan is None or s.plan.status != "APPROVED"):
        raise DomainError("The supply plan must be approved before its suggestions are converted.", code="plan_not_approved")
    if s.action == "BUY":
        from modules.procurement import services as proc
        from modules.procurement.models import SupplierItem
        item = SupplierItem.objects.filter(product=s.product).order_by("-is_preferred", "-valid_from").first()
        price = item.unit_price if item else (s.product.purchase_price or ZERO)
        req = proc.create_requisition(actor, title=f"Replenish {s.product.sku}"[:200], needed_by=s.need_by, lines=[{"product": str(s.product_id), "quantity": s.quantity, "estimated_unit_price": price}])
        s.converted_ref_type, s.converted_ref_id = "procurement.requisition", req.id
    else:
        if not location_id:
            raise ValidationFailed("location is required to create a production order.", code="location_required")
        o = mfg.create_order(actor, product_id=s.product_id, quantity=s.quantity, location_id=location_id, planned_start=max(s.start_by, today), planned_end=None)
        s.converted_ref_type, s.converted_ref_id = "manufacturing.order", o.id
    s.status, s.decided_by = "CONVERTED", actor
    s.save()
    audit("supply_chain.replenishment.converted", actor, "ReplenishmentSuggestion", s.id, ref=s.converted_ref_id)
    return s

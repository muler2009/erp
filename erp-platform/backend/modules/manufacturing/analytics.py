"""Manufacturing reports: plan vs actual, order status, output, efficiency, utilisation, downtime, consumption and material variance,
scrap, rework, quality rejection, WIP ageing, cost, labour productivity, on-time completion, OEE, capacity."""
from collections import defaultdict
from datetime import datetime, time, timedelta
from decimal import Decimal

from django.db.models import Count, Sum
from django.utils import timezone

from modules.manufacturing import models as m
from modules.manufacturing.bom import q4

ZERO = Decimal("0")


def _pct(n, d):
    return str(q4(Decimal(n) * 100 / Decimal(d))) if d else None


def _orders(a, b):
    return m.ProductionOrder.objects.filter(rework_of__isnull=True, planned_start__lte=b, planned_end__gte=a)


def plan_vs_actual(a, b):
    rows = []
    for o in _orders(a, b).select_related("product"):
        rows.append({"order": o.number, "product": o.product.sku, "status": o.status, "planned_qty": str(o.quantity), "produced_qty": str(o.produced_quantity), "planned_start": str(o.planned_start), "actual_start": str(o.actual_start) if o.actual_start else None,
                     "planned_end": str(o.planned_end), "actual_end": str(o.actual_end) if o.actual_end else None, "qty_attainment_pct": _pct(o.produced_quantity, o.quantity)})
    return rows


def order_status(a, b):
    return {r["status"]: r["n"] for r in _orders(a, b).values("status").annotate(n=Count("id"))}


def output(a, b):
    rows = defaultdict(lambda: {"good": ZERO, "rejected": ZERO, "scrapped": ZERO})
    for r in m.ProductionReceipt.objects.filter(created_at__date__gte=a, created_at__date__lte=b).select_related("order__product"):
        rows[r.order.product.sku]["good" if r.status in ("ACCEPTED", "RELEASED") else "rejected"] += r.quantity
    for sc in m.ScrapRecord.objects.filter(kind="OUTPUT", created_at__date__gte=a, created_at__date__lte=b).select_related("product"):
        rows[sc.product.sku]["scrapped"] += sc.quantity
    return [{"product": k, **{x: str(v) for x, v in r.items()}} for k, r in sorted(rows.items())]


def efficiency(a, b):
    ops = m.Operation.objects.filter(status="DONE", finished_at__date__gte=a, finished_at__date__lte=b)
    planned, actual = sum((o.planned_hours for o in ops), ZERO), sum((o.actual_hours for o in ops), ZERO)
    return {"operations": ops.count(), "planned_hours": str(planned), "actual_hours": str(actual), "efficiency_pct": _pct(planned, actual)}


def _working_hours(wc, a, b):
    days = set(wc.working_days or [0, 1, 2, 3, 4])
    return wc.capacity_hours_per_day * sum(1 for i in range((b - a).days + 1) if (a + timedelta(days=i)).weekday() in days)


def _downtime_hours(wc, a, b):
    start, end = timezone.make_aware(datetime.combine(a, time.min)), timezone.make_aware(datetime.combine(b, time.max))
    tot = ZERO
    for d in m.Downtime.objects.filter(work_center=wc, started_at__lte=end):
        e = d.ended_at or timezone.now()
        if e < start:
            continue
        tot += Decimal(str(max((min(e, end) - max(d.started_at, start)).total_seconds(), 0) / 3600))
    return tot


def utilization(a, b):
    out = []
    for wc in m.WorkCenter.objects.filter(is_active=True).order_by("code"):
        cap = _working_hours(wc, a, b)
        used = m.Operation.objects.filter(work_center=wc, status="DONE", finished_at__date__gte=a, finished_at__date__lte=b).aggregate(h=Sum("actual_hours"))["h"] or ZERO
        out.append({"work_center": wc.code, "capacity_hours": str(cap), "actual_hours": str(used), "utilization_pct": _pct(used, cap)})
    return out


def downtime(a, b):
    start = timezone.make_aware(datetime.combine(a, time.min))
    end = timezone.make_aware(datetime.combine(b, time.max))
    rows = defaultdict(lambda: defaultdict(int))
    for d in m.Downtime.objects.filter(started_at__lte=end).select_related("work_center"):
        if (d.ended_at or timezone.now()) < start:
            continue
        rows[d.work_center.code][d.category] += d.minutes
    return [{"work_center": k, "total_minutes": sum(v.values()), "by_category": dict(v)} for k, v in sorted(rows.items())]


def consumption(a, b):
    """Planned versus actual consumption per material across orders in the period; the difference is the material (usage) variance."""
    planned, actual, cost = defaultdict(lambda: ZERO), defaultdict(lambda: ZERO), defaultdict(lambda: ZERO)
    for c in m.OrderComponent.objects.filter(order__in=_orders(a, b), order__rework_of__isnull=True).select_related("product"):
        planned[c.product.sku] += c.required_quantity * (c.order.produced_quantity / c.order.quantity if c.order.status in ("COMPLETED", "CLOSED") else 1)
        actual[c.product.sku] += c.net_issued
        cost[c.product.sku] += c.issued_cost
    for x in m.Consumption.objects.filter(order__in=_orders(a, b), kind="ADDITIONAL").select_related("product"):
        actual[x.product.sku] += x.quantity
        cost[x.product.sku] += x.cost
    return [{"material": k, "planned": str(q4(planned[k])), "actual": str(q4(actual[k])), "variance": str(q4(actual[k] - planned[k])), "actual_cost": str(q4(cost[k]))} for k in sorted(set(planned) | set(actual))]


def scrap(a, b):
    rows = defaultdict(lambda: {"quantity": ZERO, "cost": ZERO})
    for s in m.ScrapRecord.objects.filter(created_at__date__gte=a, created_at__date__lte=b).select_related("product"):
        rows[(s.product.sku, s.kind)]["quantity"] += s.quantity
        rows[(s.product.sku, s.kind)]["cost"] += s.cost
    return [{"product": k[0], "kind": k[1], "quantity": str(v["quantity"]), "cost": str(v["cost"])} for k, v in sorted(rows.items())]


def rework(a, b):
    return [{"order": o.number, "source": o.rework_of.number, "product": o.product.sku, "quantity": str(o.quantity), "status": o.status, "cost": str(o.scrap_cost)} for o in m.ProductionOrder.objects.filter(rework_of__isnull=False, created_at__date__gte=a, created_at__date__lte=b).select_related("rework_of", "product")]


def quality_rejection(a, b):
    ops = m.Operation.objects.filter(status="DONE", finished_at__date__gte=a, finished_at__date__lte=b).aggregate(g=Sum("good_quantity"), d=Sum("defective_quantity"), r=Sum("rework_quantity"))
    g, d, r = ops["g"] or ZERO, ops["d"] or ZERO, ops["r"] or ZERO
    checks = m.QualityCheck.objects.filter(checked_at__date__gte=a, checked_at__date__lte=b)
    failed = checks.filter(result="FAIL").count()
    held = m.ProductionReceipt.objects.filter(created_at__date__gte=a, created_at__date__lte=b, status__in=("ON_HOLD", "REWORK", "SCRAPPED")).aggregate(q=Sum("quantity"))["q"] or ZERO
    return {"good": str(g), "defective": str(d), "rework": str(r), "defect_rate_pct": _pct(d + r, g + d + r), "checks": checks.count(), "checks_failed": failed, "fail_rate_pct": _pct(failed, checks.count()), "goods_held_or_rejected": str(held)}


def wip_aging(today=None):
    today = today or timezone.now().date()
    rows = []
    for o in m.ProductionOrder.objects.filter(status__in=("RELEASED", "IN_PROGRESS", "ON_HOLD", "COMPLETED"), rework_of__isnull=True).select_related("product"):
        cur = o.operations.exclude(status="DONE").order_by("sequence").first()
        age = (today - (o.actual_start or o.planned_start)).days
        blocked = o.status == "ON_HOLD" or bool(cur and cur.is_paused)
        rows.append({"order": o.number, "product": o.product.sku, "status": o.status, "current_operation": cur.name if cur else None, "work_center": cur.work_center.code if cur else None,
                     "wip_value": str(q4(o.material_cost + o.conversion_cost - o.received_value)), "age_days": age, "blocked": blocked, "waiting": bool(cur and cur.status == "PENDING" and o.status == "IN_PROGRESS")})
    return sorted(rows, key=lambda r: -r["age_days"])


def cost_report(a, b):
    rows = defaultdict(lambda: {"orders": 0, "produced": ZERO, "material": ZERO, "labor": ZERO, "machine": ZERO, "overhead": ZERO, "standard": ZERO, "scrap": ZERO})
    for o in _orders(a, b).filter(status__in=("COMPLETED", "CLOSED")).select_related("product", "bom"):
        r = rows[o.product.sku]
        r["orders"] += 1
        r["produced"] += o.produced_quantity
        r["material"] += o.material_cost
        r["standard"] += o.standard_unit_cost * o.produced_quantity
        r["scrap"] += o.scrap_cost
        for op in o.operations.all():
            r["labor"] += op.labor_cost
            r["machine"] += op.machine_cost
            r["overhead"] += op.overhead_cost
    out = []
    for k, r in sorted(rows.items()):
        actual = r["material"] + r["labor"] + r["machine"] + r["overhead"]
        out.append({"product": k, "orders": r["orders"], "produced": str(r["produced"]), "material": str(r["material"]), "labor": str(r["labor"]), "machine": str(r["machine"]), "overhead": str(r["overhead"]), "actual_cost": str(actual),
                    "standard_cost": str(q4(r["standard"])), "variance": str(q4(actual - r["standard"])), "unit_cost": str(q4(actual / r["produced"])) if r["produced"] else None, "scrap_cost": str(r["scrap"])})
    return out


def by_line(a, b):
    rows = defaultdict(lambda: ZERO)
    for op in m.Operation.objects.filter(status="DONE", finished_at__date__gte=a, finished_at__date__lte=b).select_related("work_center__line"):
        rows[op.work_center.line.code if op.work_center.line else "(no line)"] += op.absorbed_cost
    return [{"line": k, "conversion_cost": str(v)} for k, v in sorted(rows.items())]


def labor_productivity(a, b):
    rows = defaultdict(lambda: {"hours": ZERO, "good": ZERO})
    for op in m.Operation.objects.filter(status="DONE", finished_at__date__gte=a, finished_at__date__lte=b).select_related("work_center"):
        rows[op.work_center.code]["hours"] += op.actual_hours
        rows[op.work_center.code]["good"] += op.good_quantity
    return [{"work_center": k, "labor_hours": str(v["hours"]), "good_units": str(v["good"]), "units_per_hour": str(q4(v["good"] / v["hours"])) if v["hours"] else None} for k, v in sorted(rows.items())]


def on_time(a, b):
    done = list(m.ProductionOrder.objects.filter(status__in=("COMPLETED", "CLOSED"), rework_of__isnull=True, actual_end__gte=a, actual_end__lte=b))
    ok = sum(1 for o in done if o.actual_end <= o.planned_end)
    return {"completed": len(done), "on_time": ok, "on_time_pct": _pct(ok, len(done))}


def oee(a, b):
    """Availability x performance x quality per work center. Performance = planned (standard) hours / actual hours on completed operations."""
    out = []
    for wc in m.WorkCenter.objects.filter(is_active=True).order_by("code"):
        planned_time = _working_hours(wc, a, b)
        down = _downtime_hours(wc, a, b)
        ops = m.Operation.objects.filter(work_center=wc, status="DONE", finished_at__date__gte=a, finished_at__date__lte=b)
        if not ops.exists() or not planned_time:
            continue
        agg = ops.aggregate(p=Sum("planned_hours"), h=Sum("actual_hours"), g=Sum("good_quantity"), d=Sum("defective_quantity"), r=Sum("rework_quantity"))
        avail = max(planned_time - down, ZERO) / planned_time
        perf = min((agg["p"] or ZERO) / agg["h"], Decimal(1)) if agg["h"] else ZERO
        total = (agg["g"] or ZERO) + (agg["d"] or ZERO) + (agg["r"] or ZERO)
        qual = (agg["g"] or ZERO) / total if total else Decimal(1)
        out.append({"work_center": wc.code, "availability_pct": str(q4(avail * 100)), "performance_pct": str(q4(perf * 100)), "quality_pct": str(q4(qual * 100)), "oee_pct": str(q4(avail * perf * qual * 100))})
    return out


def capacity_bottlenecks(a, b):
    from modules.manufacturing.reports import work_center_load
    rows = work_center_load(a, b)
    return sorted(rows, key=lambda r: -Decimal(r["utilization_percent"]))

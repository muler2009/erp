"""Manufacturing reports: order cost analysis, WIP, work-center load, schedule."""
from collections import defaultdict
from decimal import Decimal

from modules.manufacturing import models as m
from modules.manufacturing.bom import q4

ZERO = Decimal("0")


def cost_analysis(order):
    produced = order.produced_quantity
    actual = order.material_cost + order.conversion_cost
    std_total = q4(order.standard_unit_cost * produced)
    return {"order": order.number, "status": order.status, "quantity": str(order.quantity), "produced": str(produced), "scrapped": str(order.scrapped_quantity),
            "standard_unit_cost": str(order.standard_unit_cost), "material_cost": str(order.material_cost), "conversion_cost": str(order.conversion_cost),
            "actual_cost": str(actual), "actual_unit_cost": str(q4(actual / produced)) if produced else None, "standard_cost_of_output": str(std_total),
            "scrap_cost": str(order.scrap_cost), "variance": str(order.variance if order.status == "CLOSED" else q4(actual - order.received_value)),
            "by_operation": [{"sequence": o.sequence, "name": o.name, "planned_hours": str(o.planned_hours), "actual_hours": str(o.actual_hours), "cost": str(o.absorbed_cost)} for o in order.operations.all()]}


def wip():
    rows, total = [], ZERO
    for o in m.ProductionOrder.objects.filter(status__in=("RELEASED", "IN_PROGRESS", "COMPLETED")).select_related("product"):
        bal = q4(o.material_cost + o.conversion_cost - o.received_value)
        total += bal
        rows.append({"order": o.number, "product": o.product.sku, "status": o.status, "wip_value": str(bal)})
    return {"total": str(total), "orders": rows}


def work_center_load(date_from, date_to):
    load = defaultdict(lambda: ZERO)
    for op in m.Operation.objects.filter(order__status__in=("RELEASED", "IN_PROGRESS"), status__in=("PENDING", "IN_PROGRESS"), planned_start__lte=date_to, planned_end__gte=date_from).select_related("work_center"):
        load[op.work_center_id] += op.planned_hours
    days = (date_to - date_from).days + 1
    out = []
    for wc in m.WorkCenter.objects.filter(is_active=True):
        cap = wc.capacity_hours_per_day * days
        out.append({"work_center": wc.code, "planned_hours": str(load[wc.id]), "capacity_hours": str(cap), "utilization_percent": str(q4(load[wc.id] / cap * 100)), "overloaded": load[wc.id] > cap})
    return out


def schedule():
    return [{"order": o.number, "product": o.product.sku, "status": o.status, "start": str(o.planned_start), "end": str(o.planned_end),
             "operations": [{"sequence": x.sequence, "work_center": x.work_center.code, "start": str(x.planned_start), "end": str(x.planned_end), "status": x.status} for x in o.operations.select_related("work_center")]}
            for o in m.ProductionOrder.objects.filter(status__in=("DRAFT", "RELEASED", "IN_PROGRESS")).select_related("product").order_by("planned_start")]

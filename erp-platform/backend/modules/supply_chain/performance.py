"""Supply chain performance: fulfilment (late and at-risk orders, backorders), the KPI dashboard and cost analysis."""
from datetime import timedelta
from decimal import Decimal

from django.db.models import Avg, Count, F, Sum

from modules.inventory import models as im
from modules.manufacturing import mrp
from modules.procurement import models as pm
from modules.sales import models as sm
from modules.supply_chain import coordination, delivery, logistics, risk
from modules.supply_chain import models as m
from platform_core.organizations import services as org

ZERO = Decimal("0")


def _pct(n, d):
    return str((Decimal(n) * 100 / Decimal(d)).quantize(Decimal("0.01"))) if d else None


def _expected_supply():
    """Earliest date each product's open purchase or production supply arrives."""
    out = {}
    for ln in pm.PurchaseOrderLine.objects.filter(order__status__in=("APPROVED", "PARTIALLY_RECEIVED"), product__isnull=False).select_related("order"):
        if ln.quantity > ln.received_quantity and ln.order.expected_date:
            k = str(ln.product_id)
            out[k] = min(out.get(k, ln.order.expected_date), ln.order.expected_date)
    from modules.manufacturing.models import ProductionOrder
    for o in ProductionOrder.objects.filter(status__in=("RELEASED", "IN_PROGRESS")):
        k = str(o.product_id)
        out[k] = min(out.get(k, o.planned_end), o.planned_end) if o.planned_end else out.get(k)
    return {k: v for k, v in out.items() if v}


def fulfilment_risk(today):
    """Open sales orders past (or about to pass) the promised date, which is order date plus supply_chain.fulfilment_days.
    A short line is at risk if no supply is expected before the promise."""
    days = int(org.get_setting("supply_chain.fulfilment_days", 7))
    supply = _expected_supply()
    out = []
    for o in sm.SalesOrder.objects.filter(status__in=("CONFIRMED", "PARTIALLY_DELIVERED")).select_related("account").order_by("order_date"):
        promised = o.order_date + timedelta(days=days)
        late_lines = []
        for ln in o.lines.filter(product__isnull=False):
            open_q = ln.quantity - ln.delivered_quantity
            if open_q <= 0:
                continue
            res = sm.OrderReservation.objects.filter(order_line=ln).values_list("quantity", flat=True).first() or ZERO
            short = max(open_q - res, ZERO)
            if short > 0:
                eta = supply.get(str(ln.product_id))
                late_lines.append({"line": ln.line_no, "product": str(ln.product_id), "short": str(short), "supply_expected": str(eta) if eta else None, "covered_in_time": bool(eta and eta <= promised)})
        overdue = promised < today
        at_risk = any(not x["covered_in_time"] for x in late_lines)
        if overdue or at_risk:
            out.append({"order": o.number, "customer": o.account.name, "promised": str(promised), "status": "LATE" if overdue else "AT_RISK", "days_late": (today - promised).days if overdue else 0, "short_lines": late_lines})
    return out


def backorders():
    rows = []
    for o in sm.SalesOrder.objects.filter(status="PARTIALLY_DELIVERED").select_related("account"):
        for ln in o.lines.filter(product__isnull=False):
            left = ln.quantity - ln.delivered_quantity
            if left > 0:
                rows.append({"order": o.number, "customer": o.account.name, "product": str(ln.product_id), "backordered": str(left)})
    return rows


def inventory_turnover(date_from, date_to):
    """Cost of goods issued in the period over the average inventory value (current value used as the base)."""
    issued = im.StockMovement.objects.filter(movement_type="ISSUE", created_at__date__gte=date_from, created_at__date__lte=date_to).aggregate(v=Sum(F("quantity") * F("unit_cost")))["v"] or ZERO
    cogs = abs(issued)
    value = im.ProductCost.objects.aggregate(v=Sum("total_value"))["v"] or ZERO
    days = (date_to - date_from).days + 1
    turns = (cogs / value) if value else None
    return {"cost_of_issues": str(cogs.quantize(Decimal("0.01"))), "inventory_value": str(value.quantize(Decimal("0.01"))), "turnover": str(turns.quantize(Decimal("0.01"))) if turns else None,
            "days_of_inventory": str((Decimal(days) / turns).quantize(Decimal("0.1"))) if turns else None}


def fulfilment_rate(date_from, date_to):
    """Share of delivered orders in the period that went out complete on their first delivery."""
    done = sm.SalesOrder.objects.filter(status__in=("DELIVERED", "INVOICED"), deliveries__delivery_date__gte=date_from, deliveries__delivery_date__lte=date_to).distinct()
    n = done.count()
    first = sum(1 for o in done if o.deliveries.exclude(status="FAILED").count() == 1)
    return {"delivered_orders": n, "complete_first_time": first, "fill_rate_pct": _pct(first, n)}


def supply_cost_analysis(date_from, date_to):
    """Planned supply cost (approved suggestions converted: quantity at catalogue price) against actual purchase receipts, plus transport cost."""
    freight = logistics.cost_report(date_from, date_to)
    received = pm.GoodsReceiptLine.objects.filter(receipt__receipt_date__gte=date_from, receipt__receipt_date__lte=date_to).aggregate(v=Sum(F("quantity") * F("po_line__unit_price")))["v"] or ZERO
    return {"purchases_received_value": str(Decimal(received).quantize(Decimal("0.01"))), "transport_total": freight["total"], "transport_by_type": freight["by_type"],
            "transport_pct_of_purchases": _pct(freight["total"], received) if received else None}


def dashboard(today, date_from=None, date_to=None):
    date_to = date_to or today
    date_from = date_from or (today - timedelta(days=30))
    carriers = logistics.carrier_performance(date_from, date_to)
    ships = m.Shipment.objects.filter(status="DELIVERED", actual_arrival__date__gte=date_from, actual_arrival__date__lte=date_to)
    on_time = sum(1 for s in ships if s.actual_arrival.date() <= s.planned_arrival)
    sup = delivery.supplier_delivery_performance(date_from, date_to)
    return {
        "period": {"from": str(date_from), "to": str(date_to)},
        "on_time_delivery_pct": _pct(on_time, ships.count()),
        "supplier_delivery": sup,
        "carrier_performance": carriers,
        "inventory_turnover": inventory_turnover(date_from, date_to),
        "fulfilment": fulfilment_rate(date_from, date_to),
        "late_orders": len([r for r in fulfilment_risk(today) if r["status"] == "LATE"]),
        "at_risk_orders": len([r for r in fulfilment_risk(today) if r["status"] == "AT_RISK"]),
        "open_exceptions": m.DeliveryException.objects.filter(status="OPEN").count(),
        "open_shortages": len(coordination.shortages()),
        "open_risks": m.SupplyRisk.objects.filter(status__in=("OPEN", "MITIGATING")).count(),
        "critical_risks": len([r for r in m.SupplyRisk.objects.filter(status__in=("OPEN", "MITIGATING")) if r.score >= int(org.get_setting("supply_chain.critical_risk_score", 15))]),
        "transport_cost": logistics.cost_report(date_from, date_to)["total"],
    }

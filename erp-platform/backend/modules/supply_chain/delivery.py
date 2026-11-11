"""Supplier delivery performance and customer order-fulfilment coordination."""
from collections import defaultdict
from datetime import date
from decimal import Decimal

from django.db.models import Sum

from modules.procurement import models as pm
from modules.sales import models as sm
from modules.supply_chain import models as m

ZERO = Decimal("0")
Q2 = Decimal("0.01")


def _pct(n, d):
    return str((Decimal(n) * 100 / d).quantize(Q2)) if d else None


def supplier_delivery_performance(date_from, date_to):
    """Per supplier, from purchase orders raised in the window: on-time (last receipt <= expected date), in-full, average days late,
    and actual lead time (order -> last receipt) against the lead time agreed in the supplier catalogue."""
    rows = defaultdict(lambda: {"orders": 0, "dated": 0, "on_time": 0, "in_full": 0, "late_days": 0, "lead": [], "agreed": []})
    orders = pm.PurchaseOrder.objects.filter(order_date__gte=date_from, order_date__lte=date_to, status__in=("PARTIALLY_RECEIVED", "RECEIVED", "CLOSED")).select_related("supplier").prefetch_related("lines")
    for o in orders:
        last = pm.GoodsReceipt.objects.filter(order=o).order_by("-receipt_date").values_list("receipt_date", flat=True).first()
        if last is None:
            continue
        r = rows[o.supplier_id]
        r["name"] = o.supplier.name
        r["orders"] += 1
        lines = [ln for ln in o.lines.all() if ln.product_id]
        if lines and all(ln.received_quantity >= ln.quantity for ln in lines):
            r["in_full"] += 1
        if o.expected_date:
            r["dated"] += 1
            if last <= o.expected_date:
                r["on_time"] += 1
            else:
                r["late_days"] += (last - o.expected_date).days
        r["lead"].append((last - o.order_date).days)
        for ln in lines:
            si = pm.SupplierItem.objects.filter(supplier_id=o.supplier_id, product_id=ln.product_id).order_by("-valid_from").first()
            if si:
                r["agreed"].append(si.lead_time_days)
    out = []
    for sid, r in rows.items():
        late = r["dated"] - r["on_time"]
        out.append({"supplier_id": str(sid), "supplier": r["name"], "orders": r["orders"], "on_time_pct": _pct(r["on_time"], r["dated"]), "in_full_pct": _pct(r["in_full"], r["orders"]),
                    "avg_days_late": str((Decimal(r["late_days"]) / late).quantize(Q2)) if late else "0.00", "actual_lead_days": str((Decimal(sum(r["lead"])) / len(r["lead"])).quantize(Q2)),
                    "agreed_lead_days": str((Decimal(sum(r["agreed"])) / len(r["agreed"])).quantize(Q2)) if r["agreed"] else None})
    return sorted(out, key=lambda x: x["supplier"])


def lead_time_suggestions(date_from, date_to, min_orders=3, tolerance_pct=20):
    """Suppliers whose real lead time runs more than `tolerance_pct` above the agreed one (planning should use the real figure)."""
    out = []
    for r in supplier_delivery_performance(date_from, date_to):
        if r["agreed_lead_days"] is None or r["orders"] < min_orders:
            continue
        actual, agreed = Decimal(r["actual_lead_days"]), Decimal(r["agreed_lead_days"])
        if actual > agreed * (1 + Decimal(tolerance_pct) / 100):
            out.append({**r, "suggested_lead_days": int(actual.to_integral_value(rounding="ROUND_CEILING"))})
    return out


def fulfillment_board():
    """Open customer orders: what is ordered, reserved, shipped and still short, with the shipments that carry them."""
    board = []
    for o in sm.SalesOrder.objects.filter(status__in=("CONFIRMED", "PARTIALLY_DELIVERED")).select_related("account").order_by("order_date"):
        lines, short_lines = [], 0
        for ln in o.lines.filter(product__isnull=False):
            open_q = ln.quantity - ln.delivered_quantity
            if open_q <= 0:
                continue
            res = sm.OrderReservation.objects.filter(order_line=ln).values_list("quantity", flat=True).first() or ZERO
            short = max(open_q - res, ZERO)
            short_lines += 1 if short > 0 else 0
            lines.append({"line": ln.line_no, "product": str(ln.product_id), "open": str(open_q), "reserved": str(res), "short": str(short)})
        if not lines:
            continue
        deliveries = list(sm.Delivery.objects.filter(order=o, status="DISPATCHED").values_list("id", flat=True))
        ships = m.Shipment.objects.filter(sales_delivery_id__in=deliveries).exclude(status="CANCELLED")
        board.append({"order": o.number, "order_id": str(o.id), "customer": o.account.name, "status": o.status, "fulfilment": "READY" if not short_lines else ("PARTIAL" if short_lines < len(lines) else "SHORT"),
                      "lines": lines, "in_transit_deliveries": len(deliveries), "shipments": [{"number": s.number, "status": s.status, "planned_arrival": str(s.planned_arrival)} for s in ships]})
    return board

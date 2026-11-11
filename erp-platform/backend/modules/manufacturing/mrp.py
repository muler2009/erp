"""Material requirements planning: nets demand against stock and open supply, explodes make-items through
their active BOMs and returns planned MAKE/BUY actions. Pure computation — nothing is written."""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import F, Sum

from modules.inventory import models as im
from modules.manufacturing import bom as bomsvc
from modules.manufacturing import models as m
from modules.manufacturing import orders
from shared.api.errors import DomainError

ZERO = Decimal("0")


def _stock():
    return {str(r["product_id"]): r["q"] for r in im.StockLevel.objects.values("product_id").annotate(q=Sum("quantity"))}


def _reserved():
    from modules.sales.models import OrderReservation
    return {str(r["product_id"]): r["q"] for r in OrderReservation.objects.values("product_id").annotate(q=Sum("quantity"))}


def open_supply(today):
    """Inbound purchase quantity (requisitions and orders not yet received) and open production output per product."""
    from modules.procurement import models as pm
    sup = defaultdict(lambda: ZERO)
    for ln in pm.PurchaseOrderLine.objects.filter(order__status__in=("DRAFT", "PENDING_APPROVAL", "APPROVED", "PARTIALLY_RECEIVED"), product__isnull=False).select_related("order"):
        left = ln.quantity - ln.received_quantity
        if left > 0:
            sup[str(ln.product_id)] += left
    # requisitions not yet turned into orders (a converted order reduces ordered_quantity, so nothing is counted twice)
    for rl in pm.RequisitionLine.objects.filter(requisition__status__in=("DRAFT", "SUBMITTED", "APPROVED", "PARTIALLY_ORDERED"), product__isnull=False):
        left = rl.quantity - rl.ordered_quantity
        if left > 0:
            sup[str(rl.product_id)] += left
    for o in m.ProductionOrder.objects.filter(status__in=("DRAFT", "RELEASED", "IN_PROGRESS")):
        left = o.quantity - o.produced_quantity - o.scrapped_quantity
        if left > 0:
            sup[str(o.product_id)] += left
    return sup


def committed_component_demand():
    """Components still to be issued to open production orders."""
    out = defaultdict(lambda: ZERO)
    for c in m.OrderComponent.objects.filter(order__status__in=("DRAFT", "RELEASED", "IN_PROGRESS")).select_related("order"):
        left = c.required_quantity - c.net_issued
        if left > 0:
            out[str(c.product_id)] += left
    return out


def _buy_info(product):
    from modules.procurement.models import SupplierItem
    row = SupplierItem.objects.filter(product=product).order_by("-is_preferred", "-valid_from").first()
    if row is not None:
        return row.supplier_id, row.lead_time_days, row.min_order_quantity
    return product.preferred_supplier_id, product.purchase_lead_days or 0, ZERO


def plan(demands, today):
    """demands: [(product_id, quantity, need_date)] -> list of suggestions
    {product, action: MAKE|BUY, quantity, need_by, start_by, lead_days, supplier_id}."""
    available = defaultdict(lambda: ZERO)
    stock, reserved, supply = _stock(), _reserved(), open_supply(today)
    for pid in set(list(stock) + list(supply)):
        available[pid] = stock.get(pid, ZERO) - reserved.get(pid, ZERO) + supply.get(pid, ZERO)
    queue = sorted(((d, str(p), Decimal(str(q)), 0) for p, q, d in demands if Decimal(str(q)) > 0), key=lambda x: x[0])
    sugg = {}
    products = {}
    while queue:
        need_date, pid, qty, depth = queue.pop(0)
        if depth > bomsvc.MAX_DEPTH:
            raise DomainError("Bill of materials is cyclic or nested too deeply.", code="bom_cycle")
        take = min(max(available[pid], ZERO), qty)
        available[pid] -= take
        net = qty - take
        if net <= 0:
            continue
        if pid not in products:
            products[pid] = im.Product.objects.get(pk=pid)
        product = products[pid]
        bom = bomsvc.active_bom(pid, need_date) if bomsvc.supply_type(pid) == "MANUFACTURED" else None
        if bom is not None:
            lead = orders.lead_days(bom, net)
            start = need_date - timedelta(days=lead)
            key = (pid, "MAKE")
            s = sugg.setdefault(key, {"product": pid, "sku": product.sku, "action": "MAKE", "quantity": ZERO, "need_by": need_date, "start_by": start, "lead_days": lead, "supplier_id": None})
            s["quantity"] += net
            s["need_by"], s["start_by"] = min(s["need_by"], need_date), min(s["start_by"], start)
            for ln in bom.lines.all():
                queue.append((start, str(ln.component_id), bomsvc.q4(net / bom.quantity * ln.quantity * (1 + ln.scrap_percent / 100)), depth + 1))
            queue.sort(key=lambda x: x[0])
        else:
            if product.stock_control == "NON_STOCK" or not product.is_stocked:
                continue
            supplier, lead, moq = _buy_info(product)
            buy = max(net, moq or ZERO)
            available[pid] += buy - net  # a MOQ surplus covers later demand
            start = need_date - timedelta(days=lead or 0)
            key = (pid, "BUY")
            s = sugg.setdefault(key, {"product": pid, "sku": product.sku, "action": "BUY", "quantity": ZERO, "need_by": need_date, "start_by": start, "lead_days": lead or 0, "supplier_id": str(supplier) if supplier else None})
            s["quantity"] += buy
            s["need_by"], s["start_by"] = min(s["need_by"], need_date), min(s["start_by"], start)
    return sorted(sugg.values(), key=lambda s: (s["start_by"], s["sku"]))


def sales_demand():
    """Confirmed customer orders not yet delivered: one demand per open line, dated by the order's delivery promise."""
    from modules.sales.models import SalesOrderLine
    out = []
    for ln in SalesOrderLine.objects.filter(order__status__in=("CONFIRMED", "PARTIALLY_DELIVERED"), product__isnull=False).select_related("order"):
        left = ln.quantity - ln.delivered_quantity
        if left > 0:
            out.append((ln.product_id, left, ln.order.order_date))
    return out

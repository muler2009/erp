"""Inventory coordination: stock health (slow-moving, excess, obsolete), shortages against reorder rules, transfer recommendations,
stock in transit, warehouse capacity and procurement status. Read-only: stock only ever moves through the inventory module."""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Max, Sum

from modules.inventory import availability
from modules.inventory import models as im
from modules.procurement import models as pm
from modules.supply_chain import models as m
from platform_core.organizations import services as org

ZERO = Decimal("0")


def _usable_stock():
    """Stock per (product, warehouse) in ordinary storage locations (not quarantine, transit or blocked)."""
    out = defaultdict(lambda: ZERO)
    for r in im.StockLevel.objects.filter(location__kind="STORAGE", location__is_blocked=False).values("product_id", "location__warehouse_id").annotate(q=Sum("quantity")):
        out[(str(r["product_id"]), str(r["location__warehouse_id"]))] += r["q"]
    return out


def stock_health(today):
    """Slow-moving (no outbound movement within slow_moving_days), obsolete (none within obsolete_days or discontinued) and excess (above max stock)."""
    slow_d, obs_d = int(org.get_setting("supply_chain.slow_moving_days", 90)), int(org.get_setting("supply_chain.obsolete_days", 365))
    on_hand = {str(r["product_id"]): r["q"] for r in im.StockLevel.objects.values("product_id").annotate(q=Sum("quantity")) if r["q"] > 0}
    last_out = {str(r["product_id"]): r["d"] for r in im.StockMovement.objects.filter(movement_type__in=("ISSUE",)).values("product_id").annotate(d=Max("created_at"))}
    rows = []
    for pid, qty in on_hand.items():
        p = im.Product.objects.filter(pk=pid).first()
        if p is None or not p.is_stocked:
            continue
        last = last_out.get(pid)
        idle = (today - last.date()).days if last else None
        value = qty * (p.cost.average if hasattr(p, "cost") else 0)
        status = None
        if p.status == "DISCONTINUED" or idle is None or idle >= obs_d:
            status = "OBSOLETE"
        elif idle >= slow_d:
            status = "SLOW_MOVING"
        elif p.max_stock is not None and qty > p.max_stock:
            status = "EXCESS"
        if status:
            rows.append({"product": p.sku, "status": status, "on_hand": str(qty), "days_since_last_issue": idle, "max_stock": str(p.max_stock) if p.max_stock is not None else None, "value": str(Decimal(value).quantize(Decimal("0.01")))})
    return sorted(rows, key=lambda r: (r["status"], r["product"]))


def shortages(today=None):
    """Warehouses holding less than their reorder minimum, with what is already on the way."""
    stock = _usable_stock()
    out = []
    for r in im.ReorderRule.objects.select_related("product", "warehouse"):
        have = stock.get((str(r.product_id), str(r.warehouse_id)), ZERO)
        if have < r.min_quantity:
            out.append({"product": r.product.sku, "product_id": str(r.product_id), "warehouse": r.warehouse.code, "warehouse_id": str(r.warehouse_id), "on_hand": str(have), "minimum": str(r.min_quantity), "shortage": str(r.min_quantity - have)})
    return sorted(out, key=lambda r: (r["product"], r["warehouse"]))


def transfer_recommendations():
    """Move stock from a warehouse that holds more than it needs (above its own minimum and, if set, over its maximum) to one that is short."""
    stock = _usable_stock()
    mins = {(str(r.product_id), str(r.warehouse_id)): r.min_quantity for r in im.ReorderRule.objects.all()}
    spare = defaultdict(list)
    for (pid, wid), q in stock.items():
        extra = q - mins.get((pid, wid), ZERO)
        if extra > 0:
            spare[pid].append([wid, extra])
    wh = {str(w.id): w.code for w in im.Warehouse.objects.all()}
    out = []
    for s in shortages():
        need = Decimal(s["shortage"])
        for src in sorted(spare.get(s["product_id"], []), key=lambda x: -x[1]):
            if src[0] == s["warehouse_id"] or need <= 0 or src[1] <= 0:
                continue
            qty = min(need, src[1])
            src[1] -= qty
            need -= qty
            out.append({"product": s["product"], "from": wh[src[0]], "to": s["warehouse"], "quantity": str(qty), "still_short_after": str(need)})
    return out


def stock_in_transit():
    """Stock that has left one place and is not yet receivable at the other: transfers on the road and inbound shipments."""
    rows = []
    for t in im.TransferOrder.objects.filter(status__in=("IN_TRANSIT", "PARTIALLY_RECEIVED")).select_related("from_warehouse", "to_warehouse"):
        for ln in t.lines.select_related("product"):
            open_q = ln.dispatched_quantity - ln.received_quantity - ln.rejected_quantity - ln.damaged_quantity
            if open_q > 0:
                rows.append({"type": "TRANSFER", "ref": t.number, "product": ln.product.sku, "quantity": str(open_q), "from": t.from_warehouse.code, "to": t.to_warehouse.code, "expected": str(t.expected_date) if t.expected_date else None})
    for s in m.Shipment.objects.filter(status__in=("DISPATCHED", "IN_TRANSIT"), kind="INBOUND"):
        for ln in s.lines.select_related("product"):
            rows.append({"type": "INBOUND_SHIPMENT", "ref": s.number, "product": ln.product.sku if ln.product else ln.description, "quantity": str(ln.quantity), "from": s.origin, "to": s.destination, "expected": str(s.planned_arrival)})
    return rows


def warehouse_capacity():
    out = []
    for w in im.Warehouse.objects.filter(is_active=True).order_by("code"):
        cap = im.Location.objects.filter(warehouse=w, capacity__isnull=False, is_active=True).aggregate(c=Sum("capacity"))["c"]
        used = im.StockLevel.objects.filter(location__warehouse=w, location__capacity__isnull=False).aggregate(q=Sum("quantity"))["q"] or ZERO
        out.append({"warehouse": w.code, "capacity": str(cap) if cap is not None else None, "used": str(used), "utilisation_pct": str((used * 100 / cap).quantize(Decimal("0.01"))) if cap else None})
    return out


def availability_by_warehouse(product_id):
    return [{"warehouse": w.code, **availability.availability(product_id, w.id)} for w in im.Warehouse.objects.filter(is_active=True).order_by("code")]


def procurement_status(today):
    """Open purchase orders with their delivery state so planners can see what is late or only partly received."""
    out = []
    for po in pm.PurchaseOrder.objects.filter(status__in=("APPROVED", "PARTIALLY_RECEIVED")).select_related("supplier").order_by("expected_date"):
        ordered = po.lines.aggregate(q=Sum("quantity"))["q"] or ZERO
        got = po.lines.aggregate(q=Sum("received_quantity"))["q"] or ZERO
        late = po.expected_date is not None and po.expected_date < today
        out.append({"order": po.number, "supplier": po.supplier.name, "expected": str(po.expected_date) if po.expected_date else None, "status": po.status, "ordered": str(ordered), "received": str(got),
                    "overdue": late, "days_late": (today - po.expected_date).days if late else 0})
    return out

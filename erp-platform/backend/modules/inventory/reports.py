"""Inventory reports: stock card, summary, movement history, ABC, turnover, adjustment and transfer reports, CSV export."""
import csv
import io
from datetime import timedelta
from decimal import Decimal

from django.db.models import F, Sum
from django.utils import timezone

from modules.inventory import models as m
from modules.inventory import services as svc
from shared.api.errors import DomainError, ValidationFailed

ZERO = Decimal("0")


def to_csv(rows, columns=None):
    """Spreadsheet-safe CSV: cells starting with = + - @ are prefixed so they cannot execute as formulas."""
    buf = io.StringIO()
    if not rows:
        return ""
    cols = columns or list(rows[0].keys())
    w = csv.writer(buf)
    w.writerow(cols)
    for r in rows:
        w.writerow([("'" + str(v)) if isinstance(v, str) and v[:1] in "=+-@" and not _num(v) else ("" if v is None else v) for v in (r.get(c) for c in cols)])
    return buf.getvalue()


def _num(v):
    try:
        Decimal(v)
        return True
    except Exception:
        return False


def stock_card(product_id, *, date_from=None, date_to=None, warehouse_id=None):
    p = svc._product(product_id)
    qs = m.StockMovement.objects.select_related("location").filter(product=p)
    if warehouse_id:
        qs = qs.filter(location__warehouse_id=warehouse_id)
    opening = ZERO
    if date_from:
        opening = qs.filter(created_at__date__lt=date_from).aggregate(t=Sum("quantity"))["t"] or ZERO
        qs = qs.filter(created_at__date__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__date__lte=date_to)
    bal, rows = opening, []
    for x in qs.order_by("created_at", "id"):
        bal += x.quantity
        rows.append({"date": str(x.created_at.date()), "type": x.movement_type, "location": x.location.code, "quantity": str(x.quantity), "unit_cost": str(x.unit_cost), "ref": f"{x.ref_type}:{x.ref_id}" if x.ref_type else "", "reason": x.reason, "balance": str(bal)})
    return {"sku": p.sku, "name": p.name, "opening": str(opening), "closing": str(bal), "rows": rows}


def stock_summary(group_by="warehouse"):
    """On-hand quantity and value grouped by warehouse, location or category (value at the product's current average cost)."""
    if group_by not in ("warehouse", "location", "category"):
        raise ValidationFailed("group_by must be warehouse, location or category.", code="invalid_group")
    avg = {c.product_id: c.average for c in m.ProductCost.objects.filter(quantity__gt=0)}
    out = {}
    for lv in m.StockLevel.objects.select_related("product", "location__warehouse").filter(quantity__gt=0):
        key = {"warehouse": lv.location.warehouse.code, "location": f"{lv.location.warehouse.code}/{lv.location.code}", "category": lv.product.category or "(none)"}[group_by]
        row = out.setdefault(key, {"group": key, "quantity": ZERO, "value": ZERO})
        row["quantity"] += lv.quantity
        row["value"] += lv.quantity * avg.get(lv.product_id, ZERO)
    return [{"group": k, "quantity": str(v["quantity"]), "value": str(v["value"].quantize(Decimal("0.0001")))} for k, v in sorted(out.items())]


def movements(*, product_id=None, warehouse_id=None, movement_type=None, date_from=None, date_to=None, limit=1000):
    qs = m.StockMovement.objects.select_related("product", "location__warehouse")
    if product_id:
        qs = qs.filter(product_id=product_id)
    if warehouse_id:
        qs = qs.filter(location__warehouse_id=warehouse_id)
    if movement_type:
        qs = qs.filter(movement_type=movement_type)
    if date_from:
        qs = qs.filter(created_at__date__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__date__lte=date_to)
    return [{"date": str(x.created_at.date()), "sku": x.product.sku, "warehouse": x.location.warehouse.code, "location": x.location.code, "type": x.movement_type, "quantity": str(x.quantity), "unit_cost": str(x.unit_cost), "value": str((x.quantity * x.unit_cost).quantize(Decimal("0.0001"))), "ref": f"{x.ref_type}:{x.ref_id}" if x.ref_type else "", "reason": x.reason} for x in qs.order_by("-created_at")[:limit]]


def abc_analysis(days=365, a_pct=80, b_pct=95):
    """Classify items by share of issued value: A = the items making up the first `a_pct`% of consumption, B up to `b_pct`%, C the rest."""
    since = timezone.now() - timedelta(days=days)
    rows = [(p, -v) for p, v in m.StockMovement.objects.filter(movement_type="ISSUE", created_at__gte=since).values_list("product__sku").annotate(v=Sum(F("quantity") * F("unit_cost")))]
    rows.sort(key=lambda r: r[1], reverse=True)
    total = sum((v for _, v in rows), ZERO)
    out, run = [], ZERO
    for sku, v in rows:
        before = (run * 100 / total) if total else ZERO
        run += v
        cls = "A" if before < a_pct else "B" if before < b_pct else "C"
        out.append({"sku": sku, "consumption_value": str(v.quantize(Decimal("0.0001"))), "cumulative_pct": str((run * 100 / total).quantize(Decimal("0.01"))), "class": cls})
    return out


def turnover(days=365):
    """Inventory turnover = value issued in the period / current inventory value; days of inventory = days / turnover."""
    since = timezone.now() - timedelta(days=days)
    issued = -(m.StockMovement.objects.filter(movement_type="ISSUE", created_at__gte=since).aggregate(v=Sum(F("quantity") * F("unit_cost")))["v"] or ZERO)
    value = m.ProductCost.objects.aggregate(v=Sum("total_value"))["v"] or ZERO
    ratio = (issued / value) if value else None
    return {"period_days": days, "issued_value": str(issued.quantize(Decimal("0.0001"))), "inventory_value": str(value), "turnover": None if ratio is None else str(ratio.quantize(Decimal("0.0001"))), "days_of_inventory": None if not ratio else str((Decimal(days) / ratio).quantize(Decimal("0.1")))}


def adjustments_report(date_from=None, date_to=None):
    qs = m.AdjustmentRequest.objects.select_related("product", "location")
    if date_from:
        qs = qs.filter(created_at__date__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__date__lte=date_to)
    by_reason = {}
    rows = []
    for r in qs.order_by("-created_at"):
        rows.append({"number": r.number, "sku": r.product.sku, "location": r.location.code, "delta": str(r.delta), "value": str(r.estimated_value), "reason_code": r.reason_code, "status": r.status})
        if r.status == "POSTED":
            b = by_reason.setdefault(r.reason_code, {"count": 0, "value": ZERO})
            b["count"] += 1
            b["value"] += r.estimated_value if r.delta > 0 else -r.estimated_value
    return {"rows": rows, "by_reason": {k: {"count": v["count"], "net_value": str(v["value"])} for k, v in by_reason.items()}}


def transfers_report(status=None):
    qs = m.TransferOrder.objects.select_related("from_warehouse", "to_warehouse")
    if status:
        qs = qs.filter(status=status)
    return [{"number": t.number, "from": t.from_warehouse.code, "to": t.to_warehouse.code, "status": t.status, "dispatched_at": None if not t.dispatched_at else str(t.dispatched_at.date())} for t in qs.order_by("-created_at")]

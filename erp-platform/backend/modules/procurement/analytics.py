"""Procurement analytics: measured supplier performance, spend, cycle times, and the buyer's work queue."""
from decimal import Decimal

from django.db.models import Avg, Count, F, Sum
from django.db.models.functions import TruncMonth

from modules.procurement import models as m

ZERO = Decimal("0")


def _pct(n, d):
    return None if not d else str((Decimal(n) * 100 / Decimal(d)).quantize(Decimal("0.1")))


def supplier_performance(date_from, date_to):
    """Per supplier, measured from what actually happened: on-time receipts, inspection rejection rate, returns and claims."""
    rows = {}

    def row(s):
        return rows.setdefault(s.id, {"supplier": s.name, "orders": 0, "receipt_lines": 0, "on_time": 0, "dated": 0, "received_qty": ZERO, "rejected_qty": ZERO, "returned_qty": ZERO, "claims": 0, "claimed": ZERO})

    for l in m.GoodsReceiptLine.objects.filter(receipt__receipt_date__gte=date_from, receipt__receipt_date__lte=date_to).select_related("receipt__order__supplier"):
        o = l.receipt.order
        r = row(o.supplier)
        r["receipt_lines"] += 1
        r["received_qty"] += l.quantity
        r["rejected_qty"] += l.rejected_quantity
        target = o.promised_date or o.expected_date
        if target:
            r["dated"] += 1
            r["on_time"] += 1 if l.receipt.receipt_date <= target else 0
    for o in m.PurchaseOrder.objects.filter(order_date__gte=date_from, order_date__lte=date_to).exclude(status__in=("DRAFT", "PENDING_APPROVAL", "CANCELLED")).select_related("supplier"):
        row(o.supplier)["orders"] += 1
    for rl in m.SupplierReturnLine.objects.filter(supplier_return__return_date__gte=date_from, supplier_return__return_date__lte=date_to, supplier_return__status__in=("DISPATCHED", "CREDITED", "CLOSED")).select_related("supplier_return__supplier"):
        row(rl.supplier_return.supplier)["returned_qty"] += rl.quantity
    for c in m.SupplierClaim.objects.filter(created_at__date__gte=date_from, created_at__date__lte=date_to).exclude(status="OPEN").select_related("supplier"):
        r = row(c.supplier)
        r["claims"] += 1
        r["claimed"] += c.amount_claimed
    out = []
    for r in sorted(rows.values(), key=lambda r: r["supplier"]):
        bad = r["rejected_qty"] + r["returned_qty"]
        out.append({"supplier": r["supplier"], "orders": r["orders"], "receipt_lines": r["receipt_lines"], "on_time_pct": _pct(r["on_time"], r["dated"]), "rejection_pct": _pct(r["rejected_qty"], r["received_qty"]), "defect_pct": _pct(bad, r["received_qty"]), "claims": r["claims"], "claimed": str(r["claimed"])})
    return out


def spend(date_from, date_to, group_by="supplier"):
    qs = m.PurchaseOrder.objects.filter(order_date__gte=date_from, order_date__lte=date_to).exclude(status__in=("DRAFT", "PENDING_APPROVAL", "CANCELLED"))
    if group_by == "supplier":
        data = qs.values(key=F("supplier__name"), cur=F("currency")).annotate(ordered=Sum("total"), n=Count("id"))
    elif group_by == "category":
        data = qs.values(key=F("supplier__category"), cur=F("currency")).annotate(ordered=Sum("total"), n=Count("id"))
    elif group_by == "month":
        data = qs.annotate(mo=TruncMonth("order_date")).values(key=F("mo"), cur=F("currency")).annotate(ordered=Sum("total"), n=Count("id"))
    else:
        from shared.api.errors import ValidationFailed

        raise ValidationFailed("group_by must be supplier, category or month.", code="invalid_group")
    return sorted(({"key": str(r["key"] or "(none)"), "currency": r["cur"], "orders": r["n"], "ordered": str(r["ordered"])} for r in data), key=lambda r: (r["key"], r["currency"]))


def cycle_times(date_from, date_to):
    """Average days from requisition approval to PO, and from PO approval to first receipt."""
    to_po, to_receipt = [], []
    for o in m.PurchaseOrder.objects.filter(order_date__gte=date_from, order_date__lte=date_to, requisition__isnull=False).select_related("requisition"):
        to_po.append((o.created_at.date() - o.requisition.created_at.date()).days)
    for r in m.GoodsReceipt.objects.filter(receipt_date__gte=date_from, receipt_date__lte=date_to).select_related("order"):
        to_receipt.append((r.receipt_date - r.order.order_date).days)
    avg = lambda xs: None if not xs else str((Decimal(sum(xs)) / len(xs)).quantize(Decimal("0.1")))
    return {"requisition_to_po_days": avg(to_po), "po_to_receipt_days": avg(to_receipt), "samples": {"requisition_to_po": len(to_po), "po_to_receipt": len(to_receipt)}}


def price_variance(date_from, date_to):
    """PO unit price against the requisition's estimate, for orders raised from a requisition."""
    rows = []
    for l in m.PurchaseOrderLine.objects.filter(order__order_date__gte=date_from, order__order_date__lte=date_to, requisition_line__isnull=False).select_related("order", "requisition_line"):
        est = l.requisition_line.estimated_unit_price
        if est:
            rows.append({"po": l.order.number, "line": l.line_no, "estimated": str(est), "actual": str(l.unit_price), "variance_pct": _pct(l.unit_price - est, est) if est else None})
    return rows


def work_queue(today):
    from modules.procurement import contracts, orders_ext, receiving, suppliers, verification

    return {"open_requisitions": m.Requisition.objects.filter(status__in=("SUBMITTED", "APPROVED", "PARTIALLY_ORDERED")).count(),
            "orders_awaiting_approval": m.PurchaseOrder.objects.filter(status="PENDING_APPROVAL").count(),
            "overdue_delivery_lines": len(orders_ext.overdue_lines(today)),
            "pending_inspections": len(receiving.pending_inspections()),
            "match_exceptions": len(verification.exceptions()),
            "contracts_expiring_60d": len(contracts.expiring(60, today)),
            "open_claims": m.SupplierClaim.objects.filter(status__in=("OPEN", "SUBMITTED", "ACCEPTED")).count(),
            "returns_awaiting_credit": m.SupplierReturn.objects.filter(status="DISPATCHED", credit_due__gt=0).count(),
            "supplier_documents_expiring_30d": len(suppliers.expiring_documents(30))}

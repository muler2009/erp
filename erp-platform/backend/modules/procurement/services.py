"""Procurement application services: suppliers, requisitions, RFQ/bids, purchase orders, goods receipts and
three-way invoice matching. Approvals use the shared workflow engine when a definition exists for the subject,
otherwise a direct, separation-of-duties-checked approval."""
from datetime import date as date_cls
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.finance import models as fm
from modules.finance import services as finance
from modules.inventory import models as im
from modules.inventory import services as inventory
from modules.procurement import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.sequences import services as sequences
from shared.tenancy import current_tenant
from shared.workflows import services as workflows

ZERO = Decimal("0")
REQ_SUBJECT, PO_SUBJECT = "procurement.requisition", "procurement.purchase_order"


def _dec(value, field="amount"):
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValidationFailed(f"{field} must be a decimal number.", code="invalid_amount")


def _get(model, pk, label):
    obj = model.objects.filter(pk=pk).first()
    if obj is None:
        raise DomainError(f"{label} not found.", code="not_found", status_code=404)
    return obj


def _lock(model, pk, label):
    obj = model.objects.select_for_update().filter(pk=pk).first()
    if obj is None:
        raise DomainError(f"{label} not found.", code="not_found", status_code=404)
    return obj


# ----------------------------------------------------------------------------- suppliers
@transaction.atomic
def create_supplier(actor_id, *, name, tax_id="", email=""):
    if not name.strip():
        raise ValidationFailed("name is required.", code="invalid_name")
    return m.Supplier.objects.create(name=name.strip(), tax_id=tax_id, email=email)


@transaction.atomic
def qualify_supplier(actor_id, supplier_id, *, notes):
    s = _lock(m.Supplier, supplier_id, "Supplier")
    if s.status == "BLOCKED":
        raise DomainError("A blocked supplier must be unblocked by re-qualification review.", code="supplier_blocked")
    if not (notes or "").strip():
        raise ValidationFailed("Qualification notes are required.", code="notes_required")
    if s.partner_id is None:  # the finance counterpart is created exactly once, at qualification
        s.partner = finance.create_partner(actor_id, name=s.name, is_supplier=True, tax_id=s.tax_id, external_ref=str(s.id))
    s.status, s.qualification_notes, s.qualified_by, s.qualified_at = "QUALIFIED", notes, actor_id, timezone.now()
    s.save()
    record_tenant_event(current_tenant(), "procurement.supplier.qualified", actor_user_id=actor_id, target_type="Supplier", target_id=s.id)
    return s


@transaction.atomic
def block_supplier(actor_id, supplier_id, *, reason):
    s = _lock(m.Supplier, supplier_id, "Supplier")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    s.status = "BLOCKED"
    s.save(update_fields=["status", "updated_at"])
    record_tenant_event(current_tenant(), "procurement.supplier.blocked", actor_user_id=actor_id, target_type="Supplier", target_id=s.id, metadata={"reason": reason[:200]})
    return s


@transaction.atomic
def evaluate_supplier(actor_id, supplier_id, *, period, delivery, quality, price, comment=""):
    s = _get(m.Supplier, supplier_id, "Supplier")
    scores = [int(delivery), int(quality), int(price)]
    if any(not 1 <= x <= 5 for x in scores):
        raise ValidationFailed("Scores must be between 1 and 5.", code="invalid_score")
    if m.SupplierEvaluation.objects.filter(supplier=s, period=period).exists():
        raise DomainError("This supplier was already evaluated for that period.", code="already_evaluated")
    return m.SupplierEvaluation.objects.create(supplier=s, period=period, delivery=scores[0], quality=scores[1], price=scores[2], comment=comment[:500], evaluated_by=actor_id)


def supplier_scorecard(supplier_id):
    rows = list(m.SupplierEvaluation.objects.filter(supplier_id=supplier_id).order_by("period"))
    avg = lambda f: (sum(getattr(r, f) for r in rows) / len(rows)) if rows else None
    return {"evaluations": len(rows), "delivery": avg("delivery"), "quality": avg("quality"), "price": avg("price"), "overall": (sum(avg(f) for f in ("delivery", "quality", "price")) / 3) if rows else None}


# ----------------------------------------------------------------------------- approvals (shared pattern)
def _submit_for_approval(actor_id, obj, subject, amount, title):
    if workflows.WorkflowDefinition.objects.filter(subject_type=subject, is_active=True).exists():
        instance = workflows.submit(actor_id, subject, str(obj.id), amount=amount, title=title)
        obj.workflow_instance_id = instance.id


def _direct_approve_guard(obj, actor_id, creator_id):
    if obj.workflow_instance_id:
        raise DomainError("This document is governed by an approval workflow; decide it in the approval inbox.", code="workflow_governed")
    if creator_id == actor_id:
        raise DomainError("Separation of duties: you cannot approve a document you created.", code="separation_of_duties", status_code=403)


def _on_outcome(kind, instance):
    model = m.Requisition if kind == "requisition" else m.PurchaseOrder
    pending = "SUBMITTED" if kind == "requisition" else "PENDING_APPROVAL"
    obj = model.objects.select_for_update().filter(pk=instance.subject_id).first()
    if obj is None or obj.workflow_instance_id != instance.id or obj.status != pending:
        return
    if instance.status == "APPROVED":
        last = instance.actions.filter(action="APPROVED").order_by("-created_at").first()
        obj.status, obj.approved_by = "APPROVED", (last.actor_id if last else None)
        obj.save(update_fields=["status", "approved_by", "updated_at"])
        _after_approved(kind, obj)
    else:
        obj.status, obj.workflow_instance_id = "DRAFT", None
        obj.save(update_fields=["status", "workflow_instance_id", "updated_at"])


def _after_approved(kind, obj):
    if kind == "po":
        events.emit("procurement.purchase_order.approved", {"po_id": str(obj.id), "number": obj.number, "supplier_id": str(obj.supplier_id), "total": str(obj.total), "currency": obj.currency}, dedup_key=f"po-approved-{obj.id}")
    else:
        events.emit("procurement.requisition.approved", {"requisition_id": str(obj.id), "number": obj.number}, dedup_key=f"req-approved-{obj.id}")


# ----------------------------------------------------------------------------- requisitions
def _lines_check(raw, price_field=None):
    if not raw:
        raise ValidationFailed("At least one line is required.", code="no_lines")
    out = []
    for i, r in enumerate(raw, start=1):
        qty = _dec(r["quantity"], "quantity")
        if qty <= 0:
            raise ValidationFailed(f"Line {i}: quantity must be positive.", code="invalid_amount")
        product = None
        if r.get("product"):
            product = im.Product.objects.filter(pk=r["product"], is_active=True).first()
            if product is None:
                raise ValidationFailed(f"Line {i}: unknown or inactive product.", code="invalid_product")
        desc = (r.get("description") or (product.name if product else "")).strip()
        if not desc:
            raise ValidationFailed(f"Line {i}: a product or description is required.", code="invalid_line")
        price = _dec(r.get(price_field, 0), price_field) if price_field else ZERO
        if price < 0:
            raise ValidationFailed(f"Line {i}: price cannot be negative.", code="invalid_amount")
        out.append((i, product, desc[:300], qty, price))
    return out


@transaction.atomic
def create_requisition(actor_id, *, title, lines, department_id=None, needed_by=None):
    rows = _lines_check(lines, "estimated_unit_price")
    req = m.Requisition.objects.create(number=sequences.next_number("procurement.requisition", for_type="Requisition"), title=title[:200], requester_id=actor_id, department_id=department_id, needed_by=needed_by,
                                       estimated_total=sum((q * p for _, _, _, q, p in rows), ZERO))
    m.RequisitionLine.objects.bulk_create([m.RequisitionLine(requisition=req, line_no=i, product=pr, description=d, quantity=q, estimated_unit_price=p) for i, pr, d, q, p in rows])
    return req


@transaction.atomic
def submit_requisition(actor_id, req_id):
    req = _lock(m.Requisition, req_id, "Requisition")
    if req.requester_id != actor_id:
        raise DomainError("Requisition not found.", code="not_found", status_code=404)
    if req.status != "DRAFT":
        raise DomainError("Only draft requisitions can be submitted.", code="invalid_state_transition")
    req.status = "SUBMITTED"
    _submit_for_approval(actor_id, req, REQ_SUBJECT, req.estimated_total, f"Requisition {req.number}: {req.title}")
    req.save()
    return req


@transaction.atomic
def approve_requisition(actor_id, req_id):
    req = _lock(m.Requisition, req_id, "Requisition")
    if req.status != "SUBMITTED":
        raise DomainError("Only submitted requisitions can be approved.", code="invalid_state_transition")
    _direct_approve_guard(req, actor_id, req.requester_id)
    req.status, req.approved_by = "APPROVED", actor_id
    req.save(update_fields=["status", "approved_by", "updated_at"])
    _after_approved("req", req)
    return req


@transaction.atomic
def cancel_requisition(actor_id, req_id):
    req = _lock(m.Requisition, req_id, "Requisition")
    if req.requester_id != actor_id:
        raise DomainError("Requisition not found.", code="not_found", status_code=404)
    if req.status not in ("DRAFT", "SUBMITTED", "APPROVED"):
        raise DomainError("This requisition can no longer be cancelled.", code="invalid_state_transition")
    if req.workflow_instance_id:
        inst = workflows.WorkflowInstance.objects.filter(pk=req.workflow_instance_id, status__in=workflows.WorkflowInstance.ACTIVE).first()
        if inst:
            req.workflow_instance_id = None
            req.save(update_fields=["workflow_instance_id"])
            workflows.cancel(actor_id, inst.id, comment="Requisition cancelled")
            req = _lock(m.Requisition, req_id, "Requisition")
    req.status = "CANCELLED"
    req.save(update_fields=["status", "updated_at"])
    return req


# ----------------------------------------------------------------------------- RFQ and bids
@transaction.atomic
def create_rfq(actor_id, *, title, supplier_ids, requisition_id=None, lines=None, due_date=None):
    suppliers = list(m.Supplier.objects.filter(pk__in=supplier_ids))
    if not suppliers or len(suppliers) != len(set(map(str, supplier_ids))) or any(s.status != "QUALIFIED" for s in suppliers):
        raise ValidationFailed("Invite at least one supplier; all invited suppliers must be qualified.", code="invalid_suppliers")
    req = None
    if requisition_id:
        req = _get(m.Requisition, requisition_id, "Requisition")
        if req.status != "APPROVED":
            raise DomainError("Only an approved requisition can be sourced.", code="invalid_state_transition")
        lines = [{"product": l.product_id, "description": l.description, "quantity": l.quantity} for l in req.lines.all()]
    rows = _lines_check(lines)
    rfq = m.Rfq.objects.create(number=sequences.next_number("procurement.rfq", for_type="Rfq"), title=title[:200], requisition=req, due_date=due_date, created_by=actor_id)
    rfq.suppliers.set(suppliers)
    m.RfqLine.objects.bulk_create([m.RfqLine(rfq=rfq, line_no=i, product=pr, description=d, quantity=q) for i, pr, d, q, _ in rows])
    return rfq


@transaction.atomic
def record_quotation(actor_id, rfq_id, *, supplier_id, currency, prices, lead_time_days=0, valid_until=None):
    rfq = _lock(m.Rfq, rfq_id, "RFQ")
    if rfq.status != "OPEN":
        raise DomainError("This RFQ is closed.", code="invalid_state_transition")
    if not rfq.suppliers.filter(pk=supplier_id).exists():
        raise ValidationFailed("That supplier was not invited to this RFQ.", code="supplier_not_invited")
    from platform_core.organizations.models import Currency

    if not Currency.objects.filter(code=currency, is_active=True).exists():
        raise ValidationFailed("Currency is not active.", code="invalid_currency")
    if m.Quotation.objects.filter(rfq=rfq, supplier_id=supplier_id).exists():
        raise DomainError("This supplier already submitted a quotation.", code="quotation_exists")
    rfq_lines = {str(l.id): l for l in rfq.lines.all()}
    if {str(k) for k in prices} != set(rfq_lines):
        raise ValidationFailed("A unit price is required for every RFQ line.", code="incomplete_quotation")
    q = m.Quotation.objects.create(rfq=rfq, supplier_id=supplier_id, currency=currency, lead_time_days=int(lead_time_days), valid_until=valid_until)
    rows = []
    for line_id, price in prices.items():
        price = _dec(price, "unit_price")
        if price < 0:
            raise ValidationFailed("Prices cannot be negative.", code="invalid_amount")
        rows.append(m.QuotationLine(quotation=q, rfq_line=rfq_lines[str(line_id)], unit_price=price))
    m.QuotationLine.objects.bulk_create(rows)
    return q


def compare_bids(rfq_id, on_date=None):
    """Bid comparison in the base currency: per-line best price and total per quotation."""
    rfq = _get(m.Rfq, rfq_id, "RFQ")
    on_date = on_date or timezone.now().date()
    quotes = list(rfq.quotations.select_related("supplier").prefetch_related("lines"))
    totals, per_line = {}, {}
    for q in quotes:
        rate = org.get_rate(q.currency, on_date)
        total = ZERO
        for ql in q.lines.all():
            qty = ql.rfq_line.quantity
            base_price = ql.unit_price * rate
            total += base_price * qty
            best = per_line.get(str(ql.rfq_line_id))
            if best is None or base_price < best["base_unit_price"]:
                per_line[str(ql.rfq_line_id)] = {"supplier": q.supplier.name, "quotation": str(q.id), "base_unit_price": base_price}
        totals[str(q.id)] = {"supplier": q.supplier.name, "total_base": str(total.quantize(Decimal("0.01"), ROUND_HALF_UP)), "lead_time_days": q.lead_time_days, "total_value": total}
    ranking = sorted(totals.items(), key=lambda kv: (kv[1]["total_value"], kv[1]["lead_time_days"]))
    return {"rfq": rfq.number, "quotations": [{"quotation": k, **{a: b for a, b in v.items() if a != "total_value"}} for k, v in ranking],
            "best_per_line": {k: {**v, "base_unit_price": str(v["base_unit_price"])} for k, v in per_line.items()}, "lowest_total": ranking[0][0] if ranking else None}


@transaction.atomic
def award_rfq(actor_id, rfq_id, quotation_id, *, order_date=None):
    rfq = _lock(m.Rfq, rfq_id, "RFQ")
    if rfq.status != "OPEN":
        raise DomainError("This RFQ was already awarded or cancelled.", code="invalid_state_transition")
    q = m.Quotation.objects.filter(pk=quotation_id, rfq=rfq).select_related("supplier").first()
    if q is None:
        raise DomainError("Quotation not found.", code="not_found", status_code=404)
    q.is_awarded = True
    q.save(update_fields=["is_awarded", "updated_at"])
    rfq.status = "AWARDED"
    rfq.save(update_fields=["status", "updated_at"])
    lines = [{"product": ql.rfq_line.product_id, "description": ql.rfq_line.description, "quantity": ql.rfq_line.quantity, "unit_price": ql.unit_price} for ql in q.lines.select_related("rfq_line")]
    return create_po(actor_id, supplier_id=q.supplier_id, currency=q.currency, order_date=order_date or timezone.now().date(), lines=lines, requisition_id=rfq.requisition_id, quotation=q)


# ----------------------------------------------------------------------------- purchase orders
def _price_po(order, rows):
    order.total = sum((q * p for _, _, _, q, p in rows), ZERO)


@transaction.atomic
def create_po(actor_id, *, supplier_id, currency, order_date, lines, expected_date=None, requisition_id=None, quotation=None):
    supplier = _get(m.Supplier, supplier_id, "Supplier")
    if supplier.status != "QUALIFIED" or supplier.partner_id is None:
        raise DomainError("Purchase orders can only be raised to qualified suppliers.", code="supplier_not_qualified")
    from platform_core.organizations.models import Currency

    if not Currency.objects.filter(code=currency, is_active=True).exists():
        raise ValidationFailed("Currency is not active.", code="invalid_currency")
    req = None
    if requisition_id:
        req = _lock(m.Requisition, requisition_id, "Requisition")
        if req.status not in ("APPROVED", "CONVERTED"):
            raise DomainError("The requisition is not approved.", code="invalid_state_transition")
    rows = _lines_check(lines, "unit_price")
    order = m.PurchaseOrder(number=sequences.next_number("procurement.purchase_order", on_date=order_date, for_type="PurchaseOrder"), supplier=supplier, currency=currency, order_date=order_date, expected_date=expected_date, requisition=req, quotation=quotation, created_by=actor_id)
    _price_po(order, rows)
    order.save()
    m.PurchaseOrderLine.objects.bulk_create([m.PurchaseOrderLine(order=order, line_no=i, product=pr, description=d, quantity=q, unit_price=p) for i, pr, d, q, p in rows])
    if req and req.status == "APPROVED":
        req.status = "CONVERTED"
        req.save(update_fields=["status", "updated_at"])
    record_tenant_event(current_tenant(), "procurement.po.created", actor_user_id=actor_id, target_type="PurchaseOrder", target_id=order.id, metadata={"number": order.number, "total": str(order.total)})
    return order


@transaction.atomic
def update_po(actor_id, order_id, *, lines, expected_date=None, expected_version=None):
    order = _lock(m.PurchaseOrder, order_id, "Purchase order")
    if order.status != "DRAFT":
        raise DomainError("Only draft purchase orders can be edited.", code="invalid_state_transition")
    if expected_version is not None and expected_version != order.version:
        raise DomainError("The purchase order was changed by someone else.", code="version_conflict")
    rows = _lines_check(lines, "unit_price")
    order.lines.all().delete()
    _price_po(order, rows)
    if expected_date is not None:
        order.expected_date = expected_date
    order.version += 1
    order.save()
    m.PurchaseOrderLine.objects.bulk_create([m.PurchaseOrderLine(order=order, line_no=i, product=pr, description=d, quantity=q, unit_price=p) for i, pr, d, q, p in rows])
    return order


@transaction.atomic
def submit_po(actor_id, order_id):
    order = _lock(m.PurchaseOrder, order_id, "Purchase order")
    if order.status != "DRAFT":
        raise DomainError("Only draft purchase orders can be submitted.", code="invalid_state_transition")
    if order.total <= 0:
        raise DomainError("A purchase order with a zero total cannot be submitted.", code="zero_total")
    order.status = "PENDING_APPROVAL"
    base_total = order.total * org.get_rate(order.currency, order.order_date)  # thresholds are expressed in base currency
    _submit_for_approval(actor_id, order, PO_SUBJECT, base_total.quantize(Decimal("0.01")), f"PO {order.number} {order.supplier.name} {order.total} {order.currency}")
    order.save()
    return order


@transaction.atomic
def approve_po(actor_id, order_id):
    order = _lock(m.PurchaseOrder, order_id, "Purchase order")
    if order.status != "PENDING_APPROVAL":
        raise DomainError("Only submitted purchase orders can be approved.", code="invalid_state_transition")
    _direct_approve_guard(order, actor_id, order.created_by)
    order.status, order.approved_by = "APPROVED", actor_id
    order.save(update_fields=["status", "approved_by", "updated_at"])
    record_tenant_event(current_tenant(), "procurement.po.approved", actor_user_id=actor_id, target_type="PurchaseOrder", target_id=order.id)
    _after_approved("po", order)
    return order


@transaction.atomic
def cancel_po(actor_id, order_id):
    order = _lock(m.PurchaseOrder, order_id, "Purchase order")
    if order.status not in ("DRAFT", "PENDING_APPROVAL", "APPROVED") or order.receipts.exists():
        raise DomainError("A purchase order with receipts or already closed cannot be cancelled.", code="invalid_state_transition")
    if order.workflow_instance_id:
        inst = workflows.WorkflowInstance.objects.filter(pk=order.workflow_instance_id, status__in=workflows.WorkflowInstance.ACTIVE).first()
        if inst:
            order.workflow_instance_id = None
            order.save(update_fields=["workflow_instance_id"])
            workflows.cancel(actor_id, inst.id, comment="Purchase order cancelled")
            order = _lock(m.PurchaseOrder, order_id, "Purchase order")
    order.status = "CANCELLED"
    order.save(update_fields=["status", "updated_at"])
    return order


# ----------------------------------------------------------------------------- goods receipt
@transaction.atomic
def receive_goods(actor_id, order_id, *, location_id, receipt_date, lines, delivery_note=""):
    order = _lock(m.PurchaseOrder, order_id, "Purchase order")
    if order.status not in ("APPROVED", "PARTIALLY_RECEIVED"):
        raise DomainError("Goods can only be received against an approved purchase order.", code="invalid_state_transition")
    location = _get(im.Location, location_id, "Location")
    if not lines:
        raise ValidationFailed("At least one line is required.", code="no_lines")
    po_lines = {str(l.id): l for l in m.PurchaseOrderLine.objects.select_for_update(of=("self",)).filter(order=order).select_related("product")}
    seen = set()
    receipt = m.GoodsReceipt.objects.create(number=sequences.next_number("procurement.goods_receipt", on_date=receipt_date, for_type="GoodsReceipt"), order=order, location=location, receipt_date=receipt_date, received_by=actor_id, delivery_note=delivery_note[:60])
    rate = org.get_rate(order.currency, receipt_date)
    event_lines = []
    for raw in lines:
        line = po_lines.get(str(raw["po_line"]))
        qty = _dec(raw["quantity"], "quantity")
        if line is None or str(raw["po_line"]) in seen:
            raise ValidationFailed("Unknown or duplicated purchase order line.", code="invalid_line")
        seen.add(str(raw["po_line"]))
        if qty <= 0 or line.received_quantity + qty > line.quantity:
            raise ValidationFailed(f"Line {line.line_no}: receiving {qty} exceeds the ordered quantity ({line.quantity - line.received_quantity} still open).", code="over_receipt")
        movement_id = None
        if line.product and line.product.is_stocked:
            unit_cost = (line.unit_price * rate).quantize(Decimal("0.0001"), ROUND_HALF_UP)
            mv = inventory.receive_stock(actor_id, product_id=line.product_id, location_id=location.id, quantity=qty, unit_cost=unit_cost, lot_code=raw.get("lot_code") or None, ref_type="goods_receipt", ref_id=receipt.number, counter="grni", on_date=receipt_date)
            movement_id = mv.id
        line.received_quantity += qty
        line.save(update_fields=["received_quantity"])
        m.GoodsReceiptLine.objects.create(receipt=receipt, po_line=line, quantity=qty, lot_code=raw.get("lot_code") or "", stock_movement_id=movement_id)
        event_lines.append({"po_line": str(line.id), "quantity": str(qty)})
    complete = not m.PurchaseOrderLine.objects.filter(order=order, received_quantity__lt=models_f("quantity")).exists()
    order.status = "RECEIVED" if complete else "PARTIALLY_RECEIVED"
    order.save(update_fields=["status", "updated_at"])
    record_tenant_event(current_tenant(), "procurement.goods_received", actor_user_id=actor_id, target_type="GoodsReceipt", target_id=receipt.id, metadata={"number": receipt.number, "po": order.number})
    events.emit("inventory.goods_received", {"receipt_id": str(receipt.id), "po_id": str(order.id), "lines": event_lines}, dedup_key=f"goods-received-{receipt.id}")
    return receipt


def models_f(name):
    from django.db.models import F

    return F(name)


# ----------------------------------------------------------------------------- three-way match
def _tolerance():
    return Decimal(str(org.get_setting("procurement.match_tolerance_percent", 2))) / 100


def _grni_lines(invoice):
    return [l for l in invoice.lines.select_related("account") if l.account.system_key == "grni"]


@transaction.atomic
def match_invoice(actor_id, invoice_id, order_id):
    """Compare a supplier invoice's stock lines with what was ordered and received. MATCHED invoices may be
    posted; an EXCEPTION is recorded (and blocks posting) until receipts or the invoice change and it is re-run."""
    inv = fm.Invoice.objects.select_for_update().filter(pk=invoice_id).select_related("partner").first()
    order = _lock(m.PurchaseOrder, order_id, "Purchase order")
    if inv is None:
        raise DomainError("Invoice not found.", code="not_found", status_code=404)
    if inv.kind != "SUPPLIER_INVOICE" or inv.status in ("POSTED", "PAID", "VOID"):
        raise DomainError("Only unposted supplier invoices can be matched.", code="invalid_state_transition")
    if inv.partner_id != order.supplier.partner_id:
        raise ValidationFailed("The invoice is from a different supplier than the purchase order.", code="supplier_mismatch")
    if inv.currency != order.currency:
        raise ValidationFailed("Invoice and purchase order currencies differ.", code="currency_mismatch")
    goods = _grni_lines(inv)
    if not goods:
        raise ValidationFailed("The invoice has no goods-received-not-invoiced lines to match.", code="nothing_to_match")
    goods_value = sum((l.line_total for l in goods), ZERO)
    lines = order.lines.all()
    ordered = sum((l.quantity * l.unit_price for l in lines), ZERO)
    received = sum((l.received_quantity * l.unit_price for l in lines), ZERO)
    previous = m.InvoiceMatch.objects.select_for_update().filter(invoice=inv).first()
    already = order.invoiced_value - (previous.goods_value if previous and previous.status == "MATCHED" and previous.order_id == order.id else ZERO)
    tol = _tolerance()
    problems = {}
    if already + goods_value > received * (1 + tol):
        problems["not_received"] = f"invoiced {already + goods_value} exceeds received value {received}"
    if already + goods_value > ordered * (1 + tol):
        problems["not_ordered"] = f"invoiced {already + goods_value} exceeds ordered value {ordered}"
    status = "EXCEPTION" if problems else "MATCHED"
    q4 = lambda v: str(Decimal(v).quantize(Decimal("0.0001")))
    detail = {"ordered_value": q4(ordered), "received_value": q4(received), "previously_invoiced": q4(already), "invoice_goods_value": q4(goods_value), "tolerance_percent": str(tol * 100), "problems": problems}
    if previous is None:
        match = m.InvoiceMatch.objects.create(invoice=inv, order=order, status=status, goods_value=goods_value, detail=detail, matched_by=actor_id)
    else:
        if previous.status == "MATCHED":
            old = m.PurchaseOrder.objects.select_for_update().get(pk=previous.order_id)
            old.invoiced_value -= previous.goods_value
            old.save(update_fields=["invoiced_value"])
            order.refresh_from_db(fields=["invoiced_value"])
        previous.order, previous.status, previous.goods_value, previous.detail, previous.matched_by = order, status, goods_value, detail, actor_id
        previous.save()
        match = previous
    if status == "MATCHED":
        order.invoiced_value += goods_value
        order.save(update_fields=["invoiced_value"])
    record_tenant_event(current_tenant(), "procurement.invoice.matched", actor_user_id=actor_id, target_type="Invoice", target_id=inv.id, metadata={"status": status, "po": order.number})
    return match


def require_match_before_posting(invoice):
    if invoice.kind == "SUPPLIER_INVOICE" and _grni_lines(invoice):
        match = m.InvoiceMatch.objects.filter(invoice=invoice).first()
        if match is None or match.status != "MATCHED":
            raise DomainError("Three-way match required: match this invoice to a purchase order with a MATCHED result before posting.", code="three_way_match_required")


def release_match_on_void(invoice):
    match = m.InvoiceMatch.objects.select_for_update().filter(invoice=invoice).first()
    if match is None:
        return
    if match.status == "MATCHED":
        order = m.PurchaseOrder.objects.select_for_update().get(pk=match.order_id)
        order.invoiced_value -= match.goods_value
        order.save(update_fields=["invoiced_value"])
    match.delete()


# ----------------------------------------------------------------------------- analytics
def spend_by_supplier(date_from, date_to):
    rows = []
    qs = m.PurchaseOrder.objects.filter(order_date__gte=date_from, order_date__lte=date_to).exclude(status__in=["DRAFT", "PENDING_APPROVAL", "CANCELLED"])
    for r in qs.values("supplier_id", "supplier__name", "currency").annotate(ordered=Sum("total"), invoiced=Sum("invoiced_value")).order_by("-ordered"):
        rows.append({"supplier": r["supplier__name"], "currency": r["currency"], "ordered": str(r["ordered"]), "invoiced": str(r["invoiced"])})
    return rows

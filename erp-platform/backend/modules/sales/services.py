"""Sales services: price lists, quotations, orders (approval), deliveries (stock issue), customer invoicing
(finance drafts) and returns (stock back + credit note)."""
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Count, Sum
from django.utils import timezone

from modules.crm import models as cm
from modules.crm import services as crm
from modules.finance import models as fm
from modules.finance import services as finance
from modules.inventory import models as im
from modules.inventory import services as inventory
from modules.sales import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.organizations import services as org
from platform_core.organizations.models import Currency
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.sequences import services as sequences
from shared.tenancy import current_tenant
from shared.workflows import services as workflows

ZERO = Decimal("0")
ORDER_SUBJECT = "sales.order"


def _dec(value, field="amount"):
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValidationFailed(f"{field} must be a decimal number.", code="invalid_amount")


def _q(value, decimals):
    return Decimal(value).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def _get(model, pk, label, lock=False):
    qs = model.objects.select_for_update() if lock else model.objects
    obj = qs.filter(pk=pk).first()
    if obj is None:
        raise DomainError(f"{label} not found.", code="not_found", status_code=404)
    return obj


def _currency(code):
    cur = Currency.objects.filter(code=code, is_active=True).first()
    if cur is None:
        raise ValidationFailed(f"Currency {code} is not active.", code="invalid_currency")
    return cur


# ----------------------------------------------------------------------------- price lists
@transaction.atomic
def create_price_list(actor_id, *, name, currency, items, valid_from=None, valid_to=None):
    _currency(currency)
    if valid_from and valid_to and valid_from > valid_to:
        raise ValidationFailed("valid_from must not be after valid_to.", code="invalid_dates")
    pl = m.PriceList.objects.create(name=name, currency=currency, valid_from=valid_from, valid_to=valid_to)
    seen = set()
    for it in items:
        qty, price = _dec(it.get("min_quantity", 1), "min_quantity"), _dec(it["unit_price"], "unit_price")
        key = (str(it["product"]), qty)
        if qty <= 0 or price < 0 or key in seen:
            raise ValidationFailed("Items need a positive minimum quantity, a non-negative price and no duplicates.", code="invalid_item")
        seen.add(key)
        product = _get(im.Product, it["product"], "Product")
        m.PriceListItem.objects.create(price_list=pl, product=product, min_quantity=qty, unit_price=price)
    return pl


def price_for(product_id, currency, quantity, on_date):
    """Best list price: largest qualifying quantity break, then lowest price, across active valid lists."""
    items = m.PriceListItem.objects.filter(price_list__is_active=True, price_list__currency=currency, product_id=product_id, min_quantity__lte=quantity).filter(
        models_q_valid(on_date)).order_by("-min_quantity", "unit_price")
    item = items.first()
    return item.unit_price if item else None


def models_q_valid(on_date):
    from django.db.models import Q

    return (Q(price_list__valid_from__isnull=True) | Q(price_list__valid_from__lte=on_date)) & (Q(price_list__valid_to__isnull=True) | Q(price_list__valid_to__gte=on_date))


# ----------------------------------------------------------------------------- pricing engine
def _price_lines(currency, raw_lines, on_date):
    cur = _currency(currency)
    if not raw_lines:
        raise ValidationFailed("At least one line is required.", code="no_lines")
    taxes = {str(t.id): t for t in fm.TaxRate.objects.filter(id__in=[r["tax_rate"] for r in raw_lines if r.get("tax_rate")], is_active=True, kind="SALES")}
    rows, subtotal, tax_total, max_disc = [], ZERO, ZERO, ZERO
    for i, r in enumerate(raw_lines, start=1):
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
        if r.get("unit_price") not in (None, ""):
            price = _dec(r["unit_price"], "unit_price")
        elif product:
            price = price_for(product.id, currency, qty, on_date)
            if price is None:
                raise ValidationFailed(f"Line {i}: no price list entry for {product.sku} in {currency}.", code="no_price")
        else:
            raise ValidationFailed(f"Line {i}: unit_price is required.", code="invalid_amount")
        disc = _dec(r.get("discount_percent", 0), "discount_percent")
        if price < 0 or not (ZERO <= disc <= 100):
            raise ValidationFailed(f"Line {i}: price must be non-negative and discount between 0 and 100.", code="invalid_amount")
        tax = taxes.get(str(r["tax_rate"])) if r.get("tax_rate") else None
        if r.get("tax_rate") and tax is None:
            raise ValidationFailed(f"Line {i}: unknown or inactive sales tax rate.", code="invalid_tax_rate")
        net = _q(price * (100 - disc) / 100, 4)
        total = _q(qty * net, cur.decimals)
        tax_amount = _q(total * tax.rate / 100, cur.decimals) if tax else ZERO
        subtotal += total
        tax_total += tax_amount
        max_disc = max(max_disc, disc)
        rows.append(dict(line_no=i, product=product, description=desc[:300], quantity=qty, unit_price=price, discount_percent=disc, net_unit_price=net, tax_rate=tax, line_total=total, tax_amount=tax_amount))
    return rows, subtotal, tax_total, max_disc


def _save_lines(model, parent_field, parent, rows):
    model.objects.bulk_create([model(**{parent_field: parent}, **row) for row in rows])


# ----------------------------------------------------------------------------- customers
@transaction.atomic
def ensure_customer(actor_id, account):
    """The finance counterpart of a CRM account, created once."""
    account = cm.CrmAccount.objects.select_for_update().get(pk=account.pk)
    if account.partner_id is None:
        account.partner = finance.create_partner(actor_id, name=account.name, is_customer=True, tax_id=account.tax_id, external_ref=str(account.id))
        account.save(update_fields=["partner", "updated_at"])
    return account.partner


# ----------------------------------------------------------------------------- quotations
@transaction.atomic
def create_quotation(actor_id, *, account_id, currency, lines, valid_until=None, opportunity_id=None):
    account = crm._own(cm.CrmAccount, account_id, actor_id, "Account")
    opp = crm._own(cm.Opportunity, opportunity_id, actor_id, "Opportunity") if opportunity_id else None
    if opp and opp.account_id != account.id:
        raise ValidationFailed("The opportunity belongs to a different account.", code="invalid_opportunity")
    today = timezone.now().date()
    rows, sub, tax, _ = _price_lines(currency, lines, today)
    q = m.Quotation.objects.create(number=sequences.next_number("sales.quotation", for_type="Quotation"), account=account, opportunity=opp, currency=currency, valid_until=valid_until, subtotal=sub, tax_total=tax, total=sub + tax, created_by=actor_id)
    _save_lines(m.QuotationLine, "quotation", q, rows)
    return q


@transaction.atomic
def update_quotation(actor_id, quotation_id, *, lines, valid_until=None, expected_version=None):
    q = _get(m.Quotation, quotation_id, "Quotation", lock=True)
    crm._own(cm.CrmAccount, q.account_id, actor_id, "Quotation")
    if q.status != "DRAFT":
        raise DomainError("Only draft quotations can be edited.", code="invalid_state_transition")
    if expected_version is not None and expected_version != q.version:
        raise DomainError("The quotation was changed by someone else.", code="version_conflict")
    rows, sub, tax, _ = _price_lines(q.currency, lines, timezone.now().date())
    q.lines.all().delete()
    q.subtotal, q.tax_total, q.total, q.version = sub, tax, sub + tax, q.version + 1
    if valid_until is not None:
        q.valid_until = valid_until
    q.save()
    _save_lines(m.QuotationLine, "quotation", q, rows)
    return q


def _transition(model, label, pk, actor_id, allowed_from, to, extra=None):
    obj = _get(model, pk, label, lock=True)
    crm._own(cm.CrmAccount, obj.account_id, actor_id, label)
    if obj.status not in allowed_from:
        raise DomainError(f"A {obj.status} {label.lower()} cannot become {to}.", code="invalid_state_transition")
    if extra:
        extra(obj)
    obj.status = to
    obj.save(update_fields=["status", "updated_at"])
    return obj


def send_quotation(actor_id, quotation_id):
    return _transition(m.Quotation, "Quotation", quotation_id, actor_id, ("DRAFT",), "SENT")


def reject_quotation(actor_id, quotation_id):
    return _transition(m.Quotation, "Quotation", quotation_id, actor_id, ("SENT",), "REJECTED")


def accept_quotation(actor_id, quotation_id):
    def check(q):
        if q.valid_until and q.valid_until < timezone.now().date():
            raise DomainError("This quotation has expired.", code="quotation_expired")

    with transaction.atomic():
        return _transition(m.Quotation, "Quotation", quotation_id, actor_id, ("SENT",), "ACCEPTED", check)


@transaction.atomic
def convert_quotation(actor_id, quotation_id, *, order_date=None):
    q = _get(m.Quotation, quotation_id, "Quotation", lock=True)
    crm._own(cm.CrmAccount, q.account_id, actor_id, "Quotation")
    if q.status != "ACCEPTED":
        raise DomainError("Only an accepted quotation can become an order.", code="invalid_state_transition")
    lines = [{"product": l.product_id, "description": l.description, "quantity": l.quantity, "unit_price": l.unit_price, "discount_percent": l.discount_percent, "tax_rate": l.tax_rate_id} for l in q.lines.all()]
    order = create_order(actor_id, account_id=q.account_id, currency=q.currency, order_date=order_date or timezone.now().date(), lines=lines, opportunity_id=q.opportunity_id, quotation=q)
    q.status = "CONVERTED"
    q.save(update_fields=["status", "updated_at"])
    return order


# ----------------------------------------------------------------------------- orders
@transaction.atomic
def create_order(actor_id, *, account_id, currency, order_date, lines, opportunity_id=None, quotation=None):
    account = crm._own(cm.CrmAccount, account_id, actor_id, "Account")
    if not account.is_active:
        raise ValidationFailed("The account is inactive.", code="invalid_account")
    opp = crm._own(cm.Opportunity, opportunity_id, actor_id, "Opportunity") if opportunity_id else None
    rows, sub, tax, max_disc = _price_lines(currency, lines, order_date)
    order = m.SalesOrder.objects.create(number=sequences.next_number("sales.order", on_date=order_date, for_type="SalesOrder"), account=account, opportunity=opp, quotation=quotation, currency=currency, order_date=order_date, subtotal=sub, tax_total=tax, total=sub + tax, max_discount=max_disc, created_by=actor_id)
    _save_lines(m.SalesOrderLine, "order", order, rows)
    record_tenant_event(current_tenant(), "sales.order.created", actor_user_id=actor_id, target_type="SalesOrder", target_id=order.id, metadata={"number": order.number, "total": str(order.total)})
    return order


@transaction.atomic
def update_order(actor_id, order_id, *, lines, expected_version=None):
    order = _get(m.SalesOrder, order_id, "Order", lock=True)
    crm._own(cm.CrmAccount, order.account_id, actor_id, "Order")
    if order.status != "DRAFT":
        raise DomainError("Only draft orders can be edited.", code="invalid_state_transition")
    if expected_version is not None and expected_version != order.version:
        raise DomainError("The order was changed by someone else.", code="version_conflict")
    rows, sub, tax, max_disc = _price_lines(order.currency, lines, order.order_date)
    order.lines.all().delete()
    order.subtotal, order.tax_total, order.total, order.max_discount, order.version = sub, tax, sub + tax, max_disc, order.version + 1
    order.save()
    _save_lines(m.SalesOrderLine, "order", order, rows)
    return order


def _needs_approval(order):
    limit = Decimal(str(org.get_setting("sales.max_discount_percent", 10)))
    threshold = Decimal(str(org.get_setting("sales.approval_threshold", 10000)))
    base_total = order.total * org.get_rate(order.currency, order.order_date)
    return order.max_discount > limit or base_total >= threshold, base_total


def _confirm(order, approver_id):
    order.status, order.approved_by = "CONFIRMED", approver_id
    order.save(update_fields=["status", "approved_by", "updated_at"])
    events.emit("sales.order.confirmed", {"order_id": str(order.id), "number": order.number, "account_id": str(order.account_id), "total": str(order.total), "currency": order.currency}, dedup_key=f"order-confirmed-{order.id}")
    if order.opportunity_id and cm.Opportunity.objects.filter(pk=order.opportunity_id, status="OPEN").exists():
        crm.win_opportunity(approver_id or order.created_by, order.opportunity_id, system=True)


@transaction.atomic
def submit_order(actor_id, order_id):
    order = _get(m.SalesOrder, order_id, "Order", lock=True)
    crm._own(cm.CrmAccount, order.account_id, actor_id, "Order")
    if order.status != "DRAFT":
        raise DomainError("Only draft orders can be submitted.", code="invalid_state_transition")
    if order.total <= 0:
        raise DomainError("An order with a zero total cannot be submitted.", code="zero_total")
    needs, base_total = _needs_approval(order)
    has_workflow = workflows.WorkflowDefinition.objects.filter(subject_type=ORDER_SUBJECT, is_active=True).exists()
    if not needs:
        _confirm(order, None)  # within the discount and value limits: no approval needed
        return order
    order.approval_required, order.status = True, "PENDING_APPROVAL"
    if has_workflow:
        inst = workflows.submit(actor_id, ORDER_SUBJECT, str(order.id), amount=base_total.quantize(Decimal("0.01")), title=f"Order {order.number} {order.total} {order.currency}")
        order.workflow_instance_id = inst.id
    order.save()
    return order


@transaction.atomic
def approve_order(actor_id, order_id):
    order = _get(m.SalesOrder, order_id, "Order", lock=True)
    if order.status != "PENDING_APPROVAL":
        raise DomainError("Only orders awaiting approval can be approved.", code="invalid_state_transition")
    if order.workflow_instance_id:
        raise DomainError("This order is governed by an approval workflow; decide it in the approval inbox.", code="workflow_governed")
    if order.created_by == actor_id:
        raise DomainError("Separation of duties: you cannot approve an order you created.", code="separation_of_duties", status_code=403)
    _confirm(order, actor_id)
    record_tenant_event(current_tenant(), "sales.order.approved", actor_user_id=actor_id, target_type="SalesOrder", target_id=order.id)
    return order


def _on_outcome(instance):
    order = m.SalesOrder.objects.select_for_update().filter(pk=instance.subject_id).first()
    if order is None or order.workflow_instance_id != instance.id or order.status != "PENDING_APPROVAL":
        return
    if instance.status == "APPROVED":
        last = instance.actions.filter(action="APPROVED").order_by("-created_at").first()
        _confirm(order, last.actor_id if last else None)
    else:
        order.status, order.workflow_instance_id, order.approval_required = "DRAFT", None, False
        order.save(update_fields=["status", "workflow_instance_id", "approval_required", "updated_at"])


@transaction.atomic
def cancel_order(actor_id, order_id):
    order = _get(m.SalesOrder, order_id, "Order", lock=True)
    crm._own(cm.CrmAccount, order.account_id, actor_id, "Order")
    if order.status not in ("DRAFT", "PENDING_APPROVAL", "CONFIRMED") or order.deliveries.exists():
        raise DomainError("An order with deliveries or already closed cannot be cancelled.", code="invalid_state_transition")
    if order.workflow_instance_id:
        inst = workflows.WorkflowInstance.objects.filter(pk=order.workflow_instance_id, status__in=workflows.WorkflowInstance.ACTIVE).first()
        if inst:
            order.workflow_instance_id = None
            order.save(update_fields=["workflow_instance_id"])
            workflows.cancel(actor_id, inst.id, comment="Order cancelled")
            order = _get(m.SalesOrder, order_id, "Order", lock=True)
    order.status = "CANCELLED"
    order.save(update_fields=["status", "updated_at"])
    return order


# ----------------------------------------------------------------------------- deliveries
@transaction.atomic
def create_delivery(actor_id, order_id, *, location_id, delivery_date, lines, carrier="", tracking_ref=""):
    order = _get(m.SalesOrder, order_id, "Order", lock=True)
    if order.status not in ("CONFIRMED", "PARTIALLY_DELIVERED"):
        raise DomainError("Only confirmed orders can be delivered.", code="invalid_state_transition")
    location = _get(im.Location, location_id, "Location")
    if not lines:
        raise ValidationFailed("At least one line is required.", code="no_lines")
    olines = {str(l.id): l for l in m.SalesOrderLine.objects.select_for_update(of=("self",)).filter(order=order).select_related("product")}
    delivery = m.Delivery.objects.create(number=sequences.next_number("sales.delivery", on_date=delivery_date, for_type="Delivery"), order=order, location=location, delivery_date=delivery_date, carrier=carrier[:80], tracking_ref=tracking_ref[:80], delivered_by=actor_id)
    seen, out = set(), []
    for raw in lines:
        line = olines.get(str(raw["order_line"]))
        qty = _dec(raw["quantity"], "quantity")
        if line is None or str(raw["order_line"]) in seen:
            raise ValidationFailed("Unknown or duplicated order line.", code="invalid_line")
        seen.add(str(raw["order_line"]))
        if qty <= 0 or line.delivered_quantity + qty > line.quantity:
            raise ValidationFailed(f"Line {line.line_no}: delivering {qty} exceeds the open quantity {line.quantity - line.delivered_quantity}.", code="over_delivery")
        cost, movement_id = ZERO, None
        if line.product and line.product.is_stocked:
            mv = inventory.issue_stock(actor_id, product_id=line.product_id, location_id=location.id, quantity=qty, lot_code=raw.get("lot_code") or None, reason=f"Delivery {delivery.number}", ref_type="delivery", ref_id=delivery.number, on_date=delivery_date)
            cost, movement_id = mv.unit_cost, mv.id
        line.delivered_quantity += qty
        line.save(update_fields=["delivered_quantity"])
        m.DeliveryLine.objects.create(delivery=delivery, order_line=line, quantity=qty, lot_code=raw.get("lot_code") or "", unit_cost=cost, stock_movement_id=movement_id)
        out.append({"order_line": str(line.id), "quantity": str(qty)})
    complete = not m.SalesOrderLine.objects.filter(order=order, delivered_quantity__lt=models_f("quantity")).exists()
    order.status = "DELIVERED" if complete else "PARTIALLY_DELIVERED"
    order.save(update_fields=["status", "updated_at"])
    events.emit("sales.delivery.completed", {"delivery_id": str(delivery.id), "order_id": str(order.id), "lines": out}, dedup_key=f"delivery-completed-{delivery.id}")
    return delivery


def models_f(name):
    from django.db.models import F

    return F(name)


# ----------------------------------------------------------------------------- invoicing
def _refresh_invoiced_status(order):
    all_done = not any(l.net_invoiced != l.quantity for l in order.lines.all())
    if all_done and order.status == "DELIVERED":
        order.status = "INVOICED"
        order.save(update_fields=["status", "updated_at"])
    elif not all_done and order.status == "INVOICED":
        order.status = "DELIVERED"
        order.save(update_fields=["status", "updated_at"])


@transaction.atomic
def invoice_order(actor_id, order_id, *, lines=None, invoice_date=None):
    """Create a DRAFT customer invoice in finance for delivered, not-yet-invoiced quantities."""
    order = _get(m.SalesOrder, order_id, "Order", lock=True)
    if order.status not in ("PARTIALLY_DELIVERED", "DELIVERED"):
        raise DomainError("Only delivered orders can be invoiced.", code="invalid_state_transition")
    olines = {str(l.id): l for l in m.SalesOrderLine.objects.select_for_update(of=("self",)).filter(order=order).select_related("product", "tax_rate")}
    if lines is None:
        wanted = {k: l.invoiceable for k, l in olines.items() if l.invoiceable > 0}
    else:
        wanted = {}
        for raw in lines:
            line = olines.get(str(raw["order_line"]))
            qty = _dec(raw["quantity"], "quantity")
            if line is None or str(raw["order_line"]) in wanted:
                raise ValidationFailed("Unknown or duplicated order line.", code="invalid_line")
            if qty <= 0 or qty > line.invoiceable:
                raise ValidationFailed(f"Line {line.line_no}: only {line.invoiceable} can still be invoiced.", code="over_invoicing")
            wanted[str(raw["order_line"])] = qty
    if not wanted:
        raise DomainError("Nothing is left to invoice.", code="nothing_to_invoice")
    partner = ensure_customer(actor_id, order.account)
    invoice_date = invoice_date or timezone.now().date()
    revenue = finance.system_account("sales_revenue")
    fin_lines = [{"description": olines[k].description, "quantity": q, "unit_price": olines[k].net_unit_price, "account": str(revenue.id), "tax_rate": str(olines[k].tax_rate_id) if olines[k].tax_rate_id else None} for k, q in wanted.items()]
    terms = int(org.get_setting("sales.payment_terms_days", 30))
    invoice = finance.create_invoice(actor_id, kind="CUSTOMER_INVOICE", partner_id=partner.id, invoice_date=invoice_date, due_date=invoice_date + timedelta(days=terms), currency=order.currency, lines=fin_lines, supplier_ref=order.number)
    for k, q in wanted.items():
        line = olines[k]
        line.invoiced_quantity += q
        line.save(update_fields=["invoiced_quantity"])
        m.InvoicedLine.objects.create(invoice=invoice, order_line=line, quantity=q)
    _refresh_invoiced_status(order)
    return invoice


def release_invoiced_on_void(invoice):
    """Finance void hook: a voided draft invoice frees the order quantities it had taken; a voided return
    credit note frees the credited quantities."""
    taken = list(m.InvoicedLine.objects.select_for_update().filter(invoice=invoice).select_related("order_line"))
    for t in taken:
        line = m.SalesOrderLine.objects.select_for_update().get(pk=t.order_line_id)
        line.invoiced_quantity -= t.quantity
        line.save(update_fields=["invoiced_quantity"])
    orders = {t.order_line.order_id for t in taken}
    m.InvoicedLine.objects.filter(invoice=invoice).delete()
    ret = m.SalesReturn.objects.select_for_update().filter(credit_note=invoice).first()
    if ret:
        for rl in ret.lines.select_related("order_line"):
            if rl.credit_quantity:
                line = m.SalesOrderLine.objects.select_for_update().get(pk=rl.order_line_id)
                line.credited_quantity -= rl.credit_quantity
                line.save(update_fields=["credited_quantity"])
                rl.credit_quantity = 0
                rl.save(update_fields=["credit_quantity"])
        ret.credit_note = None
        ret.save(update_fields=["credit_note", "updated_at"])
        orders.add(ret.order_id)
    for oid in orders:
        _refresh_invoiced_status(m.SalesOrder.objects.select_for_update().get(pk=oid))


# ----------------------------------------------------------------------------- returns
@transaction.atomic
def process_return(actor_id, order_id, *, location_id, return_date, reason, lines):
    """Goods come back: stock is restored at the cost they left with and a customer credit note (draft) is
    raised for the part that had already been invoiced."""
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    order = _get(m.SalesOrder, order_id, "Order", lock=True)
    if not order.deliveries.exists():
        raise DomainError("Nothing was delivered on this order.", code="invalid_state_transition")
    location = _get(im.Location, location_id, "Location")
    if not lines:
        raise ValidationFailed("At least one line is required.", code="no_lines")
    olines = {str(l.id): l for l in m.SalesOrderLine.objects.select_for_update(of=("self",)).filter(order=order).select_related("product", "tax_rate")}
    rma = m.SalesReturn.objects.create(number=sequences.next_number("sales.return", on_date=return_date, for_type="SalesReturn"), order=order, location=location, return_date=return_date, reason=reason[:300], processed_by=actor_id)
    seen, credit_lines = set(), []
    for raw in lines:
        line = olines.get(str(raw["order_line"]))
        qty = _dec(raw["quantity"], "quantity")
        if line is None or str(raw["order_line"]) in seen:
            raise ValidationFailed("Unknown or duplicated order line.", code="invalid_line")
        seen.add(str(raw["order_line"]))
        if qty <= 0 or line.returned_quantity + qty > line.delivered_quantity:
            raise ValidationFailed(f"Line {line.line_no}: only {line.delivered_quantity - line.returned_quantity} can still be returned.", code="over_return")
        uninvoiced_present = max(line.delivered_quantity - line.returned_quantity - line.net_invoiced, ZERO)
        credit_qty = max(qty - uninvoiced_present, ZERO)
        if line.product and line.product.is_stocked:
            dl = list(m.DeliveryLine.objects.filter(order_line=line))
            total_q = sum((d.quantity for d in dl), ZERO)
            avg = (sum((d.quantity * d.unit_cost for d in dl), ZERO) / total_q) if total_q else ZERO
            inventory.receive_stock(actor_id, product_id=line.product_id, location_id=location.id, quantity=qty, unit_cost=_q(avg, 4), lot_code=raw.get("lot_code") or None, ref_type="return", ref_id=rma.number, reason=f"Return {rma.number}: {reason}"[:300], counter="cogs", on_date=return_date)
        line.returned_quantity += qty
        line.credited_quantity += credit_qty
        line.save(update_fields=["returned_quantity", "credited_quantity"])
        m.SalesReturnLine.objects.create(sales_return=rma, order_line=line, quantity=qty, credit_quantity=credit_qty, lot_code=raw.get("lot_code") or "")
        if credit_qty > 0:
            credit_lines.append((line, credit_qty))
    if credit_lines:
        partner = ensure_customer(actor_id, order.account)
        revenue = finance.system_account("sales_revenue")
        originals = {il.invoice_id for line, _ in credit_lines for il in m.InvoicedLine.objects.filter(order_line=line)}
        credit_for = originals.pop() if len(originals) == 1 else None
        note = finance.create_invoice(actor_id, kind="CUSTOMER_CREDIT_NOTE", partner_id=partner.id, invoice_date=return_date, currency=order.currency, credit_for_id=credit_for, supplier_ref=rma.number,
                                      lines=[{"description": f"Return: {l.description}", "quantity": q, "unit_price": l.net_unit_price, "account": str(revenue.id), "tax_rate": str(l.tax_rate_id) if l.tax_rate_id else None} for l, q in credit_lines])
        rma.credit_note = note
        rma.save(update_fields=["credit_note", "updated_at"])
    _refresh_invoiced_status(order)
    record_tenant_event(current_tenant(), "sales.return.processed", actor_user_id=actor_id, target_type="SalesReturn", target_id=rma.id, metadata={"number": rma.number, "order": order.number})
    return rma


# ----------------------------------------------------------------------------- analytics
def sales_report(date_from, date_to):
    orders = m.SalesOrder.objects.filter(order_date__gte=date_from, order_date__lte=date_to, status__in=["CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED", "INVOICED"])
    by_customer = [{"customer": r["account__name"], "currency": r["currency"], "orders": r["n"], "total": str(r["t"])} for r in orders.values("account__name", "currency").annotate(n=Count("id"), t=Sum("total")).order_by("-t")]
    by_product = [{"sku": r["product__sku"] or "-", "currency": r["order__currency"], "quantity": str(r["q"]), "revenue": str(r["rev"])} for r in m.SalesOrderLine.objects.filter(order__in=orders).values("product__sku", "order__currency").annotate(q=Sum("quantity"), rev=Sum("line_total")).order_by("-rev")]
    return {"by_customer": by_customer, "by_product": by_product}

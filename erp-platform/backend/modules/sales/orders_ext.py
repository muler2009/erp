"""Order control: credit exposure and customer restrictions, stock reservations with backorders, controlled
amendments of confirmed orders, and outstanding-quantity reporting."""
from decimal import Decimal

from django.db import transaction
from django.db.models import Max, Sum
from django.utils import timezone

from modules.crm import models as cm
from modules.crm import services as crm
from modules.finance import models as fm
from modules.finance import services as finance
from modules.inventory import models as im
from modules.sales import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.tenancy import current_tenant

ZERO = Decimal("0")
OPEN_ORDER = ("CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED")


# ----------------------------------------------------------------------------- credit
def exposure(account, exclude_order_id=None, today=None):
    """What the customer already owes or is about to owe, in the base currency: unpaid posted invoices plus the
    uninvoiced value of confirmed orders."""
    today = today or timezone.now().date()
    receivables = ZERO
    if account.partner_id:
        for inv in fm.Invoice.objects.filter(partner_id=account.partner_id, kind="CUSTOMER_INVOICE", status="POSTED"):
            receivables += (inv.total - inv.paid_amount) * (inv.fx_rate or org.get_rate(inv.currency, inv.invoice_date))
    open_orders = ZERO
    for o in m.SalesOrder.objects.filter(account=account, status__in=OPEN_ORDER).exclude(pk=exclude_order_id):
        value = sum(((l.quantity - l.invoiced_quantity) * l.net_unit_price for l in o.lines.all()), ZERO)
        open_orders += max(value, ZERO) * org.get_rate(o.currency, today)
    return {"receivables": receivables, "open_orders": open_orders, "total": receivables + open_orders}


def credit_reason(order):
    """None when the customer may order; raises for blocked customers; returns the reason when a manager must approve."""
    acct = order.account
    if acct.credit_status == "BLOCKED":
        raise DomainError(f"This customer is blocked from new orders. {acct.restriction_note}".strip(), code="customer_blocked", status_code=409)
    if acct.credit_status == "ON_HOLD":
        return "customer_on_hold"
    if acct.credit_limit is not None:
        today = timezone.now().date()
        new_value = order.total * org.get_rate(order.currency, today)
        if exposure(acct, exclude_order_id=order.id, today=today)["total"] + new_value > acct.credit_limit:
            return "credit_limit_exceeded"
    return None


def credit_position(user_id, account_id):
    acct = crm._own(cm.CrmAccount, account_id, user_id, "Account")
    e = exposure(acct)
    return {"credit_status": acct.credit_status, "credit_limit": str(acct.credit_limit) if acct.credit_limit is not None else None, "receivables": str(e["receivables"]), "open_orders": str(e["open_orders"]), "exposure": str(e["total"]),
            "available_credit": str(acct.credit_limit - e["total"]) if acct.credit_limit is not None else None}


# ----------------------------------------------------------------------------- reservations / backorders
def _on_hand(product_id):
    return im.StockLevel.objects.filter(product_id=product_id).aggregate(q=Sum("quantity"))["q"] or ZERO


def _reserved_elsewhere(product_id, line_id):
    return m.OrderReservation.objects.filter(product_id=product_id).exclude(order_line_id=line_id).aggregate(q=Sum("quantity"))["q"] or ZERO


def open_quantity(line):
    return max(line.quantity - line.delivered_quantity, ZERO)


def reserve_line(line):
    """Reserve what is available for one line (never more than its open quantity).  Returns the reserved quantity."""
    if line.product_id is None or not line.product.is_stocked:
        return ZERO
    im.Product.objects.select_for_update().get(pk=line.product_id)  # serialise reservations per product
    res, _ = m.OrderReservation.objects.get_or_create(order_line=line, defaults={"product_id": line.product_id})
    free = max(_on_hand(line.product_id) - _reserved_elsewhere(line.product_id, line.id), ZERO)
    res.quantity = min(open_quantity(line), free)
    res.save(update_fields=["quantity", "updated_at"])
    return res.quantity


def reserve_order(order):
    n = ZERO
    for line in order.lines.select_related("product").order_by("line_no"):
        n += reserve_line(line)
    return n


def release_order(order):
    m.OrderReservation.objects.filter(order_line__order=order).delete()


def consume(line, quantity):
    """A delivery takes stock that was reserved for the line."""
    res = m.OrderReservation.objects.select_for_update().filter(order_line=line).first()
    if res:
        res.quantity = max(res.quantity - quantity, ZERO)
        res.save(update_fields=["quantity", "updated_at"])


def backordered(line):
    if line.product_id is None or not line.product.is_stocked:
        return ZERO
    res = getattr(line, "reservation", None)
    return max(open_quantity(line) - (res.quantity if res else ZERO), ZERO)


@transaction.atomic
def retry_backorders(today=None):
    """Give newly available stock to waiting lines, oldest order first.  Idempotent; returns lines that gained stock."""
    gained = 0
    lines = m.SalesOrderLine.objects.select_for_update(of=("self",)).filter(order__status__in=("CONFIRMED", "PARTIALLY_DELIVERED"), product__is_stocked=True).select_related("product", "order").order_by("order__created_at", "line_no")
    for line in lines:
        before = getattr(getattr(line, "reservation", None), "quantity", ZERO)
        if backordered(line) > 0 and reserve_line(line) > before:
            gained += 1
            notify([line.order.created_by], "sales.order.stock_available", f"Stock available for {line.order.number}", f"{line.description}: more stock has been reserved.", ref_type="SalesOrder", ref_id=str(line.order_id))
    return gained


def outstanding(order):
    rows = []
    for l in order.lines.select_related("product").order_by("line_no"):
        rows.append({"line": str(l.id), "line_no": l.line_no, "description": l.description, "ordered": str(l.quantity), "delivered": str(l.delivered_quantity), "returned": str(l.returned_quantity), "invoiced": str(l.invoiced_quantity),
                     "to_deliver": str(open_quantity(l)), "to_invoice": str(l.invoiceable), "reserved": str(getattr(getattr(l, "reservation", None), "quantity", ZERO)), "backordered": str(backordered(l))})
    return rows


def backorder_report(user_id):
    out = []
    qs = crm.scope(m.SalesOrderLine.objects.filter(order__status__in=("CONFIRMED", "PARTIALLY_DELIVERED"), product__is_stocked=True), user_id, owner_field="order__account__owner_id").select_related("order", "product").order_by("order__created_at")
    for l in qs:
        b = backordered(l)
        if b > 0:
            out.append({"order": l.order.number, "order_id": str(l.order_id), "line": str(l.id), "product": l.product.sku, "backordered": str(b), "ordered": str(l.quantity), "since": l.order.created_at.isoformat()})
    return out


# ----------------------------------------------------------------------------- controlled amendment
def _snapshot(order):
    return {"version": order.version, "total": str(order.total), "lines": [{"id": str(l.id), "line_no": l.line_no, "description": l.description, "quantity": str(l.quantity), "line_total": str(l.line_total)} for l in order.lines.order_by("line_no")]}


@transaction.atomic
def request_amendment(actor_id, order_id, *, quantities=None, add=None, reason):
    from modules.sales import services as sales

    order = sales._get(m.SalesOrder, order_id, "Order", lock=True)
    crm._own(cm.CrmAccount, order.account_id, actor_id, "Order")
    if order.status not in OPEN_ORDER:
        raise DomainError("Only confirmed orders can be amended; edit drafts directly.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    quantities, add = quantities or {}, add or []
    if not quantities and not add:
        raise ValidationFailed("Nothing to amend.", code="no_changes")
    lines = {str(l.id): l for l in order.lines.all()}
    for lid, q in quantities.items():
        line = lines.get(str(lid))
        if line is None:
            raise ValidationFailed("Unknown order line.", code="invalid_line")
        qty = sales._dec(q, "quantity")
        floor = max(line.delivered_quantity, line.invoiced_quantity)
        if qty < floor or qty < 0 or (qty == 0 and floor > 0):
            raise ValidationFailed(f"Line {line.line_no}: quantity cannot go below what was already delivered or invoiced ({floor}).", code="below_fulfilled")
    if m.OrderAmendment.objects.filter(order=order, status="PENDING").exists():
        raise DomainError("This order already has an amendment waiting for approval.", code="amendment_pending")
    if add:  # validate prices and rules now so the approver sees a priceable change
        sales._price_lines(order.currency, add, timezone.now().date(), actor_id, order.account)
    a = m.OrderAmendment.objects.create(order=order, reason=reason.strip()[:300], changes={"quantities": {str(k): str(v) for k, v in quantities.items()}, "add": add}, total_before=order.total, requested_by=actor_id)
    record_tenant_event(current_tenant(), "sales.order.amendment_requested", actor_user_id=actor_id, target_type="SalesOrder", target_id=order.id, metadata={"amendment": str(a.id)})
    return a


@transaction.atomic
def approve_amendment(actor_id, amendment_id):
    from modules.sales import services as sales

    a = m.OrderAmendment.objects.select_for_update().filter(pk=amendment_id).first()
    if a is None:
        raise DomainError("Amendment not found.", code="not_found", status_code=404)
    if not authz.has_permission(actor_id, "sales.order.approve"):
        raise DomainError("You may not approve order amendments.", code="permission_denied", status_code=403)
    if a.status != "PENDING":
        raise DomainError("This amendment was already decided.", code="invalid_state_transition")
    if a.requested_by == actor_id:
        raise DomainError("You cannot approve your own amendment.", code="separation_of_duties", status_code=403)
    order = sales._get(m.SalesOrder, a.order_id, "Order", lock=True)
    if order.status not in OPEN_ORDER:
        raise DomainError("The order can no longer be amended.", code="invalid_state_transition")
    a.before_snapshot = _snapshot(order)
    cur = sales._currency(order.currency)
    lines = {str(l.id): l for l in m.SalesOrderLine.objects.select_for_update(of=("self",)).filter(order=order)}
    for lid, q in a.changes["quantities"].items():
        line, qty = lines[lid], Decimal(q)
        floor = max(line.delivered_quantity, line.invoiced_quantity)
        if qty < floor:
            raise DomainError("Fulfilment moved on since the request; request the amendment again.", code="stale_amendment")
        if qty == 0:
            line.delete()
            continue
        line.quantity = qty
        line.line_total = sales._q(qty * line.net_unit_price, cur.decimals)
        line.tax_amount = sales._q(line.line_total * line.tax_rate.rate / 100, cur.decimals) if line.tax_rate_id else ZERO
        line.save(update_fields=["quantity", "line_total", "tax_amount"])
    if a.changes["add"]:
        rows, _, _, _ = sales._price_lines(order.currency, a.changes["add"], timezone.now().date(), a.requested_by, order.account)
        start = m.SalesOrderLine.objects.filter(order=order).aggregate(x=Max("line_no"))["x"] or 0
        for i, r in enumerate(rows, start=1):
            r["line_no"] = start + i
        sales._save_lines(m.SalesOrderLine, "order", order, rows)
    remaining = list(order.lines.all())
    if not remaining:
        raise ValidationFailed("An order needs at least one line; cancel it instead.", code="no_lines")
    order.subtotal = sum((l.line_total for l in remaining), ZERO)
    order.tax_total = sum((l.tax_amount for l in remaining), ZERO)
    order.total = order.subtotal + order.tax_total
    any_delivered = any(l.delivered_quantity > 0 for l in remaining)
    complete = all(l.delivered_quantity >= l.quantity for l in remaining)
    order.status = "DELIVERED" if (complete and any_delivered) else "PARTIALLY_DELIVERED" if any_delivered else "CONFIRMED"
    order.version += 1
    order.save()
    sales._refresh_invoiced_status(order)
    for line in order.lines.select_related("product"):
        reserve_line(line)
    a.status, a.decided_by, a.decided_at, a.total_after = "APPLIED", actor_id, timezone.now(), order.total
    a.save()
    record_tenant_event(current_tenant(), "sales.order.amended", actor_user_id=actor_id, target_type="SalesOrder", target_id=order.id, metadata={"amendment": str(a.id), "before": str(a.total_before), "after": str(order.total)})
    notify([a.requested_by], "sales.order.amendment_approved", f"Amendment to {order.number} applied", a.reason, ref_type="SalesOrder", ref_id=str(order.id))
    return a


@transaction.atomic
def reject_amendment(actor_id, amendment_id, note):
    a = m.OrderAmendment.objects.select_for_update().filter(pk=amendment_id).first()
    if a is None:
        raise DomainError("Amendment not found.", code="not_found", status_code=404)
    if not authz.has_permission(actor_id, "sales.order.approve"):
        raise DomainError("You may not decide order amendments.", code="permission_denied", status_code=403)
    if a.status != "PENDING":
        raise DomainError("This amendment was already decided.", code="invalid_state_transition")
    if not (note or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    a.status, a.decided_by, a.decided_at, a.decision_note = "REJECTED", actor_id, timezone.now(), note.strip()[:300]
    a.save()
    notify([a.requested_by], "sales.order.amendment_rejected", "Order amendment rejected", a.decision_note, ref_type="SalesOrder", ref_id=str(a.order_id))
    return a

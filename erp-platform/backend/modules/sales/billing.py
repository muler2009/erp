"""Customer billing beyond delivery invoicing: milestone billing plans, customer statements, receivables aging,
and graduated overdue reminders.  An order is billed either by delivery or by milestones, never both."""
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.utils import timezone

from modules.crm import models as cm
from modules.crm import services as crm
from modules.finance import models as fm
from modules.finance import services as finance
from modules.sales import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.tenancy import current_tenant

ZERO = Decimal("0")
BUCKETS = ("current", "1-30", "31-60", "61-90", "90+")
REMINDER_DAYS = {1: 1, 2: 15, 3: 30}  # level -> days overdue
BILLABLE = ("CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED", "INVOICED")


def _invoicer(actor_id):
    if not authz.has_permission(actor_id, "sales.invoice.create"):
        raise DomainError("You may not create customer invoices.", code="permission_denied", status_code=403)


def _order(order_id, lock=False):
    from modules.sales import services as sales

    return sales._get(m.SalesOrder, order_id, "Order", lock=lock)


# ----------------------------------------------------------------------------- milestones
@transaction.atomic
def set_milestones(actor_id, order_id, milestones):
    """Define the billing plan (percentages must add up to exactly 100).  Only before anything was invoiced."""
    _invoicer(actor_id)
    order = _order(order_id, lock=True)
    crm._own(cm.CrmAccount, order.account_id, actor_id, "Order")
    if order.status not in ("CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED"):
        raise DomainError("Only confirmed orders can have a billing plan.", code="invalid_state_transition")
    if m.InvoicedLine.objects.filter(order_line__order=order).exists() or order.milestones.filter(invoice__isnull=False).exists():
        raise DomainError("This order has already been invoiced.", code="already_invoiced")
    rows = []
    for it in milestones or []:
        try:
            pct = Decimal(str(it.get("percent")))
        except Exception:
            raise ValidationFailed("Each milestone needs a numeric percent.", code="invalid_milestone")
        if not (0 < pct <= 100) or not (it.get("description") or "").strip():
            raise ValidationFailed("Each milestone needs a description and a percent between 0 and 100.", code="invalid_milestone")
        rows.append((it["description"].strip()[:200], pct, it.get("due_date")))
    if not rows or sum(r[1] for r in rows) != 100:
        raise ValidationFailed("Milestone percentages must add up to 100.", code="milestones_must_total_100")
    order.milestones.all().delete()
    m.OrderMilestone.objects.bulk_create([m.OrderMilestone(order=order, description=d, percent=p, due_date=due) for d, p, due in rows])
    return list(order.milestones.order_by("created_at"))


@transaction.atomic
def invoice_milestone(actor_id, milestone_id, invoice_date=None):
    from modules.sales import services as sales

    _invoicer(actor_id)
    ms = m.OrderMilestone.objects.select_for_update(of=("self",)).select_related("order").filter(pk=milestone_id).first()
    if ms is None:
        raise DomainError("Milestone not found.", code="not_found", status_code=404)
    order = _order(ms.order_id, lock=True)
    crm._own(cm.CrmAccount, order.account_id, actor_id, "Order")
    if ms.invoice_id:
        raise DomainError("This milestone was already invoiced.", code="already_invoiced")
    if order.status not in BILLABLE:
        raise DomainError("The order is not billable.", code="invalid_state_transition")
    dec = sales._currency(order.currency).decimals
    quant = Decimal(1).scaleb(-dec)
    others = list(order.milestones.exclude(pk=ms.pk).order_by("created_at"))
    last = all(o.invoice_id for o in others)
    if last:  # the final milestone takes the rounding remainder so the invoices add up to the order exactly
        billed = sum((o.invoice.subtotal for o in others), ZERO)
        amount = order.subtotal - billed
    else:
        amount = (order.subtotal * ms.percent / 100).quantize(quant, rounding=ROUND_HALF_UP)
    partner = sales.ensure_customer(actor_id, order.account)
    when = invoice_date or timezone.now().date()
    revenue = finance.system_account("sales_revenue")
    tax_ids = {str(l.tax_rate_id) for l in order.lines.all() if l.tax_rate_id}
    tax = next(iter(tax_ids)) if len(tax_ids) == 1 else None
    if len(tax_ids) > 1 or (tax_ids and any(not l.tax_rate_id for l in order.lines.all())):
        raise ValidationFailed("Orders with mixed tax rates cannot be billed by milestone.", code="mixed_tax")
    inv = finance.create_invoice(actor_id, kind="CUSTOMER_INVOICE", partner_id=partner.id, invoice_date=when, due_date=when + timedelta(days=int(org.get_setting("sales.payment_terms_days", 30))), currency=order.currency,
                                 lines=[{"description": f"{order.number}: {ms.description}", "quantity": 1, "unit_price": amount, "account": str(revenue.id), "tax_rate": tax}], supplier_ref=order.number)
    ms.invoice = inv
    ms.save(update_fields=["invoice", "updated_at"])
    record_tenant_event(current_tenant(), "sales.milestone.invoiced", actor_user_id=actor_id, target_type="SalesOrder", target_id=order.id, metadata={"milestone": ms.description, "amount": str(amount)})
    return inv


def assert_not_milestone_billed(order):
    """Called by delivery invoicing: milestone-billed orders must not also be invoiced by delivered quantity."""
    if order.milestones.exists():
        raise DomainError("This order is billed by milestones, not by delivery.", code="billed_by_milestone", status_code=409)


# ----------------------------------------------------------------------------- statements and aging
def _accounts(user_id):
    return crm.scope(cm.CrmAccount.objects.filter(partner__isnull=False), user_id)


def statement(user_id, account_id, date_from, date_to, currency=None):
    acct = crm._own(cm.CrmAccount, account_id, user_id, "Account")
    if date_from is None or date_to is None or date_to < date_from:
        raise ValidationFailed("A valid period is required.", code="invalid_dates")
    cur = (currency or finance.base_currency().code).upper()
    entries = []
    if acct.partner_id:
        for inv in fm.Invoice.objects.filter(partner_id=acct.partner_id, kind__in=("CUSTOMER_INVOICE", "CUSTOMER_CREDIT_NOTE"), status__in=("POSTED", "PAID"), currency=cur):
            sign = 1 if inv.kind == "CUSTOMER_INVOICE" else -1
            entries.append((inv.invoice_date, "INVOICE" if sign == 1 else "CREDIT_NOTE", inv.number or str(inv.id)[:8], sign * inv.total, str(inv.due_date) if inv.due_date else None))
        for pay in fm.Payment.objects.filter(partner_id=acct.partner_id, kind="RECEIPT", currency=cur):
            entries.append((pay.payment_date, "PAYMENT", pay.number, -pay.amount, None))
    entries.sort(key=lambda e: (e[0], e[1]))
    opening = sum((e[3] for e in entries if e[0] < date_from), ZERO)
    run, lines = opening, []
    for d, kind, ref, amt, due in entries:
        if date_from <= d <= date_to:
            run += amt
            lines.append({"date": str(d), "type": kind, "reference": ref, "amount": str(amt), "balance": str(run), "due": due})
    return {"account": str(acct.id), "customer": acct.name, "currency": cur, "from": str(date_from), "to": str(date_to), "opening_balance": str(opening), "closing_balance": str(run), "lines": lines}


def aging(user_id, as_of=None, currency=None):
    as_of = as_of or timezone.now().date()
    cur = (currency or finance.base_currency().code).upper()
    out, totals = [], dict.fromkeys(BUCKETS, ZERO)
    for acct in _accounts(user_id):
        row = dict.fromkeys(BUCKETS, ZERO)
        for inv in fm.Invoice.objects.filter(partner_id=acct.partner_id, kind="CUSTOMER_INVOICE", status="POSTED", currency=cur, invoice_date__lte=as_of):
            due = (inv.total - inv.paid_amount)
            if due <= 0:
                continue
            late = (as_of - (inv.due_date or inv.invoice_date)).days
            row["current" if late <= 0 else "1-30" if late <= 30 else "31-60" if late <= 60 else "61-90" if late <= 90 else "90+"] += due
        total = sum(row.values(), ZERO)
        if total > 0:
            out.append({"account": str(acct.id), "customer": acct.name, **{k: str(v) for k, v in row.items()}, "total": str(total)})
            for k in BUCKETS:
                totals[k] += row[k]
    return {"as_of": str(as_of), "currency": cur, "customers": sorted(out, key=lambda r: -Decimal(r["total"])), "totals": {k: str(v) for k, v in totals.items()}, "total": str(sum(totals.values(), ZERO))}


def send_overdue_reminders(today=None):
    """Graduated reminders (1, 15 and 30 days overdue), once per invoice and level, to the customer's sales owner.  Idempotent."""
    today = today or timezone.now().date()
    sent = 0
    for inv in fm.Invoice.objects.filter(kind="CUSTOMER_INVOICE", status="POSTED", due_date__lt=today).select_related("partner"):
        if inv.total - inv.paid_amount <= 0:
            continue
        late = (today - inv.due_date).days
        level = max((lv for lv, d in REMINDER_DAYS.items() if late >= d), default=0)
        if not level:
            continue
        try:
            with transaction.atomic():
                m.InvoiceReminder.objects.create(invoice=inv, level=level)
        except IntegrityError:
            continue
        acct = cm.CrmAccount.objects.filter(partner_id=inv.partner_id).first()
        if acct is None:
            continue
        notify([acct.owner_id], "sales.invoice.overdue", f"Invoice {inv.number or inv.id} is {late} days overdue", f"{acct.name}: {inv.total - inv.paid_amount:f} {inv.currency} outstanding (reminder {level}).", ref_type="Invoice", ref_id=str(inv.id))
        sent += 1
    return sent

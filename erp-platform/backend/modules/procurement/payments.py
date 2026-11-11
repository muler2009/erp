"""Supplier payments: what is due, ageing, statements, and release with early-payment discount and withholding tax.

Discount and withholding are booked as their own journals that clear accounts payable, recorded as PaymentAdjustment rows,
then the net amount goes through finance's idempotent, segregation-of-duties payment engine."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Q

from modules.finance import models as fm
from modules.finance import services as finance
from modules.procurement import models as m
from modules.procurement import suppliers as supmod
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

ZERO = Decimal("0")
BUCKETS = (("current", None, 0), ("1-30", 1, 30), ("31-60", 31, 60), ("61-90", 61, 90), ("90+", 91, None))


def _supplier_invoices():
    return fm.Invoice.objects.filter(kind="SUPPLIER_INVOICE", status="POSTED").select_related("partner")


def due_date(inv):
    if inv.due_date:
        return inv.due_date
    s = m.Supplier.objects.filter(partner_id=inv.partner_id).first()
    return inv.invoice_date + timedelta(days=s.payment_terms_days if s else 30)


def discount_for(inv, pay_date, supplier=None):
    """(percent, amount) of early-payment discount available on `inv` if paid on `pay_date`; only on a wholly unpaid invoice."""
    s = supplier or m.Supplier.objects.filter(partner_id=inv.partner_id).first()
    if not s or s.early_discount_percent <= 0 or inv.paid_amount != 0:
        return ZERO, ZERO
    if pay_date > inv.invoice_date + timedelta(days=s.early_discount_days):
        return ZERO, ZERO
    return s.early_discount_percent, finance._q(inv.outstanding * s.early_discount_percent / 100, finance.base_currency().decimals)


def wht_for(inv, supplier=None):
    s = supplier or m.Supplier.objects.filter(partner_id=inv.partner_id).first()
    if not s or s.wht_percent <= 0:
        return ZERO, ZERO
    base = inv.subtotal if inv.paid_amount == 0 else inv.subtotal * inv.outstanding / inv.total
    return s.wht_percent, min(finance._q(base * s.wht_percent / 100, finance.base_currency().decimals), inv.outstanding)


def due_list(as_of, within_days=0):
    """Posted supplier invoices with a balance that fall due by as_of + within_days, or still earn a discount at as_of."""
    out = []
    suppliers = {s.partner_id: s for s in m.Supplier.objects.exclude(partner__isnull=True)}
    for inv in _supplier_invoices().order_by("invoice_date"):
        if inv.outstanding <= 0:
            continue
        s = suppliers.get(inv.partner_id)
        due = due_date(inv)
        pct, disc = discount_for(inv, as_of, s)
        if due > as_of + timedelta(days=within_days) and disc == 0:
            continue
        bank = supmod.payable_bank_account(s.id, inv.currency) if s else None
        out.append({"invoice": str(inv.id), "number": inv.number, "supplier_ref": inv.supplier_ref, "supplier": inv.partner.name, "currency": inv.currency, "total": str(inv.total), "outstanding": str(inv.outstanding), "due_date": str(due), "days_overdue": max((as_of - due).days, 0), "discount_available": str(disc), "wht": str(wht_for(inv, s)[1]), "payable": bool(bank), "standing": supmod.effective_standing(s) if s else "GOOD"})
    return out


def ageing(as_of):
    rows = {}
    for inv in _supplier_invoices():
        if inv.outstanding <= 0:
            continue
        late = (as_of - due_date(inv)).days
        label = next(b for b, lo, hi in BUCKETS if (lo is None or late >= lo) and (hi is None or late <= hi) and not (b == "current" and late > 0))
        r = rows.setdefault((inv.partner_id, inv.currency), {"supplier": inv.partner.name, "currency": inv.currency, **{b: ZERO for b, _, _ in BUCKETS}})
        r[label] += inv.outstanding
    return [{k: (str(v) if isinstance(v, Decimal) else v) for k, v in r.items()} | {"total": str(sum((v for v in r.values() if isinstance(v, Decimal)), ZERO))} for r in sorted(rows.values(), key=lambda r: (r["supplier"], r["currency"]))]


def statement(supplier_id, date_from, date_to):
    s = m.Supplier.objects.filter(pk=supplier_id).first()
    if s is None or s.partner_id is None:
        raise DomainError("Supplier not found.", code="not_found", status_code=404)
    docs = fm.Invoice.objects.filter(partner_id=s.partner_id, kind__in=("SUPPLIER_INVOICE", "SUPPLIER_CREDIT_NOTE"), status__in=("POSTED", "PAID"))
    pays = fm.Payment.objects.filter(partner_id=s.partner_id, kind="DISBURSEMENT")
    events = []
    for d in docs:
        sign = -1 if d.kind == "SUPPLIER_CREDIT_NOTE" else 1
        events.append((d.invoice_date, 0, "credit note" if sign < 0 else "invoice", d.number, d.currency, d.total * sign))
    for p in pays:
        events.append((p.payment_date, 1, "payment", p.number, p.currency, -p.amount))
    for a in m.PaymentAdjustment.objects.filter(invoice__partner_id=s.partner_id):
        events.append((a.adjustment_date, 1, "discount" if a.kind == "DISCOUNT" else "withholding tax", a.invoice.number, a.invoice.currency, -a.amount))
    events.sort(key=lambda e: (e[0], e[1], e[3]))
    balances, rows = {}, []
    for d, _, kind, ref, cur, amt in events:
        balances[cur] = balances.get(cur, ZERO) + amt
        if date_from <= d <= date_to:
            rows.append({"date": str(d), "type": kind, "reference": ref, "currency": cur, "amount": str(amt), "balance": str(balances[cur])})
    opening = {}
    for d, _, kind, ref, cur, amt in events:
        if d < date_from:
            opening[cur] = opening.get(cur, ZERO) + amt
    return {"supplier": s.name, "from": str(date_from), "to": str(date_to), "opening": {k: str(v) for k, v in opening.items()}, "rows": rows, "closing": {k: str(v) for k, v in balances.items()}}


@transaction.atomic
def pay_invoice(actor_id, *, idempotency_key, invoice_id, bank_account_id, payment_date, take_discount=True, withhold=True, memo=""):
    """Pay the whole outstanding balance of one posted supplier invoice. Idempotent on `idempotency_key`."""
    inv = fm.Invoice.objects.select_for_update().filter(pk=invoice_id).select_related("partner").first()
    if inv is None or inv.kind != "SUPPLIER_INVOICE":
        raise DomainError("Supplier invoice not found.", code="not_found", status_code=404)
    key = (idempotency_key or "").strip()
    if not key:
        raise ValidationFailed("An idempotency key is required.", code="idempotency_key_required")
    done = fm.Payment.objects.filter(idempotency_key=key).first()
    if done is not None:  # replay: same key, same invoice
        if not done.allocations.filter(invoice=inv).exists():
            raise DomainError("This idempotency key was already used with different data.", code="idempotency_conflict")
        return done, False
    s = m.Supplier.objects.filter(partner_id=inv.partner_id).first()
    if s is None:
        raise ValidationFailed("The invoice is not from a registered supplier.", code="supplier_mismatch")
    if inv.status != "POSTED" or inv.outstanding <= 0:
        raise DomainError("Only a posted invoice with a balance can be paid.", code="invalid_state")
    if supmod.effective_standing(s) == "BLACKLISTED":
        raise DomainError("This supplier is blacklisted; payments need the standing to be reviewed first.", code="supplier_blacklisted")
    if supmod.payable_bank_account(s.id, inv.currency) is None:
        raise DomainError("The supplier has no verified bank account in this currency.", code="no_verified_bank")
    if actor_id in (inv.approved_by, inv.posted_by, inv.created_by):
        raise DomainError("Separation of duties: you took part in this invoice and cannot release its payment.", code="separation_of_duties", status_code=403)
    fm.Invoice.objects.filter(pk=inv.pk)  # row already locked above
    base = finance.base_currency()
    ap = finance.system_account("ap_control")
    adjustments = []
    d_pct, d_amt = discount_for(inv, payment_date, s) if take_discount else (ZERO, ZERO)
    w_pct, w_amt = wht_for(inv, s) if withhold else (ZERO, ZERO)
    if d_amt + w_amt >= inv.outstanding:
        raise ValidationFailed("Discount and withholding would leave nothing to pay.", code="nothing_to_pay")
    for kind, pct, amt, account_key in (("DISCOUNT", d_pct, d_amt, "purchase_discount"), ("WHT", w_pct, w_amt, "wht_payable")):
        if amt <= 0:
            continue
        amt_base = finance._q(amt * inv.fx_rate, base.decimals)
        entry = finance._post_system_entry(actor_id, payment_date, f"{kind.title()} on {inv.number}", "payment_adjustment", f"{key}:{kind}", [
            {"account": ap, "debit": amt_base, "currency": inv.currency, "amount_currency": amt, "partner": inv.partner, "description": inv.partner.name},
            {"account": finance.system_account(account_key), "credit": amt_base, "description": f"{kind.title()} on {inv.number}"}])
        m.PaymentAdjustment.objects.create(invoice=inv, kind=kind, percent=pct, amount=amt, amount_base=amt_base, journal_entry_id=entry.id, adjustment_date=payment_date, idempotency_key=key, created_by=actor_id)
        adjustments.append(amt)
    if adjustments:
        inv.paid_amount += sum(adjustments, ZERO)
        inv.save(update_fields=["paid_amount", "updated_at"])
    net = inv.outstanding
    payment, created = finance.record_payment(actor_id, idempotency_key=key, kind="DISBURSEMENT", partner_id=inv.partner_id, bank_account_id=bank_account_id, payment_date=payment_date, allocations=[{"invoice": inv.id, "amount": net}], memo=memo)
    record_tenant_event(current_tenant(), "procurement.supplier_payment", actor_user_id=actor_id, target_type="Invoice", target_id=inv.id, metadata={"net": str(net), "discount": str(d_amt), "wht": str(w_amt)})
    return payment, created


def wht_report(date_from, date_to):
    rows = {}
    for a in m.PaymentAdjustment.objects.filter(kind="WHT", adjustment_date__gte=date_from, adjustment_date__lte=date_to).select_related("invoice__partner"):
        r = rows.setdefault((a.invoice.partner_id, a.invoice.currency), {"supplier": a.invoice.partner.name, "tax_id": getattr(m.Supplier.objects.filter(partner_id=a.invoice.partner_id).first(), "tax_id", ""), "currency": a.invoice.currency, "withheld": ZERO})
        r["withheld"] += a.amount
    return [{**r, "withheld": str(r["withheld"])} for r in rows.values()]

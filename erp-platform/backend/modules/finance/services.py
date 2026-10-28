"""Finance application services. Every posting runs inside a transaction that row-locks the documents it
touches, checks the fiscal period, and produces a balanced journal entry (re-checked by a database trigger)."""
import hashlib
import json
from datetime import date as date_cls
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from platform_core.audit.services import record_tenant_event
from platform_core.organizations import services as org
from platform_core.organizations.models import Currency
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.sequences import services as sequences
from shared.tenancy import current_tenant
from shared.workflows import services as workflows
from modules.finance import models as m

ZERO = Decimal("0")
INVOICE_SUBJECT = "finance.invoice"
VOID_HOOKS = []  # callables(invoice) run when an unposted invoice is voided
POST_CHECKS = []  # callables(invoice) that raise DomainError to block posting

DEFAULT_ACCOUNTS = [  # code, name, type, parent code, postable, control, system_key
    ("1000", "Current Assets", "ASSET", None, False, False, None),
    ("1010", "Bank", "ASSET", "1000", True, False, "bank_default"),
    ("1100", "Accounts Receivable", "ASSET", "1000", True, True, "ar_control"),
    ("1300", "Tax Receivable", "ASSET", "1000", True, False, "tax_receivable"),
    ("2000", "Current Liabilities", "LIABILITY", None, False, False, None),
    ("2100", "Accounts Payable", "LIABILITY", "2000", True, True, "ap_control"),
    ("2300", "Tax Payable", "LIABILITY", "2000", True, False, "tax_payable"),
    ("3000", "Equity", "EQUITY", None, False, False, None),
    ("3100", "Share Capital", "EQUITY", "3000", True, False, None),
    ("3900", "Retained Earnings", "EQUITY", "3000", True, False, "retained_earnings"),
    ("4000", "Revenue", "REVENUE", None, False, False, None),
    ("4100", "Sales Revenue", "REVENUE", "4000", True, False, "sales_revenue"),
    ("5000", "Expenses", "EXPENSE", None, False, False, None),
    ("5100", "Cost of Goods Sold", "EXPENSE", "5000", True, False, "cogs"),
    ("5200", "Operating Expenses", "EXPENSE", "5000", True, False, "default_expense"),
    ("1200", "Inventory", "ASSET", "1000", True, False, "inventory"),
    ("2200", "Goods Received Not Invoiced", "LIABILITY", "2000", True, False, "grni"),
    ("5400", "Inventory Adjustments", "EXPENSE", "5000", True, False, "inventory_adjustment"),
    ("5900", "Foreign Exchange Gain/Loss", "EXPENSE", "5000", True, False, "fx_gain_loss"),
]


# ----------------------------------------------------------------------------- helpers
def base_currency():
    company = org.get_company()
    if company.base_currency_id is None:
        raise DomainError("Set the company's base currency before using finance.", code="base_currency_required")
    return company.base_currency


def _dec(value, field="amount"):
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValidationFailed(f"{field} must be a decimal number.", code="invalid_amount")


def _q(value, decimals):
    return Decimal(value).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def _currency(code):
    cur = Currency.objects.filter(code=code, is_active=True).first()
    if cur is None:
        raise ValidationFailed(f"Currency {code} is not active.", code="invalid_currency")
    return cur


def system_account(key):
    acct = m.Account.objects.filter(system_key=key, is_active=True).first()
    if acct is None:
        raise DomainError(f"System account '{key}' is not configured.", code="system_account_missing")
    return acct


def _get(model, pk, label):
    obj = model.objects.filter(pk=pk).first()
    if obj is None:
        raise DomainError(f"{label} not found.", code="not_found", status_code=404)
    return obj


# ----------------------------------------------------------------------------- setup
@transaction.atomic
def seed_defaults():
    """Idempotent default chart of accounts and numbering sequences."""
    by_code = {}
    for code, name, typ, parent, postable, control, key in DEFAULT_ACCOUNTS:
        acct, _ = m.Account.objects.get_or_create(code=code, defaults=dict(name=name, type=typ, parent=by_code.get(parent), is_postable=postable, is_control=control, system_key=key))
        by_code[code] = acct
    return len(by_code)


@transaction.atomic
def create_account(actor_id, *, code, name, type, parent_id=None, is_postable=True, request=None):
    if type not in m.Account.Type.values:
        raise ValidationFailed("Invalid account type.", code="invalid_account_type")
    if m.Account.objects.filter(code=code).exists():
        raise DomainError("An account with this code already exists.", code="account_code_taken")
    parent = _get(m.Account, parent_id, "Parent account") if parent_id else None
    if parent and (parent.type != type or parent.is_postable):
        raise ValidationFailed("Parent must be a header account of the same type.", code="invalid_parent")
    acct = m.Account.objects.create(code=code, name=name, type=type, parent=parent, is_postable=is_postable)
    record_tenant_event(current_tenant(), "finance.account.created", actor_user_id=actor_id, target_type="Account", target_id=acct.id, metadata={"code": code}, request=request)
    return acct


@transaction.atomic
def update_account(actor_id, account_id, *, name=None, is_active=None, request=None):
    acct = m.Account.objects.select_for_update().filter(pk=account_id).first() or _get(m.Account, account_id, "Account")
    if name is not None:
        acct.name = name
    if is_active is not None and is_active != acct.is_active:
        if not is_active:
            if acct.system_key or acct.is_control:
                raise DomainError("System accounts cannot be deactivated.", code="system_account_protected")
            if account_balance(acct) != ZERO:
                raise DomainError("An account with a non-zero balance cannot be deactivated.", code="account_has_balance")
        acct.is_active = is_active
    acct.save()
    record_tenant_event(current_tenant(), "finance.account.updated", actor_user_id=actor_id, target_type="Account", target_id=acct.id, request=request)
    return acct


def account_balance(acct, as_of=None):
    from django.db.models import Sum

    qs = m.JournalLine.objects.filter(account=acct, entry__status__in=["POSTED", "REVERSED"])
    if as_of:
        qs = qs.filter(entry__entry_date__lte=as_of)
    agg = qs.aggregate(d=Sum("debit"), c=Sum("credit"))
    net = (agg["d"] or ZERO) - (agg["c"] or ZERO)
    return net if acct.debit_normal else -net


@transaction.atomic
def create_tax_rate(actor_id, *, code, name, kind, rate, account_id):
    rate = _dec(rate, "rate")
    if not (ZERO <= rate <= 100):
        raise ValidationFailed("rate must be between 0 and 100.", code="invalid_rate")
    account = _get(m.Account, account_id, "Account")
    if kind == "SALES" and account.type != "LIABILITY" or kind == "PURCHASE" and account.type != "ASSET":
        raise ValidationFailed("Sales tax posts to a liability account, purchase tax to an asset account.", code="invalid_tax_account")
    if m.TaxRate.objects.filter(code=code).exists():
        raise DomainError("A tax rate with this code already exists.", code="tax_code_taken")
    return m.TaxRate.objects.create(code=code, name=name, kind=kind, rate=rate, account=account)


@transaction.atomic
def create_bank_account(actor_id, *, name, currency, gl_account_id, account_number="", is_cash=False):
    _currency(currency)
    gl = _get(m.Account, gl_account_id, "GL account")
    if gl.type != "ASSET" or not gl.is_postable or gl.is_control:
        raise ValidationFailed("A bank account maps to a postable, non-control asset account.", code="invalid_gl_account")
    return m.BankAccount.objects.create(name=name, currency=currency, gl_account=gl, account_number=account_number, is_cash=is_cash)


@transaction.atomic
def create_partner(actor_id, *, name, is_customer=False, is_supplier=False, tax_id="", external_ref=""):
    if not (is_customer or is_supplier):
        raise ValidationFailed("A partner must be a customer, a supplier or both.", code="invalid_partner")
    return m.Partner.objects.create(name=name.strip(), is_customer=is_customer, is_supplier=is_supplier, tax_id=tax_id, external_ref=external_ref)


# ----------------------------------------------------------------------------- journals
def _build_lines(entry, raw_lines, *, allow_control):
    decimals = base_currency().decimals
    if len(raw_lines) < 2:
        raise ValidationFailed("A journal entry needs at least two lines.", code="too_few_lines")
    codes = {str(r["account"]) for r in raw_lines}
    accounts = {a.code: a for a in m.Account.objects.filter(code__in=codes)}
    out = []
    for i, r in enumerate(raw_lines, start=1):
        acct = accounts.get(str(r["account"]))
        if acct is None or not acct.is_active or not acct.is_postable:
            raise ValidationFailed(f"Line {i}: account {r['account']} is unknown, inactive or not postable.", code="invalid_account")
        if acct.is_control and not allow_control:
            raise ValidationFailed(f"Line {i}: control account {acct.code} accepts only subledger postings.", code="control_account_protected")
        debit, credit = _q(_dec(r.get("debit", 0), "debit"), decimals), _q(_dec(r.get("credit", 0), "credit"), decimals)
        if debit < 0 or credit < 0 or (debit > 0) == (credit > 0):
            raise ValidationFailed(f"Line {i}: exactly one of debit or credit must be positive.", code="invalid_line_amount")
        out.append(m.JournalLine(entry=entry, line_no=i, account=acct, debit=debit, credit=credit, description=r.get("description", "")[:300],
                                 currency=r.get("currency", ""), amount_currency=r.get("amount_currency"), partner=r.get("partner"), cost_center_id=r.get("cost_center_id")))
    return out


@transaction.atomic
def create_journal(actor_id, *, entry_date, memo="", lines, request=None, source_type="manual", source_id="", allow_control=False):
    entry = m.JournalEntry.objects.create(entry_date=entry_date, memo=memo[:500], created_by=actor_id, source_type=source_type, source_id=str(source_id))
    m.JournalLine.objects.bulk_create(_build_lines(entry, lines, allow_control=allow_control))
    return entry


def _totals(entry):
    from django.db.models import Sum

    agg = entry.lines.aggregate(d=Sum("debit"), c=Sum("credit"))
    return agg["d"] or ZERO, agg["c"] or ZERO


@transaction.atomic
def post_journal(actor_id, entry_id, *, request=None):
    entry = m.JournalEntry.objects.select_for_update().filter(pk=entry_id).first() or _get(m.JournalEntry, entry_id, "Journal entry")
    if entry.status != "DRAFT":
        raise DomainError("Only draft entries can be posted.", code="invalid_state_transition")
    period = org.assert_period_open(entry.entry_date)
    debit, credit = _totals(entry)
    if debit != credit or debit == ZERO:
        raise DomainError(f"Entry is not balanced (debit {debit}, credit {credit}).", code="unbalanced_entry")
    entry.number = sequences.next_number("finance.journal", on_date=entry.entry_date, for_type="JournalEntry", for_id=str(entry.id))
    entry.period_id, entry.status, entry.posted_by, entry.posted_at = period.id, "POSTED", actor_id, timezone.now()
    entry.save(update_fields=["number", "period_id", "status", "posted_by", "posted_at", "updated_at"])
    record_tenant_event(current_tenant(), "finance.journal.posted", actor_user_id=actor_id, target_type="JournalEntry", target_id=entry.id, metadata={"number": entry.number, "total": str(debit)}, request=request)
    events.emit("finance.journal.posted", {"entry_id": str(entry.id), "number": entry.number, "source_type": entry.source_type}, dedup_key=f"journal-posted-{entry.id}")
    return entry


@transaction.atomic
def delete_draft_journal(actor_id, entry_id):
    entry = m.JournalEntry.objects.select_for_update().filter(pk=entry_id).first() or _get(m.JournalEntry, entry_id, "Journal entry")
    if entry.status != "DRAFT" or entry.source_type != "manual":
        raise DomainError("Only draft manual entries can be deleted.", code="invalid_state_transition")
    entry.delete()


@transaction.atomic
def reverse_journal(actor_id, entry_id, *, reversal_date=None, memo="", request=None):
    entry = m.JournalEntry.objects.select_for_update().filter(pk=entry_id).first() or _get(m.JournalEntry, entry_id, "Journal entry")
    if entry.status != "POSTED":
        raise DomainError("Only posted, not yet reversed entries can be reversed.", code="invalid_state_transition")
    if entry.source_type != "manual":
        raise DomainError("Entries created by invoices or payments are corrected with credit notes, not reversed.", code="subledger_entry_protected")
    rdate = reversal_date or timezone.now().date()
    rev = m.JournalEntry.objects.create(entry_date=rdate, memo=(memo or f"Reversal of {entry.number}")[:500], created_by=actor_id, source_type="reversal", source_id=str(entry.id))
    m.JournalLine.objects.bulk_create([m.JournalLine(entry=rev, line_no=l.line_no, account=l.account, debit=l.credit, credit=l.debit, description=f"Reversal: {l.description}"[:300], currency=l.currency, partner=l.partner, cost_center_id=l.cost_center_id) for l in entry.lines.all()])
    rev = post_journal(actor_id, rev.id)
    entry = m.JournalEntry.objects.get(pk=entry.pk)
    entry.status, entry.reversed_by = "REVERSED", rev
    entry.save(update_fields=["status", "reversed_by", "updated_at"])
    record_tenant_event(current_tenant(), "finance.journal.reversed", actor_user_id=actor_id, target_type="JournalEntry", target_id=entry.id, metadata={"reversal": str(rev.id)}, request=request)
    return rev


def _post_system_entry(actor_id, entry_date, memo, source_type, source_id, lines):
    """Create and post a subledger journal. `lines` are dicts with account objects already resolved."""
    entry = m.JournalEntry.objects.create(entry_date=entry_date, memo=memo[:500], created_by=actor_id, source_type=source_type, source_id=str(source_id))
    rows = []
    for i, l in enumerate(lines, start=1):
        rows.append(m.JournalLine(entry=entry, line_no=i, account=l["account"], debit=l.get("debit", ZERO), credit=l.get("credit", ZERO), description=l.get("description", "")[:300], currency=l.get("currency", ""), amount_currency=l.get("amount_currency"), partner=l.get("partner")))
    m.JournalLine.objects.bulk_create(rows)
    return post_journal(actor_id, entry.id)


def _journal_check_closing(period):
    drafts = m.JournalEntry.objects.filter(status="DRAFT", entry_date__gte=period.start_date, entry_date__lte=period.end_date).count()
    if drafts:
        raise DomainError(f"{drafts} draft journal entr{'y' if drafts == 1 else 'ies'} must be posted or deleted before closing {period.name}.", code="unposted_journals")


# ----------------------------------------------------------------------------- invoices
CUSTOMER_KINDS = ("CUSTOMER_INVOICE", "CUSTOMER_CREDIT_NOTE")
CREDIT_KINDS = ("CUSTOMER_CREDIT_NOTE", "SUPPLIER_CREDIT_NOTE")
NUMBER_SEQ = {"CUSTOMER_INVOICE": "finance.invoice", "SUPPLIER_INVOICE": "finance.bill", "CUSTOMER_CREDIT_NOTE": "finance.credit_note", "SUPPLIER_CREDIT_NOTE": "finance.supplier_credit_note"}


def _price_lines(invoice, raw_lines):
    cur = _currency(invoice.currency)
    if not raw_lines:
        raise ValidationFailed("At least one line is required.", code="no_lines")
    customer = invoice.kind in CUSTOMER_KINDS
    codes = [r["account"] for r in raw_lines]
    accounts = {str(a.id): a for a in m.Account.objects.filter(id__in=codes)}
    taxes = {str(t.id): t for t in m.TaxRate.objects.filter(id__in=[r["tax_rate"] for r in raw_lines if r.get("tax_rate")], is_active=True)}
    rows, subtotal, tax_total = [], ZERO, ZERO
    for i, r in enumerate(raw_lines, start=1):
        acct = accounts.get(str(r["account"]))
        want = ("REVENUE",) if customer else ("EXPENSE", "ASSET")
        goods_clearing = (not customer) and acct is not None and acct.system_key == "grni"  # stock lines matched to receipts
        if acct is None or not acct.is_active or not acct.is_postable or acct.is_control or (acct.type not in want and not goods_clearing):
            raise ValidationFailed(f"Line {i}: invalid {'revenue' if customer else 'expense'} account.", code="invalid_account")
        qty, price = _dec(r["quantity"], "quantity"), _dec(r["unit_price"], "unit_price")
        if qty <= 0 or price < 0:
            raise ValidationFailed(f"Line {i}: quantity must be positive and unit_price non-negative.", code="invalid_line_amount")
        tax = taxes.get(str(r["tax_rate"])) if r.get("tax_rate") else None
        if r.get("tax_rate") and tax is None:
            raise ValidationFailed(f"Line {i}: unknown or inactive tax rate.", code="invalid_tax_rate")
        if tax and tax.kind != ("SALES" if customer else "PURCHASE"):
            raise ValidationFailed(f"Line {i}: tax rate kind does not match the document.", code="invalid_tax_rate")
        total = _q(qty * price, cur.decimals)
        tax_amount = _q(total * tax.rate / 100, cur.decimals) if tax else ZERO
        subtotal += total
        tax_total += tax_amount
        rows.append(m.InvoiceLine(invoice=invoice, line_no=i, description=r["description"][:300], quantity=qty, unit_price=price, account=acct, tax_rate=tax, line_total=total, tax_amount=tax_amount))
    invoice.subtotal, invoice.tax_total, invoice.total = subtotal, tax_total, subtotal + tax_total
    return rows


@transaction.atomic
def create_invoice(actor_id, *, kind, partner_id, invoice_date, due_date=None, currency=None, lines, supplier_ref="", credit_for_id=None, request=None):
    if kind not in m.Invoice.Kind.values:
        raise ValidationFailed("Invalid document kind.", code="invalid_kind")
    partner = _get(m.Partner, partner_id, "Partner")
    customer = kind in CUSTOMER_KINDS
    if not partner.is_active or not (partner.is_customer if customer else partner.is_supplier):
        raise ValidationFailed("The partner cannot be used for this document type.", code="invalid_partner")
    currency = currency or base_currency().code
    original = None
    if kind in CREDIT_KINDS:
        if credit_for_id:
            original = _get(m.Invoice, credit_for_id, "Original invoice")
            if original.partner_id != partner.id or original.currency != currency or original.kind != ("CUSTOMER_INVOICE" if customer else "SUPPLIER_INVOICE"):
                raise ValidationFailed("A credit note must match the original invoice's partner, kind and currency.", code="credit_mismatch")
    elif credit_for_id:
        raise ValidationFailed("Only credit notes can reference an original invoice.", code="credit_mismatch")
    inv = m.Invoice(kind=kind, partner=partner, invoice_date=invoice_date, due_date=due_date, currency=currency, supplier_ref=supplier_ref, credit_for=original, created_by=actor_id)
    rows = _price_lines(inv, lines)
    inv.save()
    m.InvoiceLine.objects.bulk_create(rows)
    record_tenant_event(current_tenant(), "finance.invoice.created", actor_user_id=actor_id, target_type="Invoice", target_id=inv.id, metadata={"kind": kind, "total": str(inv.total)}, request=request)
    return inv


def _lock_invoice(invoice_id):
    inv = m.Invoice.objects.select_for_update().filter(pk=invoice_id).first()
    if inv is None:
        raise DomainError("Invoice not found.", code="not_found", status_code=404)
    return inv


@transaction.atomic
def update_invoice(actor_id, invoice_id, *, lines, invoice_date=None, due_date=None, supplier_ref=None, expected_version=None):
    inv = _lock_invoice(invoice_id)
    if inv.status != "DRAFT":
        raise DomainError("Only draft documents can be edited.", code="invalid_state_transition")
    if expected_version is not None and expected_version != inv.version:
        raise DomainError("The document was changed by someone else.", code="version_conflict")
    if invoice_date:
        inv.invoice_date = invoice_date
    if due_date is not None:
        inv.due_date = due_date
    if supplier_ref is not None:
        inv.supplier_ref = supplier_ref
    inv.lines.all().delete()
    rows = _price_lines(inv, lines)
    inv.version += 1
    inv.save()
    m.InvoiceLine.objects.bulk_create(rows)
    return inv


@transaction.atomic
def submit_invoice(actor_id, invoice_id):
    inv = _lock_invoice(invoice_id)
    if inv.status != "DRAFT":
        raise DomainError("Only draft documents can be submitted.", code="invalid_state_transition")
    if inv.total <= 0:
        raise DomainError("A document with a zero total cannot be submitted.", code="zero_total")
    inv.status = "SUBMITTED"
    if workflows.WorkflowDefinition.objects.filter(subject_type=INVOICE_SUBJECT, is_active=True).exists():
        instance = workflows.submit(actor_id, INVOICE_SUBJECT, str(inv.id), amount=inv.total, title=f"{inv.get_kind_display()} {inv.partner.name} {inv.total} {inv.currency}")
        inv.workflow_instance_id = instance.id
    inv.save(update_fields=["status", "workflow_instance_id", "updated_at"])
    return inv


@transaction.atomic
def approve_invoice(actor_id, invoice_id, *, request=None):
    """Direct approval (used when no approval workflow is configured for invoices)."""
    inv = _lock_invoice(invoice_id)
    if inv.status != "SUBMITTED":
        raise DomainError("Only submitted documents can be approved.", code="invalid_state_transition")
    if inv.workflow_instance_id:
        raise DomainError("This document is governed by an approval workflow; decide it in the approval inbox.", code="workflow_governed")
    if inv.created_by == actor_id:
        raise DomainError("Separation of duties: you cannot approve a document you created.", code="separation_of_duties", status_code=403)
    inv.status, inv.approved_by = "APPROVED", actor_id
    inv.save(update_fields=["status", "approved_by", "updated_at"])
    record_tenant_event(current_tenant(), "finance.invoice.approved", actor_user_id=actor_id, target_type="Invoice", target_id=inv.id, request=request)
    return inv


def _on_workflow_outcome(instance):
    inv = m.Invoice.objects.select_for_update().filter(pk=instance.subject_id).first()
    if inv is None or inv.workflow_instance_id != instance.id or inv.status != "SUBMITTED":
        return
    if instance.status == "APPROVED":
        inv.status = "APPROVED"
        # the final approver is the last APPROVED action actor
        last = instance.actions.filter(action="APPROVED").order_by("-created_at").first()
        inv.approved_by = last.actor_id if last else None
    else:  # rejected or cancelled: back to the author for correction
        inv.status, inv.workflow_instance_id = "DRAFT", None
    inv.save(update_fields=["status", "approved_by", "workflow_instance_id", "updated_at"])


@transaction.atomic
def post_invoice(actor_id, invoice_id, *, request=None):
    inv = _lock_invoice(invoice_id)
    if inv.status != "APPROVED":
        raise DomainError("Only approved documents can be posted.", code="invalid_state_transition")
    if inv.created_by == actor_id:
        raise DomainError("Separation of duties: you cannot post a document you created.", code="separation_of_duties", status_code=403)
    for check in POST_CHECKS:  # other modules may veto (e.g. procurement's three-way match)
        check(inv)
    base = base_currency()
    rate = org.get_rate(inv.currency, inv.invoice_date)
    period = org.assert_period_open(inv.invoice_date)
    customer = inv.kind in CUSTOMER_KINDS
    credit_note = inv.kind in CREDIT_KINDS
    # accumulate base amounts per GL account (rounded per account so the control line always balances exactly)
    buckets, tax_buckets = {}, {}
    for l in inv.lines.select_related("account", "tax_rate__account"):
        buckets[l.account_id] = buckets.get(l.account_id, ZERO) + l.line_total
        if l.tax_amount:
            tax_buckets[l.tax_rate.account_id] = tax_buckets.get(l.tax_rate.account_id, ZERO) + l.tax_amount
    accounts = {a.id: a for a in m.Account.objects.filter(id__in=set(buckets) | set(tax_buckets))}
    control = system_account("ar_control" if customer else "ap_control")
    # a customer invoice credits revenue/tax and debits AR; credit notes and supplier documents mirror that
    revenue_side_credit = customer != credit_note  # True: credit the buckets and debit control
    lines, control_total = [], ZERO
    for source in (buckets, tax_buckets):
        for acct_id, doc_amount in source.items():
            amt = _q(doc_amount * rate, base.decimals)
            if amt == ZERO:
                continue
            control_total += amt
            side = "credit" if revenue_side_credit else "debit"
            lines.append({"account": accounts[acct_id], side: amt, "currency": inv.currency, "amount_currency": doc_amount if side == "debit" else -doc_amount, "partner": inv.partner, "description": f"{inv.partner.name}"})
    if control_total == ZERO:
        raise DomainError("The document has no postable amount in the base currency.", code="zero_total")
    lines.insert(0, {"account": control, ("debit" if revenue_side_credit else "credit"): control_total, "currency": inv.currency, "amount_currency": inv.total if revenue_side_credit else -inv.total, "partner": inv.partner, "description": inv.partner.name})
    inv.number = sequences.next_number(NUMBER_SEQ[inv.kind], on_date=inv.invoice_date, for_type="Invoice", for_id=str(inv.id))
    entry = _post_system_entry(actor_id, inv.invoice_date, f"{inv.get_kind_display()} {inv.number}", "invoice", inv.id, lines)
    inv.status, inv.fx_rate, inv.total_base, inv.journal_entry, inv.posted_by = "POSTED", rate, control_total, entry, actor_id
    inv.save(update_fields=["number", "status", "fx_rate", "total_base", "journal_entry", "posted_by", "updated_at"])
    record_tenant_event(current_tenant(), "finance.invoice.posted", actor_user_id=actor_id, target_type="Invoice", target_id=inv.id, metadata={"number": inv.number, "total": str(inv.total), "currency": inv.currency}, request=request)
    events.emit("finance.invoice.posted", {"invoice_id": str(inv.id), "number": inv.number, "kind": inv.kind, "total": str(inv.total), "currency": inv.currency}, dedup_key=f"invoice-posted-{inv.id}")
    return inv


@transaction.atomic
def void_invoice(actor_id, invoice_id, *, request=None):
    inv = _lock_invoice(invoice_id)
    if inv.status not in ("DRAFT", "SUBMITTED", "APPROVED"):
        raise DomainError("Posted documents are corrected with a credit note, not voided.", code="posted_document_protected")
    if inv.workflow_instance_id:
        instance = workflows.WorkflowInstance.objects.filter(pk=inv.workflow_instance_id, status__in=workflows.WorkflowInstance.ACTIVE).first()
        if instance:
            inv.workflow_instance_id = None  # detach first so the cancel hook does not touch this row twice
            inv.save(update_fields=["workflow_instance_id"])
            workflows.cancel(actor_id, instance.id, comment="Document voided")
            inv = _lock_invoice(invoice_id)
    for hook in VOID_HOOKS:
        hook(inv)
    inv.status = "VOID"
    inv.save(update_fields=["status", "updated_at"])
    record_tenant_event(current_tenant(), "finance.invoice.voided", actor_user_id=actor_id, target_type="Invoice", target_id=inv.id, request=request)
    return inv


@transaction.atomic
def apply_credit_note(actor_id, credit_note_id, invoice_id, amount):
    amount = _dec(amount)
    first, second = sorted([credit_note_id, invoice_id], key=str)
    locked = {str(i.id): i for i in m.Invoice.objects.select_for_update().filter(pk__in=[first, second]).order_by("pk")}
    cn, inv = locked.get(str(credit_note_id)), locked.get(str(invoice_id))
    if cn is None or inv is None:
        raise DomainError("Document not found.", code="not_found", status_code=404)
    if cn.kind not in CREDIT_KINDS or inv.kind in CREDIT_KINDS or (cn.kind == "CUSTOMER_CREDIT_NOTE") != (inv.kind == "CUSTOMER_INVOICE"):
        raise ValidationFailed("A credit note can only settle an invoice of the same side (customer/supplier).", code="credit_mismatch")
    if cn.status != "POSTED" or inv.status != "POSTED":
        raise DomainError("Both documents must be posted and open.", code="invalid_state_transition")
    if cn.partner_id != inv.partner_id or cn.currency != inv.currency:
        raise ValidationFailed("Partner and currency must match.", code="credit_mismatch")
    if amount <= 0 or amount > cn.outstanding or amount > inv.outstanding:
        raise ValidationFailed("Amount exceeds what is outstanding on the credit note or the invoice.", code="over_allocation")
    for doc in (cn, inv):
        doc.paid_amount += amount
        doc.status = "PAID" if doc.paid_amount == doc.total else "POSTED"
        doc.save(update_fields=["paid_amount", "status", "updated_at"])
    return m.CreditSettlement.objects.create(credit_note=cn, invoice=inv, amount=amount, created_by=actor_id)


# ----------------------------------------------------------------------------- payments
def _fingerprint(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


@transaction.atomic
def record_payment(actor_id, *, idempotency_key, kind, partner_id, bank_account_id, payment_date, allocations, memo="", request=None):
    """Release a payment against posted invoices. Idempotent on `idempotency_key`: the same key with the
    same payload returns the original payment; with a different payload it is rejected."""
    key = (idempotency_key or "").strip()
    if not key or len(key) > 80:
        raise ValidationFailed("An idempotency key (1-80 characters) is required.", code="idempotency_key_required")
    if kind not in m.Payment.Kind.values:
        raise ValidationFailed("Invalid payment kind.", code="invalid_kind")
    if not allocations:
        raise ValidationFailed("At least one allocation is required.", code="no_allocations")
    norm = sorted(({"invoice": str(a["invoice"]), "amount": str(_dec(a["amount"]))} for a in allocations), key=lambda a: a["invoice"])
    if len({a["invoice"] for a in norm}) != len(norm):
        raise ValidationFailed("An invoice can appear only once per payment.", code="duplicate_allocation")
    fp = _fingerprint({"kind": kind, "partner": str(partner_id), "bank": str(bank_account_id), "date": str(payment_date), "allocations": norm})
    # Serialize concurrent requests carrying the same key so a duplicate waits and then replays the original.
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [f"{connection.schema_name}:payment:{key}"])
    existing = m.Payment.objects.filter(idempotency_key=key).first()
    if existing:
        return _replay(existing, fp)
    try:
        with transaction.atomic():
            return _create_payment(actor_id, key, fp, kind, partner_id, bank_account_id, payment_date, norm, memo, request), True
    except IntegrityError:  # a concurrent request with the same key won the race
        existing = m.Payment.objects.filter(idempotency_key=key).first()
        if existing is None:
            raise
        return _replay(existing, fp)


def _replay(existing, fp):
    if existing.fingerprint != fp:
        raise DomainError("This idempotency key was already used with different data.", code="idempotency_conflict")
    return existing, False


def _create_payment(actor_id, key, fp, kind, partner_id, bank_account_id, payment_date, norm, memo, request):
    base = base_currency()
    bank = _get(m.BankAccount, bank_account_id, "Bank account")
    partner = _get(m.Partner, partner_id, "Partner")
    if not bank.is_active:
        raise ValidationFailed("The bank account is inactive.", code="invalid_bank_account")
    period = org.assert_period_open(payment_date)
    want_kind = "CUSTOMER_INVOICE" if kind == "RECEIPT" else "SUPPLIER_INVOICE"
    invoices = {str(i.id): i for i in m.Invoice.objects.select_for_update().filter(pk__in=[a["invoice"] for a in norm]).order_by("pk")}
    total = ZERO
    ctrl_total = ZERO
    alloc_rows = []
    for a in norm:
        inv, amt = invoices.get(a["invoice"]), Decimal(a["amount"])
        if inv is None:
            raise DomainError("Invoice not found.", code="not_found", status_code=404)
        if inv.kind != want_kind or inv.partner_id != partner.id or inv.status != "POSTED":
            raise ValidationFailed("Each invoice must be a posted document of this partner and the matching kind.", code="invalid_invoice")
        if inv.currency != bank.currency:
            raise ValidationFailed("Invoice currency must equal the bank account currency.", code="currency_mismatch")
        if amt <= 0 or amt > inv.outstanding:
            raise ValidationFailed(f"Allocation for {inv.number} exceeds the outstanding {inv.outstanding}.", code="over_allocation")
        if actor_id in (inv.approved_by, inv.posted_by, inv.created_by):
            raise DomainError("Separation of duties: you took part in this invoice and cannot release its payment.", code="separation_of_duties", status_code=403)
        total += amt
        ctrl_total += _q(amt * inv.fx_rate, base.decimals)
        alloc_rows.append((inv, amt))
    pay_rate = org.get_rate(bank.currency, payment_date)
    bank_base = _q(total * pay_rate, base.decimals)
    control = system_account("ar_control" if kind == "RECEIPT" else "ap_control")
    lines = []
    if kind == "RECEIPT":
        lines += [{"account": bank.gl_account, "debit": bank_base, "currency": bank.currency, "amount_currency": total}, {"account": control, "credit": ctrl_total, "currency": bank.currency, "amount_currency": -total, "partner": partner}]
    else:
        lines += [{"account": control, "debit": ctrl_total, "currency": bank.currency, "amount_currency": total, "partner": partner}, {"account": bank.gl_account, "credit": bank_base, "currency": bank.currency, "amount_currency": -total}]
    debit_sum = sum((l.get("debit", ZERO) for l in lines), ZERO)
    credit_sum = sum((l.get("credit", ZERO) for l in lines), ZERO)
    if debit_sum != credit_sum:  # realized exchange difference goes to the FX account
        fx = system_account("fx_gain_loss")
        diff = abs(debit_sum - credit_sum)
        lines.append({"account": fx, ("credit" if debit_sum > credit_sum else "debit"): diff, "description": "Realized exchange difference"})
    number = sequences.next_number("finance.payment", on_date=payment_date, for_type="Payment", for_id=key)
    entry = _post_system_entry(actor_id, payment_date, f"Payment {number}", "payment", key, lines)
    payment = m.Payment.objects.create(number=number, kind=kind, partner=partner, bank_account=bank, payment_date=payment_date, currency=bank.currency, amount=total, amount_base=bank_base, idempotency_key=key, fingerprint=fp, journal_entry=entry, released_by=actor_id, memo=memo[:300])
    for inv, amt in alloc_rows:
        m.PaymentAllocation.objects.create(payment=payment, invoice=inv, amount=amt)
        inv.paid_amount += amt
        inv.status = "PAID" if inv.paid_amount == inv.total else "POSTED"
        inv.save(update_fields=["paid_amount", "status", "updated_at"])
    record_tenant_event(current_tenant(), "finance.payment.released", actor_user_id=actor_id, target_type="Payment", target_id=payment.id, metadata={"number": number, "amount": str(total), "currency": bank.currency}, request=request)
    events.emit("finance.payment.completed", {"payment_id": str(payment.id), "number": number, "kind": kind, "amount": str(total), "currency": bank.currency}, dedup_key=f"payment-completed-{payment.id}")
    return payment


# ----------------------------------------------------------------------------- integration API for other modules
@transaction.atomic
def post_system_journal(actor_id, entry_date, memo, source_type, source_id, legs):
    """Post a balanced journal on behalf of another module. `legs` = [(system_key, "debit"|"credit", Decimal)].
    Zero legs are dropped; returns None when nothing is left (e.g. a zero-value stock movement)."""
    lines = [{"account": system_account(key), side: amount, "description": memo[:300]} for key, side, amount in legs if amount and amount > 0]
    if not lines:
        return None
    return _post_system_entry(actor_id, entry_date, memo, source_type, source_id, lines)

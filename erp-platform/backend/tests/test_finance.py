import threading
from datetime import date
from decimal import Decimal as D

import pytest
from django.db import IntegrityError, connection, connections, transaction
from django_tenants.utils import schema_context

from modules.finance import models as m
from modules.finance import reports, services as fin
from platform_core.authorization.models import RoleAssignment, RoleDefinition
from platform_core.organizations import services as org
from platform_core.organizations.models import Currency
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity, TenantMembership, User
from shared.api.errors import DomainError, ValidationFailed
from shared.workflows import services as wf
from tests.conftest import ACME_HOST, Api

D0 = date(2026, 3, 15)


def user(tenant, email, role):
    u = User.objects.create_user(email, email.split("@")[0])
    TenantMembership.objects.create(user=u, tenant=tenant, status="ACTIVE")
    RoleAssignment.objects.create(user_id=u.id, role=RoleDefinition.objects.get(name=role))
    return u


def prepare(tenant):
    """Base currency USD (+EUR), fiscal year 2026, people, partners, bank accounts. Call inside the schema."""
    usd, eur = Currency.objects.get(code="USD"), Currency.objects.get(code="EUR")
    org.update_company(None, {"base_currency": usd})
    org.set_currency_active(None, eur, True)
    org.set_exchange_rate(None, eur, date(2026, 1, 1), D("1.10"))
    org.set_exchange_rate(None, eur, date(2026, 3, 1), D("1.20"))
    org.create_fiscal_year(None, "FY2026", date(2026, 1, 1))
    people = {
        "officer": user(tenant, f"officer@{tenant.slug}.test", "finance_officer"),
        "mgr": user(tenant, f"mgr@{tenant.slug}.test", "finance_manager"),
        "mgr2": user(tenant, f"mgr2@{tenant.slug}.test", "finance_manager"),
        "ctrl": user(tenant, f"ctrl@{tenant.slug}.test", "finance_controller"),
        "auditor": user(tenant, f"aud@{tenant.slug}.test", "read_only_auditor"),
    }
    a = lambda k: m.Account.objects.get(system_key=k)
    bank_usd = fin.create_bank_account(None, name="Main USD", currency="USD", gl_account_id=a("bank_default").id)
    cash_eur_gl = fin.create_account(None, code="1020", name="EUR Bank", type="ASSET", parent_id=m.Account.objects.get(code="1000").id)
    bank_eur = fin.create_bank_account(None, name="EUR", currency="EUR", gl_account_id=cash_eur_gl.id)
    cust = fin.create_partner(None, name="Customer A", is_customer=True)
    supp = fin.create_partner(None, name="Supplier B", is_supplier=True)
    vat_s = fin.create_tax_rate(None, code="VAT15", name="VAT 15% sales", kind="SALES", rate="15", account_id=a("tax_payable").id)
    vat_p = fin.create_tax_rate(None, code="IVAT15", name="VAT 15% purchase", kind="PURCHASE", rate="15", account_id=a("tax_receivable").id)
    return dict(people=people, bank_usd=bank_usd, bank_eur=bank_eur, cust=cust, supp=supp, vat_s=vat_s, vat_p=vat_p, rev=a("sales_revenue"), exp=a("default_expense"), ar=a("ar_control"), ap=a("ap_control"))


@pytest.fixture
def f(acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        yield prepare(tenant)


def line(env, qty="1", price="100", tax=None, kind="sales", currency=None):
    acct = env["rev"] if kind == "sales" else env["exp"]
    return {"description": "Item", "quantity": qty, "unit_price": price, "account": str(acct.id), "tax_rate": str(tax.id) if tax else None}


def posted_invoice(env, kind="CUSTOMER_INVOICE", price="100", tax=True, currency=None, date_=D0, partner=None):
    p = env["people"]
    customer = kind.startswith("CUSTOMER")
    inv = fin.create_invoice(p["officer"].id, kind=kind, partner_id=(partner or (env["cust"] if customer else env["supp"])).id, invoice_date=date_, currency=currency,
                             lines=[line(env, price=price, tax=(env["vat_s"] if customer else env["vat_p"]) if tax else None, kind="sales" if customer else "exp")])
    fin.submit_invoice(p["officer"].id, inv.id)
    fin.approve_invoice(p["mgr"].id, inv.id)
    return fin.post_invoice(p["mgr2"].id, inv.id)


def jl(code, debit=0, credit=0):
    return {"account": code, "debit": debit, "credit": credit}


# ----------------------------------------------------------------------------- journals & ledger integrity
@pytest.mark.django_db
def test_balanced_journal_posts_and_shows_in_trial_balance(f):
    p = f["people"]
    e = fin.create_journal(p["officer"].id, entry_date=D0, memo="Capital", lines=[jl("1010", debit="1000"), jl("3100", credit="1000")])
    posted = fin.post_journal(p["mgr"].id, e.id)
    assert posted.status == "POSTED" and posted.number.startswith("JV-2026-") and posted.period_id
    tb = reports.trial_balance(D0)
    assert tb["balanced"] and tb["total_debit"] == "1000.0000"
    assert fin.account_balance(m.Account.objects.get(code="1010")) == D("1000")


@pytest.mark.django_db
def test_journal_validation_rules(f):
    p = f["people"]
    bad = [
        [jl("1010", debit="10")],  # one line
        [jl("1010", debit="10", credit="10"), jl("3100", credit="10")],  # both sides
        [jl("1010", debit="0"), jl("3100", credit="10")],  # zero amount
        [jl("1010", debit="-5"), jl("3100", credit="-5")],
        [jl("1000", debit="10"), jl("3100", credit="10")],  # header account
        [jl("1100", debit="10"), jl("3100", credit="10")],  # control account
        [jl("9999", debit="10"), jl("3100", credit="10")],
    ]
    for lines in bad:
        with pytest.raises(ValidationFailed):
            fin.create_journal(p["officer"].id, entry_date=D0, lines=lines)
    unbalanced = fin.create_journal(p["officer"].id, entry_date=D0, lines=[jl("1010", debit="10"), jl("3100", credit="9")])
    with pytest.raises(DomainError) as e:
        fin.post_journal(p["mgr"].id, unbalanced.id)
    assert e.value.get_codes() == "unbalanced_entry"


@pytest.mark.django_db
def test_database_blocks_tampering_with_posted_ledger(f):
    p = f["people"]
    e = fin.post_journal(p["mgr"].id, fin.create_journal(p["officer"].id, entry_date=D0, lines=[jl("1010", debit="50"), jl("3100", credit="50")]).id)
    line_row = e.lines.first()
    for action in (lambda: m.JournalLine.objects.filter(pk=line_row.pk).update(debit=999), lambda: m.JournalLine.objects.filter(pk=line_row.pk).delete(),
                   lambda: m.JournalLine.objects.create(entry=e, line_no=9, account=line_row.account, debit=1), lambda: m.JournalEntry.objects.filter(pk=e.pk).update(memo="x"),
                   lambda: m.JournalEntry.objects.filter(pk=e.pk).delete(), lambda: m.JournalEntry.objects.filter(pk=e.pk).update(status="DRAFT")):
        with pytest.raises(Exception, match="immutable|cannot|invalid"), transaction.atomic():
            action()
    # raw SQL cannot post an unbalanced draft either
    draft = fin.create_journal(p["officer"].id, entry_date=D0, lines=[jl("1010", debit="10"), jl("3100", credit="9")])
    with pytest.raises(Exception, match="unbalanced"), transaction.atomic():
        m.JournalEntry.objects.filter(pk=draft.pk).update(status="POSTED")
    # line check constraint: a line cannot carry both sides
    d2 = fin.create_journal(p["officer"].id, entry_date=D0, lines=[jl("1010", debit="1"), jl("3100", credit="1")])
    with pytest.raises(IntegrityError), transaction.atomic():
        m.JournalLine.objects.filter(entry=d2, line_no=1).update(credit=1)


@pytest.mark.django_db
def test_reversal_and_period_controls(f):
    p = f["people"]
    e = fin.post_journal(p["mgr"].id, fin.create_journal(p["officer"].id, entry_date=D0, lines=[jl("5200", debit="30"), jl("1010", credit="30")]).id)
    rev = fin.reverse_journal(p["mgr"].id, e.id, reversal_date=D0)
    e.refresh_from_db()
    assert e.status == "REVERSED" and e.reversed_by_id == rev.id and rev.status == "POSTED"
    assert fin.account_balance(m.Account.objects.get(code="5200")) == D("0")
    with pytest.raises(DomainError):
        fin.reverse_journal(p["mgr"].id, e.id)  # already reversed
    # closed period blocks posting
    draft = fin.create_journal(p["officer"].id, entry_date=date(2026, 1, 10), lines=[jl("1010", debit="5"), jl("3100", credit="5")])
    jan = org.period_for(date(2026, 1, 10))
    with pytest.raises(DomainError) as veto:
        org.close_period(None, jan)
    assert veto.value.get_codes() == "unposted_journals"
    fin.delete_draft_journal(p["officer"].id, draft.id)
    org.close_period(None, jan)
    late = fin.create_journal(p["officer"].id, entry_date=date(2026, 1, 20), lines=[jl("1010", debit="5"), jl("3100", credit="5")])
    with pytest.raises(DomainError) as closed:
        fin.post_journal(p["mgr"].id, late.id)
    assert closed.value.get_codes() == "period_closed"


@pytest.mark.django_db
def test_subledger_entries_cannot_be_reversed_manually(f):
    inv = posted_invoice(f)
    with pytest.raises(DomainError) as e:
        fin.reverse_journal(f["people"]["mgr"].id, inv.journal_entry_id)
    assert e.value.get_codes() == "subledger_entry_protected"


# ----------------------------------------------------------------------------- invoices
@pytest.mark.django_db
def test_customer_invoice_lifecycle_posting_and_separation_of_duties(f):
    p = f["people"]
    inv = fin.create_invoice(p["officer"].id, kind="CUSTOMER_INVOICE", partner_id=f["cust"].id, invoice_date=D0, lines=[line(f, qty="3", price="33.33", tax=f["vat_s"])])
    assert (inv.subtotal, inv.tax_total, inv.total) == (D("99.99"), D("15.00"), D("114.99"))
    fin.submit_invoice(p["officer"].id, inv.id)
    with pytest.raises(DomainError) as e:  # creator cannot approve their own document
        fin.approve_invoice(p["officer"].id, inv.id)
    assert e.value.get_codes() == "separation_of_duties"
    with pytest.raises(DomainError):
        fin.post_invoice(p["mgr"].id, inv.id)  # not approved yet
    fin.approve_invoice(p["mgr"].id, inv.id)
    with pytest.raises(DomainError):
        fin.update_invoice(p["officer"].id, inv.id, lines=[line(f)])  # no edits after submission
    posted = fin.post_invoice(p["mgr2"].id, inv.id)
    assert posted.number.startswith("INV-2026-") and posted.total_base == D("114.99") and posted.fx_rate == 1
    entry = posted.journal_entry
    amounts = {l.account.code: (l.debit, l.credit) for l in entry.lines.select_related("account")}
    assert amounts == {"1100": (D("114.99"), 0), "4100": (0, D("99.99")), "2300": (0, D("15.00"))}
    with pytest.raises(DomainError) as v:
        fin.void_invoice(p["officer"].id, inv.id)
    assert v.value.get_codes() == "posted_document_protected"
    from shared.events.models import OutboxEvent

    assert OutboxEvent.objects.filter(event_type="finance.invoice.posted", payload__invoice_id=str(inv.id)).count() == 1


@pytest.mark.django_db
def test_supplier_invoice_posting_and_validation(f):
    inv = posted_invoice(f, kind="SUPPLIER_INVOICE")
    amounts = {l.account.code: (l.debit, l.credit) for l in inv.journal_entry.lines.select_related("account")}
    assert amounts == {"5200": (D("100"), 0), "1300": (D("15"), 0), "2100": (0, D("115"))}
    p = f["people"]
    with pytest.raises(ValidationFailed):  # sales tax on a supplier document
        fin.create_invoice(p["officer"].id, kind="SUPPLIER_INVOICE", partner_id=f["supp"].id, invoice_date=D0, lines=[line(f, tax=f["vat_s"], kind="exp")])
    with pytest.raises(ValidationFailed):  # customer used on a supplier bill
        fin.create_invoice(p["officer"].id, kind="SUPPLIER_INVOICE", partner_id=f["cust"].id, invoice_date=D0, lines=[line(f, kind="exp")])
    with pytest.raises(ValidationFailed):  # revenue account on a bill
        fin.create_invoice(p["officer"].id, kind="SUPPLIER_INVOICE", partner_id=f["supp"].id, invoice_date=D0, lines=[line(f, kind="sales")])


@pytest.mark.django_db
def test_posting_blocked_in_closed_period_and_without_rate(f):
    p = f["people"]
    inv = fin.create_invoice(p["officer"].id, kind="CUSTOMER_INVOICE", partner_id=f["cust"].id, invoice_date=date(2026, 1, 5), lines=[line(f)])
    fin.submit_invoice(p["officer"].id, inv.id)
    fin.approve_invoice(p["mgr"].id, inv.id)
    org.close_period(None, org.period_for(date(2026, 1, 5)))
    with pytest.raises(DomainError) as e:
        fin.post_invoice(p["mgr2"].id, inv.id)
    assert e.value.get_codes() == "period_closed"
    old = fin.create_invoice(p["officer"].id, kind="CUSTOMER_INVOICE", partner_id=f["cust"].id, invoice_date=date(2026, 3, 20), currency="EUR", lines=[line(f)])
    Currency.objects.filter(code="EUR").update(is_active=False)
    with pytest.raises(ValidationFailed):
        fin.update_invoice(p["officer"].id, old.id, lines=[line(f)])  # inactive currency refused


@pytest.mark.django_db
def test_workflow_governed_invoice_approval(f):
    p = f["people"]
    wf.create_definition(p["mgr"].id, code="inv", name="Invoice approval", subject_type="finance.invoice", stages=[{"order": 1, "approvers": [{"type": "USER", "ref": str(p["mgr"].id)}]}])
    inv = fin.create_invoice(p["officer"].id, kind="SUPPLIER_INVOICE", partner_id=f["supp"].id, invoice_date=D0, lines=[line(f, kind="exp")])
    fin.submit_invoice(p["officer"].id, inv.id)
    inv.refresh_from_db()
    assert inv.status == "SUBMITTED" and inv.workflow_instance_id
    with pytest.raises(DomainError) as e:
        fin.approve_invoice(p["mgr2"].id, inv.id)  # cannot bypass the workflow
    assert e.value.get_codes() == "workflow_governed"
    from shared.workflows.models import ApprovalTask

    task = ApprovalTask.objects.get(instance_id=inv.workflow_instance_id, assignee_id=p["mgr"].id)
    wf.decide(p["mgr"].id, task.id, "REJECT", "wrong supplier")
    inv.refresh_from_db()
    assert inv.status == "DRAFT" and inv.workflow_instance_id is None  # back to the author
    fin.submit_invoice(p["officer"].id, inv.id)
    inv.refresh_from_db()
    task = ApprovalTask.objects.get(instance_id=inv.workflow_instance_id, assignee_id=p["mgr"].id, status="PENDING")
    wf.decide(p["mgr"].id, task.id, "APPROVE")
    inv.refresh_from_db()
    assert inv.status == "APPROVED" and inv.approved_by == p["mgr"].id
    assert fin.post_invoice(p["mgr2"].id, inv.id).status == "POSTED"


@pytest.mark.django_db
def test_void_before_posting_cancels_workflow(f):
    p = f["people"]
    wf.create_definition(p["mgr"].id, code="inv", name="Invoice approval", subject_type="finance.invoice", stages=[{"order": 1, "approvers": [{"type": "USER", "ref": str(p["mgr"].id)}]}])
    inv = fin.create_invoice(p["officer"].id, kind="SUPPLIER_INVOICE", partner_id=f["supp"].id, invoice_date=D0, lines=[line(f, kind="exp")])
    fin.submit_invoice(p["officer"].id, inv.id)
    inv.refresh_from_db()
    instance_id = inv.workflow_instance_id
    assert fin.void_invoice(p["officer"].id, inv.id).status == "VOID"
    from shared.workflows.models import WorkflowInstance

    assert WorkflowInstance.objects.get(pk=instance_id).status == "CANCELLED"


# ----------------------------------------------------------------------------- payments
def pay(f, inv, amount, key, who="ctrl", kind=None, bank=None, date_=D0):
    kind = kind or ("RECEIPT" if inv.kind.startswith("CUSTOMER") else "DISBURSEMENT")
    return fin.record_payment(f["people"][who].id, idempotency_key=key, kind=kind, partner_id=inv.partner_id, bank_account_id=(bank or f["bank_usd"]).id, payment_date=date_, allocations=[{"invoice": inv.id, "amount": amount}])


@pytest.mark.django_db
def test_receipt_partial_then_full_and_over_allocation(f):
    inv = posted_invoice(f)  # 115
    payment, created = pay(f, inv, "40", "k1")
    inv.refresh_from_db()
    assert created and inv.status == "POSTED" and inv.paid_amount == D("40") and inv.outstanding == D("75")
    assert {l.account.code: (l.debit, l.credit) for l in payment.journal_entry.lines.select_related("account")} == {"1010": (D("40"), 0), "1100": (0, D("40"))}
    with pytest.raises(ValidationFailed) as e:
        pay(f, inv, "75.01", "k2")
    assert e.value.get_codes() == "over_allocation"
    pay(f, inv, "75", "k3")
    inv.refresh_from_db()
    assert inv.status == "PAID" and inv.outstanding == 0
    with pytest.raises(ValidationFailed):
        pay(f, inv, "1", "k4")  # fully paid invoice is no longer payable
    assert fin.account_balance(f["ar"]) == D("0")


@pytest.mark.django_db
def test_payment_idempotency_and_conflict(f):
    inv = posted_invoice(f)
    first, c1 = pay(f, inv, "50", "same-key")
    again, c2 = pay(f, inv, "50", "same-key")
    assert c1 and not c2 and first.id == again.id
    inv.refresh_from_db()
    assert inv.paid_amount == D("50") and m.Payment.objects.count() == 1 and m.JournalEntry.objects.filter(source_type="payment").count() == 1
    with pytest.raises(DomainError) as e:
        pay(f, inv, "60", "same-key")
    assert e.value.get_codes() == "idempotency_conflict"
    with pytest.raises(ValidationFailed):
        pay(f, inv, "10", "")


@pytest.mark.django_db
def test_payment_separation_of_duties_and_kind_checks(f):
    inv = posted_invoice(f)
    with pytest.raises(DomainError) as e:  # the approver of the invoice cannot release its payment
        pay(f, inv, "10", "sod", who="mgr")
    assert e.value.get_codes() == "separation_of_duties"
    with pytest.raises(ValidationFailed):
        pay(f, inv, "10", "kind", kind="DISBURSEMENT")  # customer invoice cannot be paid out
    other = fin.create_partner(None, name="Other", is_customer=True)
    with pytest.raises(ValidationFailed):
        fin.record_payment(f["people"]["ctrl"].id, idempotency_key="partner", kind="RECEIPT", partner_id=other.id, bank_account_id=f["bank_usd"].id, payment_date=D0, allocations=[{"invoice": inv.id, "amount": "10"}])
    with pytest.raises(ValidationFailed):  # EUR bank for a USD invoice
        pay(f, inv, "10", "cur", bank=f["bank_eur"])
    org.close_period(None, org.period_for(date(2026, 1, 1)))
    with pytest.raises(DomainError) as closed:
        pay(f, inv, "10", "late", date_=date(2026, 1, 15))
    assert closed.value.get_codes() == "period_closed"


@pytest.mark.django_db
def test_supplier_disbursement_and_trial_balance(f):
    bill = posted_invoice(f, kind="SUPPLIER_INVOICE")
    payment, _ = pay(f, bill, "115", "bill-1")
    assert {l.account.code: (l.debit, l.credit) for l in payment.journal_entry.lines.select_related("account")} == {"2100": (D("115"), 0), "1010": (0, D("115"))}
    bill.refresh_from_db()
    assert bill.status == "PAID"
    tb = reports.trial_balance(D0)
    assert tb["balanced"] and D(tb["total_debit"]) == D("115")  # expense 100 + tax receivable 15 vs bank -115 netted


@pytest.mark.django_db
def test_foreign_currency_invoice_and_realized_fx_difference(f):
    inv = posted_invoice(f, currency="EUR", price="100", tax=False, date_=date(2026, 2, 10))  # rate 1.10 -> 110 USD
    assert inv.fx_rate == D("1.1") and inv.total_base == D("110.00")
    assert {l.account.code: l.debit or l.credit for l in inv.journal_entry.lines.select_related("account")} == {"1100": D("110"), "4100": D("110")}
    payment, _ = pay(f, inv, "100", "fx-1", bank=f["bank_eur"], date_=D0)  # paid at 1.20 -> 120 USD
    assert payment.amount_base == D("120.00")
    lines = {l.account.code: (l.debit, l.credit) for l in payment.journal_entry.lines.select_related("account")}
    assert lines["1020"] == (D("120"), 0) and lines["1100"] == (0, D("110")) and lines["5900"] == (0, D("10"))  # FX gain
    assert fin.account_balance(f["ar"]) == D("0") and reports.trial_balance(D0)["balanced"]


@pytest.mark.django_db
def test_credit_note_flow_and_settlement(f):
    p = f["people"]
    inv = posted_invoice(f, price="200", tax=False)
    cn = fin.create_invoice(p["officer"].id, kind="CUSTOMER_CREDIT_NOTE", partner_id=f["cust"].id, invoice_date=D0, credit_for_id=inv.id, lines=[line(f, price="50")])
    fin.submit_invoice(p["officer"].id, cn.id)
    fin.approve_invoice(p["mgr"].id, cn.id)
    cn = fin.post_invoice(p["mgr2"].id, cn.id)
    assert cn.number.startswith("CN-") and {l.account.code: (l.debit, l.credit) for l in cn.journal_entry.lines.select_related("account")} == {"4100": (D("50"), 0), "1100": (0, D("50"))}
    assert fin.account_balance(f["ar"]) == D("150")
    fin.apply_credit_note(p["mgr"].id, cn.id, inv.id, "50")
    inv.refresh_from_db(); cn.refresh_from_db()
    assert cn.status == "PAID" and inv.outstanding == D("150")
    with pytest.raises(DomainError):
        fin.apply_credit_note(p["mgr"].id, cn.id, inv.id, "1")  # credit note already fully applied
    with pytest.raises(ValidationFailed):  # mismatched original
        fin.create_invoice(p["officer"].id, kind="CUSTOMER_CREDIT_NOTE", partner_id=f["supp"].id, invoice_date=D0, credit_for_id=inv.id, lines=[line(f)])


# ----------------------------------------------------------------------------- reports
@pytest.mark.django_db
def test_financial_statements_tie_out(f):
    p = f["people"]
    fin.post_journal(p["mgr"].id, fin.create_journal(p["officer"].id, entry_date=date(2026, 1, 5), lines=[jl("1010", debit="1000"), jl("3100", credit="1000")]).id)
    inv = posted_invoice(f, price="200", tax=True)  # AR 230, rev 200, tax 30
    pay(f, inv, "100", "r1")
    posted_invoice(f, kind="SUPPLIER_INVOICE", price="80", tax=False)  # expense 80, AP 80
    pl = reports.profit_and_loss(date(2026, 1, 1), date(2026, 12, 31))
    assert pl["total_revenue"] == "200.0000" and pl["total_expenses"] == "80.0000" and pl["net_profit"] == "120.0000"
    bs = reports.balance_sheet(date(2026, 12, 31))
    assert bs["balanced"] and bs["current_earnings"] == "120.0000"
    assert D(bs["total_assets"]) == D(bs["total_liabilities"]) + D(bs["total_equity"])
    led = reports.ledger(f["ar"], D0)
    assert led["rows"][-1]["balance"] == led["closing_balance"] == "130.0000"
    assert reports.trial_balance(date(2026, 12, 31))["balanced"]


# ----------------------------------------------------------------------------- API & authorization
@pytest.fixture
def api_env(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = prepare(tenant)
    apis = {}
    for key, u in env["people"].items():
        ExternalIdentity.objects.create(user=u, issuer="https://kc.test/realms/erp", subject=f"{key}-sub")
        api = Api(ACME_HOST)
        assert api.login(idp, f"{key}-sub").status_code == 302
        apis[key] = api
    return env, apis


@pytest.mark.django_db
def test_api_permission_matrix_and_full_cycle(api_env):
    env, api = api_env
    body = {"kind": "CUSTOMER_INVOICE", "partner": str(env["cust"].id), "invoice_date": "2026-03-15", "lines": [{"description": "Work", "quantity": "2", "unit_price": "50", "account": str(env["rev"].id), "tax_rate": str(env["vat_s"].id)}]}
    assert api["ctrl"].post("/api/v1/finance/invoices", body).status_code == 403  # controller cannot create
    assert api["auditor"].post("/api/v1/finance/invoices", body).status_code == 403
    created = api["officer"].post("/api/v1/finance/invoices", body)
    assert created.status_code == 201 and D(created.json()["total"]) == D("115")
    iid = created.json()["id"]
    assert api["officer"].post(f"/api/v1/finance/invoices/{iid}/submit").status_code == 200
    assert api["officer"].post(f"/api/v1/finance/invoices/{iid}/approve").status_code == 403  # no permission
    assert api["mgr"].post(f"/api/v1/finance/invoices/{iid}/approve").status_code == 200
    assert api["ctrl"].post(f"/api/v1/finance/invoices/{iid}/post").status_code == 403  # controller cannot post
    posted = api["mgr2"].post(f"/api/v1/finance/invoices/{iid}/post")
    assert posted.status_code == 200 and posted.json()["status"] == "POSTED"
    assert api["auditor"].get(f"/api/v1/finance/invoices/{iid}").status_code == 200
    pay_body = {"kind": "RECEIPT", "partner": str(env["cust"].id), "bank_account": str(env["bank_usd"].id), "payment_date": "2026-03-16", "allocations": [{"invoice": iid, "amount": "115"}]}
    assert api["mgr"].post("/api/v1/finance/payments", pay_body, **{"Idempotency-Key": "a1"}).status_code == 403  # managers cannot release
    assert api["ctrl"].post("/api/v1/finance/payments", pay_body).status_code == 400  # key required
    first = api["ctrl"].post("/api/v1/finance/payments", pay_body, **{"Idempotency-Key": "a1"})
    again = api["ctrl"].post("/api/v1/finance/payments", pay_body, **{"Idempotency-Key": "a1"})
    assert first.status_code == 201 and again.status_code == 200 and again["Idempotent-Replay"] == "true" and first.json()["id"] == again.json()["id"]
    assert api["ctrl"].post("/api/v1/finance/payments", {**pay_body, "payment_date": "2026-03-17"}, **{"Idempotency-Key": "a1"}).status_code == 409
    tb = api["auditor"].get("/api/v1/finance/reports/trial-balance?as_of=2026-12-31").json()
    assert tb["balanced"]
    assert api["officer"].get("/api/v1/finance/reports/trial-balance").status_code == 403  # officers lack reports.financial.view
    assert api["auditor"].get("/api/v1/finance/reports/profit-loss").status_code == 400  # from/to required
    assert api["auditor"].get("/api/v1/finance/reports/profit-loss?from=2026-01-01&to=2026-12-31").json()["total_revenue"] == "100.0000"


@pytest.mark.django_db
def test_api_journal_and_account_rules(api_env):
    env, api = api_env
    j = {"entry_date": "2026-03-15", "memo": "x", "lines": [{"account": "1010", "debit": "5"}, {"account": "3100", "credit": "5"}]}
    created = api["officer"].post("/api/v1/finance/journals", j)
    assert created.status_code == 201
    jid = created.json()["id"]
    assert api["officer"].post(f"/api/v1/finance/journals/{jid}/post").status_code == 403  # create != post
    assert api["mgr"].post(f"/api/v1/finance/journals/{jid}/post").status_code == 200
    assert api["mgr"].delete(f"/api/v1/finance/journals/{jid}").status_code == 409  # posted entries cannot be deleted
    assert api["officer"].post("/api/v1/finance/accounts", {"code": "6000", "name": "X", "type": "EXPENSE"}).status_code == 403
    with schema_context("t_acme"):
        parent = m.Account.objects.get(code="5000")
    assert api["mgr"].post("/api/v1/finance/accounts", {"code": "5300", "name": "Travel", "type": "EXPENSE", "parent": str(parent.id)}).status_code == 201
    assert api["mgr"].post("/api/v1/finance/accounts", {"code": "5300", "name": "Dup", "type": "EXPENSE"}).status_code == 409
    with schema_context("t_acme"):
        ctl = m.Account.objects.get(system_key="ar_control")
    assert api["mgr"].patch(f"/api/v1/finance/accounts/{ctl.id}", {"is_active": False}).status_code == 409


@pytest.mark.django_db
def test_finance_requires_module_entitlement(api_env, acme):
    env, api = api_env
    from platform_core.tenants.models import ModuleEntitlement

    ModuleEntitlement.objects.filter(tenant_id=acme["id"], module="finance").update(enabled=False)
    r = api["mgr"].get("/api/v1/finance/accounts")
    assert r.status_code == 403


# ----------------------------------------------------------------------------- concurrency
@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicate_payment_requests_create_one_payment(own_tenant):
    tenant = own_tenant("finrace")
    with schema_context(tenant.schema_name):
        env = prepare(tenant)
        inv = posted_invoice(env)
    results = []

    def go():
        try:
            with schema_context(tenant.schema_name):
                payment, created = pay(env, inv, "115", "race-key")
            results.append(("created" if created else "replay", payment.id))
        except DomainError as exc:
            results.append((exc.get_codes(), None))
        finally:
            connections.close_all()

    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    kinds = sorted(r[0] for r in results)
    assert kinds.count("created") == 1 and set(kinds) <= {"created", "replay"}, results
    with schema_context(tenant.schema_name):
        assert m.Payment.objects.count() == 1
        assert m.Invoice.objects.get(pk=inv.pk).paid_amount == D("115")
        assert reports.trial_balance(D0)["balanced"]

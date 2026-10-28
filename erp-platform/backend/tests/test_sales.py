import threading
from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django.db import connections
from django.utils import timezone
from django_tenants.utils import schema_context

from modules.crm import models as cm
from modules.crm import services as crm
from modules.finance import models as fm
from modules.finance import services as fin
from modules.inventory import models as im
from modules.inventory import services as inv
from modules.sales import models as sm
from modules.sales import services as sales
from platform_core.organizations import services as org
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from shared.events.models import OutboxEvent
from shared.workflows import services as wf
from shared.workflows.models import ApprovalTask
from tests.conftest import ACME_HOST, Api
from tests.test_finance import prepare, user
from tests.test_inventory import master

D0 = date(2026, 3, 15)


def setup_env(tenant):
    env = master(tenant, prepare(tenant))
    crm.seed_defaults()
    p = env["people"]
    p.update(rep1=user(tenant, f"rep1@{tenant.slug}.test", "sales_rep"), rep2=user(tenant, f"rep2@{tenant.slug}.test", "sales_rep"), sm=user(tenant, f"sm@{tenant.slug}.test", "sales_manager"), sm2=user(tenant, f"sm2@{tenant.slug}.test", "sales_manager"))
    inv.receive_stock(None, product_id=env["widget"].id, location_id=env["loc_a"].id, quantity="100", unit_cost="5", on_date=D0)
    env["acct"] = crm.create_account(p["rep1"].id, name="Globex Customer")
    return env


@pytest.fixture
def f(acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        yield setup_env(tenant)


def line(f, qty="10", price="100", disc="0", tax=False, product=None):
    return {"product": str((product or f["widget"]).id), "quantity": qty, "unit_price": price, "discount_percent": disc, "tax_rate": str(f["vat_s"].id) if tax else None}


def order(f, lines=None, actor="rep1", **kw):
    return sales.create_order(f["people"][actor].id, account_id=f["acct"].id, currency="USD", order_date=D0, lines=lines or [line(f)], **kw)


def confirmed(f, lines=None, **kw):
    o = order(f, lines, **kw)
    sales.submit_order(f["people"]["rep1"].id, o.id)
    o.refresh_from_db()
    assert o.status == "CONFIRMED"
    return o


def deliver(f, o, qty=None, ol=None):
    ol = ol or o.lines.first()
    return sales.create_delivery(f["people"]["wh"].id, o.id, location_id=f["loc_a"].id, delivery_date=D0, lines=[{"order_line": str(ol.id), "quantity": qty or str(ol.quantity)}])


# ----------------------------------------------------------------------------- CRM
@pytest.mark.django_db
def test_records_are_visible_only_to_owner_and_managers(f):
    p = f["people"]
    with pytest.raises(DomainError) as e:
        crm._own(cm.CrmAccount, f["acct"].id, p["rep2"].id, "Account")
    assert e.value.status_code == 404
    assert crm._own(cm.CrmAccount, f["acct"].id, p["sm"].id, "Account").id == f["acct"].id
    assert crm.scope(cm.CrmAccount.objects.all(), p["rep2"].id).count() == 0
    with pytest.raises(DomainError):
        crm.assign_owner(p["rep1"].id, "account", f["acct"].id, p["rep2"].id)  # reps cannot reassign
    crm.assign_owner(p["sm"].id, "account", f["acct"].id, p["rep2"].id)
    assert crm.scope(cm.CrmAccount.objects.all(), p["rep2"].id).count() == 1


@pytest.mark.django_db
def test_round_robin_lead_assignment_balances_reps(f):
    p = f["people"]
    owners = [crm.create_lead(p["sm"].id, name=f"L{i}").owner_id for i in range(4)]
    assert {owners.count(p["rep1"].id), owners.count(p["rep2"].id)} == {2}


@pytest.mark.django_db
def test_lead_converts_once_and_only_when_qualified(f):
    p = f["people"]
    lead = crm.create_lead(p["rep1"].id, name="Ann", company="Initech", auto_assign=False)
    with pytest.raises(DomainError):
        crm.convert_lead(p["rep1"].id, lead.id, currency="USD")
    crm.set_lead_status(p["rep1"].id, lead.id, "QUALIFIED")
    lead2, opp = crm.convert_lead(p["rep1"].id, lead.id, amount="500", currency="USD")
    assert lead2.status == "CONVERTED" and opp.account.name == "Initech"
    with pytest.raises(DomainError) as e:
        crm.convert_lead(p["rep1"].id, lead.id, currency="USD")
    assert e.value.get_codes() == "already_converted"
    assert OutboxEvent.objects.filter(event_type="crm.lead.converted", payload__lead_id=str(lead.id)).count() == 1
    with pytest.raises(ValidationFailed):
        crm.set_lead_status(p["rep1"].id, crm.create_lead(p["rep1"].id, name="B", auto_assign=False).id, "DISQUALIFIED")  # reason required


@pytest.mark.django_db
def test_forecast_is_probability_weighted_and_activities_followup(f):
    p = f["people"]
    close = date(2026, 6, 30)
    crm.create_opportunity(p["rep1"].id, name="A", account_id=f["acct"].id, amount="1000", currency="USD", expected_close=close)
    crm.create_opportunity(p["rep1"].id, name="B", account_id=f["acct"].id, amount="2000", currency="USD", expected_close=close, stage="PROPOSAL")
    row = crm.forecast(p["rep1"].id)[0]
    assert (row["count"], row["amount"], row["weighted"]) == (2, "3000.0000", "1100.00")
    assert crm.forecast(p["rep2"].id) == []  # not theirs
    a = crm.log_activity(p["rep1"].id, type="CALL", subject="Call back", due_at=timezone.now() - timedelta(hours=1), account_id=f["acct"].id)
    assert list(crm.followups_due(p["rep1"].id)) == [a] and list(crm.followups_due(p["rep2"].id)) == []
    crm.complete_activity(p["rep1"].id, a.id)
    assert not crm.followups_due(p["rep1"].id).exists()
    with pytest.raises(ValidationFailed):
        crm.log_activity(p["rep1"].id, type="CALL", subject="orphan")


# ----------------------------------------------------------------------------- pricing & quotations
@pytest.mark.django_db
def test_price_list_quantity_breaks_and_server_side_pricing(f):
    p = f["people"]
    sales.create_price_list(p["sm"].id, name="Std", currency="USD", items=[{"product": f["widget"].id, "min_quantity": 1, "unit_price": "100"}, {"product": f["widget"].id, "min_quantity": 10, "unit_price": "90"}])
    assert sales.price_for(f["widget"].id, "USD", D("5"), D0) == D("100")
    assert sales.price_for(f["widget"].id, "USD", D("10"), D0) == D("90")
    assert sales.price_for(f["widget"].id, "EUR", D("10"), D0) is None
    q = sales.create_quotation(p["rep1"].id, account_id=f["acct"].id, currency="USD", lines=[{"product": f["widget"].id, "quantity": "10", "discount_percent": "10", "tax_rate": str(f["vat_s"].id)}])
    l = q.lines.get()
    assert (l.unit_price, l.net_unit_price, l.line_total, l.tax_amount) == (D("90"), D("81"), D("810"), D("121.50"))
    assert q.total == D("931.50")
    with pytest.raises(ValidationFailed) as e:
        sales.create_quotation(p["rep1"].id, account_id=f["acct"].id, currency="USD", lines=[{"product": f["paint"].id, "quantity": "1"}])
    assert e.value.get_codes() == "no_price"
    for bad in ({"discount_percent": "101"}, {"quantity": "0"}, {"unit_price": "-1"}):
        with pytest.raises(ValidationFailed):
            sales.create_quotation(p["rep1"].id, account_id=f["acct"].id, currency="USD", lines=[{**line(f), **bad}])


@pytest.mark.django_db
def test_quotation_lifecycle_to_order_and_expiry(f):
    p = f["people"]
    q = sales.create_quotation(p["rep1"].id, account_id=f["acct"].id, currency="USD", lines=[line(f)], valid_until=date(2999, 1, 1))
    with pytest.raises(DomainError):
        sales.accept_quotation(p["rep1"].id, q.id)  # not sent yet
    with pytest.raises(DomainError):
        sales.convert_quotation(p["rep1"].id, q.id)
    sales.send_quotation(p["rep1"].id, q.id)
    with pytest.raises(DomainError):
        sales.update_quotation(p["rep1"].id, q.id, lines=[line(f)])  # frozen once sent
    sales.accept_quotation(p["rep1"].id, q.id)
    o = sales.convert_quotation(p["rep1"].id, q.id, order_date=D0)
    q.refresh_from_db()
    assert q.status == "CONVERTED" and o.total == q.total and o.quotation_id == q.id
    with pytest.raises(DomainError):
        sales.convert_quotation(p["rep1"].id, q.id)  # only once
    old = sales.create_quotation(p["rep1"].id, account_id=f["acct"].id, currency="USD", lines=[line(f)], valid_until=date(2020, 1, 1))
    sales.send_quotation(p["rep1"].id, old.id)
    with pytest.raises(DomainError) as e:
        sales.accept_quotation(p["rep1"].id, old.id)
    assert e.value.get_codes() == "quotation_expired"
    with pytest.raises(DomainError):
        sales.send_quotation(p["rep2"].id, old.id)  # other rep's quote


# ----------------------------------------------------------------------------- order approval
@pytest.mark.django_db
def test_order_within_limits_confirms_directly_and_wins_opportunity(f):
    p = f["people"]
    opp = crm.create_opportunity(p["rep1"].id, name="Deal", account_id=f["acct"].id, amount="1000", currency="USD")
    o = confirmed(f, opportunity_id=opp.id)
    opp.refresh_from_db()
    assert opp.status == "WON" and o.approval_required is False
    assert OutboxEvent.objects.filter(event_type="sales.order.confirmed", payload__order_id=str(o.id)).count() == 1
    with pytest.raises(DomainError):
        sales.update_order(p["rep1"].id, o.id, lines=[line(f)])  # confirmed orders are frozen


@pytest.mark.django_db
def test_discount_above_limit_needs_approval_with_separation_of_duties(f):
    p = f["people"]
    o = order(f, [line(f, disc="15")])
    sales.submit_order(p["rep1"].id, o.id)
    o.refresh_from_db()
    assert o.status == "PENDING_APPROVAL" and o.approval_required
    with pytest.raises(DomainError) as e:
        sales.approve_order(p["rep1"].id, o.id)
    assert e.value.status_code == 403 and e.value.get_codes() == "separation_of_duties"
    sm_order = order(f, [line(f, disc="15")], actor="sm")
    sales.submit_order(p["sm"].id, sm_order.id)
    with pytest.raises(DomainError):
        sales.approve_order(p["sm"].id, sm_order.id)  # a manager cannot approve their own order either
    sales.approve_order(p["sm"].id, o.id)
    o.refresh_from_db()
    assert o.status == "CONFIRMED" and o.approved_by == p["sm"].id
    with pytest.raises(DomainError):
        sales.approve_order(p["sm2"].id, o.id)  # already decided


@pytest.mark.django_db
def test_value_threshold_uses_base_currency(f):
    p = f["people"]
    org.update_settings(None, {"sales.approval_threshold": 1000})
    big = order(f, [line(f, qty="10", price="100")])  # 1000 USD hits the threshold
    sales.submit_order(p["rep1"].id, big.id)
    big.refresh_from_db()
    assert big.status == "PENDING_APPROVAL"
    eur = sales.create_order(p["rep1"].id, account_id=f["acct"].id, currency="EUR", order_date=D0, lines=[line(f, qty="10", price="90")])  # 900 EUR = 1080 USD
    sales.submit_order(p["rep1"].id, eur.id)
    eur.refresh_from_db()
    assert eur.status == "PENDING_APPROVAL"
    org.update_settings(None, {"sales.approval_threshold": 100000})
    small = order(f, [line(f, qty="10", price="100")])
    sales.submit_order(p["rep1"].id, small.id)
    small.refresh_from_db()
    assert small.status == "CONFIRMED"


@pytest.mark.django_db
def test_workflow_governed_order_approval_and_rejection(f):
    p = f["people"]
    wf.create_definition(p["sm"].id, code="so", name="Order approval", subject_type="sales.order", stages=[{"order": 1, "name": "Sales mgr", "approvers": [{"type": "USER", "ref": str(p["sm"].id)}]}])
    o1, o2 = order(f, [line(f, disc="20")]), order(f, [line(f, disc="20")])
    for o in (o1, o2):
        sales.submit_order(p["rep1"].id, o.id)
        o.refresh_from_db()
        assert o.status == "PENDING_APPROVAL" and o.workflow_instance_id
    with pytest.raises(DomainError) as e:
        sales.approve_order(p["sm"].id, o1.id)
    assert e.value.get_codes() == "workflow_governed"
    wf.decide(p["sm"].id, ApprovalTask.objects.get(instance_id=o1.workflow_instance_id, assignee_id=p["sm"].id).id, "APPROVE")
    wf.decide(p["sm"].id, ApprovalTask.objects.get(instance_id=o2.workflow_instance_id, assignee_id=p["sm"].id).id, "REJECT", "no")
    o1.refresh_from_db(); o2.refresh_from_db()
    assert o1.status == "CONFIRMED" and o2.status == "DRAFT" and o2.workflow_instance_id is None
    sales.cancel_order(p["rep1"].id, o2.id)
    assert sm.SalesOrder.objects.get(pk=o2.id).status == "CANCELLED"


# ----------------------------------------------------------------------------- delivery
@pytest.mark.django_db
def test_delivery_issues_stock_posts_cogs_and_refuses_over_delivery(f):
    o = confirmed(f, [line(f, qty="10")])
    ol = o.lines.get()
    with pytest.raises(ValidationFailed) as e:
        deliver(f, o, "11")
    assert e.value.get_codes() == "over_delivery"
    assert not sm.Delivery.objects.exists() and inv.on_hand(f["widget"].id) == D("100")  # nothing half-done
    d = deliver(f, o, "4")
    o.refresh_from_db(); ol.refresh_from_db()
    assert o.status == "PARTIALLY_DELIVERED" and ol.delivered_quantity == 4 and d.lines.get().unit_cost == D("5")
    assert inv.on_hand(f["widget"].id) == D("96") and fin.account_balance(fm.Account.objects.get(code="5100")) == D("20")
    deliver(f, o, "6")
    o.refresh_from_db()
    assert o.status == "DELIVERED"
    with pytest.raises(DomainError):
        deliver(f, o, "1")
    pending = confirmed(f, [line(f, qty="500", price="1")])
    with pytest.raises(DomainError) as e:
        deliver(f, pending, "500")
    assert e.value.get_codes() == "insufficient_stock"
    assert im.StockLevel.objects.get(product=f["widget"], location=f["loc_a"]).quantity == D("90")


@pytest.mark.django_db
def test_services_need_no_stock_and_unconfirmed_orders_cannot_ship(f):
    draft = order(f)
    with pytest.raises(DomainError):
        deliver(f, draft)
    svc = confirmed(f, [line(f, qty="3", price="200", product=f["service"])])
    deliver(f, svc)
    assert svc.deliveries.get().lines.get().stock_movement_id is None


# ----------------------------------------------------------------------------- invoicing
@pytest.mark.django_db
def test_invoice_creates_finance_draft_for_delivered_quantity_only(f):
    p = f["people"]
    o = confirmed(f, [line(f, qty="10", price="100", tax=True)])
    with pytest.raises(DomainError):
        sales.invoice_order(p["sm"].id, o.id)  # nothing delivered yet
    deliver(f, o, "4")
    inv1 = sales.invoice_order(p["sm"].id, o.id, invoice_date=D0)
    assert (inv1.kind, inv1.status, inv1.currency) == ("CUSTOMER_INVOICE", "DRAFT", "USD")
    assert (inv1.subtotal, inv1.tax_total, inv1.total) == (D("400"), D("60"), D("460"))
    assert inv1.due_date == D0 + timedelta(days=30) and inv1.partner.is_customer
    with pytest.raises(DomainError) as e:
        sales.invoice_order(p["sm"].id, o.id)
    assert e.value.get_codes() == "nothing_to_invoice"
    ol = o.lines.get()
    deliver(f, o, "6")
    with pytest.raises(ValidationFailed) as e:
        sales.invoice_order(p["sm"].id, o.id, lines=[{"order_line": str(ol.id), "quantity": "7"}])
    assert e.value.get_codes() == "over_invoicing"
    sales.invoice_order(p["sm"].id, o.id, lines=[{"order_line": str(ol.id), "quantity": "6"}])
    o.refresh_from_db()
    assert o.status == "INVOICED"
    assert fm.Partner.objects.filter(is_customer=True, name="Globex Customer").count() == 1  # customer created once


@pytest.mark.django_db
def test_voiding_the_draft_invoice_releases_quantities(f):
    p = f["people"]
    o = confirmed(f, [line(f, qty="5")])
    deliver(f, o)
    i = sales.invoice_order(p["sm"].id, o.id)
    o.refresh_from_db()
    assert o.status == "INVOICED"
    fin.void_invoice(p["officer"].id if "officer" in p else p["sm"].id, i.id)
    o.refresh_from_db()
    assert o.status == "DELIVERED" and o.lines.get().invoiced_quantity == 0
    assert not sm.InvoicedLine.objects.exists()
    sales.invoice_order(p["sm"].id, o.id)  # can be invoiced again


@pytest.mark.django_db
def test_invoice_posts_to_receivables_and_revenue(f):
    p = f["people"]
    o = confirmed(f, [line(f, qty="2", price="50")])
    deliver(f, o)
    i = sales.invoice_order(p["sm"].id, o.id, invoice_date=D0)
    fin.submit_invoice(p["sm"].id, i.id)
    fin.approve_invoice(p["mgr"].id, i.id)
    fin.post_invoice(p["ctrl"].id, i.id)
    assert fin.account_balance(f["rev"]) == D("100") and fin.account_balance(f["ar"]) == D("100")


# ----------------------------------------------------------------------------- returns
@pytest.mark.django_db
def test_return_of_invoiced_goods_restores_stock_and_raises_credit_note(f):
    p = f["people"]
    o = confirmed(f, [line(f, qty="10", price="100")])
    deliver(f, o)
    i = sales.invoice_order(p["sm"].id, o.id)
    ol = o.lines.get()
    with pytest.raises(ValidationFailed) as e:
        sales.process_return(p["wh"].id, o.id, location_id=f["loc_a"].id, return_date=D0, reason="x", lines=[{"order_line": str(ol.id), "quantity": "11"}])
    assert e.value.get_codes() == "over_return"
    with pytest.raises(ValidationFailed):
        sales.process_return(p["wh"].id, o.id, location_id=f["loc_a"].id, return_date=D0, reason=" ", lines=[{"order_line": str(ol.id), "quantity": "1"}])
    r = sales.process_return(p["wh"].id, o.id, location_id=f["loc_a"].id, return_date=D0, reason="damaged", lines=[{"order_line": str(ol.id), "quantity": "3"}])
    assert inv.on_hand(f["widget"].id) == D("93")
    assert fin.account_balance(fm.Account.objects.get(code="5100")) == D("35")  # COGS reversed for the 3 returned
    note = r.credit_note
    assert (note.kind, note.status, note.total, note.credit_for_id) == ("CUSTOMER_CREDIT_NOTE", "DRAFT", D("300"), i.id)
    ol.refresh_from_db()
    assert ol.net_invoiced == 7 and ol.invoiceable == 0
    with pytest.raises(DomainError):
        sales.invoice_order(p["sm"].id, o.id)
    fin.void_invoice(p["sm"].id, note.id)  # voiding the credit note frees the credit again
    ol.refresh_from_db()
    assert ol.credited_quantity == 0 and ol.net_invoiced == 10


@pytest.mark.django_db
def test_return_of_uninvoiced_goods_needs_no_credit_note(f):
    p = f["people"]
    o = confirmed(f, [line(f, qty="10")])
    deliver(f, o)
    ol = o.lines.get()
    r = sales.process_return(p["wh"].id, o.id, location_id=f["loc_a"].id, return_date=D0, reason="wrong item", lines=[{"order_line": str(ol.id), "quantity": "4"}])
    assert r.credit_note is None
    assert ol.invoiceable == 6 or sm.SalesOrderLine.objects.get(pk=ol.pk).invoiceable == 6
    i = sales.invoice_order(p["sm"].id, o.id)
    assert i.total == D("600")


@pytest.mark.django_db
def test_sales_report_groups_by_customer_and_product(f):
    confirmed(f, [line(f, qty="2", price="50")])
    confirmed(f, [line(f, qty="1", price="100")])
    rep = sales.sales_report(date(2026, 3, 1), date(2026, 3, 31))
    assert rep["by_customer"][0]["total"] == "200.0000" and rep["by_product"][0]["quantity"] == "3.0000"


# ----------------------------------------------------------------------------- HTTP
@pytest.fixture
def api_env(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = setup_env(tenant)
    apis = {}
    for key in ("rep1", "rep2", "sm", "wh", "emp", "auditor"):
        ExternalIdentity.objects.create(user=env["people"][key], issuer="https://kc.test/realms/erp", subject=f"{key}-sub")
        apis[key] = Api(ACME_HOST)
        assert apis[key].login(idp, f"{key}-sub").status_code == 302
    return env, apis


@pytest.mark.django_db
def test_sales_api_end_to_end_and_permission_matrix(api_env):
    env, api = api_env
    assert api["emp"].get("/api/v1/crm/leads").status_code == 403
    assert api["emp"].get("/api/v1/sales/orders").status_code == 403
    acct = api["rep1"].post("/api/v1/crm/accounts", {"name": "HTTP Customer"}).json()
    assert api["rep2"].get(f"/api/v1/crm/accounts/{acct['id']}").status_code == 404
    assert api["sm"].get(f"/api/v1/crm/accounts/{acct['id']}").status_code == 200
    assert api["auditor"].get("/api/v1/crm/accounts").status_code == 200
    assert api["auditor"].post("/api/v1/crm/accounts", {"name": "x"}).status_code == 403
    assert api["rep1"].post("/api/v1/crm/accounts/" + acct["id"] + "/assign", {}).status_code in (403, 404)
    lines = [{"product": str(env["widget"].id), "quantity": "10", "unit_price": "100", "discount_percent": "15"}]
    body = {"account": acct["id"], "currency": "USD", "order_date": "2026-03-15", "lines": lines}
    assert api["rep2"].post("/api/v1/sales/orders", body).status_code == 404  # not their account
    o = api["rep1"].post("/api/v1/sales/orders", body)
    assert o.status_code == 201 and o.json()["total"] == "850.00"
    oid = o.json()["id"]
    assert api["rep1"].post(f"/api/v1/sales/orders/{oid}/submit").json()["status"] == "PENDING_APPROVAL"
    assert api["rep1"].post(f"/api/v1/sales/orders/{oid}/approve").status_code == 403  # no approve permission
    assert api["sm"].post(f"/api/v1/sales/orders/{oid}/approve").json()["status"] == "CONFIRMED"
    ol = api["sm"].get(f"/api/v1/sales/orders/{oid}").json()["lines"][0]["id"]
    dl = {"location": str(env["loc_a"].id), "delivery_date": "2026-03-15", "lines": [{"order_line": ol, "quantity": "11"}]}
    assert api["rep1"].post(f"/api/v1/sales/orders/{oid}/deliver", dl).status_code == 403
    assert api["wh"].post(f"/api/v1/sales/orders/{oid}/deliver", dl).status_code == 400
    dl["lines"][0]["quantity"] = "10"
    assert api["wh"].post(f"/api/v1/sales/orders/{oid}/deliver", dl).status_code == 201
    assert api["wh"].post(f"/api/v1/sales/orders/{oid}/invoice").status_code == 403
    inv_r = api["sm"].post(f"/api/v1/sales/orders/{oid}/invoice", {"invoice_date": "2026-03-15"})
    assert inv_r.status_code == 201 and inv_r.json()["total"] == "850.00"
    assert api["sm"].post(f"/api/v1/sales/orders/{oid}/invoice").status_code == 409
    assert api["sm"].get("/api/v1/crm/reports/forecast").status_code == 200
    assert api["sm"].get("/api/v1/sales/reports/sales?from=2026-03-01&to=2026-03-31").status_code == 200


@pytest.mark.django_db
def test_crm_and_sales_require_module_entitlement(api_env, acme):
    env, api = api_env
    from platform_core.tenants.models import ModuleEntitlement

    ModuleEntitlement.objects.filter(tenant_id=acme["id"], module="sales").update(enabled=False)
    assert api["sm"].get("/api/v1/sales/orders").status_code == 403
    assert api["sm"].get("/api/v1/crm/leads").status_code == 200  # CRM is its own entitlement
    ModuleEntitlement.objects.filter(tenant_id=acme["id"], module="crm").update(enabled=False)
    assert api["sm"].get("/api/v1/crm/leads").status_code == 403


# ----------------------------------------------------------------------------- concurrency
@pytest.mark.django_db(transaction=True)
def test_concurrent_invoicing_and_delivery_never_exceed_order(own_tenant):
    tenant = own_tenant("salesrace")
    with schema_context(tenant.schema_name):
        env = setup_env(tenant)
        o = confirmed(env, [line(env, qty="10")])
        olid = str(o.lines.get().id)
        oid = o.id
    results = []

    def deliver_once():
        try:
            with schema_context(tenant.schema_name):
                sales.create_delivery(env["people"]["wh"].id, oid, location_id=env["loc_a"].id, delivery_date=D0, lines=[{"order_line": olid, "quantity": "6"}])
            results.append("ok")
        except (DomainError, ValidationFailed) as e:
            results.append(e.get_codes())
        finally:
            connections.close_all()

    threads = [threading.Thread(target=deliver_once) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["ok", "over_delivery"]
    results.clear()

    def invoice_once():
        try:
            with schema_context(tenant.schema_name):
                sales.invoice_order(env["people"]["sm"].id, oid, invoice_date=D0)
            results.append("ok")
        except (DomainError, ValidationFailed) as e:
            results.append(e.get_codes())
        finally:
            connections.close_all()

    threads = [threading.Thread(target=invoice_once) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["nothing_to_invoice", "ok"]
    with schema_context(tenant.schema_name):
        assert fm.Invoice.objects.filter(kind="CUSTOMER_INVOICE").count() == 1
        assert sm.SalesOrderLine.objects.get(pk=olid).invoiced_quantity == 6

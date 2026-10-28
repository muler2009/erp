import threading
from datetime import date
from decimal import Decimal as D

import pytest
from django.db import connections
from django_tenants.utils import schema_context

from modules.finance import models as fm
from modules.finance import services as fin
from modules.inventory import models as im
from modules.inventory import services as inv
from modules.procurement import models as pm
from modules.procurement import services as proc
from platform_core.organizations import services as org
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from shared.events.models import OutboxEvent
from shared.workflows import services as wf
from shared.workflows.models import ApprovalTask
from tests.conftest import ACME_HOST, Api
from tests.test_finance import prepare
from tests.test_inventory import master

D0 = date(2026, 3, 15)


@pytest.fixture
def f(acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = master(tenant, prepare(tenant))
        env["supplier"] = qualified(env, "Acme Supplies")
        yield env


def qualified(env, name):
    s = proc.create_supplier(env["people"]["pm"].id, name=name, tax_id="T-" + name[:3])
    return proc.qualify_supplier(env["people"]["pm"].id, s.id, notes="Audited, ISO 9001")


def gl(code):
    return fin.account_balance(fm.Account.objects.get(code=code))


def po_lines(env, qty="10", price="10"):
    return [{"product": str(env["widget"].id), "quantity": qty, "unit_price": price}]


def approved_po(env, qty="10", price="10", currency="USD", supplier=None):
    p = env["people"]
    po = proc.create_po(p["po"].id, supplier_id=(supplier or env["supplier"]).id, currency=currency, order_date=D0, lines=po_lines(env, qty, price))
    proc.submit_po(p["po"].id, po.id)
    return proc.approve_po(p["pm"].id, po.id)


def receive(env, po, qty, lot=None):
    line = po.lines.first()
    return proc.receive_goods(env["people"]["wh"].id, po.id, location_id=env["loc_a"].id, receipt_date=D0, lines=[{"po_line": str(line.id), "quantity": qty, "lot_code": lot}])


# ----------------------------------------------------------------------------- suppliers
@pytest.mark.django_db
def test_supplier_qualification_creates_finance_partner_once(f):
    s = f["supplier"]
    assert s.status == "QUALIFIED" and s.partner.is_supplier and s.partner.external_ref == str(s.id)
    again = proc.qualify_supplier(f["people"]["pm"].id, s.id, notes="re-audit")
    assert again.partner_id == s.partner_id and fm.Partner.objects.filter(external_ref=str(s.id)).count() == 1
    with pytest.raises(ValidationFailed):
        proc.qualify_supplier(f["people"]["pm"].id, proc.create_supplier(None, name="X").id, notes="")
    blocked = proc.block_supplier(f["people"]["pm"].id, s.id, reason="fraud suspicion")
    with pytest.raises(DomainError) as e:
        proc.create_po(f["people"]["po"].id, supplier_id=blocked.id, currency="USD", order_date=D0, lines=po_lines(f))
    assert e.value.get_codes() == "supplier_not_qualified"
    with pytest.raises(DomainError):
        proc.qualify_supplier(f["people"]["pm"].id, s.id, notes="x")  # blocked suppliers need review


@pytest.mark.django_db
def test_supplier_evaluation_and_scorecard(f):
    pmid, sid = f["people"]["pm"].id, f["supplier"].id
    proc.evaluate_supplier(pmid, sid, period="2026-Q1", delivery=4, quality=5, price=3)
    proc.evaluate_supplier(pmid, sid, period="2026-Q2", delivery=2, quality=5, price=3)
    card = proc.supplier_scorecard(sid)
    assert card["evaluations"] == 2 and card["delivery"] == 3 and card["quality"] == 5
    with pytest.raises(DomainError):
        proc.evaluate_supplier(pmid, sid, period="2026-Q1", delivery=1, quality=1, price=1)
    with pytest.raises(ValidationFailed):
        proc.evaluate_supplier(pmid, sid, period="2026-Q3", delivery=6, quality=1, price=1)


# ----------------------------------------------------------------------------- requisition -> RFQ -> PO
@pytest.mark.django_db
def test_requisition_to_purchase_order_flow(f):
    p = f["people"]
    req = proc.create_requisition(p["emp"].id, title="Widgets for Q2", lines=[{"product": str(f["widget"].id), "quantity": "20", "estimated_unit_price": "11"}])
    assert req.number.startswith("PR-2026-") or req.number.startswith("PR-") and req.estimated_total == D("220")
    with pytest.raises(DomainError):
        proc.approve_requisition(p["pm"].id, req.id)  # not submitted
    with pytest.raises(DomainError) as nf:
        proc.submit_requisition(p["pm"].id, req.id)  # only the requester submits
    assert nf.value.status_code == 404
    proc.submit_requisition(p["emp"].id, req.id)
    with pytest.raises(DomainError) as sod:
        proc.approve_requisition(p["emp"].id, req.id)
    assert sod.value.get_codes() == "separation_of_duties"
    proc.approve_requisition(p["pm"].id, req.id)
    assert OutboxEvent.objects.filter(event_type="procurement.requisition.approved", payload__requisition_id=str(req.id)).exists()

    s2 = qualified(f, "Budget Parts")
    unqualified = proc.create_supplier(None, name="Newbie")
    with pytest.raises(ValidationFailed):
        proc.create_rfq(p["po"].id, title="x", supplier_ids=[unqualified.id], requisition_id=req.id)
    rfq = proc.create_rfq(p["po"].id, title="Widgets", supplier_ids=[f["supplier"].id, s2.id], requisition_id=req.id)
    line = str(rfq.lines.get().id)
    proc.record_quotation(p["po"].id, rfq.id, supplier_id=f["supplier"].id, currency="USD", prices={line: "10.50"}, lead_time_days=7)
    with pytest.raises(ValidationFailed):
        proc.record_quotation(p["po"].id, rfq.id, supplier_id=s2.id, currency="USD", prices={})  # incomplete
    with pytest.raises(ValidationFailed):
        proc.record_quotation(p["po"].id, rfq.id, supplier_id=unqualified.id, currency="USD", prices={line: "1"})  # not invited
    with pytest.raises(DomainError):
        proc.record_quotation(p["po"].id, rfq.id, supplier_id=f["supplier"].id, currency="USD", prices={line: "9"})  # one quote each
    proc.record_quotation(p["po"].id, rfq.id, supplier_id=s2.id, currency="EUR", prices={line: "8.50"}, lead_time_days=14)  # 8.50 EUR = 10.20 USD @1.20
    cmp = proc.compare_bids(rfq.id, on_date=D0)
    assert [q["supplier"] for q in cmp["quotations"]] == ["Budget Parts", "Acme Supplies"] and cmp["quotations"][0]["total_base"] == "204.00"
    winner = cmp["lowest_total"]
    po = proc.award_rfq(p["pm"].id, rfq.id, winner, order_date=D0)
    req.refresh_from_db()
    assert po.status == "DRAFT" and po.currency == "EUR" and po.total == D("170") and po.quotation_id and req.status == "CONVERTED"
    with pytest.raises(DomainError):
        proc.award_rfq(p["pm"].id, rfq.id, winner)  # already awarded


@pytest.mark.django_db
def test_po_direct_approval_rules_and_event(f):
    p = f["people"]
    po = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f))
    with pytest.raises(DomainError):
        proc.receive_goods(p["wh"].id, po.id, location_id=f["loc_a"].id, receipt_date=D0, lines=[{"po_line": str(po.lines.first().id), "quantity": "1"}])  # not approved
    proc.update_po(p["po"].id, po.id, lines=po_lines(f, "5", "20"))
    proc.submit_po(p["po"].id, po.id)
    with pytest.raises(DomainError):
        proc.update_po(p["po"].id, po.id, lines=po_lines(f))  # locked after submission
    with pytest.raises(DomainError) as sod:
        proc.approve_po(p["po"].id, po.id)
    assert sod.value.get_codes() == "separation_of_duties"
    approved = proc.approve_po(p["pm"].id, po.id)
    assert approved.status == "APPROVED" and approved.total == D("100") and approved.approved_by == p["pm"].id
    assert OutboxEvent.objects.filter(event_type="procurement.purchase_order.approved", payload__po_id=str(po.id)).count() == 1
    with pytest.raises(ValidationFailed):
        proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=[{"description": "x", "quantity": "-1", "unit_price": "1"}])


@pytest.mark.django_db
def test_po_threshold_workflow_chain(f):
    p = f["people"]
    wf.create_definition(p["pm"].id, code="po", name="PO approval", subject_type="procurement.purchase_order", stages=[
        {"order": 1, "name": "Procurement", "approvers": [{"type": "USER", "ref": str(p["pm"].id)}]},
        {"order": 2, "name": "Finance", "min_amount": "1000", "approvers": [{"type": "USER", "ref": str(p["mgr"].id)}]}])
    small = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f, "10", "10"))
    big = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f, "100", "20"))
    for po in (small, big):
        proc.submit_po(p["po"].id, po.id)
    with pytest.raises(DomainError) as e:
        proc.approve_po(p["pm2"].id, small.id)
    assert e.value.get_codes() == "workflow_governed"
    small.refresh_from_db(); big.refresh_from_db()
    wf.decide(p["pm"].id, ApprovalTask.objects.get(instance_id=small.workflow_instance_id, assignee_id=p["pm"].id).id, "APPROVE")
    small.refresh_from_db()
    assert small.status == "APPROVED"  # below the finance threshold: one stage only
    wf.decide(p["pm"].id, ApprovalTask.objects.get(instance_id=big.workflow_instance_id, assignee_id=p["pm"].id).id, "APPROVE")
    big.refresh_from_db()
    assert big.status == "PENDING_APPROVAL"
    wf.decide(p["mgr"].id, ApprovalTask.objects.get(instance_id=big.workflow_instance_id, assignee_id=p["mgr"].id, status="PENDING").id, "REJECT", "too expensive")
    big.refresh_from_db()
    assert big.status == "DRAFT" and big.workflow_instance_id is None


@pytest.mark.django_db
def test_cancel_rules(f):
    p = f["people"]
    po = approved_po(f)
    receive(f, po, "2")
    with pytest.raises(DomainError):
        proc.cancel_po(p["po"].id, po.id)  # has a receipt
    other = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f))
    assert proc.cancel_po(p["po"].id, other.id).status == "CANCELLED"


# ----------------------------------------------------------------------------- goods receipt
@pytest.mark.django_db
def test_partial_and_full_receipt_updates_stock_gl_and_status(f):
    po = approved_po(f, qty="10", price="10")
    r1 = receive(f, po, "4")
    po.refresh_from_db()
    assert po.status == "PARTIALLY_RECEIVED" and r1.number.startswith("GR-")
    assert inv.on_hand(f["widget"].id) == 4 and gl("1200") == D("40") and gl("2200") == D("40")  # Dr inventory / Cr GRNI
    with pytest.raises(ValidationFailed) as over:
        receive(f, po, "7")
    assert over.value.get_codes() == "over_receipt"
    assert inv.on_hand(f["widget"].id) == 4  # nothing leaked from the failed attempt
    receive(f, po, "6")
    po.refresh_from_db()
    assert po.status == "RECEIVED" and gl("2200") == D("100")
    with pytest.raises(DomainError):
        receive(f, po, "1")
    assert OutboxEvent.objects.filter(event_type="inventory.goods_received").count() == 2


@pytest.mark.django_db
def test_foreign_currency_receipt_is_valued_in_base(f):
    po = approved_po(f, qty="5", price="10", currency="EUR")
    receive(f, po, "5")
    mv = im.StockMovement.objects.get(product=f["widget"])
    assert mv.unit_cost == D("12.0000") and inv.valuation()["total_value"] == "60.0000" and gl("2200") == D("60")


@pytest.mark.django_db
def test_lot_and_service_lines_on_receipt(f):
    p = f["people"]
    po = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=[
        {"product": str(f["paint"].id), "quantity": "5", "unit_price": "3"}, {"product": str(f["service"].id), "quantity": "1", "unit_price": "100"}])
    proc.submit_po(p["po"].id, po.id)
    proc.approve_po(p["pm"].id, po.id)
    paint, service = po.lines.order_by("line_no")
    with pytest.raises(ValidationFailed) as e:
        proc.receive_goods(p["wh"].id, po.id, location_id=f["loc_a"].id, receipt_date=D0, lines=[{"po_line": str(paint.id), "quantity": "5"}])
    assert e.value.get_codes() == "lot_required"
    proc.receive_goods(p["wh"].id, po.id, location_id=f["loc_a"].id, receipt_date=D0, lines=[{"po_line": str(paint.id), "quantity": "5", "lot_code": "B-77"}, {"po_line": str(service.id), "quantity": "1"}])
    po.refresh_from_db()
    assert po.status == "RECEIVED" and gl("2200") == D("15")  # the service line creates no stock and no accrual
    assert im.StockLevel.objects.get(product=f["paint"]).lot.code == "B-77"


# ----------------------------------------------------------------------------- three-way match
def grni_invoice(f, supplier, amount, currency=None):
    p = f["people"]
    grni = fm.Account.objects.get(system_key="grni")
    invc = fin.create_invoice(p["officer"].id, kind="SUPPLIER_INVOICE", partner_id=supplier.partner_id, invoice_date=D0, currency=currency,
                              lines=[{"description": "Widgets", "quantity": "1", "unit_price": amount, "account": str(grni.id)}], supplier_ref="S-1")
    fin.submit_invoice(p["officer"].id, invc.id)
    fin.approve_invoice(p["mgr"].id, invc.id)
    return invc


@pytest.mark.django_db
def test_three_way_match_gates_posting_and_clears_grni(f):
    p = f["people"]
    po = approved_po(f, qty="10", price="10")
    receive(f, po, "6")  # received 60
    invc = grni_invoice(f, f["supplier"], "60")
    with pytest.raises(DomainError) as e:
        fin.post_invoice(p["mgr2"].id, invc.id)  # unmatched stock invoice
    assert e.value.get_codes() == "three_way_match_required"
    m = proc.match_invoice(p["pm"].id, invc.id, po.id)
    assert m.status == "MATCHED" and m.detail["received_value"] == "60.0000"
    posted = fin.post_invoice(p["mgr2"].id, invc.id)
    assert posted.status == "POSTED" and gl("2200") == D("0") and gl("2100") == D("60")  # GRNI cleared into AP
    po.refresh_from_db()
    assert po.invoiced_value == D("60")


@pytest.mark.django_db
def test_match_exception_when_invoice_exceeds_receipts_then_rematch(f):
    p = f["people"]
    po = approved_po(f, qty="10", price="10")
    receive(f, po, "5")  # 50 received
    invc = grni_invoice(f, f["supplier"], "80")
    bad = proc.match_invoice(p["pm"].id, invc.id, po.id)
    assert bad.status == "EXCEPTION" and "not_received" in bad.detail["problems"]
    with pytest.raises(DomainError):
        fin.post_invoice(p["mgr2"].id, invc.id)
    po.refresh_from_db()
    assert po.invoiced_value == 0  # exceptions do not consume the PO
    receive(f, po, "3")  # 80 received now
    ok = proc.match_invoice(p["pm"].id, invc.id, po.id)
    assert ok.status == "MATCHED" and pm.InvoiceMatch.objects.count() == 1
    assert fin.post_invoice(p["mgr2"].id, invc.id).status == "POSTED"
    # a second invoice cannot be matched for goods already invoiced
    second = grni_invoice(f, f["supplier"], "50")
    assert proc.match_invoice(p["pm"].id, second.id, po.id).status == "EXCEPTION"


@pytest.mark.django_db
def test_match_tolerance_is_a_tenant_setting(f):
    p = f["people"]
    po = approved_po(f, qty="10", price="10")
    receive(f, po, "10")  # 100 received/ordered
    invc = grni_invoice(f, f["supplier"], "101.50")
    assert proc.match_invoice(p["pm"].id, invc.id, po.id).status == "MATCHED"  # within the default 2%
    po.refresh_from_db()
    org.update_settings(None, {"procurement.match_tolerance_percent": 0})
    other = grni_invoice(f, f["supplier"], "101.50")
    po2 = approved_po(f, qty="10", price="10")
    receive(f, po2, "10")
    assert proc.match_invoice(p["pm"].id, other.id, po2.id).status == "EXCEPTION"
    with pytest.raises(ValidationFailed):
        org.update_settings(None, {"procurement.match_tolerance_percent": 50})


@pytest.mark.django_db
def test_match_validations_and_void_release(f):
    p = f["people"]
    po = approved_po(f, qty="10", price="10")
    receive(f, po, "10")
    other_supplier = qualified(f, "Other Co")
    wrong = grni_invoice(f, other_supplier, "50")
    with pytest.raises(ValidationFailed) as e:
        proc.match_invoice(p["pm"].id, wrong.id, po.id)
    assert e.value.get_codes() == "supplier_mismatch"
    plain = fin.create_invoice(p["officer"].id, kind="SUPPLIER_INVOICE", partner_id=f["supplier"].partner_id, invoice_date=D0, lines=[{"description": "Fee", "quantity": "1", "unit_price": "5", "account": str(fm.Account.objects.get(system_key="default_expense").id)}])
    with pytest.raises(ValidationFailed) as none:
        proc.match_invoice(p["pm"].id, plain.id, po.id)
    assert none.value.get_codes() == "nothing_to_match"
    good = grni_invoice(f, f["supplier"], "100")
    proc.match_invoice(p["pm"].id, good.id, po.id)
    po.refresh_from_db()
    assert po.invoiced_value == D("100")
    fin.void_invoice(p["officer"].id, good.id)
    po.refresh_from_db()
    assert po.invoiced_value == 0 and not pm.InvoiceMatch.objects.filter(invoice=good).exists()


@pytest.mark.django_db
def test_spend_report(f):
    approved_po(f, qty="10", price="10")
    approved_po(f, qty="5", price="20")
    rows = proc.spend_by_supplier(date(2026, 1, 1), date(2026, 12, 31))
    assert rows == [{"supplier": "Acme Supplies", "currency": "USD", "ordered": "200.0000", "invoiced": "0.0000"}]


# ----------------------------------------------------------------------------- API
@pytest.fixture
def api_env(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = master(tenant, prepare(tenant))
        env["supplier"] = qualified(env, "Api Supplier")
    apis = {}
    for key in ("wh", "pm", "po", "emp", "auditor"):
        ExternalIdentity.objects.create(user=env["people"][key], issuer="https://kc.test/realms/erp", subject=f"{key}-sub")
        apis[key] = Api(ACME_HOST)
        assert apis[key].login(idp, f"{key}-sub").status_code == 302
    return env, apis


@pytest.mark.django_db
def test_procure_to_stock_over_http_with_permission_matrix(api_env):
    env, api = api_env
    body = {"supplier": str(env["supplier"].id), "currency": "USD", "order_date": "2026-03-15", "lines": [{"product": str(env["widget"].id), "quantity": "10", "unit_price": "10"}]}
    assert api["emp"].post("/api/v1/procurement/purchase-orders", body).status_code == 403
    assert api["wh"].post("/api/v1/procurement/purchase-orders", body).status_code == 403
    created = api["po"].post("/api/v1/procurement/purchase-orders", body)
    assert created.status_code == 201 and created.json()["total"].startswith("100")
    oid = created.json()["id"]
    assert api["po"].post(f"/api/v1/procurement/purchase-orders/{oid}/submit").status_code == 200
    assert api["po"].post(f"/api/v1/procurement/purchase-orders/{oid}/approve").status_code == 403  # no approve permission
    assert api["pm"].post(f"/api/v1/procurement/purchase-orders/{oid}/approve").status_code == 200
    line = api["pm"].get(f"/api/v1/procurement/purchase-orders/{oid}").json()["lines"][0]["id"]
    rb = {"location": str(env["loc_a"].id), "receipt_date": "2026-03-16", "lines": [{"po_line": line, "quantity": "11"}]}
    assert api["po"].post(f"/api/v1/procurement/purchase-orders/{oid}/receive", rb).status_code == 403  # officers cannot receive
    assert api["wh"].post(f"/api/v1/procurement/purchase-orders/{oid}/receive", rb).status_code == 400  # over-receipt
    rb["lines"][0]["quantity"] = "10"
    assert api["wh"].post(f"/api/v1/procurement/purchase-orders/{oid}/receive", rb).status_code == 201
    assert api["wh"].get("/api/v1/inventory/valuation").json()["total_value"] == "100.0000"
    assert api["auditor"].get("/api/v1/procurement/purchase-orders").status_code == 200
    assert api["auditor"].post("/api/v1/procurement/suppliers", {"name": "x"}).status_code == 403
    rows = api["pm"].get("/api/v1/procurement/reports/spend?from=2026-01-01&to=2026-12-31").json()["rows"]
    assert rows[0]["supplier"] == "Api Supplier"
    assert api["pm"].get("/api/v1/procurement/reports/spend").status_code == 400
    req = api["emp"].post("/api/v1/procurement/requisitions", {"title": "Pens", "lines": [{"description": "Pens", "quantity": "10"}]})
    assert req.status_code == 201
    rid = req.json()["id"]
    assert api["emp"].post(f"/api/v1/procurement/requisitions/{rid}/submit").status_code == 200
    assert api["emp"].post(f"/api/v1/procurement/requisitions/{rid}/approve").status_code == 403
    assert api["pm"].post(f"/api/v1/procurement/requisitions/{rid}/approve").status_code == 200


@pytest.mark.django_db
def test_procurement_requires_module_entitlement(api_env, acme):
    env, api = api_env
    from platform_core.tenants.models import ModuleEntitlement

    ModuleEntitlement.objects.filter(tenant_id=acme["id"], module="procurement").update(enabled=False)
    assert api["pm"].get("/api/v1/procurement/suppliers").status_code == 403
    assert api["wh"].get("/api/v1/inventory/valuation").status_code == 200  # inventory is a separate entitlement


# ----------------------------------------------------------------------------- concurrency
@pytest.mark.django_db(transaction=True)
def test_concurrent_receipts_cannot_exceed_ordered_quantity(own_tenant):
    tenant = own_tenant("porace")
    with schema_context(tenant.schema_name):
        env = master(tenant, prepare(tenant))
        env["supplier"] = qualified(env, "Race Co")
        po = approved_po(env, qty="10", price="10")
        line = str(po.lines.first().id)
    results = []

    def go():
        try:
            with schema_context(tenant.schema_name):
                proc.receive_goods(env["people"]["wh"].id, po.id, location_id=env["loc_a"].id, receipt_date=D0, lines=[{"po_line": line, "quantity": "4"}])
            results.append("ok")
        except (DomainError, ValidationFailed) as exc:
            results.append(exc.get_codes())
        finally:
            connections.close_all()

    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert results.count("ok") == 2, results  # 4 + 4 = 8 fits, a third 4 does not
    with schema_context(tenant.schema_name):
        assert inv.on_hand(env["widget"].id) == D("8") and gl("2200") == D("80") and gl("1200") == D("80")
        assert pm.PurchaseOrderLine.objects.get(pk=line).received_quantity == D("8")

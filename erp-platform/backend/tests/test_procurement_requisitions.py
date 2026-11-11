from datetime import timedelta
from decimal import Decimal as D

import pytest
from django.utils import timezone

from modules.inventory import services as inv
from modules.procurement import models as pm
from modules.procurement import requisitions_ext as rx
from modules.procurement import services as proc
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from tests.test_procurement import D0, api_env, f, po_lines, qualified  # noqa: F401

T = timezone.now().date()


def approved_req(f, lines, **kw):
    p = f["people"]
    r = proc.create_requisition(p["po"].id, title="Need", lines=lines, **kw)
    proc.submit_requisition(p["po"].id, r.id)
    return proc.approve_requisition(p["pm"].id, r.id)


def ln(f, qty, product=None):
    return {"product": str((product or f["widget"]).id), "quantity": qty, "estimated_unit_price": "10"}


@pytest.mark.django_db
def test_priority_emergency_and_attributes(f):
    p = f["people"]
    with pytest.raises(ValidationFailed):
        proc.create_requisition(p["po"].id, title="x", lines=[ln(f, "1")], priority="EMERGENCY")  # justification needed
    with pytest.raises(ValidationFailed):
        proc.create_requisition(p["po"].id, title="x", lines=[ln(f, "1")], priority="WHENEVER")
    r = proc.create_requisition(p["po"].id, title="Pump failure", lines=[ln(f, "1")], priority="EMERGENCY", emergency_justification="Line down", project_ref="P-9", cost_center_ref="CC-1", procurement_type="WORKS")
    assert (r.priority, r.project_ref, r.procurement_type, r.source) == ("EMERGENCY", "P-9", "WORKS", "MANUAL")
    proc.submit_requisition(p["po"].id, r.id)
    assert Notification.objects.filter(notification_type="procurement.requisition.emergency", user_id=p["pm"].id).exists()


@pytest.mark.django_db
def test_stock_check_recommendations(f):
    inv.receive_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="6", unit_cost="1", on_date=D0)
    r = approved_req(f, [ln(f, "5"), ln(f, "9"), {"description": "Consulting", "quantity": "1"}])
    check = rx.stock_check(r.id)
    assert [c["recommendation"] for c in check] == ["ISSUE_FROM_STOCK", "PARTIAL_FROM_STOCK", "PURCHASE"]
    assert check[1]["shortfall"] == "3.0000"


@pytest.mark.django_db
def test_partial_ordering_status_and_release_on_cancel(f):
    p = f["people"]
    r = approved_req(f, [ln(f, "10")])
    rl = r.lines.get()
    po1 = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, requisition_id=r.id, lines=[{"product": str(f["widget"].id), "quantity": "4", "unit_price": "10", "requisition_line": str(rl.id)}])
    r.refresh_from_db(); rl.refresh_from_db()
    assert r.status == "PARTIALLY_ORDERED" and rl.ordered_quantity == 4
    with pytest.raises(DomainError) as e:
        proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, requisition_id=r.id, lines=[{"product": str(f["widget"].id), "quantity": "7", "unit_price": "10", "requisition_line": str(rl.id)}])
    assert e.value.get_codes() == "over_order"
    proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, requisition_id=r.id, lines=[{"product": str(f["widget"].id), "quantity": "6", "unit_price": "10", "requisition_line": str(rl.id)}])
    r.refresh_from_db()
    assert r.status == "CONVERTED"
    proc.cancel_po(p["po"].id, po1.id)
    r.refresh_from_db(); rl.refresh_from_db()
    assert r.status == "PARTIALLY_ORDERED" and rl.ordered_quantity == 6
    rfq = proc.create_rfq(p["pm"].id, title="rest", supplier_ids=[f["supplier"].id], requisition_id=r.id)
    assert rfq.lines.get().quantity == 4  # only the outstanding quantity is sourced


@pytest.mark.django_db
def test_reorder_generation_is_idempotent_and_counts_on_order(f):
    inv.update_product(None, f["widget"].id, reorder_level="20", max_stock="100", purchase_price="3")
    inv.receive_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="5", unit_cost="1", on_date=D0)
    r = rx.generate_from_reorder(f["people"]["po"].id)
    assert r.source == "REORDER" and r.lines.get().quantity == D("95") and r.lines.get().estimated_unit_price == D("3")
    assert rx.generate_from_reorder(f["people"]["po"].id) is None  # already requested
    proc.cancel_requisition(f["people"]["po"].id, r.id)
    approved_po(f, "100")
    assert rx.generate_from_reorder(f["people"]["po"].id) is None  # enough on order


def approved_po(f, qty):
    from tests.test_procurement import approved_po as ap
    return ap(f, qty, "1")


@pytest.mark.django_db
def test_consolidation_and_joint_rfq(f):
    other = inv.create_product(None, sku="O-1", name="Other")
    r1 = approved_req(f, [ln(f, "5"), ln(f, "2", other)])
    r2 = approved_req(f, [ln(f, "7")])
    groups = {g["product"]: g for g in rx.consolidate([r1.id, r2.id])}
    assert groups[f["widget"].id]["quantity"] == D("12") and len(groups[f["widget"].id]["sources"]) == 2 and groups[other.id]["quantity"] == D("2")
    draft = proc.create_requisition(f["people"]["po"].id, title="d", lines=[ln(f, "1")])
    with pytest.raises(ValidationFailed):
        rx.consolidate([r1.id, draft.id])
    rfq = rx.create_consolidated_rfq(f["people"]["pm"].id, [r1.id, r2.id], title="Joint", supplier_ids=[f["supplier"].id])
    assert rfq.lines.count() == 2 and len(rfq.source_requisition_ids) == 2


@pytest.mark.django_db
def test_recurring_requisitions(f):
    r = approved_req(f, [ln(f, "3")], recurring_every_days=30)
    assert r.next_run_on == T + timedelta(days=30)
    assert rx.run_recurring(T) == 0
    assert rx.run_recurring(T + timedelta(days=30)) == 1
    new = pm.Requisition.objects.get(source="RECURRING")
    assert new.status == "DRAFT" and new.lines.get().quantity == 3 and new.requester_id == r.requester_id
    r.refresh_from_db()
    assert r.next_run_on == T + timedelta(days=60)
    assert rx.run_recurring(T + timedelta(days=30)) == 0  # idempotent for the same day
    rx.stop_recurring(r.requester_id, r.id)
    assert rx.run_recurring(T + timedelta(days=90)) == 0


@pytest.mark.django_db
def test_requisition_extension_api(api_env):
    env, api = api_env
    body = {"title": "API", "lines": [{"product": str(env["widget"].id), "quantity": "2"}], "priority": "URGENT", "project_ref": "P1"}
    r = api["po"].post("/api/v1/procurement/requisitions", body)
    assert r.status_code == 201 and r.json()["priority"] == "URGENT"
    rid = r.json()["id"]
    assert api["emp"].get(f"/api/v1/procurement/requisitions/{rid}/stock-check").status_code == 403
    assert api["po"].get(f"/api/v1/procurement/requisitions/{rid}/stock-check").json()["results"][0]["recommendation"] == "PURCHASE"
    assert api["po"].post("/api/v1/procurement/requisitions/consolidate", {"requisitions": [rid]}).status_code == 400

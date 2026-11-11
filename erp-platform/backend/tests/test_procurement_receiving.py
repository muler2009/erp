from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.inventory import services as inv
from modules.procurement import models as pm
from modules.procurement import receiving as rc
from modules.procurement import services as proc
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from tests.test_procurement import D0, api_env, approved_po, f, gl, po_lines  # noqa: F401


def recv(f, po, qty, **raw):
    line = po.lines.first()
    kw = raw.pop("kw", {})
    return proc.receive_goods(f["people"]["wh"].id, po.id, location_id=f["loc_a"].id, receipt_date=D0, lines=[{"po_line": str(line.id), "quantity": qty, **raw}], **kw)


@pytest.mark.django_db
def test_over_receipt_tolerance_needs_approval(f):
    po = approved_po(f, "10", "10")
    with pytest.raises(ValidationFailed) as e:
        recv(f, po, "11")
    assert e.value.get_codes() == "over_receipt"  # tolerance defaults to 0
    org.update_settings(None, {"procurement.over_receipt_percent": 10})
    with pytest.raises(DomainError) as e:
        recv(f, po, "11")
    assert e.value.get_codes() == "over_receipt_needs_approval"
    with pytest.raises(ValidationFailed):
        recv(f, po, "12", kw={"approve_over": True})  # 20% > 10%
    r = recv(f, po, "11", kw={"approve_over": True})
    assert r.lines.get().over_quantity == D("1")
    po.refresh_from_db()
    assert po.status == "RECEIVED" and po.lines.get().received_quantity == D("11")


@pytest.mark.django_db
def test_inspection_accept_reject_and_accounting(f):
    inv.create_location(None, warehouse_id=f["loc_a"].warehouse_id, code="QC", kind="QUARANTINE")
    po = approved_po(f, "10", "10")
    r = recv(f, po, "10", inspect=True)
    line = r.lines.get()
    assert line.inspection_status == "PENDING" and line.quarantine_location.code == "QC"
    assert inv.on_hand(f["widget"].id, f["loc_a"].id) == 0 and inv.on_hand(f["widget"].id, line.quarantine_location_id) == 10
    assert gl("1200") == D("100") and len(rc.pending_inspections()) == 1
    with pytest.raises(ValidationFailed):
        rc.inspect_line(None, line.id, accept="3", reject="8", note="x")
    with pytest.raises(ValidationFailed) as e:
        rc.inspect_line(None, line.id, reject="2")
    assert e.value.get_codes() == "reason_required"
    rc.inspect_line(None, line.id, accept="6")
    line.refresh_from_db()
    assert line.inspection_status == "PARTIAL" and inv.on_hand(f["widget"].id, f["loc_a"].id) == 6
    rc.inspect_line(f["people"]["pm"].id, line.id, reject="4", note="Cracked")
    line.refresh_from_db(); po.refresh_from_db()
    assert line.inspection_status == "ACCEPTED" and (line.accepted_quantity, line.rejected_quantity) == (D("6"), D("4"))
    assert inv.on_hand(f["widget"].id, line.quarantine_location_id) == 0
    assert po.lines.get().received_quantity == D("6") and po.status == "PARTIALLY_RECEIVED"
    assert gl("1200") == D("60") and gl("2200") == D("60")  # accrual reversed for the rejected part
    with pytest.raises(DomainError):
        rc.inspect_line(None, line.id, accept="1")
    recv(f, po, "4")  # the supplier redelivers the rejected quantity
    po.refresh_from_db()
    assert po.status == "RECEIVED"


@pytest.mark.django_db
def test_full_rejection_reopens_order_and_needs_quarantine(f):
    po = approved_po(f, "5", "10")
    with pytest.raises(ValidationFailed) as e:
        recv(f, po, "5", inspect=True)
    assert e.value.get_codes() == "no_quarantine_location"
    inv.create_location(None, warehouse_id=f["loc_a"].warehouse_id, code="QC", kind="QUARANTINE")
    line = recv(f, po, "5", inspect=True).lines.get()
    rc.inspect_line(None, line.id, reject="5", note="Wrong item")
    line.refresh_from_db(); po.refresh_from_db()
    assert line.inspection_status == "REJECTED" and po.status == "APPROVED" and gl("1200") == D("0") and gl("2200") == D("0")


@pytest.mark.django_db
def test_service_receipt_needs_note(f):
    po = proc.create_po(f["people"]["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=[{"product": str(f["service"].id), "quantity": "1", "unit_price": "50"}])
    proc.submit_po(f["people"]["po"].id, po.id); proc.approve_po(f["people"]["pm"].id, po.id)
    with pytest.raises(ValidationFailed) as e:
        recv(f, po, "1")
    assert e.value.get_codes() == "service_note_required"
    r = recv(f, po, "1", kw={"notes": "Installation signed off by site manager"})
    assert r.kind == "SERVICE"


@pytest.mark.django_db
def test_receiving_over_http_permissions(api_env, acme):
    env, api = api_env
    with schema_context(acme["schema"]):
        inv.create_location(None, warehouse_id=env["loc_a"].warehouse_id, code="QC", kind="QUARANTINE")
        po = approved_po(env, "10", "10")
        line = po.lines.get()
    body = {"location": str(env["loc_a"].id), "receipt_date": "2026-03-15", "lines": [{"po_line": str(line.id), "quantity": "10", "inspect": True}]}
    assert api["emp"].post(f"/api/v1/procurement/purchase-orders/{po.id}/receive", body).status_code == 403
    r = api["wh"].post(f"/api/v1/procurement/purchase-orders/{po.id}/receive", body)
    assert r.status_code == 201
    rid = r.json()["id"]
    assert api["emp"].get("/api/v1/procurement/inspections").status_code == 403
    pend = api["wh"].get("/api/v1/procurement/inspections")
    assert pend.status_code == 200 and len(pend.json()["results"]) == 1
    lid = pend.json()["results"][0]["line"]
    assert api["emp"].post(f"/api/v1/procurement/inspections/{lid}", {"accept": "10"}).status_code == 403
    assert api["wh"].post(f"/api/v1/procurement/inspections/{lid}", {"accept": "10"}).json()["inspection_status"] == "ACCEPTED"
    assert api["pm"].get(f"/api/v1/procurement/receipts/{rid}").json()["lines"][0]["accepted"] == "10.0000"
    assert api["emp"].get(f"/api/v1/procurement/receipts/{rid}").status_code in (200, 403)

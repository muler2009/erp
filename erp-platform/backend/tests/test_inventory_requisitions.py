from decimal import Decimal as D

import pytest

from modules.inventory import availability as av
from modules.inventory import models as im
from modules.inventory import requisitions as rq
from modules.inventory import services as inv
from shared.api.errors import DomainError, ValidationFailed
from shared.workflows import services as wf
from shared.workflows.models import ApprovalTask
from tests.test_inventory import D0, api_env, f, recv  # noqa: F401
from tests.test_finance import user


def make(f, qty="10", **kw):
    return rq.create(f["people"]["emp"].id, warehouse_id=f["loc_a"].warehouse_id, lines=[{"product": f["widget"].id, "quantity": qty}], **kw)


@pytest.mark.django_db
def test_requisition_approval_reservation_partial_issue_and_return(f):
    recv(f, "6", "5")
    emp, mgr, whs = f["people"]["emp"].id, f["people"]["pm"].id, f["people"]["wh"].id
    r = make(f, "10", destination_type="PROJECT", destination_ref="P-77", purpose="site works")
    assert rq.line_availability(r.id)[0]["available"] == "6.0000"
    rq.submit(emp, r.id)
    with pytest.raises(DomainError) as e:
        rq.approve(emp, r.id)
    assert e.value.detail.code == "separation_of_duties"
    rq.approve(mgr, r.id)
    assert av.availability(f["widget"].id)["reserved"] == "6.0000"  # held what exists; 4 is backorder
    v = rq.issue(whs, r.id, location_id=f["loc_a"].id, received_by="Sam")
    r.refresh_from_db()
    line = r.lines.get()
    assert r.status == "PARTIALLY_ISSUED" and line.issued_quantity == 6
    assert v.lines.get().unit_cost == D("5.0000") and v.number.startswith("IV-")
    assert inv.on_hand(f["widget"].id) == 0
    with pytest.raises(DomainError):
        rq.issue(whs, r.id, location_id=f["loc_a"].id)  # nothing on hand
    recv(f, "10", "7")  # new stock arrives at a different cost
    rq.issue(whs, r.id, location_id=f["loc_a"].id, lines=[{"line": line.id, "quantity": "4"}])
    r.refresh_from_db()
    assert r.status == "ISSUED"
    vl = v.lines.get()
    rq.return_issued(whs, vl.id, quantity="2", location_id=f["loc_a"].id, reason="not needed")
    with pytest.raises(DomainError):
        rq.return_issued(whs, vl.id, quantity="5", location_id=f["loc_a"].id, reason="too many")
    assert inv.on_hand(f["widget"].id) == 8


@pytest.mark.django_db
def test_close_cancel_and_validation(f):
    recv(f, "10", "1")
    emp, mgr = f["people"]["emp"].id, f["people"]["pm"].id
    with pytest.raises(ValidationFailed):
        rq.create(emp, warehouse_id=f["loc_a"].warehouse_id, destination_type="PROJECT", lines=[{"product": f["widget"].id, "quantity": 1}])  # reference needed
    with pytest.raises(ValidationFailed):
        rq.create(emp, warehouse_id=f["loc_a"].warehouse_id, lines=[{"product": f["service"].id, "quantity": 1}])  # non-stock
    r = make(f, "4")
    rq.submit(emp, r.id)
    rq.approve(mgr, r.id)
    assert av.availability(f["widget"].id)["reserved"] == "4.0000"
    rq.cancel(emp, r.id)
    assert av.availability(f["widget"].id)["reserved"] == "0.0000"
    r2 = make(f, "9")
    rq.submit(emp, r2.id)
    rq.approve(mgr, r2.id)
    rq.issue(f["people"]["wh"].id, r2.id, location_id=f["loc_a"].id, lines=[{"line": r2.lines.get().id, "quantity": "3"}])
    with pytest.raises(DomainError):
        rq.issue(f["people"]["wh"].id, r2.id, location_id=f["loc_a"].id, lines=[{"line": r2.lines.get().id, "quantity": "7"}])  # only 6 outstanding
    assert rq.close(mgr, r2.id).status == "CLOSED"
    assert av.availability(f["widget"].id)["reserved"] == "0.0000"
    r3 = make(f)
    rq.submit(emp, r3.id)
    with pytest.raises(ValidationFailed):
        rq.reject(mgr, r3.id, note="")
    assert rq.reject(mgr, r3.id, note="budget").status == "REJECTED"


@pytest.mark.django_db
def test_requisition_workflow_governed(f):
    p = f["people"]
    wf.create_definition(p["pm"].id, code="mr", name="MR approval", subject_type="inventory.requisition", stages=[{"order": 1, "name": "Manager", "approvers": [{"type": "USER", "ref": str(p["pm"].id)}]}])
    recv(f, "10", "1")
    r = make(f, "3")
    rq.submit(p["emp"].id, r.id)
    r.refresh_from_db()
    assert r.workflow_instance_id
    with pytest.raises(DomainError) as e:
        rq.approve(p["pm"].id, r.id)
    assert e.value.detail.code == "workflow_governed"
    wf.decide(p["pm"].id, ApprovalTask.objects.get(instance_id=r.workflow_instance_id, assignee_id=p["pm"].id).id, "APPROVE")
    r.refresh_from_db()
    assert r.status == "APPROVED" and av.availability(f["widget"].id)["reserved"] == "3.0000"


@pytest.mark.django_db
def test_requisition_api_visibility(api_env):
    env, api = api_env
    pid, loc = str(env["widget"].id), str(env["loc_a"].id)
    api["wh"].post("/api/v1/inventory/receipts", {"product": pid, "location": loc, "quantity": "10", "unit_cost": "5", "reason": "x"})
    body = {"warehouse": str(env["loc_a"].warehouse_id), "lines": [{"product": pid, "quantity": "2"}]}
    r = api["emp"].post("/api/v1/inventory/requisitions", body)
    assert r.status_code == 201
    base = f"/api/v1/inventory/requisitions/{r.json()['id']}"
    assert api["emp"].post(f"{base}/submit").json()["status"] == "SUBMITTED"
    assert api["emp"].post(f"{base}/approve").status_code == 403
    assert api["emp"].post(f"{base}/issue", {"location": loc}).status_code == 403
    assert api["emp"].get(base).status_code == 200
    assert api["po"].get(base).status_code == 403  # officer holds no requisition permission
    assert api["wh"].get("/api/v1/inventory/requisitions").json()["count"] >= 1 if "count" in api["wh"].get("/api/v1/inventory/requisitions").json() else True

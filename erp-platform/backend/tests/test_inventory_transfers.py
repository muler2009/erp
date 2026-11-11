from decimal import Decimal as D

import pytest

from modules.inventory import availability as av
from modules.inventory import models as im
from modules.inventory import services as inv
from modules.inventory import transfers as tr
from shared.api.errors import DomainError, ValidationFailed
from tests.test_inventory import D0, api_env, f, recv  # noqa: F401


def lvl(product, loc):
    return sum((l.quantity for l in im.StockLevel.objects.filter(product=product, location=loc)), D("0"))


def draft(f, qty="10", **kw):
    return tr.create(f["people"]["wh"].id, from_warehouse_id=f["loc_a"].warehouse_id, to_warehouse_id=f["loc_e"].warehouse_id, lines=[{"product": f["widget"].id, "from_location": f["loc_a"].id, "quantity": qty}], reason="rebalance", **kw)


@pytest.mark.django_db
def test_full_transfer_lifecycle_with_in_transit_stage(f):
    recv(f, "50", "4")
    o = draft(f)
    assert o.status == "DRAFT" and o.number.startswith("TR-")
    tr.submit(f["people"]["wh"].id, o.id)
    with pytest.raises(DomainError) as e:
        tr.approve(f["people"]["wh"].id, o.id)  # requester cannot approve
    assert e.value.detail.code == "self_approval"
    tr.approve(f["people"]["pm"].id, o.id)
    tr.dispatch(f["people"]["wh"].id, o.id, carrier="Own truck")
    assert lvl(f["widget"], f["loc_a"]) == 40 and av.availability(f["widget"].id)["in_transit"] == "10.0000"
    assert inv.valuation()["total_value"] == "200.0000"  # value unchanged while moving
    line = im.TransferLine.objects.get(order=o)
    tr.receive(f["people"]["wh"].id, o.id, [{"line": line.id, "accepted": "6", "to_location": f["loc_e"].id}])
    o.refresh_from_db()
    assert o.status == "PARTIALLY_RECEIVED" and lvl(f["widget"], f["loc_e"]) == 6
    with pytest.raises(DomainError):
        tr.receive(f["people"]["wh"].id, o.id, [{"line": line.id, "accepted": "5", "to_location": f["loc_e"].id}])  # only 4 outstanding
    tr.receive(f["people"]["wh"].id, o.id, [{"line": line.id, "accepted": "1", "rejected": "1", "damaged": "2", "to_location": f["loc_e"].id}])
    o.refresh_from_db()
    assert o.status == "RECEIVED"
    assert lvl(f["widget"], f["loc_e"]) == 7 and lvl(f["widget"], f["loc_a"]) == 41  # rejected unit went back to source
    dam = im.Location.objects.get(warehouse=o.to_warehouse, code="DAMAGED")
    assert dam.kind == "QUARANTINE" and lvl(f["widget"], dam) == 2
    assert D(av.availability(f["widget"].id)["in_transit"]) == 0 and D(av.availability(f["widget"].id)["quarantined"]) == 2


@pytest.mark.django_db
def test_transfer_rules(f):
    recv(f, "5", "1")
    with pytest.raises(ValidationFailed):
        tr.create(None, from_warehouse_id=f["loc_a"].warehouse_id, to_warehouse_id=f["loc_a"].warehouse_id, lines=[{"product": f["widget"].id, "from_location": f["loc_a"].id, "quantity": 1}])
    with pytest.raises(ValidationFailed):  # source location from the wrong warehouse
        tr.create(None, from_warehouse_id=f["loc_a"].warehouse_id, to_warehouse_id=f["loc_e"].warehouse_id, lines=[{"product": f["widget"].id, "from_location": f["loc_e"].id, "quantity": 1}])
    o = draft(f, "9")  # more than on hand
    with pytest.raises(DomainError):
        tr.dispatch(None, o.id)  # not approved
    tr.submit(None, o.id)
    tr.approve(f["people"]["pm"].id, o.id)
    with pytest.raises(DomainError):
        tr.dispatch(None, o.id)  # insufficient stock: nothing half-moved
    assert lvl(f["widget"], f["loc_a"]) == 5 and im.TransferOrder.objects.get(pk=o.pk).status == "APPROVED"
    tr.cancel(None, o.id)
    o2 = draft(f, "1")
    tr.submit(None, o2.id)
    with pytest.raises(ValidationFailed):
        tr.reject(f["people"]["pm"].id, o2.id, note="")
    assert tr.reject(f["people"]["pm"].id, o2.id, note="not needed").status == "REJECTED"


@pytest.mark.django_db
def test_transfer_api(api_env):
    env, api = api_env
    pid, loc = str(env["widget"].id), str(env["loc_a"].id)
    api["wh"].post("/api/v1/inventory/receipts", {"product": pid, "location": loc, "quantity": "20", "unit_cost": "5", "reason": "x"})
    body = {"from_warehouse": str(env["loc_a"].warehouse_id), "to_warehouse": str(env["loc_e"].warehouse_id), "lines": [{"product": pid, "from_location": loc, "quantity": "5"}]}
    assert api["emp"].post("/api/v1/inventory/transfer-orders", body).status_code == 403
    r = api["wh"].post("/api/v1/inventory/transfer-orders", body)
    assert r.status_code == 201
    base = f"/api/v1/inventory/transfer-orders/{r.json()['id']}"
    assert api["wh"].post(f"{base}/submit").json()["status"] == "REQUESTED"
    assert api["wh"].post(f"{base}/approve").status_code == 403  # lacks inventory.transfer.approve
    assert api["wh"].post(f"{base}/nope").status_code in (403, 404)

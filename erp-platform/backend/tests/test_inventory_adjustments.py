from decimal import Decimal as D

import pytest

from modules.inventory import adjustments as adj
from modules.inventory import models as im
from modules.inventory import services as inv
from modules.inventory import stocktake as st
from shared.api.errors import DomainError, ValidationFailed
from tests.test_inventory import D0, api_env, f, gl, recv  # noqa: F401


@pytest.mark.django_db
def test_threshold_requires_second_person_approval(f):
    recv(f, "100", "10")
    me, other = f["people"]["wh"].id, f["people"]["pm"].id
    adj.set_threshold(me, "100")
    small = adj.request(me, product_id=f["widget"].id, location_id=f["loc_a"].id, delta="-5", reason_code="DAMAGE", reason="dropped")  # 50 <= 100
    assert small.status == "POSTED" and inv.on_hand(f["widget"].id) == 95
    with pytest.raises(DomainError) as e:  # direct call above the threshold is refused
        inv.adjust_stock(me, product_id=f["widget"].id, location_id=f["loc_a"].id, delta="-20", reason="x")
    assert e.value.detail.code == "approval_required"
    big = adj.request(me, product_id=f["widget"].id, location_id=f["loc_a"].id, delta="-20", reason_code="LOSS", reason="missing pallet")
    assert big.status == "PENDING" and big.estimated_value == D("200") and inv.on_hand(f["widget"].id) == 95
    with pytest.raises(DomainError) as e:
        adj.approve(me, big.id)
    assert e.value.detail.code == "separation_of_duties"
    assert adj.approve(other, big.id).status == "POSTED" and inv.on_hand(f["widget"].id) == 75
    with pytest.raises(DomainError):
        adj.approve(other, big.id)
    rej = adj.request(me, product_id=f["widget"].id, location_id=f["loc_a"].id, delta="-30", reason_code="THEFT", reason="x")
    with pytest.raises(ValidationFailed):
        adj.reject(other, rej.id, note="")
    assert adj.reject(other, rej.id, note="no evidence").status == "REJECTED" and inv.on_hand(f["widget"].id) == 75
    with pytest.raises(ValidationFailed):
        adj.request(me, product_id=f["widget"].id, location_id=f["loc_a"].id, delta="1", reason_code="BOGUS", reason="x")
    adj.set_threshold(me, None)
    assert adj.get_threshold() is None


@pytest.mark.django_db
def test_stocktake_freeze_blind_count_variance_and_posting(f):
    recv(f, "50", "4")
    recv(f, "20", "4", loc=f["loc_b"])
    me, other, counter = f["people"]["wh"].id, f["people"]["pm"].id, f["people"]["po"].id
    c = st.create(me, warehouse_id=f["loc_a"].warehouse_id, kind="FULL", freeze=True)
    st.start(me, c.id)
    sheet = st.worksheet(c.id)
    assert len(sheet) == 2 and "system" not in sheet[0]  # blind
    with pytest.raises(DomainError) as e:
        recv(f, "1", "4")  # location is frozen
    assert e.value.detail.code == "location_frozen"
    la, lb = [l for l in c.lines.all() if l.location_id == f["loc_a"].id][0], [l for l in c.lines.all() if l.location_id == f["loc_b"].id][0]
    st.assign(me, c.id, user_id=counter, line_ids=[la.id])
    with pytest.raises(DomainError):
        st.record(other, la.id, counted_quantity="47")  # assigned to someone else
    st.record(counter, la.id, counted_quantity="47")
    with pytest.raises(DomainError):
        st.submit(me, c.id)  # one line uncounted
    st.record(me, lb.id, counted_quantity="20")
    st.submit(me, c.id)
    v = {x["location"]: x for x in st.variances(c.id)}
    assert v["A1"]["variance"] == "-3.0000" and v["A1"]["variance_pct"] == "-6.00" and v["A1"]["variance_value"] == "-12.0000"
    st.request_recount(other, c.id, [la.id])
    assert c.lines.get(pk=la.id).counted_quantity is None
    st.record(counter, la.id, counted_quantity="46")
    st.submit(me, c.id)
    with pytest.raises(DomainError):
        st.approve(me, c.id)  # creator cannot approve
    st.approve(other, c.id)
    assert inv.on_hand(f["widget"].id, location_id=f["loc_a"].id) == 46 and inv.on_hand(f["widget"].id, location_id=f["loc_b"].id) == 20
    assert im.StockCountLine.objects.get(pk=la.id).variance_value == D("-16.0000")
    recv(f, "1", "4")  # freeze lifted
    assert st.history(f["widget"].id)[0]["status"] == "APPROVED"


@pytest.mark.django_db
def test_stocktake_validation_and_adjustment_api(api_env):
    env, api = api_env
    pid, loc, wid = str(env["widget"].id), str(env["loc_a"].id), str(env["loc_a"].warehouse_id)
    api["wh"].post("/api/v1/inventory/receipts", {"product": pid, "location": loc, "quantity": "10", "unit_cost": "5", "reason": "x"})
    assert api["emp"].get("/api/v1/inventory/adjustment-policy").status_code == 403
    assert api["wh"].put("/api/v1/inventory/adjustment-policy", {"threshold": "10"}).status_code == 403
    assert api["wh"].post("/api/v1/inventory/stock-counts", {"warehouse": wid, "kind": "CYCLE"}).status_code == 400  # scope needed
    r = api["wh"].post("/api/v1/inventory/adjustment-requests", {"product": pid, "location": loc, "delta": "-1", "reason": "broken"})
    assert r.status_code == 201 and r.json()["status"] == "POSTED"
    assert api["wh"].post(f"/api/v1/inventory/adjustment-requests/{r.json()['id']}/approve").status_code == 403

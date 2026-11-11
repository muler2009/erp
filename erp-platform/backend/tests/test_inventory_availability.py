from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django.utils import timezone

from modules.inventory import availability as av
from modules.inventory import models as im
from modules.inventory import services as inv
from shared.api.errors import DomainError, ValidationFailed
from tests.test_inventory import D0, api_env, f, recv  # noqa: F401


@pytest.mark.django_db
def test_availability_breakdown(f):
    wh = f["loc_a"].warehouse
    q = inv.create_location(None, warehouse_id=wh.id, code="QQ", kind="QUARANTINE")
    t = inv.create_location(None, warehouse_id=wh.id, code="TT", kind="TRANSIT")
    recv(f, "100", "5")
    recv(f, "10", "5", loc=q)
    recv(f, "5", "5", loc=t)
    av.reserve(None, product_id=f["widget"].id, quantity="20", ref_type="job", ref_id="J1")
    a = av.availability(f["widget"].id)
    assert (a["on_hand"], a["quarantined"], a["in_transit"], a["reserved"], a["available"]) == ("115.0000", "10.0000", "5.0000", "20.0000", "80.0000")
    with pytest.raises(DomainError):
        av.reserve(None, product_id=f["widget"].id, quantity="81")
    with pytest.raises(ValidationFailed):
        av.reserve(None, product_id=f["service"].id, quantity="1")  # non-stock
    assert av.release_by_ref(None, "job", "J1") == 1
    assert av.availability(f["widget"].id)["available"] == "100.0000"


@pytest.mark.django_db
def test_reservation_expiry_and_release_rules(f):
    recv(f, "10", "1")
    r = av.reserve(None, product_id=f["widget"].id, quantity="4", expires_on=D0 - timedelta(days=1))
    assert av.expire_reservations(D0) == 1
    assert im.StockReservation.objects.get(pk=r.pk).status == "EXPIRED"
    with pytest.raises(DomainError):
        av.release(None, r.id)
    assert av.availability(f["widget"].id)["available"] == "10.0000"


@pytest.mark.django_db
def test_alerts_ageing_slow_and_excess(f):
    inv.update_product(None, f["widget"].id, min_stock="50", reorder_level="60", safety_stock="20", max_stock="500")
    kinds = lambda: {a["alert"] for a in av.alerts(D0) if a["sku"] == "W-1"}  # noqa: E731
    assert "OUT_OF_STOCK" in kinds()
    recv(f, "10", "1")
    assert "BELOW_SAFETY" in kinds()
    recv(f, "30", "1")
    assert "BELOW_MINIMUM" in kinds()
    recv(f, "15", "1")
    assert kinds() == {"REORDER"}
    recv(f, "600", "1")
    assert "ABOVE_MAXIMUM" in kinds()
    row = [r for r in av.ageing(timezone.now().date() + timedelta(days=100)) if r["sku"] == "W-1"][0]
    assert row["buckets"]["90+"] != "0" and row["oldest_days"] >= 90
    sm = [r for r in av.slow_moving(30) if r["sku"] == "W-1"][0]
    assert sm["last_issue"] is None
    assert [e for e in av.excess() if e["sku"] == "W-1"][0]["reason"] == "ABOVE_MAXIMUM"
    p = inv.create_product(None, sku="LOTX", name="Lotty", tracking="LOT")
    recv(f, "3", "1", product=p, lot_code="L1", expiry_date=date(2026, 4, 1))
    assert {a["alert"] for a in av.alerts(D0) if a["sku"] == "LOTX"} == {"EXPIRING_SOON"}
    assert {a["alert"] for a in av.alerts(date(2026, 5, 1)) if a["sku"] == "LOTX"} == {"EXPIRED"}


@pytest.mark.django_db
def test_availability_api(api_env):
    env, api = api_env
    pid, loc = str(env["widget"].id), str(env["loc_a"].id)
    api["wh"].post("/api/v1/inventory/receipts", {"product": pid, "location": loc, "quantity": "10", "unit_cost": "5", "reason": "x"})
    assert api["emp"].get(f"/api/v1/inventory/availability?product={pid}").status_code == 403
    assert api["pm"].post("/api/v1/inventory/reservations", {"product": pid, "quantity": "1"}).status_code == 403
    r = api["wh"].post("/api/v1/inventory/reservations", {"product": pid, "quantity": "4", "ref_type": "job", "ref_id": "1"})
    assert r.status_code == 201
    assert api["pm"].get(f"/api/v1/inventory/availability?product={pid}").json()["available"] == "6.0000"
    assert api["wh"].post("/api/v1/inventory/reservations", {"product": pid, "quantity": "7"}).status_code == 409
    assert api["wh"].post(f"/api/v1/inventory/reservations/{r.json()['id']}/release").json()["status"] == "RELEASED"
    for u in ("alerts", "ageing", "slow-moving"):
        assert api["wh"].get(f"/api/v1/inventory/{u}").status_code == 200

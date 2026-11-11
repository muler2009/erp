from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django.utils import timezone

from modules.inventory import models as im
from modules.inventory import services as inv
from modules.inventory import tracking as tk
from shared.api.errors import DomainError, ValidationFailed
from tests.test_inventory import D0, api_env, f, recv  # noqa: F401

T = timezone.now().date()


def lots(f):
    p = inv.create_product(None, sku="MED-1", name="Medicine", tracking="LOT", tracks_expiry=True)
    recv(f, "10", "3", product=p, lot_code="L-OLD", expiry_date=T + timedelta(days=20))
    recv(f, "10", "3", product=p, lot_code="L-NEW", expiry_date=T + timedelta(days=200))
    return p


@pytest.mark.django_db
def test_expiry_required_and_expired_or_held_lots_cannot_be_issued(f):
    p = inv.create_product(None, sku="MED-2", name="Med", tracking="LOT", tracks_expiry=True)
    with pytest.raises(ValidationFailed) as e:
        recv(f, "5", "1", product=p, lot_code="X")
    assert e.value.detail.code == "expiry_required"
    recv(f, "5", "1", product=p, lot_code="OLD", expiry_date=T - timedelta(days=1))
    recv(f, "5", "1", product=p, lot_code="OK", expiry_date=T + timedelta(days=30))
    with pytest.raises(DomainError) as e:
        inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="1", lot_code="OLD", on_date=T)
    assert e.value.detail.code == "lot_expired"
    assert inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="1", lot_code="OLD", on_date=T, allow_expired=True)  # authorised write-off path
    assert [x["lot"] for x in tk.expired_stock()] == ["OLD"]
    tk.set_lot_status(None, p.id, "OK", "QUARANTINED", "QC hold")
    with pytest.raises(DomainError) as e:
        inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="1", lot_code="OK", on_date=T)
    assert e.value.detail.code == "lot_not_issuable"
    with pytest.raises(ValidationFailed):
        tk.set_lot_status(None, p.id, "OK", "BLOCKED", "")
    tk.set_lot_status(None, p.id, "OK", "AVAILABLE")
    assert inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="1", lot_code="OK", on_date=T)


@pytest.mark.django_db
def test_fefo_and_fifo_picking(f):
    p = lots(f)
    wh = f["loc_a"].warehouse_id
    picks = tk.pick(p.id, wh, "12", "FEFO")
    assert [(x["lot_code"], x["quantity"]) for x in picks] == [("L-OLD", "10.0000"), ("L-NEW", "2.0000")]
    tk.set_lot_status(None, p.id, "L-OLD", "RECALLED", "supplier recall")
    assert [x["lot_code"] for x in tk.pick(p.id, wh, "3")] == ["L-NEW"]  # held lots are skipped
    with pytest.raises(DomainError):
        tk.pick(p.id, wh, "11")
    tk.set_lot_status(None, p.id, "L-OLD", "AVAILABLE")
    out = tk.issue_picked(None, product_id=p.id, warehouse_id=wh, quantity="12", reason="ward", ref_type="job", ref_id="1", on_date=T)
    assert len(out) == 2 and inv.on_hand(p.id) == 8


@pytest.mark.django_db
def test_recall_trace(f):
    p = lots(f)
    inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="4", lot_code="L-OLD", ref_type="delivery", ref_id="DN-9", on_date=T)
    t = tk.trace_lot(p.id, "L-OLD")
    assert t["received"][0]["quantity"] == "10.0000" and t["on_hand"][0]["quantity"] == "6.0000" and t["issued"][0]["ref_id"] == "DN-9"


@pytest.mark.django_db
def test_serial_numbers_lifecycle(f):
    p = inv.create_product(None, sku="LAP-1", name="Laptop", tracking="SERIAL")
    with pytest.raises(ValidationFailed):
        recv(f, "2", "100", product=p)  # serials required
    with pytest.raises(ValidationFailed):
        recv(f, "2", "100", product=p, serials=["A1"])  # count mismatch
    with pytest.raises(ValidationFailed):
        recv(f, "2", "100", product=p, serials=["A1", "A1"])
    recv(f, "3", "100", product=p, serials=["A1", "A2", "A3"], ref_type="goods_receipt", ref_id="GR-5")
    with pytest.raises(DomainError):
        recv(f, "1", "100", product=p, serials=["A1"])  # already in stock
    inv.transfer_stock(None, product_id=p.id, from_location_id=f["loc_a"].id, to_location_id=f["loc_b"].id, quantity="1", serials=["A2"])
    assert im.SerialNumber.objects.get(serial="A2").location_id == f["loc_b"].id
    with pytest.raises(DomainError) as e:
        inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="1", serials=["A2"], on_date=T)  # A2 is at B1 now
    assert e.value.detail.code == "serial_not_available"
    inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="1", serials=["A1"], ref_type="delivery", ref_id="DN-1", on_date=T)
    h = tk.serial_history(p.id, "A1")
    assert h["status"] == "ISSUED" and h["issued_ref"] == "delivery:DN-1" and h["received_ref"] == "goods_receipt:GR-5"
    with pytest.raises(DomainError):
        inv.adjust_stock(None, product_id=p.id, location_id=f["loc_a"].id, delta="-1", reason="x")
    assert tk.reconcile_serials(p.id, f["loc_a"].id, ["A3", "ZZ"]) == {"missing": [], "unexpected": ["ZZ"], "matched": 1}
    recv(f, "1", "100", product=p, serials=["A1"])  # the issued unit comes back
    assert im.SerialNumber.objects.get(serial="A1").status == "IN_STOCK"


@pytest.mark.django_db
def test_tracking_api(api_env):
    env, api = api_env
    pid, loc = str(env["paint"].id), str(env["loc_a"].id)
    api["wh"].post("/api/v1/inventory/receipts", {"product": pid, "location": loc, "quantity": "5", "unit_cost": "2", "lot_code": "B1", "reason": "x"})
    base = f"/api/v1/inventory/lots/{pid}/B1"
    assert api["emp"].get(f"{base}/trace").status_code == 403
    assert api["wh"].get(f"{base}/trace").json()["on_hand"][0]["quantity"] == "5.0000"
    assert api["pm"].post(f"{base}/status", {"status": "BLOCKED", "note": "x"}).status_code == 403
    assert api["wh"].post(f"{base}/status", {"status": "BLOCKED", "note": "damaged seal"}).json()["status"] == "BLOCKED"
    assert api["wh"].post("/api/v1/inventory/issues", {"product": pid, "location": loc, "quantity": "1", "lot_code": "B1", "reason": "x"}).status_code == 409

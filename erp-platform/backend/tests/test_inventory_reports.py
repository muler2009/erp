from datetime import timedelta
from decimal import Decimal as D

import pytest
from django.utils import timezone

from modules.inventory import adjustments as adj
from modules.inventory import reports as rp
from modules.inventory import services as inv
from shared.api.errors import DomainError, ValidationFailed
from tests.test_inventory import D0, api_env, f, recv  # noqa: F401


@pytest.mark.django_db
def test_stock_card_summary_movements(f):
    recv(f, "10", "5")
    inv.issue_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="3", on_date=D0)
    recv(f, "4", "5", loc=f["loc_e"])
    card = rp.stock_card(f["widget"].id)
    assert [r["balance"] for r in card["rows"]] == ["10.0000", "7.0000", "11.0000"] and card["closing"] == "11.0000"
    tomorrow = timezone.now().date() + timedelta(days=1)
    later = rp.stock_card(f["widget"].id, date_from=tomorrow)
    assert later["opening"] == "11.0000" and later["rows"] == []
    assert rp.stock_card(f["widget"].id, warehouse_id=f["loc_e"].warehouse_id)["closing"] == "4.0000"
    s = {r["group"]: r for r in rp.stock_summary("warehouse")}
    assert s["MAIN"]["quantity"] == "7.0000" and s["EAST"]["value"] == "20.0000"
    with pytest.raises(ValidationFailed):
        rp.stock_summary("colour")
    assert len(rp.movements(movement_type="ISSUE")) == 1 and len(rp.movements(product_id=f["widget"].id)) == 3


@pytest.mark.django_db
def test_abc_turnover_adjustments_and_csv(f):
    big = inv.create_product(None, sku="BIG", name="Big spender")
    small = inv.create_product(None, sku="SMALL", name="=cmd()")
    recv(f, "100", "10", product=big)
    recv(f, "100", "1", product=small)
    recv(f, "50", "2")
    inv.issue_stock(None, product_id=big.id, location_id=f["loc_a"].id, quantity="50", on_date=D0)  # 500
    inv.issue_stock(None, product_id=small.id, location_id=f["loc_a"].id, quantity="10", on_date=D0)  # 10
    abc = {r["sku"]: r["class"] for r in rp.abc_analysis()}
    assert abc["BIG"] == "A" and abc["SMALL"] in ("B", "C")
    t = rp.turnover(365)
    assert t["issued_value"] == "510.0000" and D(t["turnover"]) > 0
    adj.request(None, product_id=f["widget"].id, location_id=f["loc_a"].id, delta="-2", reason_code="DAMAGE", reason="broken")
    rep = rp.adjustments_report()
    assert rep["by_reason"]["DAMAGE"] == {"count": 1, "net_value": "-4.0000"}
    csv_text = rp.to_csv([{"sku": "=1+1", "q": "-5"}, {"sku": "ok", "q": "3"}])
    assert "'=1+1" in csv_text and "-5" in csv_text and "\nok,3" in csv_text  # formulas defused, plain numbers untouched
    assert rp.to_csv([]) == ""


@pytest.mark.django_db
def test_reports_api(api_env):
    env, api = api_env
    pid, loc = str(env["widget"].id), str(env["loc_a"].id)
    api["wh"].post("/api/v1/inventory/receipts", {"product": pid, "location": loc, "quantity": "5", "unit_cost": "2", "reason": "x"})
    assert api["emp"].get("/api/v1/inventory/reports/summary").status_code == 403
    assert api["wh"].get("/api/v1/inventory/reports/summary?group_by=location").json()["results"][0]["quantity"] == "5.0000"
    r = api["wh"].get(f"/api/v1/inventory/reports/stock-card?product={pid}&export=csv")
    assert r.status_code == 200 and r["Content-Type"].startswith("text/csv") and "balance" in r.content.decode()
    assert api["wh"].get("/api/v1/inventory/reports/bogus").status_code == 404

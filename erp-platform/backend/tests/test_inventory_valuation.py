from decimal import Decimal as D

import pytest
from django.utils import timezone

from modules.inventory import models as im
from modules.inventory import services as inv
from modules.inventory import valuation as val
from shared.api.errors import DomainError, ValidationFailed
from tests.test_inventory import D0, api_env, f, gl, recv  # noqa: F401


def fifo(f, sku="F-1"):
    return inv.create_product(None, sku=sku, name="Fifo item", costing_method="FIFO")


@pytest.mark.django_db
def test_fifo_consumes_oldest_layers_and_ties_to_ledger(f):
    p = fifo(f)
    recv(f, "10", "2", product=p)
    recv(f, "10", "4", product=p)
    mv = inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="15", on_date=D0)
    assert mv.unit_cost == D("2.6667")  # (10*2 + 5*4) / 15
    layers = list(im.CostLayer.objects.filter(product=p).order_by("received_at", "id"))
    assert [(l.remaining, l.remaining_value) for l in layers] == [(0, D("0")), (5, D("20.0000"))]
    cost = im.ProductCost.objects.get(product=p)
    assert (cost.quantity, cost.total_value) == (5, D("20.0000"))
    assert gl("1200") == D("20")  # ledger = FIFO subledger
    inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="5", on_date=D0)
    assert im.ProductCost.objects.get(product=p).total_value == 0 and gl("1200") == 0


@pytest.mark.django_db
def test_costing_method_differs_between_products(f):
    p = fifo(f)
    for prod in (p, f["widget"]):
        recv(f, "10", "2", product=prod)
        recv(f, "10", "4", product=prod)
        inv.issue_stock(None, product_id=prod.id, location_id=f["loc_a"].id, quantity="10", on_date=D0)
    assert im.ProductCost.objects.get(product=p).total_value == D("40.0000")  # FIFO: the 4.00 layer remains
    assert im.ProductCost.objects.get(product=f["widget"]).total_value == D("30.0000")  # average 3.00


@pytest.mark.django_db
def test_landed_cost_allocation_fifo_and_average(f):
    p = fifo(f)
    recv(f, "10", "10", product=p, ref_type="goods_receipt", ref_id="GR-1")
    recv(f, "10", "10", product=f["widget"], ref_type="goods_receipt", ref_id="GR-1")
    inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="5", on_date=D0)  # half of the FIFO item is gone
    lc = val.post_landed_cost(None, ref_type="goods_receipt", ref_id="GR-1", amount="40", description="Sea freight", on_date=D0)
    a = {x.product.sku: x for x in lc.allocations.select_related("product")}
    assert a["F-1"].share == D("20.00") and a["F-1"].to_inventory == D("10.0000") and a["F-1"].to_cogs == D("10.0000")
    assert a["W-1"].to_inventory == D("20.0000") and a["W-1"].to_cogs == 0  # nothing of the widget sold
    assert im.ProductCost.objects.get(product=p).total_value == D("60.0000")  # 50 + 10
    assert gl("2210") == D("-40") or gl("2210") == D("40")
    assert gl("1200") == im.ProductCost.objects.aggregate(t=__import__("django").db.models.Sum("total_value"))["t"]
    with pytest.raises(DomainError):
        val.post_landed_cost(None, ref_type="goods_receipt", ref_id="NOPE", amount="1", description="x")
    with pytest.raises(ValidationFailed):
        val.post_landed_cost(None, ref_type="goods_receipt", ref_id="GR-1", amount="0", description="x")
    nxt = inv.issue_stock(None, product_id=p.id, location_id=f["loc_a"].id, quantity="5", on_date=D0)
    assert nxt.unit_cost == D("12.0000")  # remaining layer carries 10 + 2 landed per unit


@pytest.mark.django_db
def test_historical_and_warehouse_valuation(f):
    recv(f, "10", "5")
    recv(f, "4", "5", loc=f["loc_e"])
    today = timezone.now().date()
    full = val.valuation_report(as_of=today)
    assert full["total_value"] == "70.0000"
    east = val.valuation_report(warehouse_id=f["loc_e"].warehouse_id)
    assert east["total_value"] == "20.0000" and east["rows"][0]["quantity"] == "4.0000"
    past = val.valuation_report(as_of=today.replace(year=today.year - 1))
    assert past["total_value"] == "0" and past["rows"] == []
    inv.issue_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="2", on_date=D0)
    assert val.valuation_report(as_of=today)["total_value"] == "60.0000" == inv.valuation()["total_value"]


@pytest.mark.django_db
def test_valuation_api(api_env):
    env, api = api_env
    pid, loc = str(env["widget"].id), str(env["loc_a"].id)
    api["wh"].post("/api/v1/inventory/receipts", {"product": pid, "location": loc, "quantity": "2", "unit_cost": "5", "reason": "x"})
    assert api["wh"].get("/api/v1/inventory/valuation?as_of=2099-01-01").json()["total_value"] == "10.0000"
    assert api["wh"].post("/api/v1/inventory/landed-costs", {"ref_type": "x", "ref_id": "y", "amount": "1", "description": "d"}).status_code == 403

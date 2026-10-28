import threading
from datetime import date
from decimal import Decimal as D

import pytest
from django.db import IntegrityError, connections, transaction
from django_tenants.utils import schema_context

from modules.finance import models as fm
from modules.finance import services as fin
from modules.inventory import models as im
from modules.inventory import services as inv
from platform_core.authorization.models import RoleAssignment, RoleDefinition
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity, TenantMembership, User
from shared.api.errors import DomainError, ValidationFailed
from tests.conftest import ACME_HOST, Api
from tests.test_finance import prepare, user

D0 = date(2026, 3, 15)


def master(tenant, env):
    wh = inv.create_warehouse(None, code="MAIN", name="Main")
    wh2 = inv.create_warehouse(None, code="EAST", name="East")
    env.update(
        wh=wh, loc_a=inv.create_location(None, warehouse_id=wh.id, code="A1"), loc_b=inv.create_location(None, warehouse_id=wh.id, code="B1"), loc_e=inv.create_location(None, warehouse_id=wh2.id, code="E1"),
        widget=inv.create_product(None, sku="W-1", name="Widget", barcode="111"),
        paint=inv.create_product(None, sku="P-1", name="Paint", tracking="LOT"),
        service=inv.create_product(None, sku="S-1", name="Consulting", is_stocked=False),
    )
    env["people"].update(
        wh=user(tenant, f"wh@{tenant.slug}.test", "warehouse_staff"),
        pm=user(tenant, f"pm@{tenant.slug}.test", "procurement_manager"),
        pm2=user(tenant, f"pm2@{tenant.slug}.test", "procurement_manager"),
        po=user(tenant, f"po@{tenant.slug}.test", "procurement_officer"),
        emp=user(tenant, f"emp@{tenant.slug}.test", "employee"),
    )
    return env


@pytest.fixture
def f(acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        yield master(tenant, prepare(tenant))


def recv(f, qty, cost, product=None, loc=None, **kw):
    return inv.receive_stock(f["people"]["wh"].id, product_id=(product or f["widget"]).id, location_id=(loc or f["loc_a"]).id, quantity=qty, unit_cost=cost, on_date=D0, **kw)


def gl(code):
    return fin.account_balance(fm.Account.objects.get(code=code))


@pytest.mark.django_db
def test_weighted_average_valuation_and_gl_tie_out(f):
    recv(f, "10", "5")
    recv(f, "10", "7")
    cost = im.ProductCost.objects.get(product=f["widget"])
    assert (cost.quantity, cost.total_value, cost.average) == (20, D("120"), D("6"))
    issue = inv.issue_stock(f["people"]["wh"].id, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="5", reason="job 1", on_date=D0)
    assert issue.quantity == -5 and issue.unit_cost == D("6.0000")
    val = inv.valuation()
    assert val["total_value"] == "90.0000" and val["rows"][0]["quantity"] == "15.0000"
    assert gl("1200") == D("90") and gl("5100") == D("30")  # inventory asset = subledger valuation; COGS = issued value
    assert inv.on_hand(f["widget"].id) == D("15")


@pytest.mark.django_db
def test_issue_all_leaves_no_rounding_residue(f):
    recv(f, "3", "10")
    recv(f, "4", "3.3333")
    inv.issue_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="3", on_date=D0)
    inv.issue_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="4", on_date=D0)
    cost = im.ProductCost.objects.get(product=f["widget"])
    assert cost.quantity == 0 and cost.total_value == 0 and gl("1200") == 0


@pytest.mark.django_db
def test_insufficient_stock_and_db_never_negative(f):
    recv(f, "5", "2")
    with pytest.raises(DomainError) as e:
        inv.issue_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="6", on_date=D0)
    assert e.value.get_codes() == "insufficient_stock"
    with pytest.raises(DomainError):
        inv.issue_stock(None, product_id=f["widget"].id, location_id=f["loc_b"].id, quantity="1", on_date=D0)  # nothing at B1
    with pytest.raises(IntegrityError), transaction.atomic():
        im.StockLevel.objects.filter(product=f["widget"]).update(quantity=-1)


@pytest.mark.django_db
def test_transfer_moves_stock_without_changing_value(f):
    recv(f, "10", "4")
    out = inv.transfer_stock(None, product_id=f["widget"].id, from_location_id=f["loc_a"].id, to_location_id=f["loc_e"].id, quantity="4", reason="rebalance")
    legs = im.StockMovement.objects.filter(group_id=out.group_id)
    assert sorted(l.movement_type for l in legs) == ["TRANSFER_IN", "TRANSFER_OUT"] and sum(l.quantity for l in legs) == 0
    assert inv.on_hand(f["widget"].id, location_id=f["loc_a"].id) == 6 and inv.on_hand(f["widget"].id, warehouse_id=im.Warehouse.objects.get(code="EAST").id) == 4
    assert inv.valuation()["total_value"] == "40.0000" and gl("1200") == D("40")
    for bad in (dict(to_location_id=f["loc_a"].id), dict(quantity="0")):
        with pytest.raises(ValidationFailed):
            inv.transfer_stock(None, **{**dict(product_id=f["widget"].id, from_location_id=f["loc_a"].id, to_location_id=f["loc_e"].id, quantity="1"), **bad})
    with pytest.raises(DomainError):
        inv.transfer_stock(None, product_id=f["widget"].id, from_location_id=f["loc_a"].id, to_location_id=f["loc_e"].id, quantity="7")


@pytest.mark.django_db
def test_lot_tracking_rules(f):
    with pytest.raises(ValidationFailed) as e:
        recv(f, "5", "1", product=f["paint"])
    assert e.value.get_codes() == "lot_required"
    recv(f, "5", "1", product=f["paint"], lot_code="L1", expiry_date=date(2027, 1, 1))
    recv(f, "5", "1", product=f["paint"], lot_code="L2")
    with pytest.raises(DomainError) as unknown:
        inv.issue_stock(None, product_id=f["paint"].id, location_id=f["loc_a"].id, quantity="1", lot_code="NOPE", on_date=D0)
    assert unknown.value.get_codes() == "lot_not_found"
    with pytest.raises(DomainError):  # lot L1 only holds 5
        inv.issue_stock(None, product_id=f["paint"].id, location_id=f["loc_a"].id, quantity="6", lot_code="L1", on_date=D0)
    inv.issue_stock(None, product_id=f["paint"].id, location_id=f["loc_a"].id, quantity="5", lot_code="L1", on_date=D0)
    with pytest.raises(ValidationFailed):
        recv(f, "1", "1", lot_code="X")  # non-lot product rejects a lot code
    with pytest.raises(ValidationFailed):
        recv(f, "1", "1", product=f["service"])  # non-stocked item


@pytest.mark.django_db
def test_adjustments_and_cycle_count(f):
    recv(f, "10", "5")
    with pytest.raises(ValidationFailed):
        inv.adjust_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, delta="-1", reason=" ", on_date=D0)
    inv.adjust_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, counted_quantity="8", reason="cycle count", on_date=D0)
    assert inv.on_hand(f["widget"].id) == 8 and gl("5400") == D("-40") and gl("1200") == D("40")  # opening credit 50 less shrinkage 2 x 5
    inv.adjust_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, delta="2", unit_cost="6", reason="found", on_date=D0)
    assert gl("5400") == D("-52") and inv.valuation()["total_value"] == "52.0000"
    with pytest.raises(DomainError) as e:
        inv.adjust_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, counted_quantity="10", reason="same", on_date=D0)
    assert e.value.get_codes() == "no_difference"
    with pytest.raises(ValidationFailed):
        inv.adjust_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, delta="1", counted_quantity="1", reason="both", on_date=D0)


@pytest.mark.django_db
def test_movement_ledger_is_append_only_and_period_enforced(f):
    mv = recv(f, "1", "1")
    for action in (lambda: im.StockMovement.objects.filter(pk=mv.pk).update(quantity=99), lambda: im.StockMovement.objects.filter(pk=mv.pk).delete()):
        with pytest.raises(Exception, match="append-only"), transaction.atomic():
            action()
    from platform_core.organizations import services as org

    org.close_period(None, org.period_for(date(2026, 1, 1)))
    with pytest.raises(DomainError) as closed:
        inv.receive_stock(None, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="1", unit_cost="1", on_date=date(2026, 1, 10))
    assert closed.value.get_codes() == "period_closed"
    assert inv.on_hand(f["widget"].id) == 1  # the failed receipt left no trace


@pytest.mark.django_db
def test_reorder_rules_variants_and_master_data_rules(f):
    inv.set_reorder_rule(None, product_id=f["widget"].id, warehouse_id=im.Warehouse.objects.get(code="MAIN").id, min_quantity="10", reorder_quantity="25")
    recv(f, "4", "1")
    rep = inv.reorder_report()
    assert rep == [{"sku": "W-1", "warehouse": "MAIN", "on_hand": "4.0000", "min_quantity": "10.0000", "suggested_order_quantity": "25.0000"}]
    recv(f, "10", "1")
    assert inv.reorder_report() == []
    variant = inv.create_product(None, sku="W-1-RED", name="Widget red", variant_of_id=f["widget"].id, attributes={"colour": "red"})
    assert variant.variant_of_id == f["widget"].id
    with pytest.raises(ValidationFailed):
        inv.create_product(None, sku="W-1-RED-L", name="x", variant_of_id=variant.id)
    with pytest.raises(DomainError):
        inv.create_product(None, sku="W-1", name="dup")
    with pytest.raises(DomainError):
        inv.create_product(None, sku="W-2", name="dup barcode", barcode="111")
    with pytest.raises(DomainError):
        inv.update_product(None, f["widget"].id, is_active=False)  # stock on hand


@pytest.fixture
def api_env(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = master(tenant, prepare(tenant))
    apis = {}
    for key in ("wh", "pm", "po", "emp", "mgr"):
        ExternalIdentity.objects.create(user=env["people"][key], issuer="https://kc.test/realms/erp", subject=f"{key}-sub")
        apis[key] = Api(ACME_HOST)
        assert apis[key].login(idp, f"{key}-sub").status_code == 302
    return env, apis


@pytest.mark.django_db
def test_inventory_api_permissions_and_barcode_lookup(api_env):
    env, api = api_env
    pid, loc = str(env["widget"].id), str(env["loc_a"].id)
    assert api["emp"].get("/api/v1/inventory/products").status_code == 403
    assert api["po"].post("/api/v1/inventory/products", {"sku": "X", "name": "X"}).status_code == 403  # officer cannot manage master data
    assert api["pm"].get("/api/v1/inventory/products?barcode=111").status_code == 200  # inventory.view
    assert api["pm"].post("/api/v1/inventory/products", {"sku": "X", "name": "X"}).status_code == 403
    assert api["wh"].get("/api/v1/inventory/products?barcode=111").json()["results"][0]["sku"] == "W-1"
    assert api["wh"].post("/api/v1/inventory/receipts", {"product": pid, "location": loc, "quantity": "10", "unit_cost": "5", "reason": "opening"}).status_code == 201
    assert api["wh"].post("/api/v1/inventory/issues", {"product": pid, "location": loc, "quantity": "11", "reason": "x"}).status_code == 409
    assert api["wh"].post("/api/v1/inventory/issues", {"product": pid, "location": loc, "quantity": "4", "reason": "x"}).status_code == 201
    assert api["po"].post("/api/v1/inventory/adjustments", {"product": pid, "location": loc, "delta": "1", "reason": "x"}).status_code == 403
    assert api["wh"].get("/api/v1/inventory/valuation").json()["total_value"] == "30.0000"
    stock = api["wh"].get("/api/v1/inventory/stock").json()["results"]
    assert stock[0]["quantity"] == "6.0000"
    assert len(api["wh"].get("/api/v1/inventory/movements").json()["results"]) == 2


@pytest.mark.django_db(transaction=True)
def test_concurrent_issues_never_oversell(own_tenant):
    tenant = own_tenant("invrace")
    with schema_context(tenant.schema_name):
        env = master(tenant, prepare(tenant))
        recv(env, "10", "2")
    results = []

    def go():
        try:
            with schema_context(tenant.schema_name):
                inv.issue_stock(None, product_id=env["widget"].id, location_id=env["loc_a"].id, quantity="3", on_date=D0)
            results.append("ok")
        except DomainError as exc:
            results.append(exc.get_codes())
        finally:
            connections.close_all()

    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["insufficient_stock"] * 3 + ["ok"] * 3, results
    with schema_context(tenant.schema_name):
        assert inv.on_hand(env["widget"].id) == D("1")
        assert im.ProductCost.objects.get(product=env["widget"]).total_value == D("2") and gl("1200") == D("2")

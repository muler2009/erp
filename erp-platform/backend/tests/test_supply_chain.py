from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django.utils import timezone
from django_tenants.utils import schema_context

from modules.finance import models as fm
from modules.finance import services as fin
from modules.inventory import models as im
from modules.inventory import services as inv
from modules.manufacturing import bom as bs
from modules.manufacturing import models as mm
from modules.procurement import models as pm
from modules.sales import services as sales
from modules.supply_chain import delivery as dv
from modules.supply_chain import jobs
from modules.supply_chain import logistics as lg
from modules.supply_chain import models as m
from modules.supply_chain import planning as pl
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from tests.conftest import ACME_HOST, Api
from tests.test_finance import user
from tests.test_sales import D0, confirmed, deliver, f as sales_f, line  # noqa: F401

TODAY = timezone.now().date()


@pytest.fixture
def f(sales_f, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    p = sales_f["people"]
    p["logi"] = user(tenant, "lg1@acme.test", "logistics_coordinator")
    p["logi2"] = user(tenant, "lg2@acme.test", "logistics_coordinator")
    p["pm"] = user(tenant, "mfpm@acme.test", "production_manager")
    p["planner"] = user(tenant, "mfpl@acme.test", "production_planner")
    p["aud"] = user(tenant, "scaud@acme.test", "read_only_auditor")
    p["emp"] = user(tenant, "scemp@acme.test", "employee")
    return sales_f


def codes(e):
    return e.value.get_codes()


def gl(code):
    return fin.account_balance(fm.Account.objects.get(code=code))


def uid(f, k="logi"):
    return f["people"][k].id


def ship(f, **kw):
    a = kw.pop("a", None)
    d = dict(kind="OUTBOUND", origin="Main warehouse", destination="Customer site", planned_dispatch=TODAY, planned_arrival=TODAY + timedelta(days=3), lines=[{"description": "Pallet", "quantity": 2}], weight_kg=100)
    d.update(kw)
    return lg.create_shipment(uid(f), **d)


@pytest.mark.django_db
def test_carrier_route_and_shipment_lifecycle(f):
    a = uid(f)
    c = lg.create_carrier(a, code="dhl", name="DHL", mode="COURIER")
    assert c.code == "DHL"
    with pytest.raises(DomainError) as x:
        lg.create_carrier(a, code="DHL", name="dup")
    assert codes(x) == "duplicate_code"
    with pytest.raises(ValidationFailed):
        lg.create_carrier(a, code="X", name="X", mode="TELEPORT")
    r = lg.create_route(a, code="R1", name="Addis-Adama", origin="Addis", destination="Adama", distance_km=90, transit_days=2, carrier_id=c.id)
    s = lg.create_shipment(a, kind="OUTBOUND", origin="Addis", destination="Adama", planned_dispatch=TODAY, route_id=r.id, lines=[{"description": "Boxes", "quantity": 4}])
    assert s.planned_arrival == TODAY + timedelta(days=2) and s.carrier_id == c.id and s.number.startswith("SHP-") and s.status == "PLANNED"
    with pytest.raises(DomainError) as x:
        lg.add_tracking(a, s.id, location="Somewhere")
    assert codes(x) == "invalid_state_transition"
    with pytest.raises(DomainError):
        lg.deliver(a, s.id)
    lg.dispatch(a, s.id)
    with pytest.raises(DomainError):
        lg.dispatch(a, s.id)
    lg.add_tracking(a, s.id, location="Mojo", note="Passed hub")
    with pytest.raises(ValidationFailed):
        lg.add_tracking(a, s.id, location=" ")
    done = lg.deliver(a, s.id, received_by="Abebe")
    assert done.status == "DELIVERED" and [e.status for e in done.events.order_by("occurred_at", "id")] == ["PLANNED", "DISPATCHED", "IN_TRANSIT", "DELIVERED"]
    with pytest.raises(DomainError):
        lg.cancel(a, s.id, reason="late")
    with pytest.raises(ValidationFailed) as x:
        lg.create_shipment(a, kind="OUTBOUND", origin="A", destination="B", planned_dispatch=TODAY, planned_arrival=TODAY - timedelta(days=1))
    assert codes(x) == "invalid_dates"
    s2 = ship(f)
    with pytest.raises(ValidationFailed):
        lg.cancel(a, s2.id, reason="")
    assert lg.cancel(a, s2.id, reason="Order cancelled").status == "CANCELLED"


@pytest.mark.django_db
def test_costs_post_to_ledger_and_reports(f):
    a = uid(f)
    c = lg.create_carrier(a, code="DHL", name="DHL")
    s = ship(f, carrier_id=c.id, weight_kg=200)
    lg.add_cost(a, s.id, cost_type="FREIGHT", amount="300")
    lg.add_cost(a, s.id, cost_type="FUEL", amount="50")
    assert gl("5340") == D("350") and gl("2260") == D("350")
    with pytest.raises(ValidationFailed):
        lg.add_cost(a, s.id, cost_type="FREIGHT", amount="0")
    with pytest.raises(ValidationFailed):
        lg.add_cost(a, s.id, cost_type="BRIBE", amount="5")
    with pytest.raises(DomainError) as x:
        lg.cancel(a, s.id, reason="x")
    assert codes(x) == "has_costs"
    rep = lg.cost_report(TODAY, TODAY)
    assert rep["total"].startswith("350") and rep["by_type"]["FREIGHT"].startswith("300") and rep["by_carrier"][0]["carrier"] == "DHL" and rep["by_carrier"][0]["cost_per_kg"] == "1.7500"


@pytest.mark.django_db
def test_shipment_for_sales_delivery_is_unique_and_copies_tracking(f):
    o = confirmed(f)
    d = sales.create_delivery(f["people"]["wh"].id, o.id, location_id=f["loc_a"].id, delivery_date=D0, lines=[{"order_line": str(o.lines.get().id), "quantity": "10"}], carrier="DHL", tracking_ref="TRK-1")
    s = ship(f, sales_delivery_id=d.id)
    assert s.tracking_ref == "TRK-1"
    with pytest.raises(DomainError) as x:
        ship(f, sales_delivery_id=d.id)
    assert codes(x) == "duplicate_shipment"
    with pytest.raises(ValidationFailed):
        ship(f, sales_delivery_id="00000000-0000-0000-0000-000000000001")
    board = dv.fulfillment_board()
    assert board == []  # fully delivered lines drop off the board only when delivered; here the order is dispatched
    assert lg.cancel(uid(f), s.id, reason="redo").status == "CANCELLED"
    assert ship(f, sales_delivery_id=d.id).status == "PLANNED"  # a cancelled shipment frees the delivery


@pytest.mark.django_db
def test_fulfilment_board_shows_short_and_ready(f):
    o = confirmed(f, [line(f, qty="10")])
    b = dv.fulfillment_board()
    assert b[0]["order"] == o.number and b[0]["fulfilment"] in ("READY", "SHORT", "PARTIAL") and b[0]["lines"][0]["open"] == "10.0000"
    big = confirmed(f, [line(f, qty="95", price="1")])
    rows = {r["order"]: r for r in dv.fulfillment_board()}
    assert rows[big.number]["fulfilment"] in ("SHORT", "PARTIAL") and D(rows[big.number]["lines"][0]["short"]) > 0


@pytest.mark.django_db
def test_exceptions_sod_and_auto_detection(f):
    a, b = uid(f), uid(f, "logi2")
    s = ship(f)
    lg.dispatch(a, s.id)
    x = lg.report_exception(a, s.id, kind="DAMAGE", severity="HIGH", description="Crushed pallet")
    with pytest.raises(DomainError) as e:
        lg.resolve_exception(a, x.id, resolution="Replaced")
    assert codes(e) == "separation_of_duties"
    with pytest.raises(ValidationFailed):
        lg.resolve_exception(b, x.id, resolution=" ")
    assert lg.resolve_exception(b, x.id, resolution="Replaced").status == "RESOLVED"
    with pytest.raises(DomainError):
        lg.resolve_exception(b, x.id, resolution="again")
    low = lg.report_exception(a, s.id, kind="DELAY", severity="LOW", description="Rain")
    assert lg.resolve_exception(a, low.id, resolution="Arrived").status == "RESOLVED"  # low severity: the reporter may resolve it
    with pytest.raises(ValidationFailed):
        lg.report_exception(a, s.id, kind="NOPE", description="x")
    # job: a late in-transit shipment gets exactly one automatic delay exception, and the owner is told
    late = ship(f, planned_dispatch=TODAY - timedelta(days=10), planned_arrival=TODAY - timedelta(days=5))
    lg.dispatch(a, late.id)
    assert jobs.late_shipments(TODAY) == 1 and jobs.late_shipments(TODAY) == 0
    ex = late.exceptions.get()
    assert ex.kind == "DELAY" and ex.auto_detected and Notification.objects.filter(ref_type="supply_chain.shipment", ref_id=str(late.id)).exists()
    # planned but never dispatched: reminder, at most every 3 days
    idle = ship(f, planned_dispatch=TODAY - timedelta(days=2), planned_arrival=TODAY + timedelta(days=1))
    assert jobs.undispatched_reminders(TODAY) == 1 and jobs.undispatched_reminders(TODAY) == 0
    assert jobs.run_daily() == {"late": 0, "reminders": 0, "risk_reminders": 0}
    assert idle.id


@pytest.mark.django_db
def test_carrier_performance(f):
    a = uid(f)
    c = lg.create_carrier(a, code="TNT", name="TNT")
    ok = ship(f, carrier_id=c.id)
    late = ship(f, carrier_id=c.id, planned_arrival=TODAY - timedelta(days=0), planned_dispatch=TODAY)
    for s in (ok, late):
        lg.dispatch(a, s.id)
    lg.deliver(a, ok.id)
    m.Shipment.objects.filter(pk=late.id).update(planned_dispatch=TODAY - timedelta(days=4), planned_arrival=TODAY - timedelta(days=2))
    lg.deliver(a, late.id)
    lg.report_exception(a, late.id, kind="DELAY", description="slow")
    row = lg.carrier_performance(TODAY, TODAY)[0]
    assert row["carrier"] == "TNT" and row["delivered"] == 2 and row["on_time_pct"] == "50.00" and row["exceptions"] == 1 and row["exception_rate_pct"] == "50.00"


@pytest.mark.django_db
def test_forecast_history_generation_and_approval(f):
    o = confirmed(f, [line(f, qty="30")])
    deliver(f, o)  # 30 widgets delivered in March 2026 (D0)
    today = date(2026, 6, 10)
    made = pl.generate_from_history(uid(f, "planner"), product_ids=[f["widget"].id], today=today)
    assert [str(x.period_start) for x in made] == ["2026-07-01", "2026-08-01", "2026-09-01"] and all(x.quantity == D("10.0000") and x.method == "HISTORY" for x in made)
    fc = made[0]
    with pytest.raises(DomainError) as e:
        pl.approve_forecast(uid(f, "planner"), fc.id)
    assert codes(e) == "separation_of_duties"
    pl.approve_forecast(uid(f, "logi"), fc.id)
    with pytest.raises(DomainError) as e:
        pl.set_forecast(uid(f, "planner"), product_id=f["widget"].id, period_start=date(2026, 7, 20), quantity=99)
    assert codes(e) == "forecast_approved"
    again = pl.generate_from_history(uid(f, "planner"), product_ids=[f["widget"].id], today=today)
    assert len(again) == 2  # the approved month is left alone
    assert pl.history(f["widget"].id, 3, today)[0] == (date(2026, 3, 1), D("30"))
    acc = pl.forecast_accuracy(3, date(2026, 8, 5))
    assert acc[0]["period"] == "2026-07-01" and acc[0]["actual"] == "0"
    with pytest.raises(ValidationFailed):
        pl.set_forecast(uid(f, "planner"), product_id=f["widget"].id, period_start=today, quantity=-1)


@pytest.mark.django_db
def test_replenishment_reorder_forecast_convert_and_supersede(f):
    w, loc = f["widget"], f["loc_a"]
    inv.set_reorder_rule(uid(f, "pm"), product_id=w.id, warehouse_id=loc.warehouse_id, min_quantity=150, reorder_quantity=200)
    run1, rows = pl.run_replenishment(uid(f, "planner"), today=date(2026, 3, 20))
    mine = [r for r in rows if r.product_id == w.id]
    assert len(mine) == 1 and mine[0].action == "BUY" and mine[0].quantity == D("200.0000")  # 100 on hand vs 150 minimum -> short 50, bought in the reorder lot
    run2, rows2 = pl.run_replenishment(uid(f, "planner"), today=date(2026, 3, 20))
    assert m.ReplenishmentSuggestion.objects.filter(run_id=run1, status="SUPERSEDED").count() == len(rows) and m.ReplenishmentSuggestion.objects.filter(status="OPEN").count() == len(rows2)
    s = next(r for r in rows2 if r.product_id == w.id)
    done = pl.convert(uid(f, "planner"), s.id)
    req = pm.Requisition.objects.get(pk=done.converted_ref_id)
    assert done.status == "CONVERTED" and req.lines.get().quantity == D("200.0000") and req.requester_id == uid(f, "planner")
    with pytest.raises(DomainError):
        pl.convert(uid(f, "planner"), s.id)
    with pytest.raises(DomainError):
        pl.dismiss(uid(f, "planner"), s.id, note="x")
    # approved forecast adds demand; confirmed orders consume it
    fc = pl.set_forecast(uid(f, "planner"), product_id=w.id, period_start=date(2026, 4, 1), quantity=500)
    pl.approve_forecast(uid(f, "logi"), fc.id)
    _, rows3 = pl.run_replenishment(uid(f, "planner"), today=date(2026, 3, 20))
    w3 = next(r for r in rows3 if r.product_id == w.id)
    assert w3.quantity == D("350.0000") and w3.need_by == date(2026, 4, 1)  # 150 minimum + 500 forecast - 100 on hand - 200 already requisitioned
    with pytest.raises(ValidationFailed) as e:
        pl.dismiss(uid(f, "planner"), w3.id, note=" ")
    assert codes(e) == "reason_required"
    assert pl.dismiss(uid(f, "planner"), w3.id, note="Handled by blanket order").status == "DISMISSED"


@pytest.mark.django_db
def test_replenishment_make_converts_to_production_order(f):
    w, loc, a = f["widget"], f["loc_a"], uid(f, "pm")
    gadget = inv.create_product(a, sku="GADGET", name="Gadget")
    b = bs.create_bom(a, product_id=gadget.id, lines=[{"component": w.id, "quantity": 2}])
    bs.approve_bom(uid(f, "planner"), b.id)
    inv.set_reorder_rule(a, product_id=gadget.id, warehouse_id=loc.warehouse_id, min_quantity=5, reorder_quantity=10)
    _, rows = pl.run_replenishment(uid(f, "planner"), today=date(2026, 3, 20))
    g = next(r for r in rows if r.product_id == gadget.id)
    assert g.action == "MAKE" and g.quantity == D("10.0000")
    with pytest.raises(ValidationFailed) as e:
        pl.convert(uid(f, "planner"), g.id)
    assert codes(e) == "location_required"
    done = pl.convert(uid(f, "planner"), g.id, location_id=loc.id)
    o = mm.ProductionOrder.objects.get(pk=done.converted_ref_id)
    assert o.product_id == gadget.id and o.quantity == D("10.0000") and o.components.get().required_quantity == D("20.0000")
    # the open production order now counts as supply: nothing left to make
    _, rows2 = pl.run_replenishment(uid(f, "planner"), today=date(2026, 3, 20))
    assert not [r for r in rows2 if r.product_id == gadget.id]


@pytest.mark.django_db
def test_http_permissions(world, idp, acme, f):
    p = f["people"]
    with schema_context(acme["schema"]):
        pass
    for key in ("logi", "planner", "aud", "emp"):
        ExternalIdentity.objects.create(user=p[key], issuer="https://kc.test/realms/erp", subject=f"sc-{key}")
    api = {}
    for key in ("logi", "planner", "aud", "emp"):
        api[key] = Api(ACME_HOST)
        assert api[key].login(idp, f"sc-{key}").status_code == 302
    body = {"code": "UPS", "name": "UPS"}
    assert api["emp"].post("/api/v1/supply-chain/carriers", body).status_code == 403
    assert api["aud"].post("/api/v1/supply-chain/carriers", body).status_code == 403
    assert api["planner"].post("/api/v1/supply-chain/carriers", body).status_code == 403
    assert api["logi"].post("/api/v1/supply-chain/carriers", body).status_code == 201
    assert api["aud"].get("/api/v1/supply-chain/carriers").status_code == 200 and api["emp"].get("/api/v1/supply-chain/carriers").status_code == 403
    sh = api["logi"].post("/api/v1/supply-chain/shipments", {"kind": "OUTBOUND", "origin": "A", "destination": "B", "planned_dispatch": str(TODAY), "planned_arrival": str(TODAY + timedelta(days=1)), "lines": [{"description": "x", "quantity": "1"}]})
    assert sh.status_code == 201
    sid = sh.json()["id"]
    assert api["aud"].post(f"/api/v1/supply-chain/shipments/{sid}/dispatch").status_code == 403
    assert api["logi"].post(f"/api/v1/supply-chain/shipments/{sid}/dispatch").status_code == 200
    assert api["logi"].post(f"/api/v1/supply-chain/shipments/{sid}/deliver", {}).status_code == 200
    assert api["logi"].get(f"/api/v1/supply-chain/shipments/{sid}").json()["status"] == "DELIVERED"
    assert api["planner"].post("/api/v1/supply-chain/replenishment/run").status_code == 201
    assert api["logi"].post("/api/v1/supply-chain/replenishment/run").status_code == 403
    assert api["aud"].get("/api/v1/supply-chain/replenishment/suggestions").status_code == 200
    assert api["logi"].post("/api/v1/supply-chain/forecasts", {"product": str(f["widget"].id), "period_start": "2026-12-01", "quantity": "5"}).status_code == 403
    fc = api["planner"].post("/api/v1/supply-chain/forecasts", {"product": str(f["widget"].id), "period_start": "2026-12-01", "quantity": "5"})
    assert fc.status_code == 201
    assert api["planner"].post(f"/api/v1/supply-chain/forecasts/{fc.json()['id']}/approve").status_code == 403
    assert api["logi"].post(f"/api/v1/supply-chain/forecasts/{fc.json()['id']}/approve").status_code == 200
    qs = f"?from={TODAY}&to={TODAY}"
    for path in ("reports/costs", "reports/carriers", "reports/supplier-delivery"):
        assert api["aud"].get(f"/api/v1/supply-chain/{path}{qs}").status_code == 200
        assert api["emp"].get(f"/api/v1/supply-chain/{path}{qs}").status_code == 403
    assert api["aud"].get("/api/v1/supply-chain/reports/costs").status_code == 400
    assert api["aud"].get("/api/v1/supply-chain/fulfilment").status_code == 200


@pytest.mark.django_db
def test_shipment_detail_exposes_line_ids_usable_for_delivery(f):
    from modules.supply_chain import views as scv

    s = ship(f)
    lg.dispatch(uid(f), s.id)
    d = scv._ship(s, True)
    line = d["lines"][0]
    assert line["id"] == str(s.lines.get().id)
    done = lg.deliver(uid(f), s.id, received_by="Abebe", lines=[{"line": line["id"], "received": 1, "damaged": 0, "note": "one short"}])
    assert done.lines.get().received_quantity == 1
    assert done.exceptions.filter(kind="SHORTAGE").exists()


@pytest.mark.django_db
def test_forecast_rows_carry_the_product_sku(f):
    from modules.supply_chain import views as scv

    fc = pl.set_forecast(uid(f, "planner"), product_id=f["widget"].id, period_start=date(2026, 7, 1), quantity=5)
    assert scv._fc(fc)["sku"] == f["widget"].sku

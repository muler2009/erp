from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django.utils import timezone
from django_tenants.utils import schema_context

from modules.inventory import models as im
from modules.inventory import services as inv
from modules.procurement import models as pm
from modules.supply_chain import coordination as co
from modules.supply_chain import demand as dm
from modules.supply_chain import fleet as fl
from modules.supply_chain import jobs
from modules.supply_chain import logistics as lg
from modules.supply_chain import models as m
from modules.supply_chain import performance as pf
from modules.supply_chain import planning as pl
from modules.supply_chain import risk as rk
from platform_core.organizations import services as org
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from tests.conftest import ACME_HOST, Api
from tests.test_sales import confirmed, line, f as sales_f  # noqa: F401
from tests.test_supply_chain import TODAY, codes, f, ship, uid  # noqa: F401


# ----------------------------------------------------------------------------- demand
@pytest.mark.django_db
def test_demand_lifecycle_and_double_counting_guard(f):
    w, planner, logi = f["widget"], uid(f, "planner"), uid(f, "logi")
    with pytest.raises(ValidationFailed) as e:
        dm.create_demand(planner, product_id=w.id, quantity=5, required_date=TODAY, source="SALES_ORDER", source_ref="SO-1")
    assert codes(e) == "double_counting"
    d = dm.create_demand(planner, product_id=w.id, quantity=300, required_date=TODAY + timedelta(days=10), source="PROJECT", source_ref="PRJ-1", kind="CONFIRMED")
    with pytest.raises(DomainError) as e:
        dm.create_demand(planner, product_id=w.id, quantity=1, required_date=TODAY, source="PROJECT", source_ref="PRJ-1")
    assert codes(e) == "duplicate_demand"
    with pytest.raises(DomainError) as e:
        dm.approve_demand(planner, d.id)
    assert codes(e) == "separation_of_duties"
    # draft demand is not planned yet; impact shows what approval would add
    imp = dm.impact(d.id, TODAY)
    assert any(r["product"] == "W-1" and D(r["change"]) > 0 for r in imp)
    assert not [s for s in pl.run_preview(TODAY) if s["sku"] == "W-1" and s["quantity"] >= 300]
    dm.approve_demand(logi, d.id)
    assert [s for s in pl.run_preview(TODAY) if s["sku"] == "W-1" and s["quantity"] >= 200]
    imp2 = dm.impact(d.id, TODAY)
    assert any(D(r["change"]) > 0 for r in imp2)
    # revision keeps history, needs a reason and sends the demand back for approval
    with pytest.raises(ValidationFailed):
        dm.revise_demand(planner, d.id, reason=" ", quantity=10)
    r = dm.revise_demand(planner, d.id, reason="Customer reduced", quantity=50)
    assert r.status == "DRAFT" and r.revision == 2 and r.revisions.get().old_quantity == D("300.0000")
    with pytest.raises(DomainError) as e:
        dm.approve_demand(planner, d.id)  # reviser cannot approve
    assert codes(e) == "separation_of_duties"
    dm.approve_demand(logi, d.id)
    rows = dm.consolidated(TODAY, TODAY + timedelta(days=60))
    assert rows and rows[0]["confirmed"] == "50.0000"
    dm.cancel_demand(planner, d.id, reason="Project cancelled")
    assert m.Demand.objects.get(pk=d.id).status == "CANCELLED"
    with pytest.raises(DomainError):
        dm.revise_demand(planner, d.id, reason="x", quantity=1)
    # a cancelled demand frees its source reference
    assert dm.create_demand(planner, product_id=w.id, quantity=1, required_date=TODAY, source="PROJECT", source_ref="PRJ-1")


# ----------------------------------------------------------------------------- supply plans
@pytest.mark.django_db
def test_supply_plan_revision_history_and_approval_gate(f):
    w, loc, planner, logi = f["widget"], f["loc_a"], uid(f, "planner"), uid(f, "logi")
    inv.set_reorder_rule(planner, product_id=w.id, warehouse_id=loc.warehouse_id, min_quantity=150, reorder_quantity=200)
    org.update_settings(planner, {"supply_chain.plan_approval_required": True})
    _, rows = pl.run_replenishment(planner, today=TODAY)
    s = next(r for r in rows if r.product_id == w.id)
    plan = m.SupplyPlan.objects.get(pk=s.plan_id)
    assert plan.status == "DRAFT" and plan.revision == 1 and plan.balance["items"] is not None
    with pytest.raises(DomainError) as e:
        pl.convert(planner, s.id)
    assert codes(e) == "plan_not_approved"
    pl.adjust_suggestion(planner, s.id, quantity=400, reason="Supplier MOQ")
    plan.refresh_from_db()
    ch = plan.changes.get()
    assert plan.revision == 2 and ch.field == "quantity" and ch.new_value.startswith("400") and ch.reason == "Supplier MOQ"
    with pytest.raises(ValidationFailed):
        pl.adjust_suggestion(planner, s.id, quantity=500, reason=" ")
    with pytest.raises(DomainError) as e:
        pl.approve_supply_plan(planner, plan.id)
    assert codes(e) == "separation_of_duties"
    pl.approve_supply_plan(logi, plan.id)
    # adjusting an approved plan returns it to draft: it must be approved again
    pl.adjust_suggestion(planner, s.id, quantity=300, reason="Budget")
    plan.refresh_from_db()
    assert plan.status == "DRAFT" and plan.approved_by is None
    pl.approve_supply_plan(logi, plan.id)
    done = pl.convert(planner, s.id)
    assert done.status == "CONVERTED"
    assert pm.Requisition.objects.get(pk=done.converted_ref_id).lines.get().quantity == D("300.0000")


# ----------------------------------------------------------------------------- risk
@pytest.mark.django_db
def test_risk_register_actions_disruptions_and_reminders(f):
    logi, w = uid(f, "logi"), f["widget"]
    owner = uid(f, "planner")
    with pytest.raises(ValidationFailed):
        rk.create_risk(logi, category="SUPPLIER", title="x", likelihood=6, impact=1, owner_id=owner)
    r = rk.create_risk(logi, category="SUPPLIER", title="Sole supplier fails", likelihood=4, impact=5, owner_id=owner, product_id=w.id, financial_impact=1000)
    assert r.score == 20 and r.number.startswith("SR-")
    assert Notification.objects.filter(user_id=owner, notification_type="supply_chain.critical_risk").count() == 1  # critical: owner told at once
    low = rk.create_risk(logi, category="LOGISTICS", title="Minor", likelihood=1, impact=2, owner_id=owner)
    assert Notification.objects.filter(user_id=owner, notification_type="supply_chain.critical_risk").count() == 1
    a = rk.add_action(logi, r.id, description="Qualify second supplier", owner_id=owner, due_date=TODAY - timedelta(days=1))
    assert m.SupplyRisk.objects.get(pk=r.id).status == "MITIGATING"
    with pytest.raises(DomainError) as e:
        rk.update_risk(logi, r.id, status="CLOSED")
    assert codes(e) == "open_actions"
    assert rk.daily(TODAY) == 2  # critical risk reminder + overdue action
    assert rk.daily(TODAY) == 0  # once a week, not every run
    assert rk.daily(TODAY + timedelta(days=7)) == 2
    rk.complete_action(logi, a.id)
    with pytest.raises(DomainError):
        rk.complete_action(logi, a.id)
    assert rk.update_risk(logi, r.id, status="CLOSED").status == "CLOSED"
    with pytest.raises(ValidationFailed):
        rk.add_action(logi, r.id, description="late", owner_id=owner, due_date=TODAY)
    assert low.status == "OPEN"
    d = rk.record_disruption(logi, category="SUPPLIER", title="Port strike", cause="Strike", started_on=TODAY - timedelta(days=2), product_id=w.id, financial_impact=500)
    with pytest.raises(ValidationFailed):
        rk.record_disruption(logi, category="X", title="t", cause="c", started_on=TODAY)
    with pytest.raises(DomainError):
        rk.resolve_disruption(logi, d.id, resolution=" ")
    assert rk.resolve_disruption(logi, d.id, resolution="Rerouted").status == "RESOLVED"
    assert rk.incident_history(TODAY - timedelta(days=30), TODAY)[0]["title"] == "Port strike"
    assert jobs.run_daily()["risk_reminders"] >= 0


@pytest.mark.django_db
def test_critical_materials_single_source_and_detection(f):
    logi, w = uid(f, "logi"), f["widget"]
    rk.mark_critical(logi, w.id, reason="Key component", min_sources=2)
    rep = rk.critical_materials_report()
    assert rep[0]["product"] == "W-1" and rep[0]["at_risk"] is True
    with pytest.raises(ValidationFailed):
        rk.mark_critical(logi, w.id, reason=" ")
    types = {x["type"] for x in rk.detect_supply_risks(TODAY)}
    assert "CRITICAL_SOURCING" in types
    # a late shipment is flagged
    s = ship(f, planned_dispatch=TODAY - timedelta(days=5), planned_arrival=TODAY - timedelta(days=2))
    lg.dispatch(logi, s.id)
    assert any(x["type"] == "LATE_SHIPMENT" and x["ref"] == s.number for x in rk.detect_supply_risks(TODAY))


# ----------------------------------------------------------------------------- fleet, consolidation, POD
@pytest.mark.django_db
def test_vehicle_capacity_overlap_consolidation_and_pod(f):
    logi = uid(f, "logi")
    v = fl.create_vehicle(logi, code="TRK1", plate="AA-123", capacity_kg=250)
    with pytest.raises(DomainError) as e:
        fl.create_vehicle(logi, code="TRK1")
    assert codes(e) == "duplicate_code"
    s1 = ship(f, weight_kg=100)
    s2 = ship(f, weight_kg=120)
    s3 = ship(f, weight_kg=300)
    with pytest.raises(DomainError) as e:
        fl.assign_vehicle(logi, s3.id, v.id)
    assert codes(e) == "over_capacity"
    fl.assign_vehicle(logi, s1.id, v.id)
    with pytest.raises(DomainError) as e:
        fl.assign_vehicle(logi, s2.id, v.id)  # same dates
    assert codes(e) == "vehicle_busy"
    # consolidation: s2 travels with s1 (220 kg fits 250), s3 is too heavy
    with pytest.raises(DomainError) as e:
        fl.consolidate(logi, s1.id, [s3.id])
    assert codes(e) == "over_capacity"
    other = ship(f, destination="Elsewhere")
    with pytest.raises(DomainError) as e:
        fl.consolidate(logi, s1.id, [other.id])
    assert codes(e) == "destination_mismatch"
    fl.consolidate(logi, s1.id, [s2.id])
    with pytest.raises(DomainError) as e:
        lg.dispatch(logi, s2.id)
    assert codes(e) == "consolidated"
    lg.dispatch(logi, s1.id)
    assert m.Shipment.objects.get(pk=s2.id).status == "DISPATCHED"
    # delivery with proof, a short line and damage -> exceptions on the carrying shipment
    line1 = s1.lines.get()
    out = lg.deliver(logi, s1.id, received_by="Abebe", note="Signed", lines=[{"line": str(line1.id), "received": 1, "damaged": 1, "note": "one box crushed"}])
    assert out.pod_received_by == "Abebe" and out.pod_at is not None
    assert m.Shipment.objects.get(pk=s2.id).status == "DELIVERED"
    kinds = set(s1.exceptions.values_list("kind", flat=True))
    assert kinds == {"SHORTAGE", "DAMAGE"}
    util = fl.vehicle_utilisation(TODAY, TODAY + timedelta(days=6))
    assert util[0]["vehicle"] == "TRK1" and util[0]["shipments"] == 1


@pytest.mark.django_db
def test_deliver_rejects_bad_quantities_and_unknown_file(f):
    logi = uid(f, "logi")
    s = ship(f)
    lg.dispatch(logi, s.id)
    ln = s.lines.get()
    with pytest.raises(ValidationFailed) as e:
        lg.deliver(logi, s.id, lines=[{"line": str(ln.id), "received": 5}])
    assert codes(e) == "invalid_amount"
    with pytest.raises(ValidationFailed) as e:
        lg.deliver(logi, s.id, pod_file_id="00000000-0000-0000-0000-000000000001")
    assert codes(e) == "invalid_file"
    assert lg.deliver(logi, s.id).status == "DELIVERED"


@pytest.mark.django_db
def test_transfer_shipment_link_is_unique(f):
    logi = uid(f, "logi")
    with pytest.raises(ValidationFailed):
        ship(f, kind="TRANSFER", transfer_order_id="00000000-0000-0000-0000-000000000001")


# ----------------------------------------------------------------------------- coordination and performance
@pytest.mark.django_db
def test_inventory_coordination(f):
    w, loc, pm_ = f["widget"], f["loc_a"], uid(f, "pm")
    wh2 = inv.create_warehouse(pm_, code="WH2", name="Second")
    loc2 = inv.create_location(pm_, warehouse_id=wh2.id, code="B1")
    inv.set_reorder_rule(pm_, product_id=w.id, warehouse_id=wh2.id, min_quantity=40, reorder_quantity=50)
    inv.set_reorder_rule(pm_, product_id=w.id, warehouse_id=loc.warehouse_id, min_quantity=30, reorder_quantity=50)
    sh = co.shortages()
    assert len(sh) == 1 and sh[0]["warehouse"] == "WH2" and sh[0]["shortage"] == "40.0000"
    rec = co.transfer_recommendations()
    assert rec[0]["from"] == loc.warehouse.code and rec[0]["to"] == "WH2" and D(rec[0]["quantity"]) == D("40") and D(rec[0]["still_short_after"]) == 0
    assert D(co.availability_by_warehouse(w.id)[0]["on_hand"]) >= 0
    # excess against a maximum and obsolete when never issued
    im.Product.objects.filter(pk=w.pk).update(max_stock=D("50"))
    health = {r["product"]: r["status"] for r in co.stock_health(TODAY)}
    assert health["W-1"] == "OBSOLETE"  # never issued
    assert isinstance(co.warehouse_capacity(), list) and isinstance(co.stock_in_transit(), list) and isinstance(co.procurement_status(TODAY), list)
    del loc2


@pytest.mark.django_db
def test_fulfilment_risk_backorders_and_dashboard(f):
    o = confirmed(f, [line(f, qty="5", price="1")])
    late = pf.fulfilment_risk(TODAY)
    mine = [r for r in late if r["order"] == o.number]
    assert mine and mine[0]["status"] == "LATE" and mine[0]["days_late"] > 0
    assert isinstance(pf.backorders(), list)
    dash = pf.dashboard(TODAY)
    assert dash["late_orders"] >= 1 and "on_time_delivery_pct" in dash and "inventory_turnover" in dash
    assert pf.inventory_turnover(TODAY - timedelta(days=30), TODAY)["turnover"] is None  # nothing issued in the period
    assert "fill_rate_pct" in pf.fulfilment_rate(TODAY - timedelta(days=30), TODAY)
    assert "transport_total" in pf.supply_cost_analysis(TODAY - timedelta(days=30), TODAY)


# ----------------------------------------------------------------------------- http
@pytest.mark.django_db
def test_http_permissions_ext(world, idp, acme, f):
    p = f["people"]
    keys = ("logi", "planner", "aud", "emp")
    for key in keys:
        ExternalIdentity.objects.create(user=p[key], issuer="https://kc.test/realms/erp", subject=f"scx-{key}")
    api = {}
    for key in keys:
        api[key] = Api(ACME_HOST)
        assert api[key].login(idp, f"scx-{key}").status_code == 302
    w = str(f["widget"].id)
    body = {"product": w, "quantity": "10", "required_date": str(TODAY + timedelta(days=5)), "source": "PROJECT", "source_ref": "P9"}
    assert api["emp"].post("/api/v1/supply-chain/demands", body).status_code == 403
    assert api["aud"].post("/api/v1/supply-chain/demands", body).status_code == 403
    r = api["planner"].post("/api/v1/supply-chain/demands", body)
    assert r.status_code == 201
    did = r.json()["id"]
    assert api["planner"].post(f"/api/v1/supply-chain/demands/{did}/approve").status_code == 403  # no plan.approve
    assert api["logi"].post(f"/api/v1/supply-chain/demands/{did}/approve").status_code == 200
    assert api["aud"].get("/api/v1/supply-chain/demands").status_code == 200 and api["emp"].get("/api/v1/supply-chain/demands").status_code == 403
    assert api["aud"].get(f"/api/v1/supply-chain/demands/{did}/impact").status_code == 200
    assert api["aud"].post("/api/v1/supply-chain/risks", {}).status_code == 403
    rr = api["logi"].post("/api/v1/supply-chain/risks", {"category": "SUPPLIER", "title": "T", "likelihood": 3, "impact": 3, "owner": str(p["planner"].id)})
    assert rr.status_code == 201 and rr.json()["score"] == 9
    assert api["planner"].post("/api/v1/supply-chain/vehicles", {"code": "V"}).status_code == 403
    assert api["logi"].post("/api/v1/supply-chain/vehicles", {"code": "V1", "capacity_kg": "100"}).status_code == 201
    assert api["emp"].get("/api/v1/supply-chain/vehicles").status_code == 403
    assert api["planner"].post("/api/v1/supply-chain/replenishment/run").status_code == 201
    pid = api["aud"].get("/api/v1/supply-chain/plans").json()["results"][0]["id"]
    assert api["aud"].get(f"/api/v1/supply-chain/plans/{pid}").status_code == 200
    assert api["planner"].post(f"/api/v1/supply-chain/plans/{pid}/approve").status_code == 403
    assert api["logi"].post(f"/api/v1/supply-chain/plans/{pid}/approve").status_code == 200
    for name in ("dashboard", "fulfilment-risk", "shortages", "stock-health", "risk-register", "supply-risks", "transfer-recommendations", "inventory-turnover"):
        assert api["aud"].get(f"/api/v1/supply-chain/analytics/{name}").status_code == 200, name
        assert api["emp"].get(f"/api/v1/supply-chain/analytics/{name}").status_code == 403
    assert api["aud"].get("/api/v1/supply-chain/analytics/nope").status_code == 404


@pytest.mark.django_db
def test_demand_rows_and_fulfilment_lines_carry_the_sku(f):
    from modules.supply_chain import delivery as dv
    from modules.supply_chain import views_ext as scx

    w = f["widget"]
    d = dm.create_demand(uid(f, "planner"), product_id=w.id, quantity=5, required_date=TODAY + timedelta(days=5), source="PROJECT", source_ref="PRJ-SKU")
    assert scx._demand(m.Demand.objects.select_related("product").get(pk=d.id))["sku"] == w.sku
    confirmed(f, [line(f, qty="3")])
    assert all(ln["sku"] == w.sku for row in dv.fulfillment_board() for ln in row["lines"]) and dv.fulfillment_board()

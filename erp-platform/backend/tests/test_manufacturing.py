from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.finance import models as fm
from modules.finance import services as fin
from modules.inventory import models as im
from modules.inventory import services as inv
from modules.manufacturing import bom as bs
from modules.manufacturing import models as mm
from modules.manufacturing import mrp
from modules.manufacturing import orders as od
from modules.manufacturing import reports
from platform_core.users.models import ExternalIdentity
from platform_core.tenants.models import Tenant
from shared.api.errors import DomainError, ValidationFailed
from tests.conftest import ACME_HOST, Api
from tests.test_finance import prepare, user

S = date(2026, 11, 9)


def codes(e):
    return e.value.get_codes()


def gl(code):
    return fin.account_balance(fm.Account.objects.get(code=code))


def make_env(tenant):
    env = prepare(tenant)
    p = env["people"]
    e = {"people": p, "planner": user(tenant, "plan@acme.test", "production_planner"), "pm": user(tenant, "prodm@acme.test", "production_manager"),
         "pm2": user(tenant, "prodm2@acme.test", "production_manager"), "logi": user(tenant, "logi@acme.test", "logistics_coordinator")}
    a = e["pm"].id
    wh = inv.create_warehouse(a, code="MAIN", name="Main")
    loc = inv.create_location(a, warehouse_id=wh.id, code="A1")
    e["wh"], e["loc"] = wh, loc
    e["steel"] = inv.create_product(a, sku="STEEL", name="Steel")
    e["bolt"] = inv.create_product(a, sku="BOLT", name="Bolt")
    e["frame"] = inv.create_product(a, sku="FRAME", name="Frame")  # sub-assembly
    e["bike"] = inv.create_product(a, sku="BIKE", name="Bike")
    inv.receive_stock(a, product_id=e["steel"].id, location_id=loc.id, quantity=100, unit_cost="10")
    inv.receive_stock(a, product_id=e["bolt"].id, location_id=loc.id, quantity=500, unit_cost="0.5")
    e["wc"] = bs.create_work_center(a, code="WELD", name="Welding", capacity_hours_per_day=8, labor_rate=20, machine_rate=10, overhead_rate=5)
    return e


@pytest.fixture
def e(acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        yield make_env(tenant)


def frame_bom(e, approve=True):
    b = bs.create_bom(e["pm"].id, product_id=e["frame"].id, lines=[{"component": e["steel"].id, "quantity": 2, "scrap_percent": 0}, {"component": e["bolt"].id, "quantity": 10}],
                      steps=[{"sequence": 10, "name": "Weld", "work_center": e["wc"].id, "setup_hours": 1, "run_hours": 1}], checks=[{"name": "Weld inspection", "step_sequence": 10}, {"name": "Final dimensions"}])
    return bs.approve_bom(e["planner"].id, b.id) if approve else b


def run_order(e, qty=5, close=True):
    frame_bom(e)
    o = od.create_order(e["pm"].id, product_id=e["frame"].id, quantity=qty, location_id=e["loc"].id, planned_start=S)
    od.release_order(e["pm"].id, o.id)
    return o


def finish(e, o, qty, hours=6):
    a = e["pm"].id
    od.issue_all(a, o.id)
    op = o.operations.get()
    od.start_operation(a, o.id, op.id)
    for c in o.checks.all():
        od.record_check(e["pm"].id, o.id, c.id, result="PASS")
    od.complete_operation(a, o.id, op.id, hours=hours)
    return od.receive_output(a, o.id, quantity=qty)


@pytest.mark.django_db
def test_work_center_validation_and_cost(e):
    assert e["wc"].hourly_cost == D("35")
    with pytest.raises(DomainError) as x:
        bs.create_work_center(e["pm"].id, code="weld", name="dup")
    assert codes(x) == "duplicate_code"
    with pytest.raises(ValidationFailed):
        bs.create_work_center(e["pm"].id, code="X", name="X", labor_rate=-1)


@pytest.mark.django_db
def test_bom_versioning_approval_sod_and_cycles(e):
    b = frame_bom(e, approve=False)
    with pytest.raises(DomainError) as x:
        bs.approve_bom(e["pm"].id, b.id)
    assert codes(x) == "separation_of_duties"
    ok = bs.approve_bom(e["planner"].id, b.id)
    assert ok.status == "ACTIVE" and ok.version == 1
    with pytest.raises(DomainError) as x:
        bs.update_bom(e["pm"].id, b.id, name="n")
    assert codes(x) == "bom_frozen"
    v2 = bs.revise_bom(e["pm"].id, b.id)
    assert v2.version == 2 and v2.status == "DRAFT" and v2.lines.count() == 2 and v2.steps.count() == 1 and v2.checks.count() == 2
    with pytest.raises(DomainError) as x:
        bs.revise_bom(e["pm"].id, b.id)
    assert codes(x) == "draft_exists"
    bs.approve_bom(e["planner"].id, v2.id)
    b.refresh_from_db()
    assert b.status == "ARCHIVED" and mm.Bom.objects.filter(product=e["frame"], status="ACTIVE").count() == 1
    with pytest.raises(ValidationFailed) as x:
        bs.create_bom(e["pm"].id, product_id=e["frame"].id, lines=[{"component": e["frame"].id, "quantity": 1}])
    assert codes(x) == "bom_cycle"
    # indirect cycle: bike needs frame; frame needing bike is refused at approval
    bike = bs.create_bom(e["pm"].id, product_id=e["bike"].id, lines=[{"component": e["frame"].id, "quantity": 1}])
    bs.approve_bom(e["planner"].id, bike.id)
    loop = bs.create_bom(e["pm"].id, product_id=e["frame"].id, lines=[{"component": e["bike"].id, "quantity": 1}])
    with pytest.raises(DomainError) as x:
        bs.approve_bom(e["planner"].id, loop.id)
    assert codes(x) == "bom_cycle"


@pytest.mark.django_db
def test_bom_validation_and_explosion_and_standard_cost(e):
    with pytest.raises(ValidationFailed) as x:
        bs.create_bom(e["pm"].id, product_id=e["frame"].id, lines=[])
    assert codes(x) == "no_lines"
    with pytest.raises(ValidationFailed) as x:
        bs.create_bom(e["pm"].id, product_id=e["frame"].id, lines=[{"component": e["steel"].id, "quantity": 1}, {"component": e["steel"].id, "quantity": 1}])
    assert codes(x) == "duplicate_component"
    with pytest.raises(ValidationFailed):
        bs.create_bom(e["pm"].id, product_id=e["frame"].id, lines=[{"component": e["steel"].id, "quantity": 1}], checks=[{"name": "c", "step_sequence": 99}])
    b = frame_bom(e)
    assert bs.standard_cost(b) == D("95.0000")  # material 2*10+10*0.5=25 + (1+1)h * 35


@pytest.mark.django_db
def test_order_creation_scheduling_and_guards(e):
    with pytest.raises(DomainError) as x:
        od.create_order(e["pm"].id, product_id=e["frame"].id, quantity=1, location_id=e["loc"].id, planned_start=S)
    assert codes(x) == "no_active_bom"
    frame_bom(e)
    o = od.create_order(e["pm"].id, product_id=e["frame"].id, quantity=5, location_id=e["loc"].id, planned_start=S)
    assert o.number.startswith("MO-") and o.status == "DRAFT" and o.standard_unit_cost == D("95")
    comps = {c.product.sku: c.required_quantity for c in o.components.select_related("product")}
    assert comps == {"STEEL": D("10"), "BOLT": D("50")}
    op = o.operations.get()
    assert op.planned_hours == D("6.00") and o.planned_end == S
    big = od.create_order(e["pm"].id, product_id=e["frame"].id, quantity=20, location_id=e["loc"].id, planned_start=S)  # 1 + 20 = 21h -> 3 days at 8h
    assert big.planned_end == S + timedelta(days=2)
    with pytest.raises(ValidationFailed):
        od.create_order(e["pm"].id, product_id=e["frame"].id, quantity=0, location_id=e["loc"].id, planned_start=S)
    with pytest.raises(DomainError) as x:
        od.issue_material(e["pm"].id, o.id, product_id=e["steel"].id, quantity=1)
    assert codes(x) == "invalid_state_transition"  # not released
    from platform_core.organizations import services as org
    org.update_settings(e["pm"].id, {"manufacturing.enabled": False})
    with pytest.raises(DomainError) as x:
        od.release_order(e["pm"].id, o.id)
    assert codes(x) == "manufacturing_disabled"
    org.update_settings(e["pm"].id, {"manufacturing.enabled": True})


@pytest.mark.django_db
def test_material_issue_return_and_availability(e):
    o = run_order(e)
    av = {a["sku"]: a for a in od.availability(o)}
    assert D(av["STEEL"]["short"]) == 0
    od.issue_material(e["pm"].id, o.id, product_id=e["steel"].id, quantity=10)
    o.refresh_from_db()
    assert o.status == "IN_PROGRESS" and o.material_cost == D("100.0000")
    assert inv.on_hand(e["steel"].id) == D("90")
    with pytest.raises(DomainError) as x:
        od.issue_material(e["pm"].id, o.id, product_id=e["steel"].id, quantity=1)  # 11 > 10 * 1.05
    assert codes(x) == "over_issue"
    with pytest.raises(DomainError) as x:
        od.issue_material(e["pm"].id, o.id, product_id=e["frame"].id, quantity=1)
    assert codes(x) == "not_a_component"
    od.return_material(e["pm"].id, o.id, product_id=e["steel"].id, quantity=4)
    o.refresh_from_db()
    assert o.material_cost == D("60.0000") and inv.on_hand(e["steel"].id) == D("94")
    with pytest.raises(DomainError) as x:
        od.return_material(e["pm"].id, o.id, product_id=e["steel"].id, quantity=7)
    assert codes(x) == "invalid_return"
    assert gl("1250") == D("60.0000")
    with pytest.raises(DomainError) as x:
        od.cancel_order(e["pm"].id, o.id)
    assert codes(x) == "order_has_activity"


@pytest.mark.django_db
def test_full_run_costing_and_close(e):
    o = run_order(e)
    finish(e, o, 5)
    o.refresh_from_db()
    assert o.status == "COMPLETED" and o.produced_quantity == 5
    assert inv.on_hand(e["frame"].id) == 5 and inv.on_hand(e["steel"].id) == 90 and inv.on_hand(e["bolt"].id) == 450
    assert o.material_cost == D("125.0000") and o.conversion_cost == D("210.0000") and o.received_value == D("475.0000")
    assert gl("1250") == D("-140.0000")  # 335 in, 475 out at standard
    ca = reports.cost_analysis(o)
    assert ca["actual_cost"] == "335.0000" and ca["actual_unit_cost"] == "67.0000" and ca["variance"] == "-140.0000"
    with pytest.raises(DomainError) as x:
        od.close_order(e["pm"].id, o.id)
    assert codes(x) == "separation_of_duties"
    od.close_order(e["pm2"].id, o.id)
    o.refresh_from_db()
    assert o.status == "CLOSED" and o.variance == D("-140.0000")
    assert gl("1250") == 0 and gl("5320") == D("-140.0000") and gl("5310") == D("-210.0000")
    with pytest.raises(DomainError) as x:
        od.close_order(e["pm2"].id, o.id)
    assert codes(x) == "invalid_state_transition"


@pytest.mark.django_db
def test_scrap_goes_to_scrap_loss_and_rest_to_variance(e):
    o = run_order(e)
    a = e["pm"].id
    od.issue_all(a, o.id)
    op = o.operations.get()
    od.start_operation(a, o.id, op.id)
    for c in o.checks.all():
        od.record_check(a, o.id, c.id, result="PASS")
    od.complete_operation(a, o.id, op.id, hours=40)
    od.report_scrap(a, o.id, kind="OUTPUT", quantity=1, reason="Cracked weld")
    od.receive_output(a, o.id, quantity=4)
    o.refresh_from_db()
    assert o.status == "COMPLETED" and o.scrapped_quantity == 1 and o.scrap_cost == D("95.0000")
    od.close_order(e["pm2"].id, o.id)
    assert gl("5330") == D("95.0000") and gl("5320") == D("1050.0000") and gl("1250") == 0  # 125+1400-380 = 1145
    with pytest.raises(DomainError):
        od.report_scrap(a, o.id, kind="OUTPUT", quantity=1, reason="late")


@pytest.mark.django_db
def test_quality_gates_sequence_and_overproduction(e):
    o = run_order(e)
    a = e["pm"].id
    od.issue_all(a, o.id)
    op = o.operations.get()
    with pytest.raises(DomainError) as x:
        od.complete_operation(a, o.id, op.id, hours=1)
    assert codes(x) == "invalid_state_transition"
    od.start_operation(a, o.id, op.id)
    with pytest.raises(DomainError) as x:
        od.complete_operation(a, o.id, op.id, hours=1)
    assert codes(x) == "quality_check_pending"
    step_check = o.checks.get(step_sequence=10)
    with pytest.raises(ValidationFailed) as x:
        od.record_check(a, o.id, step_check.id, result="FAIL")
    assert codes(x) == "note_required"
    od.record_check(a, o.id, step_check.id, result="FAIL", note="porosity")
    with pytest.raises(DomainError):
        od.complete_operation(a, o.id, op.id, hours=1)
    od.record_check(a, o.id, step_check.id, result="PASS")
    with pytest.raises(DomainError) as x:
        od.receive_output(a, o.id, quantity=1)
    assert codes(x) == "operations_pending"
    od.complete_operation(a, o.id, op.id, hours=6)
    with pytest.raises(DomainError) as x:
        od.receive_output(a, o.id, quantity=1)
    assert codes(x) == "quality_check_pending"  # final inspection outstanding
    od.record_check(a, o.id, o.checks.get(step_sequence__isnull=True).id, result="PASS")
    with pytest.raises(DomainError) as x:
        od.receive_output(a, o.id, quantity=6)  # 5 + 5% = 5.25
    assert codes(x) == "over_production"
    od.receive_output(a, o.id, quantity=3)
    o.refresh_from_db()
    assert o.status == "IN_PROGRESS"
    od.complete_short(a, o.id)
    o.refresh_from_db()
    assert o.status == "COMPLETED" and o.produced_quantity == 3


@pytest.mark.django_db
def test_cancel_idle_order_and_operation_order(e):
    o = run_order(e)
    assert od.cancel_order(e["pm"].id, o.id).status == "CANCELLED"
    with pytest.raises(DomainError) as x:
        od.release_order(e["pm"].id, o.id)
    assert codes(x) == "invalid_state_transition"


@pytest.mark.django_db
def test_explosion_and_mrp_netting(e):
    frame_bom(e)
    bike = bs.create_bom(e["pm"].id, product_id=e["bike"].id, lines=[{"component": e["frame"].id, "quantity": 1}, {"component": e["bolt"].id, "quantity": 4}])
    bs.approve_bom(e["planner"].id, bike.id)
    ex = bs.explode(e["bike"].id, 10)
    got = {(r["sku"], r["level"]): r["quantity"] for r in ex}
    assert got[("FRAME", 1)] == "10.0000" and got[("STEEL", 2)] == "20.0000" and got[("BOLT", 2)] == "100.0000"
    assert bs.where_used(e["steel"].id) == ["FRAME"]
    today = S
    small = mrp.plan([(e["bike"].id, 10, S + timedelta(days=30))], today)
    assert [(s["sku"], s["action"]) for s in small] == [("FRAME", "MAKE"), ("BIKE", "MAKE")] or {(s["sku"], s["action"]) for s in small} == {("BIKE", "MAKE"), ("FRAME", "MAKE")}
    big = {(s["sku"], s["action"]): s for s in mrp.plan([(e["bike"].id, 100, S + timedelta(days=30))], today)}
    assert big[("STEEL", "BUY")]["quantity"] == D("100.0000")  # needs 200, 100 on hand
    assert big[("FRAME", "MAKE")]["quantity"] == D("100.0000") and big[("BIKE", "MAKE")]["quantity"] == D("100")
    assert big[("FRAME", "MAKE")]["start_by"] < big[("BIKE", "MAKE")]["need_by"]
    assert big[("BOLT", "BUY")]["quantity"] == D("900.0000")  # 400 + 1000 = 1400 needed, 500 on hand -> 900
    # an open draft production order for frames counts as supply
    od.create_order(e["pm"].id, product_id=e["frame"].id, quantity=100, location_id=e["loc"].id, planned_start=S)
    again = {(s["sku"], s["action"]) for s in mrp.plan([(e["bike"].id, 100, S + timedelta(days=30))], today)}
    assert ("FRAME", "MAKE") not in again


@pytest.mark.django_db
def test_reports_wip_load_schedule(e):
    o = run_order(e, qty=20)
    od.issue_all(e["pm"].id, o.id)
    assert reports.wip()["total"] == "500.0000"  # 40 steel at 10 + 200 bolts at 0.5
    load = reports.work_center_load(S, S + timedelta(days=2))
    assert load[0]["planned_hours"] == "21.00" and load[0]["utilization_percent"] == "87.5000" and not load[0]["overloaded"]
    assert reports.work_center_load(S, S)[0]["overloaded"]
    assert reports.schedule()[0]["order"] == o.number


@pytest.mark.django_db
def test_http_permissions_and_flow(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        e = make_env(tenant)
        aud = user(tenant, "audm@acme.test", "read_only_auditor")
        emp = user(tenant, "empm@acme.test", "employee")
        for key, u in (("pm", e["pm"]), ("planner", e["planner"]), ("aud", aud), ("emp", emp)):
            ExternalIdentity.objects.create(user=u, issuer="https://kc.test/realms/erp", subject=f"mf-{key}")
    api = {}
    for key in ("pm", "planner", "aud", "emp"):
        api[key] = Api(ACME_HOST)
        assert api[key].login(idp, f"mf-{key}").status_code == 302
    body = {"code": "PAINT", "name": "Paint", "labor_rate": "10"}
    assert api["emp"].post("/api/v1/manufacturing/work-centers", body).status_code == 403
    assert api["aud"].post("/api/v1/manufacturing/work-centers", body).status_code == 403
    assert api["pm"].post("/api/v1/manufacturing/work-centers", body).status_code == 201
    assert api["aud"].get("/api/v1/manufacturing/work-centers").status_code == 200
    assert api["emp"].get("/api/v1/manufacturing/work-centers").status_code == 403
    bom = {"product": str(e["frame"].id), "lines": [{"component": str(e["steel"].id), "quantity": "2"}], "steps": [{"sequence": 1, "work_center": str(e["wc"].id), "run_hours": "1"}]}
    r = api["pm"].post("/api/v1/manufacturing/boms", bom)
    assert r.status_code == 201
    bid = r.json()["id"]
    assert api["pm"].post(f"/api/v1/manufacturing/boms/{bid}/approve").status_code == 403  # lacks bom.approve
    assert api["planner"].post(f"/api/v1/manufacturing/boms/{bid}/approve").status_code == 200
    od_ = api["pm"].post("/api/v1/manufacturing/orders", {"product": str(e["frame"].id), "quantity": "3", "location": str(e["loc"].id), "planned_start": "2026-11-09"})
    assert od_.status_code == 201
    oid = od_.json()["id"]
    assert api["aud"].post(f"/api/v1/manufacturing/orders/{oid}/release").status_code == 403
    assert api["pm"].post(f"/api/v1/manufacturing/orders/{oid}/release").status_code == 200
    assert api["pm"].post(f"/api/v1/manufacturing/orders/{oid}/issue-all").status_code == 200
    assert api["pm"].get(f"/api/v1/manufacturing/orders/{oid}/cost").status_code == 200
    assert api["aud"].get("/api/v1/manufacturing/reports/wip").json()["total"] == "60.0000"
    assert api["pm"].post(f"/api/v1/manufacturing/orders/{oid}/close").status_code == 409
    assert api["pm"].post("/api/v1/manufacturing/mrp/preview", {"demands": [{"product": str(e["frame"].id), "quantity": "100", "date": "2026-12-01"}]}).status_code == 200
    assert api["pm"].get(f"/api/v1/manufacturing/products/{e['frame'].id}/explosion?quantity=2").status_code == 200

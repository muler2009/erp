from datetime import date, datetime, timedelta, timezone as dtz
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.inventory import models as im
from modules.inventory import services as inv
from modules.manufacturing import analytics as an
from modules.manufacturing import bom as bs
from modules.manufacturing import execution as ex
from modules.manufacturing import models as mm
from modules.manufacturing import mrp
from modules.manufacturing import orders as od
from modules.manufacturing import plans as pl
from platform_core.organizations import services as org
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from tests.conftest import ACME_HOST, Api
from tests.test_finance import user
from tests.test_manufacturing import S, codes, e, finish, frame_bom, gl, make_env, run_order  # noqa: F401


def pm(e):
    return e["pm"].id


def pm2(e):
    return e["pm2"].id


def settings(e, **kw):
    org.update_settings(e["pm"].id, {f"manufacturing.{k}": v for k, v in kw.items()})


def quarantine(e):
    return inv.create_location(pm(e), warehouse_id=e["wh"].id, code="QH", kind="QUARANTINE")


def ready_to_receive(e, qty=5):
    o = run_order(e, qty=qty)
    a = pm(e)
    od.issue_all(a, o.id)
    op = o.operations.get()
    od.start_operation(a, o.id, op.id)
    for c in o.checks.filter(step_sequence=10):
        od.record_check(a, o.id, c.id, result="PASS")
    od.complete_operation(a, o.id, op.id, hours=6)
    return o


@pytest.mark.django_db
def test_approval_limit_hold_priority_reschedule_and_effective_dates(e):
    frame_bom(e)
    o = od.create_order(pm(e), product_id=e["frame"].id, quantity=5, location_id=e["loc"].id, planned_start=S)  # standard value 475
    settings(e, order_approval_value=400)
    with pytest.raises(DomainError) as x:
        od.release_order(pm(e), o.id)
    assert codes(x) == "approval_required"
    with pytest.raises(DomainError) as x:
        od.approve_order(pm(e), o.id)
    assert codes(x) == "separation_of_duties"
    od.approve_order(pm2(e), o.id)
    assert od.release_order(pm(e), o.id).status == "RELEASED"
    small = od.create_order(pm(e), product_id=e["frame"].id, quantity=1, location_id=e["loc"].id, planned_start=S)  # 95 is below the limit
    assert od.release_order(pm(e), small.id).status == "RELEASED"
    with pytest.raises(ValidationFailed):
        od.hold_order(pm(e), o.id, reason=" ")
    assert od.hold_order(pm(e), o.id, reason="Waiting for drawing").status == "ON_HOLD"
    with pytest.raises(DomainError):
        od.issue_material(pm(e), o.id, product_id=e["steel"].id, quantity=1)  # nothing runs while on hold
    assert od.resume_order(pm(e), o.id).status == "RELEASED"
    assert od.set_priority(pm(e), o.id, 1).priority == 1
    with pytest.raises(ValidationFailed):
        od.set_priority(pm(e), o.id, 9)
    moved = od.reschedule_order(pm(e), o.id, S + timedelta(days=7))
    assert moved.planned_start == S + timedelta(days=7) and moved.operations.get().planned_start == S + timedelta(days=7)
    # effective window: the approved BOM only applies inside its dates
    b = mm.Bom.objects.get(product=e["frame"], status="ACTIVE")
    b.effective_to = S + timedelta(days=2)
    b.save()
    with pytest.raises(DomainError) as x:
        od.create_order(pm(e), product_id=e["frame"].id, quantity=1, location_id=e["loc"].id, planned_start=S + timedelta(days=10))
    assert codes(x) == "bom_not_effective"


@pytest.mark.django_db
def test_item_profile_makes_mrp_buy_and_blocks_orders(e):
    frame_bom(e)
    assert {(s["sku"], s["action"]) for s in mrp.plan([(e["frame"].id, 100, S + timedelta(days=20))], S)} >= {("FRAME", "MAKE")}
    bs.set_item_profile(pm(e), e["frame"].id, supply_type="PURCHASED", drawing_ref="DWG-1")
    acts = {(s["sku"], s["action"]) for s in mrp.plan([(e["frame"].id, 100, S + timedelta(days=20))], S)}
    assert ("FRAME", "BUY") in acts and ("FRAME", "MAKE") not in acts
    with pytest.raises(DomainError) as x:
        od.create_order(pm(e), product_id=e["frame"].id, quantity=1, location_id=e["loc"].id, planned_start=S)
    assert codes(x) == "not_manufactured"
    with pytest.raises(ValidationFailed):
        bs.set_item_profile(pm(e), e["frame"].id, supply_type="MAGIC")


@pytest.mark.django_db
def test_material_reservation_follows_issue_and_cancel(e):
    o = run_order(e)  # needs 10 steel, 50 bolts
    from modules.inventory import availability as av
    assert av.availability(e["steel"].id)["reserved"].startswith("10")
    od.issue_material(pm(e), o.id, product_id=e["steel"].id, quantity=4)
    assert av.availability(e["steel"].id)["reserved"].startswith("6")
    od.return_material(pm(e), o.id, product_id=e["steel"].id, quantity=4)
    od.cancel_order(pm(e), o.id)
    assert av.availability(e["steel"].id)["reserved"].startswith("0")
    # shortage: warn by default, block when the setting says so
    big = od.create_order(pm(e), product_id=e["frame"].id, quantity=80, location_id=e["loc"].id, planned_start=S)  # 160 steel needed, 100 on hand
    assert od.release_order(pm(e), big.id).status == "RELEASED"
    other = od.create_order(pm(e), product_id=e["frame"].id, quantity=10, location_id=e["loc"].id, planned_start=S)
    settings(e, require_material_on_release=True)
    with pytest.raises(DomainError) as x:
        od.release_order(pm(e), other.id)
    assert codes(x) == "material_shortage"


@pytest.mark.django_db
def test_substitute_additional_usage_and_consumption_ledger(e):
    alt = inv.create_product(pm(e), sku="STEEL2", name="Alloy steel")
    inv.receive_stock(pm(e), product_id=alt.id, location_id=e["loc"].id, quantity=100, unit_cost="12")
    b = bs.create_bom(pm(e), product_id=e["frame"].id, lines=[{"component": e["steel"].id, "quantity": 2, "substitutes": [{"product": alt.id, "ratio": "0.5"}]}], steps=[{"sequence": 10, "work_center": e["wc"].id, "run_hours": 1}])
    bs.approve_bom(e["planner"].id, b.id)
    o = od.create_order(pm(e), product_id=e["frame"].id, quantity=5, location_id=e["loc"].id, planned_start=S)
    od.release_order(pm(e), o.id)
    with pytest.raises(DomainError) as x:
        od.issue_material(pm(e), o.id, product_id=e["bolt"].id, quantity=1, substitute_for=e["steel"].id)
    assert codes(x) == "not_a_substitute"
    od.issue_material(pm(e), o.id, product_id=alt.id, quantity=5, substitute_for=e["steel"].id)  # 5 alloy covers 10 steel (ratio 0.5)
    c = o.components.get()
    assert c.net_issued == D("10") and c.issued_cost == D("60.0000")
    od.issue_material(pm(e), o.id, product_id=e["bolt"].id, quantity=20, additional=True)
    o.refresh_from_db()
    assert o.material_cost == D("70.0000")
    kinds = list(o.consumptions.order_by("recorded_at").values_list("kind", flat=True))
    assert kinds == ["SUBSTITUTE", "ADDITIONAL"] and c.required_quantity == D("10")  # the plan is never overwritten
    rows = {r["material"]: r for r in an.consumption(S, S)}
    assert rows["BOLT"]["planned"] == "0.0000" and rows["BOLT"]["actual"] == "20.0000" and rows["STEEL"]["variance"] == "0.0000"


@pytest.mark.django_db
def test_tolerance_checks_and_conditional_acceptance(e):
    b = bs.create_bom(pm(e), product_id=e["frame"].id, lines=[{"component": e["steel"].id, "quantity": 1}], steps=[{"sequence": 10, "work_center": e["wc"].id, "run_hours": 1}], checks=[{"name": "Length", "step_sequence": 10, "lower_limit": "99.5", "upper_limit": "100.5"}])
    bs.approve_bom(e["planner"].id, b.id)
    with pytest.raises(ValidationFailed):
        bs.create_bom(pm(e), product_id=e["bike"].id, lines=[{"component": e["steel"].id, "quantity": 1}], checks=[{"name": "x", "lower_limit": "5", "upper_limit": "1"}])
    o = od.create_order(pm(e), product_id=e["frame"].id, quantity=1, location_id=e["loc"].id, planned_start=S)
    od.release_order(pm(e), o.id)
    od.issue_all(pm(e), o.id)
    op = o.operations.get()
    od.start_operation(pm(e), o.id, op.id)
    chk = o.checks.get()
    with pytest.raises(ValidationFailed) as x:
        od.record_check(pm(e), o.id, chk.id, result="PASS", measured="101.2")
    assert codes(x) == "result_contradicts_measurement"
    assert od.record_check(pm(e), o.id, chk.id, measured="101.2", note="out of range").result == "FAIL"  # the measurement decides
    with pytest.raises(DomainError):
        od.complete_operation(pm(e), o.id, op.id, hours=1)
    with pytest.raises(ValidationFailed):
        od.record_check(pm(e), o.id, chk.id, result="CONDITIONAL", measured="101.2")
    assert od.record_check(pm(e), o.id, chk.id, result="CONDITIONAL", measured="101.2", note="Customer concession 4711").result == "CONDITIONAL"
    assert od.complete_operation(pm(e), o.id, op.id, hours=1).status == "DONE"
    with pytest.raises(ValidationFailed) as x:
        od.record_check(pm(e), o.id, chk.id, measured="abc")
    assert codes(x) == "invalid_measurement"


@pytest.mark.django_db
def test_pause_resume_interruptions_and_operation_approval(e):
    o = run_order(e)
    a = pm(e)
    od.issue_all(a, o.id)
    op = o.operations.get()
    with pytest.raises(DomainError):
        ex.pause_operation(a, o.id, op.id, reason="x")  # not started
    od.start_operation(a, o.id, op.id, operator_id=e["pm2"].id)
    with pytest.raises(ValidationFailed):
        ex.pause_operation(a, o.id, op.id, reason=" ")
    ex.pause_operation(a, o.id, op.id, reason="Power cut")
    with pytest.raises(DomainError):
        od.complete_operation(a, o.id, op.id, hours=1)  # paused
    assert an.wip_aging()[0]["blocked"] is True
    ex.resume_operation(a, o.id, op.id)
    with pytest.raises(DomainError):
        ex.resume_operation(a, o.id, op.id)
    assert op.interruptions.get().ended_at is not None
    for c in o.checks.filter(step_sequence=10):
        od.record_check(a, o.id, c.id, result="PASS")
    od.complete_operation(a, o.id, op.id, hours=6, good=4, defective=1, rework=0)
    op.refresh_from_db()
    assert (op.good_quantity, op.defective_quantity) == (D("4"), D("1")) and op.labor_cost == D("120.0000") and op.machine_cost == D("60.0000") and op.overhead_cost == D("30.0000") and op.operator_id == e["pm2"].id
    settings(e, operation_approval_required=True)
    for c in o.checks.filter(step_sequence__isnull=True):
        od.record_check(a, o.id, c.id, result="PASS")
    with pytest.raises(DomainError) as x:
        od.receive_output(a, o.id, quantity=1)
    assert codes(x) == "operation_approval_pending"
    with pytest.raises(DomainError) as x:
        ex.approve_operation(e["pm2"].id, o.id, op.id)  # the operator may not sign it off
    assert codes(x) == "separation_of_duties"
    ex.approve_operation(e["planner"].id, o.id, op.id)
    assert od.receive_output(a, o.id, quantity=1).status == "ACCEPTED"


@pytest.mark.django_db
def test_quality_hold_release_and_scrap(e):
    o = ready_to_receive(e)
    q = quarantine(e)
    r = od.receive_output(pm(e), o.id, quantity=3, quarantine_location_id=q.id)  # no final inspection needed to hold goods
    assert r.status == "ON_HOLD" and inv.on_hand(e["frame"].id, location_id=q.id) == 3 and inv.on_hand(e["frame"].id, location_id=e["loc"].id) == 0
    from modules.inventory import availability as av
    assert av.availability(e["frame"].id)["available"].startswith("0") and av.availability(e["frame"].id)["quarantined"].startswith("3")
    with pytest.raises(ValidationFailed):
        od.receive_output(pm(e), o.id, quantity=1, quarantine_location_id=e["loc"].id)  # not a quarantine location
    r2 = od.receive_output(pm(e), o.id, quantity=2, quarantine_location_id=q.id)
    o.refresh_from_db()
    assert o.status == "COMPLETED"
    with pytest.raises(DomainError) as x:
        od.close_order(pm2(e), o.id)
    assert codes(x) == "goods_on_hold"
    with pytest.raises(DomainError) as x:
        ex.dispose_receipt(pm(e), r.id, decision="RELEASE", note="ok")
    assert codes(x) == "separation_of_duties"
    with pytest.raises(ValidationFailed):
        ex.dispose_receipt(pm2(e), r.id, decision="RELEASE", note="")
    assert ex.dispose_receipt(pm2(e), r.id, decision="RELEASE", note="Re-inspected OK").status == "RELEASED"
    assert inv.on_hand(e["frame"].id, location_id=e["loc"].id) == 3
    ex.dispose_receipt(pm2(e), r2.id, decision="SCRAP", note="Cracked")
    o.refresh_from_db()
    assert o.scrapped_quantity == 2 and o.produced_quantity == 3 and gl("5330") == D("190.0000")  # 2 x 95
    od.close_order(pm2(e), o.id)
    assert gl("1250") == 0


@pytest.mark.django_db
def test_rework_order_cost_goes_to_scrap_loss_and_goods_return(e):
    o = ready_to_receive(e)
    q = quarantine(e)
    r = od.receive_output(pm(e), o.id, quantity=5, quarantine_location_id=q.id)
    ro = ex.dispose_receipt(pm2(e), r.id, decision="REWORK", note="Re-weld")
    assert ro.rework_of_id == o.id and ro.status == "RELEASED" and ro.priority == 1
    with pytest.raises(DomainError) as x:
        od.close_order(pm2(e), o.id)
    assert codes(x) == "goods_on_hold"
    od.issue_material(pm(e), ro.id, product_id=e["bolt"].id, quantity=10, additional=True)  # 5.00
    ex.book_time(pm(e), ro.id, work_center_id=e["wc"].id, hours=2)  # 70.00
    with pytest.raises(DomainError):
        od.receive_output(pm(e), ro.id, quantity=1)
    ex.finish_rework(pm(e), ro.id)
    ro.refresh_from_db()
    assert ro.status == "CLOSED" and ro.scrap_cost == D("75.0000") and gl("5330") == D("75.0000")
    assert inv.on_hand(e["frame"].id, location_id=e["loc"].id) == 5 and inv.on_hand(e["frame"].id, location_id=q.id) == 0
    assert an.rework(S - timedelta(days=60), date.today() + timedelta(days=1))[0]["cost"] == "75.0000"
    od.close_order(pm2(e), o.id)  # now allowed


@pytest.mark.django_db
def test_byproduct_reduces_wip(e):
    scrap_metal = inv.create_product(pm(e), sku="OFFCUT", name="Offcut")
    o = ready_to_receive(e)
    ex.record_byproduct(pm(e), o.id, product_id=scrap_metal.id, quantity=4, unit_cost="2.5", kind="BYPRODUCT")
    assert inv.on_hand(scrap_metal.id) == 4
    o.refresh_from_db()
    assert o.received_value == D("10.0000")
    ex.record_byproduct(pm(e), o.id, product_id=scrap_metal.id, quantity=1, decision="DISPOSE")
    assert inv.on_hand(scrap_metal.id) == 4  # disposed material is not received
    with pytest.raises(ValidationFailed):
        ex.record_byproduct(pm(e), o.id, product_id=scrap_metal.id, quantity=0)


@pytest.mark.django_db
def test_production_plan_check_approve_revise_release(e):
    frame_bom(e)
    a = e["planner"].id
    lines = [{"product": e["frame"].id, "quantity": 10, "required_date": S + timedelta(days=10), "priority": 2}, {"product": e["frame"].id, "quantity": 5, "required_date": S + timedelta(days=5), "priority": 1}]
    plan = pl.create_plan(a, name="Week 46", period_start=S, period_end=S + timedelta(days=13), lines=lines)
    assert plan.number.startswith("PP-") and plan.lines.count() == 2
    with pytest.raises(ValidationFailed):
        pl.create_plan(a, name="bad", period_start=S, period_end=S + timedelta(days=3), lines=[{"product": e["frame"].id, "quantity": 1, "required_date": S + timedelta(days=9)}])
    chk = pl.check_plan(plan)
    assert chk["feasible"] is True and chk["material_shortages"] == []  # 30 steel of 100, 150 bolts of 500
    huge = pl.revise_plan(a, plan.id, lines=[{"product": e["frame"].id, "quantity": 100, "required_date": S + timedelta(days=10)}], reason="Customer volume")
    assert huge.revision == 2 and huge.revisions.get().snapshot[0]["quantity"] in ("10.0000", "5.0000")
    bad = pl.check_plan(huge)
    assert bad["feasible"] is False and bad["material_shortages"][0]["sku"] == "STEEL" and bad["material_shortages"][0]["short"] == "100.0000" and bad["capacity"][0]["bottleneck"] is True
    plan = pl.revise_plan(a, plan.id, lines=lines, reason="Back to original")
    with pytest.raises(DomainError) as x:
        pl.approve_plan(a, plan.id)
    assert codes(x) == "separation_of_duties"
    with pytest.raises(DomainError):
        pl.release_plan(e["pm"].id, plan.id, location_id=e["loc"].id)  # not approved yet
    pl.approve_plan(e["pm"].id, plan.id)
    orders = pl.release_plan(e["pm"].id, plan.id, location_id=e["loc"].id)
    assert [o.priority for o in orders] == [1, 2] and all(o.status == "PLANNED" for o in orders)
    assert orders[0].planned_start >= S and orders[0].plan_line_id is not None
    assert od.release_order(pm(e), orders[0].id).status == "RELEASED"  # a PLANNED order is released like a draft
    with pytest.raises(DomainError):
        pl.revise_plan(a, plan.id, lines=lines, reason="too late")


@pytest.mark.django_db
def test_calendar_conflicts_and_downtime_oee(e):
    frame_bom(e)
    fri = date(2026, 11, 13)
    o = od.create_order(pm(e), product_id=e["frame"].id, quantity=20, location_id=e["loc"].id, planned_start=fri)  # 21 h -> 3 working days
    op = o.operations.get()
    assert (op.planned_start, op.planned_end) == (fri, date(2026, 11, 17)) and o.planned_end == date(2026, 11, 17)  # Fri, (weekend skipped) Mon, Tue
    bs.update_work_center(pm(e), e["wc"].id, working_days=[0, 1, 2, 3, 4, 5, 6])
    o2 = od.create_order(pm(e), product_id=e["frame"].id, quantity=20, location_id=e["loc"].id, planned_start=fri)
    assert o2.planned_end == date(2026, 11, 15)
    with pytest.raises(ValidationFailed):
        bs.update_work_center(pm(e), e["wc"].id, working_days=[9])
    # two orders over the same days exceed 8 h/day
    cf = pl.conflicts(fri, date(2026, 11, 20))
    assert cf and cf[0]["work_center"] == "WELD" and D(cf[0]["planned_hours"]) > D(cf[0]["capacity_hours"])
    # downtime and OEE
    done = ready_to_receive(e)
    start = datetime.now(dtz.utc) - timedelta(hours=3)
    d = ex.record_downtime(e["pm"].id, work_center_id=e["wc"].id, category="BREAKDOWN", reason="Bearing", started_at=start, ended_at=start + timedelta(hours=2))
    assert d.minutes == 120
    open_d = ex.record_downtime(e["pm"].id, work_center_id=e["wc"].id, category="SETUP", reason="Changeover", started_at=datetime.now(dtz.utc) - timedelta(minutes=30))
    assert ex.end_downtime(e["pm"].id, open_d.id).ended_at is not None
    with pytest.raises(DomainError):
        ex.end_downtime(e["pm"].id, open_d.id)
    with pytest.raises(ValidationFailed):
        ex.record_downtime(e["pm"].id, work_center_id=e["wc"].id, category="NAP", reason="x", started_at=start)
    with pytest.raises(DomainError) as x:
        ex.request_maintenance(e["pm"].id, work_center_id=e["wc"].id, symptoms="Noise")
    assert codes(x) == "no_asset"
    today = date.today()
    rep = an.downtime(today - timedelta(days=1), today + timedelta(days=1))
    assert rep[0]["work_center"] == "WELD" and rep[0]["by_category"]["BREAKDOWN"] == 120
    oee = an.oee(today - timedelta(days=1), today + timedelta(days=1))[0]
    assert D(oee["performance_pct"]) == D("100.0000") and D(oee["quality_pct"]) == D("100.0000") and D(oee["availability_pct"]) < D("100")
    od.release_order(pm(e), o.id)
    assert [x.number for x in ex.affected_orders(e["wc"].id)] == [o.number]


@pytest.mark.django_db
def test_reports_cost_output_and_ontime(e):
    o = ready_to_receive(e)
    od.record_check(pm(e), o.id, o.checks.get(step_sequence__isnull=True).id, result="PASS")
    od.receive_output(pm(e), o.id, quantity=5)
    od.close_order(pm2(e), o.id)
    a, b = S - timedelta(days=30), date.today() + timedelta(days=30)
    cost = an.cost_report(a, b)[0]
    assert cost["product"] == "FRAME" and cost["material"] == "125.0000" and cost["labor"] == "120.0000" and cost["machine"] == "60.0000" and cost["overhead"] == "30.0000" and cost["variance"] == "-140.0000" and cost["unit_cost"] == "67.0000"
    assert an.output(a, b)[0] == {"product": "FRAME", "good": "5.0000", "rejected": "0", "scrapped": "0"}
    assert an.order_status(a, b) == {"CLOSED": 1}
    assert an.on_time(a, b)["completed"] == 1
    assert an.labor_productivity(a, b)[0]["units_per_hour"] == "0.8333"
    assert an.plan_vs_actual(a, b)[0]["qty_attainment_pct"] == "100.0000"
    assert an.efficiency(a, b)["operations"] == 1
    assert an.utilization(a, b)[0]["work_center"] == "WELD"
    assert an.by_line(a, b)[0]["line"] == "(no line)"
    assert an.quality_rejection(a, b)["checks_failed"] == 0


@pytest.mark.django_db
def test_http_extension_permissions(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        e = make_env(tenant)
        aud = user(tenant, "audm2@acme.test", "read_only_auditor")
        for key, u in (("pm", e["pm"]), ("pm2", e["pm2"]), ("planner", e["planner"]), ("aud", aud)):
            ExternalIdentity.objects.create(user=u, issuer="https://kc.test/realms/erp", subject=f"mx-{key}")
        frame_bom(e)
    api = {}
    for key in ("pm", "pm2", "planner", "aud"):
        api[key] = Api(ACME_HOST)
        assert api[key].login(idp, f"mx-{key}").status_code == 302
    body = {"name": "W47", "period_start": "2026-11-16", "period_end": "2026-11-27", "lines": [{"product": str(e["frame"].id), "quantity": "3", "required_date": "2026-11-20"}]}
    assert api["aud"].post("/api/v1/manufacturing/plans", body).status_code == 403
    r = api["planner"].post("/api/v1/manufacturing/plans", body)
    assert r.status_code == 201
    pid = r.json()["id"]
    assert api["aud"].get(f"/api/v1/manufacturing/plans/{pid}/check").status_code == 200
    assert api["pm"].post(f"/api/v1/manufacturing/plans/{pid}/approve").status_code == 403  # no plan.approve
    assert api["planner"].post(f"/api/v1/manufacturing/plans/{pid}/approve").status_code == 403  # own plan: separation of duties
    assert api["pm"].post("/api/v1/manufacturing/lines", {"code": "L1", "name": "Line 1"}).status_code == 201
    assert api["aud"].post("/api/v1/manufacturing/lines", {"code": "L2", "name": "x"}).status_code == 403
    assert api["pm"].post("/api/v1/manufacturing/downtime", {"work_center": str(e["wc"].id), "category": "SETUP", "reason": "Changeover"}).status_code == 201
    assert api["aud"].post("/api/v1/manufacturing/downtime", {"work_center": str(e["wc"].id), "category": "SETUP", "reason": "x"}).status_code == 403
    assert api["aud"].get("/api/v1/manufacturing/downtime").status_code == 200
    qs = "?from=2026-11-01&to=2026-11-30"
    for name in ("oee", "cost", "consumption", "downtime", "utilization", "bottlenecks"):
        assert api["aud"].get(f"/api/v1/manufacturing/analytics/{name}{qs}").status_code == 200
    assert api["aud"].get(f"/api/v1/manufacturing/analytics/nope{qs}").status_code == 404
    assert api["aud"].get("/api/v1/manufacturing/reports/wip-aging").status_code == 200
    assert api["pm"].post("/api/v1/manufacturing/orders", {"product": str(e["frame"].id), "quantity": "1", "location": str(e["loc"].id), "planned_start": "2026-11-16"}).status_code == 201

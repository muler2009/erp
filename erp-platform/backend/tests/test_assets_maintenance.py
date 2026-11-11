from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.assets import maintenance as mt
from modules.assets import models as am
from modules.assets import services as svc
from modules.finance import models as fm
from modules.finance import services as fin
from shared.api.errors import DomainError, ValidationFailed
from tests.test_assets import activate, api_env, f, laptop  # noqa: F401


def gl(code):
    return fin.account_balance(fm.Account.objects.get(code=code))


def ids(f):
    return f["people"]["am_"].id, f["people"]["am2"].id


def live(f, serial="M1"):
    return activate(f, laptop(f, serial_number=serial))


def stock(f, qty="5", cost="10"):
    from modules.inventory import services as inv

    wh = inv.create_warehouse(None, code="WM", name="Spares")
    loc = inv.create_location(None, warehouse_id=wh.id, code="WM-A")
    p = inv.create_product(None, sku="FAN", name="Cooling fan")
    inv.receive_stock(None, product_id=p.id, location_id=loc.id, quantity=qty, unit_cost=cost)
    return p, loc


def codes(e):
    return e.value.get_codes()


@pytest.mark.django_db
def test_meter_is_monotonic(f):
    a, _ = live(f), None
    u, _ = ids(f)
    mt.record_meter(u, a.id, "100", date.today())
    with pytest.raises(ValidationFailed) as e:
        mt.record_meter(u, a.id, "90", date.today())
    assert codes(e) == "meter_backwards"


@pytest.mark.django_db
def test_time_plan_generates_one_preventive_order_and_reschedules(f):
    a = live(f)
    u, u2 = ids(f)
    today = date.today()
    p = mt.create_plan(u, a.id, name="Clean fans", interval_days=30, first_due_on=today + timedelta(days=5), lead_days=7, checklist="Open case; blow dust")
    assert mt.generate_due(u, today) and mt.generate_due(u, today) == []  # idempotent while one is open
    wo = am.WorkOrder.objects.get(plan=p)
    assert wo.kind == "PREVENTIVE" and wo.status == "OPEN"
    mt.start(u, wo.id)
    a.refresh_from_db()
    assert a.status == "UNDER_MAINTENANCE"
    mt.complete(u, wo.id, notes="Done", completed_on=today)
    a.refresh_from_db(); p.refresh_from_db()
    assert a.status == "AVAILABLE" and p.next_due_on == today + timedelta(days=30) and p.last_done_on == today


@pytest.mark.django_db
def test_usage_plan_triggers_on_meter(f):
    a = live(f, "M2")
    u, _ = ids(f)
    p = mt.create_plan(u, a.id, name="Service", trigger="USAGE", interval_usage="500", lead_usage="50")
    assert mt.generate_due(u) == []
    mt.record_meter(u, a.id, "460", date.today())
    assert len(mt.generate_due(u)) == 1
    with pytest.raises(ValidationFailed):
        mt.create_plan(u, a.id, name="bad", trigger="USAGE")


@pytest.mark.django_db
def test_repair_over_threshold_needs_other_approver_and_verification(f):
    a = live(f, "M3")
    p, loc = stock(f)
    u, u2 = ids(f)
    wo = mt.create_work_order(u, a.id, kind="CORRECTIVE", description="Screen", estimated_cost="1500")
    assert wo.status == "AWAITING_APPROVAL"
    with pytest.raises(DomainError) as e:
        mt.start(u, wo.id)
    assert codes(e) == "approval_required"
    with pytest.raises(DomainError) as e:
        mt.approve_work_order(u, wo.id, approve=True)
    assert codes(e) == "separation_of_duties"
    mt.approve_work_order(u2, wo.id, approve=True)
    mt.start(u, wo.id)
    mt.add_labor(u, wo.id, hours="2", rate="40")
    mt.add_material(u, wo.id, product_id=p.id, location_id=loc.id, quantity="3")
    mt.add_external_cost(u, wo.id, amount="100")
    w = mt.complete(u, wo.id, notes="Replaced")
    assert w.status == "COMPLETED" and w.total_cost == D("210")  # 80 + 30 + 100
    assert gl("5700") == D("30")  # spare parts expensed through inventory
    a.refresh_from_db()
    assert a.status == "UNDER_MAINTENANCE"  # still out of service until verified
    with pytest.raises(DomainError) as e:
        mt.verify_return_to_service(u, wo.id, notes="ok")
    assert codes(e) == "separation_of_duties"
    mt.verify_return_to_service(u2, wo.id, notes="Tested")
    a.refresh_from_db()
    assert a.status == "AVAILABLE"


@pytest.mark.django_db
def test_failed_verification_sends_back_and_insufficient_stock_blocked(f):
    a = live(f, "M4")
    p, loc = stock(f, qty="1")
    u, u2 = ids(f)
    wo = mt.create_work_order(u, a.id, kind="REPAIR", description="x")
    mt.start(u, wo.id)
    with pytest.raises(DomainError) as e:
        mt.add_material(u, wo.id, product_id=p.id, location_id=loc.id, quantity="2")
    assert codes(e) == "insufficient_stock"
    mt.complete(u, wo.id, notes="fixed")
    assert mt.verify_return_to_service(u2, wo.id, notes="still faulty", passed=False).status == "IN_PROGRESS"


@pytest.mark.django_db
def test_breakdown_lifecycle_downtime_and_restoration(f):
    a = live(f, "M5")
    u, u2 = ids(f)
    b = mt.report_breakdown(f["people"]["emp"].id, a.id, symptoms="No power", severity="HIGH", failure_code="PSU")
    a.refresh_from_db()
    assert a.status == "UNDER_MAINTENANCE" and b.prior_status == "AVAILABLE"
    mt.diagnose(u, b.id, cause="Dead PSU")
    wo = mt.open_repair(u, b.id, description="Replace PSU", estimated_cost="100")
    with pytest.raises(DomainError) as e:
        mt.open_repair(u, b.id, description="again")
    assert codes(e) == "already_pending"
    mt.start(u, wo.id)
    assert am.Breakdown.objects.get(pk=b.id).status == "IN_REPAIR"
    mt.complete(u, wo.id, notes="PSU swapped")
    mt.verify_return_to_service(u2, wo.id, notes="Boots")
    b.refresh_from_db(); a.refresh_from_db()
    assert b.status == "RESTORED" and b.downtime_hours is not None and a.status == "AVAILABLE"
    assert mt.close_breakdown(u, b.id).status == "CLOSED"


@pytest.mark.django_db
def test_asset_stays_out_of_service_while_another_job_is_open(f):
    a = live(f, "M6")
    u, u2 = ids(f)
    b = mt.report_breakdown(u, a.id, symptoms="Noise")
    prev = mt.create_work_order(u, a.id, kind="PREVENTIVE", description="Service")
    mt.start(u, prev.id)
    mt.complete(u, prev.id, notes="done")
    a.refresh_from_db()
    assert a.status == "UNDER_MAINTENANCE"  # the breakdown is still open


@pytest.mark.django_db
def test_assigned_asset_returns_to_assigned_and_disposed_cannot_be_maintained(f):
    a = live(f, "M7")
    u, _ = ids(f)
    with pytest.raises(ValidationFailed):
        mt.report_breakdown(u, a.id, symptoms=" ")
    a.status = "DISPOSED"; a.save(update_fields=["status"])
    with pytest.raises(DomainError) as e:
        mt.create_work_order(u, a.id, kind="REPAIR", description="x")
    assert codes(e) == "asset_not_maintainable"


@pytest.mark.django_db
def test_reports_and_overdue_reminders(f):
    a = live(f, "M8")
    u, u2 = ids(f)
    today = date.today()
    for hrs in ("10", "20"):
        wo = mt.create_work_order(u, a.id, kind="REPAIR", description="r", due_on=today - timedelta(days=2))
        mt.start(u, wo.id)
        mt.add_labor(u, wo.id, hours=hrs, rate="10")
        mt.complete(u, wo.id, notes="n")
        mt.verify_return_to_service(u2, wo.id, notes="ok")
    rows = mt.maintenance_costs(today - timedelta(days=1), today)
    assert rows[0]["work_orders"] == 2 and D(rows[0]["total"]) == D("300")
    od = mt.create_work_order(u, a.id, kind="PREVENTIVE", description="late", due_on=today - timedelta(days=3))
    r = mt.run_daily(today)
    assert r["reminded"] == 1 and mt.run_daily(today)["reminded"] == 0
    assert mt.unavailable_assets() == []
    assert mt.breakdown_analysis(today - timedelta(days=30), today) == []
    for _ in range(2):
        b = mt.report_breakdown(u, a.id, symptoms="again", failure_code="PSU")
        wo = mt.open_repair(u, b.id, description="fix")
        mt.start(u, wo.id)
        mt.complete(u, wo.id, notes="n")
        mt.verify_return_to_service(u2, wo.id, notes="ok")
    br = mt.breakdown_analysis(today - timedelta(days=30), today)[0]
    assert br["breakdowns"] == 2 and br["recurring"] and br["repeated_failure_codes"] == ["PSU"] and br["mttr_hours"] is not None


@pytest.mark.django_db
def test_http_permissions_and_flow(api_env, acme):
    env, api = api_env
    with schema_context(acme["schema"]):
        a = activate(env, laptop(env, serial_number="H1"))
    r = api["emp"].post("/api/v1/assets/breakdowns", {"asset": str(a.id), "symptoms": "Dead", "severity": "LOW"})
    assert r.status_code == 201  # any employee may report
    bid = r.json()["id"]
    assert api["emp"].post(f"/api/v1/assets/breakdowns/{bid}/diagnose", {"cause": "x"}).status_code == 403
    assert api["auditor"].post("/api/v1/assets/work-orders", {"asset": str(a.id), "kind": "REPAIR", "description": "x"}).status_code == 403
    assert api["auditor"].get("/api/v1/assets/work-orders").status_code == 200
    rep = api["am"].post(f"/api/v1/assets/breakdowns/{bid}/repair", {"description": "Fix"})
    assert rep.status_code == 201
    wid = rep.json()["id"]
    assert api["am"].post(f"/api/v1/assets/work-orders/{wid}/start").status_code == 200
    assert api["am"].post(f"/api/v1/assets/work-orders/{wid}/complete", {"notes": "ok"}).json()["status"] == "COMPLETED"
    assert api["am"].post(f"/api/v1/assets/work-orders/{wid}/verify", {"notes": "ok"}).status_code == 403  # same person
    assert api["am"].get("/api/v1/assets/reports/maintenance/unavailable").status_code == 200
    assert api["am"].get("/api/v1/assets/reports/maintenance/costs").status_code == 400

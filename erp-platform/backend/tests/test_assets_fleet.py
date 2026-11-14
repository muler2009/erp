import uuid
from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.assets import allocation as al
from modules.assets import fleet as fl
from modules.assets import maintenance as mt
from modules.assets import models as am
from modules.assets import services as svc
from modules.assets import warranty as wt
from modules.hr import services as hr
from shared.api.errors import DomainError, ValidationFailed
from tests.test_assets import activate, api_env, f, laptop  # noqa: F401

TODAY = date.today()


def codes(e):
    return e.value.get_codes()


def live(f, serial="A1"):
    return activate(f, laptop(f, serial_number=serial))


def car(f, serial="V1"):
    return activate(f, laptop(f, serial_number=serial, category_id=f["veh"].id, name="Pickup"))


@pytest.mark.django_db
def test_shared_allocation_cannot_exceed_100_percent(f):
    a = live(f)
    u = f["people"]["am_"].id
    p1, p2, p3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    al.allocate(u, a.id, target_kind="COST_CENTER", target_id=p1, start_on=TODAY, share_percent=60)
    al.allocate(u, a.id, target_kind="COST_CENTER", target_id=p2, start_on=TODAY, share_percent=40)
    with pytest.raises(DomainError) as e:
        al.allocate(u, a.id, target_kind="COST_CENTER", target_id=p3, start_on=TODAY, share_percent=10)
    assert codes(e) == "over_allocated"
    with pytest.raises(DomainError) as e:
        al.allocate(u, a.id, target_kind="COST_CENTER", target_id=p1, start_on=TODAY, share_percent=1)
    assert codes(e) == "already_pending"
    first = am.AssetAllocation.objects.get(target_id=p1)
    al.end_allocation(u, first.id, TODAY)
    al.allocate(u, a.id, target_kind="COST_CENTER", target_id=p3, start_on=TODAY, share_percent=60)  # freed share
    with pytest.raises(ValidationFailed):
        al.allocate(u, a.id, target_kind="TEAM", target_id=p1, start_on=TODAY)
    with pytest.raises(DomainError) as e:
        al.end_allocation(u, first.id, TODAY)
    assert codes(e) == "invalid_state"


@pytest.mark.django_db
def test_allocation_requires_asset_in_service(f):
    a = laptop(f, serial_number="NOTYET")
    with pytest.raises(DomainError) as e:
        al.allocate(f["people"]["am_"].id, a.id, target_kind="DEPARTMENT", target_id=uuid.uuid4(), start_on=TODAY)
    assert codes(e) == "asset_not_allocatable"


@pytest.mark.django_db
def test_usage_rules_and_utilization_flags(f):
    busy, idle, light = live(f, "U1"), live(f, "U2"), live(f, "U3")
    u = f["people"]["am_"].id
    proj = uuid.uuid4()
    a1 = al.allocate(u, busy.id, target_kind="COST_CENTER", target_id=proj, start_on=TODAY - timedelta(days=5), end_on=TODAY)
    for d in range(5):
        al.log_usage(u, busy.id, logged_on=TODAY - timedelta(days=d), hours=8, allocation_id=a1.id)
    al.log_usage(u, light.id, logged_on=TODAY, hours=1)
    with pytest.raises(DomainError) as e:
        al.log_usage(u, busy.id, logged_on=TODAY, hours=17)
    assert codes(e) == "over_24_hours"
    with pytest.raises(DomainError) as e:
        al.log_usage(u, busy.id, logged_on=TODAY + timedelta(days=3), hours=1, allocation_id=a1.id)
    assert codes(e) == "outside_allocation"
    with pytest.raises(ValidationFailed):
        al.log_usage(u, busy.id, logged_on=TODAY, hours=0)
    with pytest.raises(ValidationFailed) as e:
        al.log_usage(u, idle.id, logged_on=TODAY, hours=1, allocation_id=a1.id)
    assert codes(e) == "invalid_allocation"
    rep = al.utilization_report(TODAY - timedelta(days=4), TODAY)
    by = {r["asset"]: r for r in rep["rows"]}
    assert by[busy.number]["utilization_percent"] == "100.00" and by[idle.number]["idle"] and by[light.number]["underutilized"]
    assert rep["idle"] == 1 and rep["underutilized"] == 1
    assert al.project_usage(TODAY - timedelta(days=4), TODAY) == [{"target_kind": "COST_CENTER", "target_id": str(proj), "hours": "40.0000"}]
    assert al.end_all_for_asset(u, busy.id, TODAY) == 1


@pytest.mark.django_db
def test_vehicle_registration_driver_fuel_and_cost_report(f):
    c = car(f)
    laptop_asset = live(f, "NV")
    u = f["people"]["am_"].id
    with pytest.raises(ValidationFailed) as e:
        fl.register_vehicle(u, laptop_asset.id, plate_number="AA-1")
    assert codes(e) == "not_a_vehicle"
    v = fl.register_vehicle(u, c.id, plate_number=" aa-123 ", registration_expiry=TODAY + timedelta(days=10))
    assert v.plate_number == "AA-123"
    with pytest.raises(DomainError) as e:
        fl.register_vehicle(u, c.id, plate_number="AA-999")
    assert codes(e) == "duplicate_code"
    emp = hr.create_employee(None, first_name="Dawit", last_name="K", hire_date=date(2026, 1, 1))
    with pytest.raises(DomainError) as e:
        fl.assign_driver(u, v.id, emp.id, TODAY - timedelta(days=1))
    assert codes(e) == "licence_expired"
    fl.assign_driver(u, v.id, emp.id, TODAY + timedelta(days=365))
    fl.log_fuel(u, v.id, filled_on=TODAY - timedelta(days=20), liters="40", cost="60", odometer="1000")
    fl.log_fuel(u, v.id, filled_on=TODAY - timedelta(days=10), liters="40", cost="60", odometer="1400")
    with pytest.raises(ValidationFailed) as e:
        fl.log_fuel(u, v.id, filled_on=TODAY, liters="10", cost="10", odometer="1300")
    assert codes(e) == "meter_backwards"
    assert fl.fuel_efficiency(v.id)[0]["km_per_liter"] == "10.00"
    wo = mt.create_work_order(u, c.id, kind="PREVENTIVE", description="Service")
    mt.start(u, wo.id)
    mt.add_labor(u, wo.id, hours="2", rate="20")
    mt.complete(u, wo.id, notes="ok")
    row = fl.fleet_cost_report(TODAY - timedelta(days=30), TODAY)[0]
    assert D(row["fuel_cost"]) == 120 and D(row["maintenance_cost"]) == 40 and D(row["km"]) == 400 and D(row["cost_per_km"]) == D("0.4")


@pytest.mark.django_db
def test_expiry_alerts_insurance_and_reminders(f):
    c = car(f, "V2")
    u = f["people"]["am_"].id
    v = fl.register_vehicle(u, c.id, plate_number="BB-1", registration_expiry=TODAY + timedelta(days=5))
    items = {i["item"] for i in fl.expiries()[0]["issues"]}
    assert items == {"REGISTRATION", "INSURANCE"}
    wt.create_policy(u, policy_number="V-POL", insurer="x", start_on=TODAY - timedelta(days=1), end_on=TODAY + timedelta(days=300), asset_ids=[c.id])
    assert {i["item"] for i in fl.expiries()[0]["issues"]} == {"REGISTRATION"}
    assert fl.run_reminders(TODAY) == 1 and fl.run_reminders(TODAY) == 0
    fl.renew_registration(u, v.id, TODAY + timedelta(days=365))
    assert fl.expiries() == []
    with pytest.raises(ValidationFailed):
        fl.renew_registration(u, v.id, TODAY)


@pytest.mark.django_db
def test_incidents_and_electric_fuel_rule(f):
    c = car(f, "V3")
    u = f["people"]["am_"].id
    v = fl.register_vehicle(u, c.id, plate_number="EV-1", fuel_type="ELECTRIC")
    with pytest.raises(DomainError) as e:
        fl.log_fuel(u, v.id, filled_on=TODAY, liters="1", cost="1", odometer="1")
    assert codes(e) == "invalid_fuel"
    i = fl.report_incident(u, v.id, occurred_on=TODAY, description="Scratch", damage_cost="50")
    with pytest.raises(ValidationFailed):
        fl.report_incident(u, v.id, occurred_on=TODAY, description="x", severity="HUGE")
    assert fl.close_incident(u, i.id).status == "CLOSED"
    with pytest.raises(DomainError):
        fl.close_incident(u, i.id)


@pytest.mark.django_db
def test_http_permissions(api_env, acme):
    env, api = api_env
    with schema_context(acme["schema"]):
        a = activate(env, laptop(env, serial_number="HF1", category_id=env["veh"].id))
    body = {"asset": str(a.id), "plate_number": "H-1"}
    assert api["emp"].post("/api/v1/assets/vehicles", body).status_code == 403
    assert api["auditor"].post("/api/v1/assets/vehicles", body).status_code == 403
    r = api["am"].post("/api/v1/assets/vehicles", body)
    assert r.status_code == 201
    vid = r.json()["id"]
    assert api["am"].post(f"/api/v1/assets/vehicles/{vid}/fuel", {"liters": "10", "cost": "15", "odometer": "100"}).status_code == 201
    assert api["auditor"].get("/api/v1/assets/vehicles").status_code == 200
    assert api["emp"].post("/api/v1/assets/allocations", {"asset": str(a.id)}).status_code == 403
    ok = api["am"].post("/api/v1/assets/allocations", {"asset": str(a.id), "target_kind": "DEPARTMENT", "target_id": str(uuid.uuid4()), "share_percent": "50"})
    assert ok.status_code == 201
    assert api["am"].post(f"/api/v1/assets/assets/{a.id}/usage", {"hours": "30"}).status_code == 400
    assert api["am"].get("/api/v1/assets/reports/usage/utilization").status_code == 400
    inc = api["am"].post(f"/api/v1/assets/vehicles/{vid}/incidents", {"description": "Scraped a gate", "severity": "MINOR", "damage_cost": "40"})
    assert inc.status_code == 201
    listed = api["auditor"].get(f"/api/v1/assets/vehicles/{vid}/info/incidents").json()["results"]  # incidents can be found again to close them
    assert [(i["id"], i["status"], i["damage_cost"]) for i in listed] == [(inc.json()["id"], "OPEN", "40.0000")]
    assert api["emp"].get(f"/api/v1/assets/vehicles/{vid}/info/incidents").status_code == 403
    assert api["am"].post(f"/api/v1/assets/incidents/{inc.json()['id']}/close").status_code == 200
    assert api["auditor"].get(f"/api/v1/assets/vehicles/{vid}/info/incidents").json()["results"][0]["status"] == "CLOSED"

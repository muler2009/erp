from datetime import date
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.assets import models as am
from modules.assets import models as m
from modules.assets import services as svc
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from tests.conftest import ACME_HOST, Api
from tests.test_finance import prepare, user

D0 = date(2026, 3, 15)


def master(tenant, env):
    env["people"].update(am_=user(tenant, f"am@{tenant.slug}.test", "asset_manager"), am2=user(tenant, f"am2@{tenant.slug}.test", "asset_manager"), emp=user(tenant, f"aemp@{tenant.slug}.test", "employee"), auditor=user(tenant, f"aaud@{tenant.slug}.test", "read_only_auditor"))
    env["cat"] = svc.create_category(None, code="IT", name="IT equipment", asset_class="IT", capitalization_threshold="500", useful_life_months=36, residual_percent="10", requires_serial=True)
    env["veh"] = svc.create_category(None, code="VEH", name="Vehicles", asset_class="VEHICLE", prefix="V", depreciation_method="RB", reducing_rate_percent="20", tracking="RFID")
    env["loc"] = svc.create_location(None, code="HQ", name="Head office")
    env["loc2"] = svc.create_location(None, code="BR1", name="Branch 1")
    return env


@pytest.fixture
def f(acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        yield master(tenant, prepare(tenant))


@pytest.fixture
def api_env(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = master(tenant, prepare(tenant))
    apis = {}
    for key, uk in (("am", "am_"), ("emp", "emp"), ("auditor", "auditor")):
        ExternalIdentity.objects.create(user=env["people"][uk], issuer="https://kc.test/realms/erp", subject=f"as-{key}-sub")
        apis[key] = Api(ACME_HOST)
        assert apis[key].login(idp, f"as-{key}-sub").status_code == 302
    return env, apis


def laptop(f, **kw):
    a = dict(category_id=f["cat"].id, name="Laptop", manufacturer="Dell", model="X1", serial_number="SN1", purchase_cost="1200", location_id=f["loc"].id)
    a.update(kw)
    return svc.create_asset(f["people"]["am_"].id, **a)


def activate(f, a, cost=None, source="OPENING", day=D0):
    """Take a requested asset through acquisition, acceptance, commissioning and approved capitalization."""
    from modules.assets import acquisition as acq

    u, u2 = f["people"]["am_"].id, f["people"]["am2"].id
    acq.record_acquisition(u, a.id, source=source, cost=cost or a.purchase_cost or "1000", reference_note="Opening balance import", delivered_on=day)
    acq.accept_delivery(u, a.id, delivered_on=day)
    acq.commission(u, a.id, passed=True, on_date=day)
    req = acq.request_capitalization(u, a.id, capitalization_date=day)
    acq.approve_capitalization(u2, req.id)
    a.refresh_from_db()
    return a


@pytest.mark.django_db
def test_numbering_identification_and_uniqueness(f):
    a, b = laptop(f), laptop(f, serial_number="SN2")
    assert (a.number, b.number) == ("IT-000001", "IT-000002")
    assert a.barcode == a.number and a.qr_code == "AST:IT-000001" and a.status == "REQUESTED" and a.asset_class == "IT"
    with pytest.raises(DomainError) as e:
        laptop(f)  # same manufacturer/model/serial
    assert e.value.get_codes() == "identifier_taken"
    with pytest.raises(DomainError):
        laptop(f, serial_number="SN3", rfid_tag="R1")
        laptop(f, serial_number="SN4", rfid_tag="R1")
    assert svc.find_by_code("AST:IT-000002").id == b.id and svc.find_by_code("R1").serial_number == "SN3"
    with pytest.raises(DomainError):
        svc.find_by_code("nope")
    v = svc.create_asset(None, category_id=f["veh"].id, name="Truck")
    assert v.number == "V-000001" and v.asset_class == "VEHICLE"
    with pytest.raises(ValidationFailed) as e:
        svc.create_asset(None, category_id=f["veh"].id, name="Truck 2", status="RECEIVED")
    assert e.value.get_codes() == "rfid_required"
    with pytest.raises(ValidationFailed):
        svc.create_asset(None, category_id=f["cat"].id, name="No serial", status="RECEIVED")
    with pytest.raises(ValidationFailed):
        svc.create_asset(None, category_id=f["cat"].id, name="x", status="AVAILABLE")


@pytest.mark.django_db
def test_lifecycle_and_history_are_immutable(f):
    u = f["people"]["am_"].id
    a = laptop(f)
    with pytest.raises(DomainError):
        svc.set_status(u, a.id, "AVAILABLE", manual=True)  # not received yet
    svc.set_status(u, a.id, "ORDERED", manual=True)
    svc.set_status(u, a.id, "RECEIVED", manual=True)
    with pytest.raises(DomainError) as e:
        svc.set_status(u, a.id, "AVAILABLE", manual=True)
    assert e.value.get_codes() == "capitalization_required"
    from modules.assets import acquisition as acq
    acq.record_acquisition(u, a.id, source="OPENING", cost="1200", reference_note="Opening balance")
    req = m.CapitalizationRequest.objects.create(number="CAP-T", asset=a, capitalize=True, total_cost=1200, capitalization_date=D0, requested_by=u, status="APPROVED")
    svc.set_status(u, a.id, "AVAILABLE", manual=True)
    with pytest.raises(DomainError):
        svc.set_status(u, a.id, "DISPOSED", manual=True)  # only the disposal process may do this
    with pytest.raises(ValidationFailed):
        svc.set_status(u, a.id, "RETIRED", manual=True)
    svc.set_status(u, a.id, "RETIRED", reason="Obsolete", manual=True)
    events = [h["event"] for h in svc.history(a.id)]
    assert events == ["REGISTERED", "STATUS_CHANGED", "STATUS_CHANGED", "ACQUISITION_RECORDED", "STATUS_CHANGED", "STATUS_CHANGED"]
    with pytest.raises(RuntimeError):
        am.AssetHistory.objects.first().delete()
    h = am.AssetHistory.objects.first()
    h.note = "x"
    with pytest.raises(RuntimeError):
        h.save()


@pytest.mark.django_db
def test_update_tracks_ownership_and_locks_cost(f):
    u = f["people"]["am_"].id
    a = laptop(f)
    dept = f["people"]["emp"].id
    svc.update_asset(u, a.id, custodian_id=dept, location_id=f["loc2"].id, description="Spare")
    ev = [(h["event"], h["detail"].get("field")) for h in svc.history(a.id)][1:]
    assert ("OWNERSHIP_CHANGED", "custodian_id") in ev and ("OWNERSHIP_CHANGED", "location_id") in ev and ("UPDATED", "description") in ev
    with pytest.raises(DomainError) as e:
        svc.update_asset(u, a.id, expected_version=99, name="x")
    assert e.value.get_codes() == "version_conflict"
    activate(f, a)
    with pytest.raises(DomainError) as e:
        svc.update_asset(u, a.id, purchase_cost="1")
    assert e.value.get_codes() == "cost_locked"
    with pytest.raises(ValidationFailed):
        svc._clean_asset({"bogus": 1})


@pytest.mark.django_db
def test_category_rules(f):
    with pytest.raises(ValidationFailed):
        svc.create_category(None, code="X", name="x", depreciation_method="ZZ")
    with pytest.raises(ValidationFailed):
        svc.create_category(None, code="X", name="x", prefix="bad prefix")
    with pytest.raises(ValidationFailed):
        svc.create_category(None, code="X", name="x", residual_percent="150")
    child = svc.create_category(None, code="LAP", name="Laptops", parent_id=f["cat"].id)
    with pytest.raises(ValidationFailed) as e:
        svc.update_category(None, f["cat"].id, parent_id=child.id)
    assert e.value.get_codes() == "category_cycle"
    with pytest.raises(DomainError):
        svc.create_category(None, code="IT", name="dup")


@pytest.mark.django_db
def test_assets_over_http_permissions(api_env):
    env, api = api_env
    body = {"category": str(env["cat"].id), "name": "Printer", "serial_number": "P1", "purchase_cost": "300"}
    assert api["emp"].post("/api/v1/assets/assets", body).status_code == 403
    assert api["auditor"].post("/api/v1/assets/assets", body).status_code == 403
    assert api["emp"].get("/api/v1/assets/assets").status_code == 403
    r = api["am"].post("/api/v1/assets/assets", body)
    assert r.status_code == 201 and r.json()["number"] == "IT-000001"
    aid = r.json()["id"]
    assert api["auditor"].get("/api/v1/assets/assets").status_code == 200
    assert api["auditor"].get(f"/api/v1/assets/assets/{aid}/history").status_code == 200
    assert api["auditor"].patch(f"/api/v1/assets/assets/{aid}", {"name": "x"}).status_code == 403
    assert api["am"].get("/api/v1/assets/lookup?code=AST:IT-000001").json()["id"] == aid
    assert api["am"].get("/api/v1/assets/assets?q=printer").json()["results"][0]["id"] == aid
    assert api["am"].post(f"/api/v1/assets/assets/{aid}/status", {"status": "AVAILABLE"}).status_code == 409
    assert api["auditor"].post("/api/v1/assets/categories", {"code": "Z", "name": "z"}).status_code == 403
    assert api["am"].post("/api/v1/assets/categories", {"code": "Z", "name": "z", "depreciation_method": "bad"}).status_code == 400
    assert api["emp"].get(f"/api/v1/assets/assets/{aid}/label").status_code == 403

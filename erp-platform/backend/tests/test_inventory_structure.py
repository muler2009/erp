from decimal import Decimal as D

import pytest

from modules.inventory import structure
from modules.inventory import services as inv
from platform_core.authorization.models import RoleAssignment, RoleDefinition
from shared.api.errors import DomainError, ValidationFailed
from tests.test_inventory import D0, api_env, f, recv  # noqa: F401


@pytest.mark.django_db
def test_location_hierarchy_kinds_and_validation(f):
    wh = inv.create_warehouse(None, code="N1", name="North", warehouse_type="BRANCH", policies={"picking": "FEFO"}, address="1 Road")
    loc = inv.create_location(None, warehouse_id=wh.id, code="Z1-A2-R3-S4-B5", zone="Z1", aisle="A2", rack="R3", shelf="S4", bin="B5", capacity="50")
    assert (loc.zone, loc.bin, loc.kind, loc.capacity) == ("Z1", "B5", "STORAGE", D("50"))
    for bad in ({"kind": "NOWHERE"}, {"capacity": "0"}, {"capacity": "abc"}, {"bogus": 1}):
        with pytest.raises(ValidationFailed):
            inv.create_location(None, warehouse_id=wh.id, code="X" + str(len(str(bad))), **bad)
    with pytest.raises(ValidationFailed):
        inv.create_warehouse(None, code="N2", name="x", warehouse_type="MOON")
    with pytest.raises(ValidationFailed):
        inv.create_warehouse(None, code="N3", name="x", policies={"picking": "RANDOM"})


@pytest.mark.django_db
def test_capacity_and_utilisation(f):
    wh = inv.create_warehouse(None, code="CAP", name="Cap")
    loc = inv.create_location(None, warehouse_id=wh.id, code="C1", capacity="10")
    recv(f, "8", "1", loc=loc)
    with pytest.raises(DomainError) as e:
        recv(f, "3", "1", loc=loc)
    assert e.value.detail.code == "capacity_exceeded"
    recv(f, "5", "1")  # stock elsewhere; moving 3 into the nearly full location must also be refused
    with pytest.raises(DomainError):
        inv.transfer_stock(f["people"]["wh"].id, product_id=f["widget"].id, from_location_id=f["loc_a"].id, to_location_id=loc.id, quantity="3")
    row = [r for r in structure.utilisation(wh.id) if r["location"] == "C1"][0]
    assert row["used"] == "8.0000" and row["utilisation_pct"] == "80.0"


@pytest.mark.django_db
def test_quarantine_blocked_and_restricted_guards(f):
    wh = f["loc_a"].warehouse
    q = inv.create_location(None, warehouse_id=wh.id, code="QUAR", kind="QUARANTINE")
    r = inv.create_location(None, warehouse_id=wh.id, code="RSTR", kind="RESTRICTED")
    recv(f, "10", "2", loc=q)
    recv(f, "10", "2", loc=r)
    recv(f, "10", "2")
    who = f["people"]["wh"].id
    with pytest.raises(DomainError):  # quarantined stock cannot be issued
        inv.issue_stock(who, product_id=f["widget"].id, location_id=q.id, quantity="1", on_date=D0)
    inv.transfer_stock(who, product_id=f["widget"].id, from_location_id=q.id, to_location_id=f["loc_a"].id, quantity="4")  # release by transfer
    with pytest.raises(DomainError):  # warehouse staff lack restricted access
        inv.issue_stock(who, product_id=f["widget"].id, location_id=r.id, quantity="1", on_date=D0)
    assert inv.issue_stock(None, product_id=f["widget"].id, location_id=r.id, quantity="1", on_date=D0)  # system call is trusted
    structure.update_location(None, f["loc_a"].id, is_blocked=True)
    with pytest.raises(DomainError):
        inv.issue_stock(who, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="1", on_date=D0)
    structure.update_location(None, f["loc_a"].id, is_blocked=False)
    assert inv.issue_stock(who, product_id=f["widget"].id, location_id=f["loc_a"].id, quantity="1", on_date=D0)


@pytest.mark.django_db
def test_structure_api_permissions(api_env):
    env, api = api_env
    wid = str(env["loc_a"].warehouse_id)
    assert api["wh"].post("/api/v1/inventory/locations", {"warehouse": wid, "code": "Q9", "kind": "QUARANTINE"}).status_code == 403
    assert api["wh"].get("/api/v1/inventory/locations/utilisation").status_code == 200
    assert api["emp"].get("/api/v1/inventory/locations/utilisation").status_code == 403
    assert api["wh"].patch(f"/api/v1/inventory/warehouses/{wid}", {"address": "x"}).status_code == 403

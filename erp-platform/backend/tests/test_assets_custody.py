from datetime import timedelta
from decimal import Decimal as D

import pytest

from modules.assets import custody as cu
from modules.assets import models as am
from modules.assets import services as svc
from modules.hr import services as hr
from shared.api.errors import DomainError, ValidationFailed
from tests.test_assets import D0, activate, api_env, f, laptop  # noqa: F401


def staff(f):
    p = f["people"]
    boss = hr.create_employee(None, first_name="Abel", last_name="K", hire_date=D0, user_id=p["emp"].id)
    other = hr.create_employee(None, first_name="Sara", last_name="T", hire_date=D0)
    return boss, other


def available(f, serial="A1"):
    return activate(f, laptop(f, serial_number=serial))


@pytest.mark.django_db
def test_assignment_lifecycle_with_acknowledgment_and_return(f):
    p = f["people"]
    u, u2 = p["am_"].id, p["am2"].id
    me, other = staff(f)
    a = available(f)
    asg = cu.request_assignment(u, a.id, assignee_type="EMPLOYEE", assignee_id=me.id, assigned_on=D0)
    with pytest.raises(DomainError) as e:
        cu.request_assignment(u, a.id, assignee_type="EMPLOYEE", assignee_id=other.id, assigned_on=D0)
    assert e.value.get_codes() == "already_pending"
    with pytest.raises(DomainError) as e:
        cu.approve_assignment(u, asg.id)
    assert e.value.get_codes() == "separation_of_duties"
    cu.approve_assignment(u2, asg.id)
    cu.hand_over(u, asg.id, condition="GOOD", notes="With charger")
    a.refresh_from_db()
    assert a.status == "ASSIGNED" and a.custodian_id == me.id
    with pytest.raises(DomainError) as e:
        cu.acknowledge_custody(u, asg.id)  # not the employee
    assert e.value.get_codes() == "not_the_assignee"
    assert len(cu.unacknowledged()) == 1
    cu.acknowledge_custody(p["emp"].id, asg.id)
    assert cu.unacknowledged() == [] and [r["asset"] for r in cu.employee_equipment(me.id)] == [a.number]
    with pytest.raises(DomainError) as e:
        cu.request_assignment(u, a.id, assignee_type="EMPLOYEE", assignee_id=other.id, assigned_on=D0)
    assert e.value.get_codes() == "asset_not_available"
    with pytest.raises(ValidationFailed):
        cu.record_return(u, asg.id, condition="DAMAGED")
    cu.record_return(u, asg.id, condition="DAMAGED", notes="Cracked screen", returned_on=D0 + timedelta(days=30))
    a.refresh_from_db()
    assert a.status == "UNDER_MAINTENANCE" and a.custodian_id is None and a.condition == "DAMAGED"
    events = [h["event"] for h in svc.history(a.id)]
    assert {"ASSIGNMENT_REQUESTED", "HANDED_OVER", "CUSTODY_ACKNOWLEDGED", "RETURNED"} <= set(events)
    html = cu.handover_html(asg.id)
    assert "Asset handover" in html and a.number in html


@pytest.mark.django_db
def test_temporary_assignment_rules_overdue_and_reminders(f):
    p = f["people"]
    u, u2 = p["am_"].id, p["am2"].id
    me, _ = staff(f)
    a = available(f)
    with pytest.raises(ValidationFailed) as e:
        cu.request_assignment(u, a.id, assignee_type="EMPLOYEE", assignee_id=me.id, kind="TEMPORARY", assigned_on=D0)
    assert e.value.get_codes() == "return_date_required"
    with pytest.raises(ValidationFailed):
        cu.request_assignment(u, a.id, assignee_type="PROJECT", assigned_on=D0)
    asg = cu.request_assignment(u, a.id, assignee_type="EMPLOYEE", assignee_id=me.id, kind="TEMPORARY", assigned_on=D0, expected_return_on=D0 + timedelta(days=5))
    cu.approve_assignment(u2, asg.id)
    cu.hand_over(u, asg.id, condition="GOOD")
    assert cu.unreturned(D0 + timedelta(days=5)) == []
    assert cu.unreturned(D0 + timedelta(days=9))[0]["days_overdue"] == 4
    assert cu.run_reminders(D0 + timedelta(days=9)) == 1 and cu.run_reminders(D0 + timedelta(days=10)) == 0 and cu.run_reminders(D0 + timedelta(days=17)) == 1


@pytest.mark.django_db
def test_disposed_or_unavailable_assets_cannot_be_assigned(f):
    me, _ = staff(f)
    a = laptop(f, serial_number="NEW")  # still requested
    with pytest.raises(DomainError) as e:
        cu.request_assignment(f["people"]["am_"].id, a.id, assignee_type="EMPLOYEE", assignee_id=me.id, assigned_on=D0)
    assert e.value.get_codes() == "asset_not_available"
    ok = available(f, "OK")
    with pytest.raises(ValidationFailed) as e:
        cu.request_assignment(f["people"]["am_"].id, ok.id, assignee_type="DEPARTMENT", assignee_id="00000000-0000-0000-0000-000000000009", assigned_on=D0)
    assert e.value.get_codes() == "invalid_assignee"


@pytest.mark.django_db
def test_transfer_flow_updates_location_only_on_acknowledged_receipt(f):
    p = f["people"]
    u, u2 = p["am_"].id, p["am2"].id
    me, _ = staff(f)
    a = available(f, "T1")
    with pytest.raises(ValidationFailed):
        cu.request_transfer(u, a.id, reason="", effective_date=D0, to_location_id=f["loc2"].id)
    with pytest.raises(ValidationFailed):
        cu.request_transfer(u, a.id, reason="Move", effective_date=D0)
    t = cu.request_transfer(u, a.id, reason="Branch opening", effective_date=D0, to_location_id=f["loc2"].id, to_custodian_id=me.id)
    with pytest.raises(DomainError):
        cu.request_transfer(u, a.id, reason="again", effective_date=D0, to_location_id=f["loc2"].id)
    with pytest.raises(DomainError) as e:
        cu.decide_transfer(u, t.id, approve=True)
    assert e.value.get_codes() == "separation_of_duties"
    with pytest.raises(DomainError):
        cu.dispatch_transfer(u, t.id, condition="GOOD")  # not approved
    cu.decide_transfer(u2, t.id, approve=True)
    cu.dispatch_transfer(u, t.id, condition="GOOD")
    a.refresh_from_db()
    assert a.status == "TRANSFERRED" and a.location_id == f["loc"].id  # nothing moves until received
    with pytest.raises(DomainError) as e:
        cu.receive_transfer(u2, t.id, condition="GOOD")
    assert e.value.get_codes() == "not_the_assignee"
    with pytest.raises(ValidationFailed):
        cu.receive_transfer(p["emp"].id, t.id, condition="FAIR")  # changed in transit, no explanation
    cu.receive_transfer(p["emp"].id, t.id, condition="FAIR", notes="Scratched lid")
    a.refresh_from_db()
    assert a.status == "AVAILABLE" and a.location_id == f["loc2"].id and a.custodian_id == me.id and a.condition == "FAIR"
    assert cu.transfer_history(a.id)[0]["status"] == "COMPLETED"
    assert [h["detail"].get("field") for h in svc.history(a.id) if h["event"] == "OWNERSHIP_CHANGED"] == ["location_id", "custodian_id"]


@pytest.mark.django_db
def test_transfer_reject_and_cancel(f):
    u, u2 = f["people"]["am_"].id, f["people"]["am2"].id
    a = available(f, "T2")
    t = cu.request_transfer(u, a.id, reason="Move", effective_date=D0, to_location_id=f["loc2"].id)
    with pytest.raises(ValidationFailed):
        cu.decide_transfer(u2, t.id, approve=False)
    assert cu.decide_transfer(u2, t.id, approve=False, note="Not now").status == "REJECTED"
    t2 = cu.request_transfer(u, a.id, reason="Move", effective_date=D0, to_location_id=f["loc2"].id)
    assert cu.cancel_transfer(u, t2.id).status == "CANCELLED"


@pytest.mark.django_db
def test_custody_over_http_permissions(api_env):
    env, api = api_env
    aid = api["am"].post("/api/v1/assets/assets", {"category": str(env["cat"].id), "name": "Phone", "serial_number": "H1"}).json()["id"]
    assert api["emp"].post("/api/v1/assets/assignments", {"asset": aid}).status_code == 403
    assert api["auditor"].post("/api/v1/assets/assignments", {"asset": aid}).status_code == 403
    assert api["auditor"].get("/api/v1/assets/assignments").status_code == 200
    assert api["emp"].get("/api/v1/assets/assignments").status_code == 403
    assert api["emp"].post(f"/api/v1/assets/assignments/{aid}/approve").status_code == 403
    assert api["auditor"].post("/api/v1/assets/transfers", {"asset": aid}).status_code == 403
    assert api["auditor"].get("/api/v1/assets/reports/custody").status_code == 200
    assert api["emp"].get("/api/v1/assets/reports/custody").status_code == 403
    assert api["am"].post("/api/v1/assets/assignments", {"asset": aid, "assignee_type": "PROJECT", "project": "P1"}).status_code == 409  # not available yet

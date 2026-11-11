from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.assets import inspections as ins
from modules.assets import maintenance as mt
from modules.assets import models as am
from modules.assets import services as svc
from modules.assets import warranty as wt
from shared.api.errors import DomainError, ValidationFailed
from tests.test_assets import activate, api_env, f, laptop  # noqa: F401

TODAY = date.today()


def codes(e):
    return e.value.get_codes()


def live(f, serial="I1"):
    return activate(f, laptop(f, serial_number=serial))


def uids(f):
    return f["people"]["am_"].id, f["people"]["am2"].id


def tpl(f):
    return ins.create_template(None, code="it-check", name="IT check", items=[{"text": "Powers on", "kind": "PASS_FAIL"}, {"text": "Battery %", "kind": "READING"}], category_id=f["cat"].id)


@pytest.mark.django_db
def test_inspection_updates_condition_requires_findings_for_failures(f):
    a, t = live(f), None
    t = tpl(f)
    u, u2 = uids(f)
    i = ins.schedule(u, a.id, scheduled_on=TODAY, template_id=t.id)
    with pytest.raises(ValidationFailed) as e:
        ins.complete(u, i.id, results=[{"result": "PASS"}], condition="GOOD")
    assert codes(e) == "incomplete_checklist"
    with pytest.raises(ValidationFailed) as e:
        ins.complete(u, i.id, results=[{"result": "FAIL"}, {"result": "80"}], condition="POOR")
    assert codes(e) == "finding_required"
    with pytest.raises(ValidationFailed):
        ins.complete(u, i.id, results=[{"result": "PASS"}, {"result": "80"}], condition="ODD")
    ins.complete(u, i.id, results=[{"result": "FAIL"}, {"result": "80"}], condition="POOR", findings=[{"description": "Hinge cracked", "severity": "HIGH"}])
    a.refresh_from_db()
    assert a.condition == "POOR"
    fid = am.InspectionFinding.objects.get(inspection=i).id
    with pytest.raises(DomainError) as e:
        ins.complete(u, i.id, results=[], condition="GOOD")
    assert codes(e) == "invalid_state"
    wo = ins.raise_corrective_action(u, fid)
    with pytest.raises(DomainError) as e:
        ins.raise_corrective_action(u, fid)
    assert codes(e) == "already_pending"
    with pytest.raises(DomainError) as e:
        ins.resolve_finding(u, fid, notes="x")
    assert codes(e) == "corrective_action_open"
    mt.start(u, wo.id)
    mt.complete(u, wo.id, notes="fixed")
    mt.verify_return_to_service(u2, wo.id, notes="ok")
    assert ins.resolve_finding(u, fid, notes="Hinge replaced").status == "RESOLVED"
    assert ins.condition_report()["open_findings"] == 0


@pytest.mark.django_db
def test_category_interval_schedules_and_reports_overdue(f):
    a = live(f, "I2")
    svc.update_category(None, f["cat"].id, inspection_interval_days=30)
    assert ins.schedule_due(None, TODAY + timedelta(days=40)) == 1
    assert ins.schedule_due(None, TODAY + timedelta(days=40)) == 0  # one open inspection per asset
    assert len(ins.overdue(TODAY + timedelta(days=60))) == 1
    assert ins.condition_report()["never_inspected"] == 1


@pytest.mark.django_db
def test_warranty_claims_lifecycle(f):
    a = live(f, "W1")
    u, _ = uids(f)
    w = wt.add_warranty(u, a.id, provider_name="Dell", start_on=TODAY - timedelta(days=10), end_on=TODAY + timedelta(days=20))
    assert wt.active_warranty(a.id).id == w.id
    with pytest.raises(ValidationFailed):
        wt.add_warranty(u, a.id, provider_name="X", start_on=TODAY, end_on=TODAY - timedelta(days=1))
    c = wt.file_claim(u, w.id, description="Dead board", amount_claimed="200")
    with pytest.raises(DomainError) as e:
        wt.decide_warranty_claim(u, c.id, status="SETTLED")
    assert codes(e) == "invalid_state"
    wt.decide_warranty_claim(u, c.id, status="ACCEPTED")
    with pytest.raises(ValidationFailed):
        wt.decide_warranty_claim(u, c.id, status="SETTLED", amount_recovered="300")
    assert wt.decide_warranty_claim(u, c.id, status="SETTLED", amount_recovered="180").amount_recovered == D("180")
    with pytest.raises(DomainError) as e:
        wt.file_claim(u, w.id, description="late", claim_date=TODAY + timedelta(days=30))
    assert codes(e) == "warranty_expired"
    other = live(f, "W2")
    b = mt.report_breakdown(u, other.id, symptoms="x")
    with pytest.raises(ValidationFailed):
        wt.file_claim(u, w.id, description="wrong asset", breakdown_id=b.id)


@pytest.mark.django_db
def test_insurance_uninsured_renewal_claims_and_reminders(f):
    svc.update_category(None, f["cat"].id, requires_insurance=True)
    a = live(f, "P1")
    u, _ = uids(f)
    assert [r["asset"] for r in wt.uninsured_assets()] == [a.number]
    p = wt.create_policy(u, policy_number="POL-1", insurer="Nyala", start_on=TODAY - timedelta(days=300), end_on=TODAY + timedelta(days=20), premium="500", coverage_amount="5000", asset_ids=[a.id])
    assert wt.uninsured_assets() == [] and wt.is_insured(a.id)
    with pytest.raises(DomainError) as e:
        wt.create_policy(u, policy_number="POL-1", insurer="x", start_on=TODAY, end_on=TODAY)
    assert codes(e) == "duplicate_code"
    c = wt.file_insurance_claim(u, p.id, a.id, incident_date=TODAY - timedelta(days=1), description="Theft", amount_claimed="1000")
    with pytest.raises(DomainError) as e:
        wt.file_insurance_claim(u, p.id, a.id, incident_date=TODAY - timedelta(days=400), description="old")
    assert codes(e) == "policy_not_in_force"
    assert wt.expiring(30)["policies"][0]["renewed"] is False
    assert wt.run_reminders(TODAY) == 1 and wt.run_reminders(TODAY) == 0
    new = wt.renew_policy(u, p.id, policy_number="POL-2", start_on=TODAY + timedelta(days=21), end_on=TODAY + timedelta(days=386), premium="520")
    assert new.covered.count() == 1 and new.insurer == "Nyala"
    with pytest.raises(DomainError) as e:
        wt.renew_policy(u, p.id, policy_number="POL-3", start_on=TODAY, end_on=TODAY)
    assert codes(e) == "already_pending"
    assert wt.uninsured_assets(TODAY + timedelta(days=100)) == []  # covered by the renewal


@pytest.mark.django_db
def test_http_permissions_evidence_and_flow(api_env, acme):
    from django.core.files.uploadedfile import SimpleUploadedFile

    env, api = api_env
    with schema_context(acme["schema"]):
        a = activate(env, laptop(env, serial_number="HI1"))
    for call in (lambda c: c.post("/api/v1/assets/insurance-policies", {"policy_number": "Z", "insurer": "x", "start_on": "2026-01-01", "end_on": "2026-12-31"}),
                 lambda c: c.post("/api/v1/assets/inspections", {"asset": str(a.id)})):
        assert api["emp"].__class__ and call(api["emp"]).status_code == 403
        assert call(api["auditor"]).status_code == 403
    assert api["auditor"].get("/api/v1/assets/insurance-policies").status_code == 200
    t = api["am"].post("/api/v1/assets/inspection-templates", {"code": "g", "name": "General", "items": [{"text": "Clean", "kind": "PASS_FAIL"}]})
    assert t.status_code == 201
    r = api["am"].post("/api/v1/assets/inspections", {"asset": str(a.id), "template": t.json()["id"]})
    iid = r.json()["id"]
    done = api["am"].post(f"/api/v1/assets/inspections/{iid}/complete", {"results": [{"result": "PASS"}], "condition": "GOOD"})
    assert done.status_code == 200 and done.json()["status"] == "COMPLETED"
    pol = api["am"].post("/api/v1/assets/insurance-policies", {"policy_number": "H-1", "insurer": "Nyala", "start_on": "2026-01-01", "end_on": "2026-12-31", "assets": [str(a.id)]})
    assert pol.status_code == 201 and len(pol.json()["assets"]) == 1
    assert api["am"].get("/api/v1/assets/reports/coverage/uninsured").status_code == 200
    assert api["am"].get("/api/v1/assets/reports/condition").status_code == 200
    assert api["am"].post(f"/api/v1/assets/claims/bogus/{iid}/accept").status_code == 404

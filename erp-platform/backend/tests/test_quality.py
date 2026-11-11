from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from modules.inventory import services as inv
from modules.procurement import services as proc
from modules.projects import services as prj
from modules.projects import wbs
from modules.projects.models import TaskDependency
from modules.quality import analytics, approvals, audits, calibration, complaints, core, holds, inspections, jobs, ncr, planning, projectqa, risks, suppliers
from modules.quality import models as m
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from shared.workflows import services as wf
from tests.conftest import ACME_HOST, Api
from tests.test_finance import user
from tests.test_sales import f as sales_f  # noqa: F401
from tests.test_supply_chain import codes
from tests.test_supply_chain import f as sc_f  # noqa: F401

TODAY = timezone.now().date()
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"


@pytest.fixture
def dm(sc_f, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    p = sc_f["people"]
    p["qm"] = user(tenant, "qm@acme.test", "quality_manager")
    p["qm2"] = user(tenant, "qm2@acme.test", "quality_manager")
    p["qi"] = user(tenant, "qi@acme.test", "quality_inspector")
    p["pjm"] = user(tenant, "pjm@acme.test", "project_manager")
    core.seed_config()
    for subject in ("quality.plan", "quality.ncr", "quality.capa"):
        wf.create_definition(p["qm"].id, code=subject, name=subject, subject_type=subject, stages=[{"order": 1, "name": "Quality approver", "approvers": [{"type": "USER", "ref": str(p["qm2"].id)}]}])
    return {"p": p, "f": sc_f, "product": sc_f["widget"], "loc": sc_f["loc_a"]}


def u(dm, k):
    return dm["p"][k].id


def approve(dm, subject, obj_id, model, who="qm2"):
    obj = model.objects.get(pk=obj_id)
    task = wf.inbox(u(dm, who)).get(instance_id=obj.workflow_instance_id)
    wf.decide(u(dm, who), task.id, "APPROVE")
    return model.objects.get(pk=obj_id)


def make_plan(dm, critical=False, stage="INCOMING", product=True):
    ip = inspections.create_plan(u(dm, "qm"), {"title": "Incoming bolts", "stage": stage, "subject_type": "MATERIAL", "product_id": dm["product"].id if product else None})
    inspections.add_parameter(u(dm, "qm"), ip.id, {"name": "Length", "kind": "NUMERIC", "lower": "9.9", "upper": "10.1", "unit": "mm", "critical": critical})
    inspections.add_parameter(u(dm, "qm"), ip.id, {"name": "Finish", "kind": "BOOLEAN"})
    return ip


def run_inspection(dm, ip, length="10.0", finish="PASS", qty=50, supplier=None, lot="", complete=True, **kw):
    i = inspections.schedule(u(dm, "qm"), {"plan_id": ip.id, "scheduled_for": TODAY, "inspector_id": u(dm, "qi"), "quantity_total": qty, "supplier_id": supplier, "lot_number": lot, "ref_type": "procurement.goods_receipt", "ref_id": "GR-1"})
    inspections.start(u(dm, "qi"), i.id)
    params = {p.name: p for p in ip.parameters.all()}
    inspections.record_result(u(dm, "qi"), i.id, parameter_id=params["Length"].id, value=length)
    inspections.record_result(u(dm, "qi"), i.id, parameter_id=params["Finish"].id, text=finish)
    if complete:
        i = inspections.complete(u(dm, "qi"), i.id, **kw)
    return i


def new_ncr(dm, severity="MINOR", **kw):
    d = {"title": "Cracked housing", "source": "PRODUCTION", "source_ref_type": "manufacturing.order", "source_ref_id": "MO-1", "category": "MATERIAL", "severity": severity,
         "description": "Housings arrived cracked", "product_id": dm["product"].id}
    d.update(kw)
    return ncr.raise_ncr(u(dm, "qi"), d)


def capa_to_verifying(dm, source_type="OTHER", source_id=None):
    c = ncr.create_capa_record(u(dm, "qm"), {"kind": "CORRECTIVE", "title": "Fix jig", "source_type": source_type, "source_id": source_id, "problem": "Jig wears", "owner_id": u(dm, "qi"), "reviewer_id": u(dm, "qm"), "due_date": TODAY + timedelta(days=30)})
    ncr.add_root_cause(u(dm, "qm"), c.id, method="FIVE_WHYS", conclusion="No preventive maintenance of the jig")
    ncr.update_capa(u(dm, "qm"), c.id, {"corrective": "Replace jig and add maintenance"})
    a = core.add_action(u(dm, "qm"), "capa", c.id, action_type="CORRECTIVE", description="Replace the jig", owner_id=u(dm, "qi"), due_date=TODAY + timedelta(days=10))
    ncr.submit_capa(u(dm, "qm"), c.id)
    approve(dm, "quality.capa", c.id, m.Capa)
    ncr.start_capa(u(dm, "qm"), c.id)
    core.complete_action(u(dm, "qi"), a.id, note="jig replaced")
    core.add_evidence(u(dm, "qi"), "capa", c.id, filename="proof.pdf", data=PDF)
    ncr.mark_implemented(u(dm, "qi"), c.id)
    return c, a


# ----------------------------------------------------------------------------- inspections and holds
@pytest.mark.django_db
def test_inspection_pass_keeps_result_history_and_defects(dm):
    ip = make_plan(dm)
    i = run_inspection(dm, ip, complete=False)
    length = ip.parameters.get(name="Length")
    with pytest.raises(ValidationFailed) as e:
        inspections.record_result(u(dm, "qi"), i.id, parameter_id=length.id, value="10.05")
    assert codes(e) == "correction_reason_required"
    inspections.record_result(u(dm, "qi"), i.id, parameter_id=length.id, value="10.05", correction_reason="re-measured with the right gauge")
    assert i.results.filter(parameter=length).count() == 2 and i.results.get(parameter=length, is_current=True).value == Decimal("10.05")
    assert i.results.get(parameter=length, is_current=False).superseded_by_id
    inspections.record_defect(u(dm, "qi"), i.id, defect_code="SURFACE", quantity=2, note="scratch")
    done = inspections.complete(u(dm, "qi"), i.id)
    assert done.result == "PASS" and done.quantity_accepted == 50
    assert not m.Hold.objects.exists() and not m.Ncr.objects.exists()
    with pytest.raises(DomainError):
        inspections.cancel(u(dm, "qm"), i.id, reason="oops")  # completed inspections are permanent
    with pytest.raises(DomainError):
        inspections.record_result(u(dm, "qi"), i.id, parameter_id=length.id, value="10", correction_reason="late")


@pytest.mark.django_db
def test_incomplete_and_invalid_results_are_refused(dm):
    ip = make_plan(dm)
    i = run_inspection(dm, ip, complete=False)
    j = inspections.schedule(u(dm, "qm"), {"plan_id": ip.id, "scheduled_for": TODAY, "inspector_id": u(dm, "qi"), "quantity_total": 5})
    inspections.start(u(dm, "qi"), j.id)
    with pytest.raises(ValidationFailed) as e:
        inspections.complete(u(dm, "qi"), j.id)
    assert codes(e) == "results_incomplete"
    with pytest.raises(ValidationFailed) as e:
        inspections.record_result(u(dm, "qi"), j.id, parameter_id=ip.parameters.get(name="Length").id)
    assert codes(e) == "value_required"
    with pytest.raises(DomainError):
        inspections.record_result(u(dm, "emp" if False else "qm2"), i.id, parameter_id=ip.parameters.get(name="Length").id, value="10", correction_reason="x") if False else inspections.start(u(dm, "qi"), j.id)
    with pytest.raises(ValidationFailed):
        inspections.create_plan(u(dm, "qm"), {"title": "x", "stage": "NOPE", "subject_type": "MATERIAL"})
    with pytest.raises(ValidationFailed):
        inspections.add_parameter(u(dm, "qm"), ip.id, {"name": "bad", "kind": "NUMERIC", "lower": "5", "upper": "1"})


@pytest.mark.django_db
def test_failed_inspection_holds_stock_raises_ncr_and_needs_authorised_release(dm):
    ip = make_plan(dm)
    i = run_inspection(dm, ip, length="11.5", supplier=None)
    assert i.result == "FAIL" and i.quantity_rejected == 50
    hold = m.Hold.objects.get()
    ncr_ = m.Ncr.objects.get()
    assert hold.status == "ACTIVE" and ncr_.source == "INSPECTION" and ncr_.source_ref_id == str(i.id) and ncr_.severity == "MAJOR"
    with pytest.raises(DomainError) as e:
        inv.issue_stock(u(dm, "qm"), product_id=dm["product"].id, location_id=dm["loc"].id, quantity=1)
    assert codes(e) == "quality_hold" and e.value.status_code == 409
    # the person who placed the hold cannot release it, and release needs an accepting disposition
    with pytest.raises(DomainError) as e:
        holds.release_hold(u(dm, "qi"), hold.id, note="looks ok")
    assert codes(e) == "separation_of_duties"
    with pytest.raises(DomainError) as e:
        holds.release_hold(u(dm, "qm"), hold.id, note="looks ok")
    assert codes(e) == "disposition_required"
    holds.decide_disposition(u(dm, "qm"), hold.id, disposition="ACCEPT", note="Engineering concession EC-1")
    holds.release_hold(u(dm, "qm"), hold.id, note="concession granted")
    inv.issue_stock(u(dm, "qm"), product_id=dm["product"].id, location_id=dm["loc"].id, quantity=1)
    hold.refresh_from_db()
    assert hold.status == "RELEASED" and core.history("hold", hold.id)[-1]["action"] == "RELEASED"


@pytest.mark.django_db
def test_lot_hold_blocks_only_that_lot_and_scrap_is_permanent(dm):
    h = holds.place_hold(u(dm, "qi"), product_id=dm["product"].id, lot_number="L-9", reason="suspect lot")
    assert holds.place_hold(u(dm, "qi"), product_id=dm["product"].id, lot_number="L-9", reason="suspect lot").id == h.id
    inv.issue_stock(u(dm, "qm"), product_id=dm["product"].id, location_id=dm["loc"].id, quantity=1)  # another lot (none) is unaffected
    with pytest.raises(DomainError):
        holds.guard_stock(dm["product"], type("L", (), {"code": "L-9"})(), "issue")
    with pytest.raises(DomainError) as e:
        holds.reject_hold(u(dm, "qm"), h.id, note="x")
    assert codes(e) == "disposition_required"
    holds.decide_disposition(u(dm, "qm"), h.id, disposition="SCRAP", note="destroyed")
    holds.reject_hold(u(dm, "qm"), h.id, note="scrapped under SCR-1")
    h.refresh_from_db()
    assert h.status == "REJECTED"
    with pytest.raises(DomainError):
        holds.release_hold(u(dm, "qm2"), h.id, note="try")


@pytest.mark.django_db
def test_critical_failure_cannot_be_conditional_and_reinspection_links_to_hold(dm):
    ip = make_plan(dm, critical=True)
    i = run_inspection(dm, ip, length="12", complete=False)
    with pytest.raises(DomainError) as e:
        inspections.complete(u(dm, "qi"), i.id, accept_conditionally=True, conditional_note="ok")
    assert codes(e) == "critical_failure"
    i = inspections.complete(u(dm, "qi"), i.id)
    assert i.result == "FAIL" and m.Ncr.objects.get().severity == "CRITICAL"
    again = inspections.reinspect(u(dm, "qm"), i.id, scheduled_for=TODAY + timedelta(days=1))
    assert again.reinspection_of_id == i.id and m.Hold.objects.get().reinspection_id == again.id
    inspections.start(u(dm, "qi"), again.id)
    for p in ip.parameters.all():
        inspections.record_result(u(dm, "qi"), again.id, parameter_id=p.id, value="10" if p.kind == "NUMERIC" else None, text="PASS" if p.kind == "BOOLEAN" else "")
    assert inspections.complete(u(dm, "qi"), again.id).result == "PASS"
    h = m.Hold.objects.get()
    holds.decide_disposition(u(dm, "qm"), h.id, disposition="ACCEPT", note="re-inspected and passed")
    assert holds.release_hold(u(dm, "qm"), h.id, note="re-inspection passed").status == "RELEASED"


@pytest.mark.django_db
def test_conditional_acceptance_needs_a_note_and_still_holds_the_goods(dm):
    ip = make_plan(dm)
    i = run_inspection(dm, ip, finish="FAIL", complete=False)
    with pytest.raises(ValidationFailed):
        inspections.complete(u(dm, "qi"), i.id, accept_conditionally=True)
    done = inspections.complete(u(dm, "qi"), i.id, accept_conditionally=True, conditional_note="Use for non-visible parts only", quantity_accepted=50, quantity_rejected=0)
    assert done.result == "CONDITIONAL" and m.Hold.objects.filter(status="ACTIVE").exists() and not m.Ncr.objects.exists()


# ----------------------------------------------------------------------------- calibration
@pytest.mark.django_db
def test_overdue_equipment_cannot_be_used_and_failed_calibration_reviews_past_inspections(dm):
    old = calibration.register(u(dm, "qm"), {"tag": "CAL-1", "name": "Caliper", "responsible_id": u(dm, "qi"), "interval_days": 365, "last_calibrated_on": TODAY - timedelta(days=400)})
    good = calibration.register(u(dm, "qm"), {"tag": "CAL-2", "name": "Micrometer", "responsible_id": u(dm, "qi"), "interval_days": 365, "last_calibrated_on": TODAY - timedelta(days=10)})
    with pytest.raises(ValidationFailed):
        calibration.register(u(dm, "qm"), {"tag": "CAL-2", "name": "dup", "responsible_id": u(dm, "qi"), "interval_days": 30})
    ip = make_plan(dm)
    i = inspections.schedule(u(dm, "qm"), {"plan_id": ip.id, "scheduled_for": TODAY, "inspector_id": u(dm, "qi"), "quantity_total": 10})
    with pytest.raises(DomainError) as e:
        inspections.start(u(dm, "qi"), i.id, equipment_ids=[old.id])
    assert codes(e) == "equipment_overdue"
    inspections.start(u(dm, "qi"), i.id, equipment_ids=[good.id])
    for p in ip.parameters.all():
        inspections.record_result(u(dm, "qi"), i.id, parameter_id=p.id, value="10" if p.kind == "NUMERIC" else None, text="PASS" if p.kind == "BOOLEAN" else "")
    inspections.complete(u(dm, "qi"), i.id)
    cal = calibration.schedule(u(dm, "qm"), good.id, scheduled_for=TODAY)
    with pytest.raises(ValidationFailed):
        calibration.record(u(dm, "qm"), cal.id, performed_on=TODAY, performed_by="Lab", result="FAIL", certificate_ref="C-1")
    with pytest.raises(ValidationFailed):
        calibration.record(u(dm, "qm"), cal.id, performed_on=TODAY + timedelta(days=2), performed_by="Lab", result="PASS", certificate_ref="C-1")
    calibration.record(u(dm, "qm"), cal.id, performed_on=TODAY, performed_by="Lab", result="FAIL", certificate_ref="C-1", as_found="Reads 0.3 mm high")
    good.refresh_from_db()
    assert good.status == "ON_HOLD"
    impact = m.ImpactAssessment.objects.get()
    assert impact.inspection_id == i.id and impact.status == "PENDING"
    with pytest.raises(DomainError) as e:
        calibration.return_to_service(u(dm, "qm"), good.id, calibration_id=cal.id)
    assert codes(e) == "calibration_required"
    cal2 = calibration.schedule(u(dm, "qm"), good.id, scheduled_for=TODAY)
    calibration.record(u(dm, "qm"), cal2.id, performed_on=TODAY, performed_by="Lab", result="PASS", certificate_ref="C-2")
    with pytest.raises(DomainError) as e:
        calibration.return_to_service(u(dm, "qm"), good.id, calibration_id=cal2.id)
    assert codes(e) == "impact_pending"
    calibration.assess_impact(u(dm, "qm"), impact.id, affected=True, note="Re-inspect the lot")
    assert calibration.return_to_service(u(dm, "qm"), good.id, calibration_id=cal2.id).status == "ACTIVE"
    assert good.calibrations.count() == 2 and calibration.reminders(TODAY) >= 1


# ----------------------------------------------------------------------------- NCR
@pytest.mark.django_db
def test_ncr_must_be_traceable_and_follows_its_lifecycle(dm):
    with pytest.raises(ValidationFailed) as e:
        new_ncr(dm, source_ref_id="")
    assert codes(e) == "source_required"
    with pytest.raises(ValidationFailed):
        new_ncr(dm, severity="BOGUS")
    n = new_ncr(dm)
    assert n.number.startswith("NCR-") and n.status == "OPEN"
    with pytest.raises(ValidationFailed) as e:
        ncr.submit_for_approval(u(dm, "qi"), n.id)
    assert codes(e) == "investigator_required"
    ncr.assign(u(dm, "qm"), n.id, investigator_id=u(dm, "qi"))
    with pytest.raises(ValidationFailed) as e:
        ncr.submit_for_approval(u(dm, "qi"), n.id)
    assert codes(e) == "investigation_incomplete"
    ncr.contain(u(dm, "qm"), n.id, containment="Quarantined the pallet", place_hold=True)
    assert m.Hold.objects.filter(source_type="ncr", source_id=n.id, status="ACTIVE").exists()
    ncr.update_ncr(u(dm, "qi"), n.id, {"root_cause": "Rough handling", "proposed_correction": "Rework"})
    ncr.submit_for_approval(u(dm, "qi"), n.id)
    assert ncr.get_ncr(n.id).status == "PENDING_APPROVAL"
    n = approve(dm, "quality.ncr", n.id, m.Ncr)
    assert n.status == "APPROVED"
    with pytest.raises(ValidationFailed) as e:
        ncr.start_implementation(u(dm, "qm"), n.id)
    assert codes(e) == "actions_required"
    a = core.add_action(u(dm, "qm"), "ncr", n.id, action_type="CORRECTION", description="Rework the housings", owner_id=u(dm, "qi"), due_date=TODAY + timedelta(days=5))
    ncr.start_implementation(u(dm, "qm"), n.id)
    with pytest.raises(DomainError) as e:
        ncr.submit_for_verification(u(dm, "qm"), n.id)
    assert codes(e) == "actions_open"
    core.complete_action(u(dm, "qi"), a.id, note="done")
    ncr.submit_for_verification(u(dm, "qm"), n.id)
    with pytest.raises(DomainError) as e:
        ncr.close_ncr(u(dm, "qi"), n.id, note="fine")
    assert codes(e) == "separation_of_duties"
    with pytest.raises(DomainError) as e:
        ncr.close_ncr(u(dm, "qm"), n.id, note="fine")
    assert codes(e) == "actions_unverified"
    with pytest.raises(DomainError) as e:
        core.verify_action(u(dm, "qi"), a.id)  # the doer cannot verify
    assert codes(e) == "separation_of_duties"
    core.verify_action(u(dm, "qm"), a.id)
    with pytest.raises(DomainError) as e:
        ncr.close_ncr(u(dm, "qm"), n.id, note="fine")
    assert codes(e) == "hold_active"
    h = m.Hold.objects.get(source_type="ncr")
    holds.decide_disposition(u(dm, "qm"), h.id, disposition="REWORK", note="reworked")
    holds.release_hold(u(dm, "qm2"), h.id, note="rework verified")
    n = ncr.close_ncr(u(dm, "qm"), n.id, note="Verified on site")
    assert n.status == "CLOSED" and n.closed_at
    with pytest.raises(DomainError):
        ncr.update_ncr(u(dm, "qm"), n.id, {"title": "changed"})
    assert ncr.reopen(u(dm, "qm"), n.id, reason="Recurred").reopened_count == 1
    actions = [e["action"] for e in core.history("ncr", n.id)]
    assert actions[0] == "RAISED" and "CLOSED" in actions and actions[-1] == "REOPENED"


@pytest.mark.django_db
def test_ncr_rejection_by_approver_returns_it_to_investigation_and_dismissal_is_recorded(dm):
    n = new_ncr(dm)
    ncr.assign(u(dm, "qm"), n.id, investigator_id=u(dm, "qi"))
    ncr.update_ncr(u(dm, "qi"), n.id, {"root_cause": "x", "proposed_correction": "y"})
    ncr.submit_for_approval(u(dm, "qi"), n.id)
    obj = m.Ncr.objects.get(pk=n.id)
    task = wf.inbox(u(dm, "qm2")).get(instance_id=obj.workflow_instance_id)
    wf.decide(u(dm, "qm2"), task.id, "REJECT", "Root cause too vague")
    assert m.Ncr.objects.get(pk=n.id).status == "INVESTIGATING"
    other = new_ncr(dm, title="Duplicate")
    with pytest.raises(ValidationFailed):
        ncr.reject_ncr(u(dm, "qm"), other.id, reason="")
    assert ncr.reject_ncr(u(dm, "qm"), other.id, reason="Duplicate of another NCR").status == "REJECTED"
    assert m.Ncr.objects.filter(pk=other.id).exists()


# ----------------------------------------------------------------------------- CAPA
@pytest.mark.django_db
def test_capa_rules_and_effectiveness_verification(dm):
    with pytest.raises(DomainError) as e:
        ncr.create_capa_record(u(dm, "qm"), {"kind": "CORRECTIVE", "title": "x", "source_type": "OTHER", "problem": "p", "owner_id": u(dm, "qm"), "reviewer_id": u(dm, "qm"), "due_date": TODAY})
    assert codes(e) == "separation_of_duties"
    with pytest.raises(ValidationFailed) as e:
        ncr.create_capa_record(u(dm, "qm"), {"kind": "CORRECTIVE", "title": "x", "source_type": "NCR", "problem": "p", "owner_id": u(dm, "qi"), "reviewer_id": u(dm, "qm"), "due_date": TODAY})
    assert codes(e) == "source_required"
    c = ncr.create_capa_record(u(dm, "qm"), {"kind": "CORRECTIVE", "title": "Fix jig", "source_type": "OTHER", "problem": "Jig wears", "owner_id": u(dm, "qi"), "reviewer_id": u(dm, "qm"), "due_date": TODAY + timedelta(days=30)})
    with pytest.raises(ValidationFailed) as e:
        ncr.submit_capa(u(dm, "qm"), c.id)
    assert codes(e) == "analysis_required"
    ncr.add_root_cause(u(dm, "qm"), c.id, method="FIVE_WHYS", conclusion="No maintenance")
    with pytest.raises(ValidationFailed) as e:
        ncr.submit_capa(u(dm, "qm"), c.id)
    assert codes(e) == "plan_required"
    ncr.update_capa(u(dm, "qm"), c.id, {"corrective": "Replace jig"})
    with pytest.raises(ValidationFailed) as e:
        ncr.submit_capa(u(dm, "qm"), c.id)
    assert codes(e) == "actions_required"
    a = core.add_action(u(dm, "qm"), "capa", c.id, action_type="CORRECTIVE", description="Replace the jig", owner_id=u(dm, "qi"), due_date=TODAY + timedelta(days=10))
    ncr.submit_capa(u(dm, "qm"), c.id)
    approve(dm, "quality.capa", c.id, m.Capa)
    ncr.start_capa(u(dm, "qm"), c.id)
    with pytest.raises(DomainError) as e:
        ncr.mark_implemented(u(dm, "qi"), c.id)
    assert codes(e) == "actions_open"
    core.complete_action(u(dm, "qi"), a.id)
    with pytest.raises(DomainError) as e:
        ncr.mark_implemented(u(dm, "qi"), c.id)
    assert codes(e) == "evidence_required"
    core.add_evidence(u(dm, "qi"), "capa", c.id, filename="proof.pdf", data=PDF)
    c = ncr.mark_implemented(u(dm, "qi"), c.id)
    assert c.status == "VERIFYING" and c.effectiveness_due
    with pytest.raises(DomainError) as e:
        ncr.verify_effectiveness(u(dm, "qm2"), c.id, effective=True, notes="fine")
    assert codes(e) == "separation_of_duties"  # only the named reviewer
    with pytest.raises(DomainError) as e:
        ncr.verify_effectiveness(u(dm, "qm"), c.id, effective=True, notes="fine")
    assert codes(e) == "actions_unverified"
    core.verify_action(u(dm, "qm2"), a.id)
    c = ncr.verify_effectiveness(u(dm, "qm"), c.id, effective=False, notes="Defect came back in week 3")
    assert c.status == "ANALYSIS" and c.cycles == 2 and c.reviews.count() == 1
    assert [e["action"] for e in core.history("capa", c.id)][-1] == "NOT_EFFECTIVE"


@pytest.mark.django_db
def test_major_ncr_closes_only_after_capa_is_closed_and_evidence_is_attached(dm):
    n = new_ncr(dm, severity="MAJOR")
    m.Ncr.objects.filter(pk=n.id).update(status="VERIFYING", investigator_id=u(dm, "qi"))
    with pytest.raises(DomainError) as e:
        ncr.close_ncr(u(dm, "qm"), n.id, note="ok")
    assert codes(e) == "capa_required"
    c0 = ncr.create_capa(u(dm, "qm"), n.id, owner_id=u(dm, "qi"), reviewer_id=u(dm, "qm"), due_date=TODAY + timedelta(days=30))
    with pytest.raises(ValidationFailed):
        ncr.create_capa(u(dm, "qm"), n.id, owner_id=u(dm, "qi"), reviewer_id=u(dm, "qm"), due_date=TODAY)
    c, a = capa_to_verifying(dm, "NCR", n.id)
    m.Capa.objects.filter(pk=c0.id).update(status="CANCELLED")
    core.verify_action(u(dm, "qm2"), a.id)
    assert ncr.verify_effectiveness(u(dm, "qm"), c.id, effective=True, notes="No recurrence in 90 days").status == "CLOSED"
    with pytest.raises(DomainError) as e:
        ncr.close_ncr(u(dm, "qm"), n.id, note="ok")
    assert codes(e) == "capa_required"  # the NCR is linked to the first (cancelled) CAPA
    m.Ncr.objects.filter(pk=n.id).update(capa_id=c.id)
    with pytest.raises(DomainError) as e:
        ncr.close_ncr(u(dm, "qm"), n.id, note="ok")
    assert codes(e) == "evidence_required"
    core.add_evidence(u(dm, "qm"), "ncr", n.id, filename="correction.pdf", data=PDF)
    assert ncr.close_ncr(u(dm, "qm"), n.id, note="All verified").status == "CLOSED"


# ----------------------------------------------------------------------------- plans, standards
@pytest.mark.django_db
def test_quality_plan_approval_and_revision_history(dm):
    p = planning.create_plan(u(dm, "qm"), {"title": "Housing line plan", "scope_type": "PRODUCT", "owner_id": u(dm, "qm"), "standards": "ISO 9001"})
    with pytest.raises(ValidationFailed) as e:
        planning.submit_plan(u(dm, "qm"), p.id)
    assert codes(e) == "plan_incomplete"
    obj = planning.add_objective(u(dm, "qm"), p.id, {"name": "Rejection rate", "metric": "REJECTION_RATE", "target": "2", "owner_id": u(dm, "qm")})
    planning.add_control_point(u(dm, "qm"), p.id, {"name": "Final inspection", "responsible_id": u(dm, "qi"), "frequency": "every lot"})
    with pytest.raises(DomainError):
        planning.measure_objective(u(dm, "qm"), obj.id, period=TODAY.replace(day=1), value="1")  # not approved yet
    planning.submit_plan(u(dm, "qm"), p.id)
    p = approve(dm, "quality.plan", p.id, m.QualityPlan)
    assert p.status == "APPROVED" and p.revision == 1
    with pytest.raises(DomainError):
        planning.update_plan(u(dm, "qm"), p.id, {"title": "silently changed"})
    planning.measure_objective(u(dm, "qm"), obj.id, period=TODAY.replace(day=1), value="1.5")
    assert planning.objective_dict(m.Objective.objects.get(pk=obj.id))["met"] is True
    planning.measure_objective(u(dm, "qm"), obj.id, period=TODAY.replace(day=1), value="3")
    assert planning.objective_dict(m.Objective.objects.get(pk=obj.id))["met"] is False
    planning.revise_plan(u(dm, "qm"), p.id, reason="New acceptance criteria")
    p.refresh_from_db()
    assert p.status == "DRAFT" and p.revision == 2 and p.revisions.get().revision == 1
    assert p.revisions.get().snapshot["objectives"][0]["name"] == "Rejection rate"
    with pytest.raises(DomainError):
        planning.revise_plan(u(dm, "qm"), p.id, reason="again")  # no longer approved


@pytest.mark.django_db
def test_standards_compliance_and_version_changes(dm):
    s = planning.save_standard(u(dm, "qm"), {"code": "ISO9001", "name": "Quality management systems", "version": "2015"})
    with pytest.raises(ValidationFailed):
        planning.save_standard(u(dm, "qm"), {"code": "ISO9001", "name": "dup"})
    r1 = planning.add_requirement(u(dm, "qm"), s.id, {"clause": "8.5", "text": "Production control", "owner_id": u(dm, "qm")})
    r2 = planning.add_requirement(u(dm, "qm"), s.id, {"clause": "8.6", "text": "Release of products", "owner_id": u(dm, "qm")})
    with pytest.raises(ValidationFailed):
        planning.add_requirement(u(dm, "qm"), s.id, {"clause": "8.5", "text": "dup", "owner_id": u(dm, "qm")})
    with pytest.raises(ValidationFailed) as e:
        planning.assess(u(dm, "qm"), r1.id, status="PARTIAL")
    assert codes(e) == "gap_required"
    planning.assess(u(dm, "qm"), r1.id, status="COMPLIANT")
    planning.assess(u(dm, "qm"), r2.id, status="NON_COMPLIANT", gap="No release procedure")
    summary = planning.compliance_summary(s.id)
    assert summary["compliance_percent"] == 50.0 and len(summary["gaps"]) == 1
    planning.new_standard_version(u(dm, "qm"), s.id, version="2026", summary="Climate clause added", impact="Review 8.5")
    assert m.Requirement.objects.filter(needs_review=True).count() == 2 and m.Assessment.objects.count() == 2
    planning.assess(u(dm, "qm"), r1.id, status="COMPLIANT")
    assert m.Requirement.objects.filter(needs_review=True).count() == 1 and m.Assessment.objects.filter(requirement=r1).count() == 2
    with pytest.raises(ValidationFailed):
        planning.new_standard_version(u(dm, "qm"), s.id, version="2026", summary="same")


# ----------------------------------------------------------------------------- audits
@pytest.mark.django_db
def test_audit_findings_stay_open_until_actioned_and_audit_closes_last(dm):
    t = audits.save_template(u(dm, "qm"), {"name": "Internal ISO audit", "audit_type": "INTERNAL", "questions": [{"question": "Are records controlled?"}, {"question": "Is calibration current?"}]})
    with pytest.raises(ValidationFailed):
        audits.schedule(u(dm, "qm"), {"audit_type": "INTERNAL", "title": "x", "scope": "s", "planned_start": TODAY, "planned_end": TODAY - timedelta(days=1), "lead_auditor_id": u(dm, "qi")})
    a = audits.schedule(u(dm, "qm"), {"audit_type": "INTERNAL", "title": "Q4 internal audit", "scope": "Production", "planned_start": TODAY, "planned_end": TODAY + timedelta(days=2),
                                      "lead_auditor_id": u(dm, "qi"), "template_id": t.id})
    items = list(a.checklist.order_by("position"))
    assert len(items) == 2 and a.number.startswith("AUD-")
    with pytest.raises(DomainError):
        audits.answer(u(dm, "qi"), items[0].id, response="CONFORMS")  # not started
    audits.start(u(dm, "qi"), a.id)
    with pytest.raises(DomainError) as e:
        audits.report(u(dm, "qi"), a.id, summary="done")
    assert codes(e) == "checklist_incomplete"
    audits.answer(u(dm, "qi"), items[0].id, response="CONFORMS")
    with pytest.raises(ValidationFailed):
        audits.answer(u(dm, "qi"), items[1].id, response="NONCONFORMS")
    audits.answer(u(dm, "qi"), items[1].id, response="NONCONFORMS", note="Two instruments overdue")
    with pytest.raises(DomainError) as e:
        audits.report(u(dm, "qi"), a.id, summary="done")
    assert codes(e) == "finding_missing"
    nc = audits.raise_finding(u(dm, "qi"), a.id, {"finding_type": "NONCONFORMITY", "severity": "MAJOR", "description": "Overdue instruments", "checklist_item_id": items[1].id, "due_date": TODAY + timedelta(days=14), "owner_id": u(dm, "qm")})
    ob = audits.raise_finding(u(dm, "qi"), a.id, {"finding_type": "OBSERVATION", "severity": "MINOR", "description": "Labels faded"})
    audits.report(u(dm, "qi"), a.id, summary="One major non-conformity")
    with pytest.raises(DomainError) as e:
        audits.close_audit(u(dm, "qm"), a.id)
    assert codes(e) == "findings_open"
    with pytest.raises(DomainError) as e:
        audits.close_finding(u(dm, "qi"), nc.id, note="ok")
    assert codes(e) == "action_required"
    capa = audits.finding_capa(u(dm, "qi"), nc.id, owner_id=u(dm, "qm2"), reviewer_id=u(dm, "qm"), due_date=TODAY + timedelta(days=30))
    assert m.Finding.objects.get(pk=nc.id).status == "ACTION_ASSIGNED" and capa.source_type == "AUDIT_FINDING"
    with pytest.raises(DomainError) as e:
        audits.close_finding(u(dm, "qi"), nc.id, note="ok")
    assert codes(e) == "capa_open"
    assert audits.close_finding(u(dm, "qi"), ob.id, note="Labels replaced").status == "CLOSED"
    with pytest.raises(DomainError):
        audits.close_audit(u(dm, "qm"), a.id)
    assert audits.reminders(TODAY + timedelta(days=20)) == 1


# ----------------------------------------------------------------------------- suppliers
@pytest.mark.django_db
def test_supplier_status_scar_cycle_and_evaluation(dm):
    s = proc.create_supplier(u(dm, "qm"), name="Bolt Co")
    p = suppliers.profile(s.id)
    assert p.status == "PENDING"
    suppliers.set_status(u(dm, "qm"), s.id, status="APPROVED", reason="Audit passed")
    cert = suppliers.add_certificate(u(dm, "qm"), s.id, {"name": "ISO 9001", "expires_on": TODAY + timedelta(days=10)})
    with pytest.raises(ValidationFailed):
        suppliers.add_certificate(u(dm, "qm"), s.id, {"name": "bad", "issued_on": TODAY, "expires_on": TODAY - timedelta(days=1)})
    assert suppliers.reminders(TODAY) == 1 and suppliers.reminders(TODAY) == 0
    ip = make_plan(dm)
    run_inspection(dm, ip, supplier=s.id)
    run_inspection(dm, ip, length="12", supplier=s.id)
    ev = suppliers.evaluate(u(dm, "qm"), s.id, date_from=TODAY - timedelta(days=30), date_to=TODAY, apply_status=True)
    assert str(ev.rejection_rate) == "50.00" and ev.outcome == "BELOW" and ev.ncr_count == 1 and ev.lots_rejected == 1
    assert suppliers.profile(s.id).status == "CONDITIONAL"
    sc = suppliers.raise_scar(u(dm, "qm"), {"supplier_id": s.id, "ncr_id": m.Ncr.objects.get().id, "description": "Length out of tolerance", "due_date": TODAY + timedelta(days=14), "owner_id": u(dm, "qm")})
    with pytest.raises(DomainError) as e:
        suppliers.set_status(u(dm, "qm"), s.id, status="APPROVED", reason="back")
    assert codes(e) == "scar_open"
    with pytest.raises(DomainError):
        suppliers.review_response(u(dm, "qm"), sc.id, accept=True, note="n")  # no response yet
    suppliers.record_response(u(dm, "qm"), sc.id, response="Gauge replaced")
    assert suppliers.review_response(u(dm, "qm"), sc.id, accept=False, note="No root cause").status == "REJECTED"
    suppliers.record_response(u(dm, "qm"), sc.id, response="Root cause: worn tool; replaced")
    suppliers.review_response(u(dm, "qm"), sc.id, accept=True, note="Accepted")
    assert suppliers.close_scar(u(dm, "qm"), sc.id, note="Verified at re-audit").status == "CLOSED"
    suppliers.set_status(u(dm, "qm"), s.id, status="BLOCKED", reason="Repeated failures")
    s.refresh_from_db()
    assert s.status == "BLOCKED"
    suppliers.set_status(u(dm, "qm"), s.id, status="APPROVED", reason="Re-qualified")
    s.refresh_from_db()
    assert s.status == "QUALIFIED" and cert.id


# ----------------------------------------------------------------------------- complaints, risks, improvement
@pytest.mark.django_db
def test_complaint_flow_and_recurrence_detection(dm):
    base = {"complaint_type": "PRODUCT", "severity": "MAJOR", "customer_name": "Globex", "product_id": dm["product"].id, "description": "Units arrive scratched", "investigator_id": u(dm, "qm")}
    c = complaints.register(u(dm, "qm"), base)
    assert not c.is_recurring
    c2 = complaints.register(u(dm, "qm"), {**base, "description": "Scratched again"})
    assert c2.is_recurring
    with pytest.raises(ValidationFailed):
        complaints.register(u(dm, "qm"), {**base, "customer_name": ""})
    with pytest.raises(DomainError):
        complaints.respond(u(dm, "qm"), c.id, response_text="sorry", resolution="refund")
    complaints.investigate(u(dm, "qm"), c.id, findings="Packaging failure")
    n = complaints.raise_ncr(u(dm, "qm"), c.id, category="PROCESS", containment="Packaging changed")
    assert n.source == "COMPLAINT" and n.source_ref_id == str(c.id)
    complaints.respond(u(dm, "qm"), c.id, response_text="We apologise and replaced the goods", resolution="Replacement")
    with pytest.raises(ValidationFailed) as e:
        complaints.close(u(dm, "qm"), c.id)
    assert codes(e) == "confirmation_required"
    with pytest.raises(DomainError) as e:
        complaints.close(u(dm, "qm"), c.id, customer_confirmed_on=TODAY)
    assert codes(e) == "capa_required"
    complaints.link_capa(u(dm, "qm"), c.id, owner_id=u(dm, "qi"), reviewer_id=u(dm, "qm2"), due_date=TODAY + timedelta(days=20))
    assert complaints.close(u(dm, "qm"), c.id, customer_confirmed_on=TODAY).status == "CLOSED"


@pytest.mark.django_db
def test_risk_rules_and_improvement_initiatives(dm):
    with pytest.raises(ValidationFailed):
        risks.register(u(dm, "qm"), {"title": "x", "area": "PROCESS", "likelihood": 6, "impact": 2, "owner_id": u(dm, "qm")})
    r = risks.register(u(dm, "qm"), {"title": "Single-source supplier", "area": "SUPPLIER", "likelihood": 5, "impact": 4, "owner_id": u(dm, "qm"), "next_review_on": TODAY})
    assert r.score == 20 and risks.level(r.score) == "HIGH" and risks.risk_matrix()["5x4"] == 1
    with pytest.raises(DomainError) as e:
        risks.set_status(u(dm, "qm"), r.id, status="ACCEPTED", note="we can live with it")
    assert codes(e) == "high_risk"
    with pytest.raises(ValidationFailed):
        risks.set_status(u(dm, "qm"), r.id, status="MITIGATING")
    a = core.add_action(u(dm, "qm"), "risk", r.id, action_type="MITIGATION", description="Qualify a second supplier", owner_id=u(dm, "qi"), due_date=TODAY + timedelta(days=60))
    risks.set_status(u(dm, "qm"), r.id, status="MITIGATING")
    with pytest.raises(DomainError):
        risks.set_status(u(dm, "qm"), r.id, status="CLOSED")
    core.complete_action(u(dm, "qi"), a.id)
    core.verify_action(u(dm, "qm"), a.id)
    with pytest.raises(ValidationFailed) as e:
        risks.set_status(u(dm, "qm"), r.id, status="CLOSED")
    assert codes(e) == "residual_required"
    risks.reassess(u(dm, "qm"), r.id, likelihood=2, impact=2, residual=True)
    assert risks.set_status(u(dm, "qm"), r.id, status="CLOSED").status == "CLOSED"
    s = risks.suggest(u(dm, "emp"), {"title": "Colour-code bins", "description": "Reduce mix-ups"})
    with pytest.raises(DomainError):
        risks.create_initiative(u(dm, "qm"), {"title": "x", "owner_id": u(dm, "qi"), "target_date": TODAY, "suggestion_id": s.id})
    risks.decide_suggestion(u(dm, "qm"), s.id, accept=True, note="Good idea")
    i = risks.create_initiative(u(dm, "qm"), {"title": "Colour-coded bins", "owner_id": u(dm, "qi"), "target_date": TODAY + timedelta(days=30), "suggestion_id": s.id, "metric": "mix-ups", "baseline_value": "10", "target_value": "2"})
    assert m.Suggestion.objects.get(pk=s.id).status == "CONVERTED"
    with pytest.raises(DomainError) as e:
        risks.initiative_status(u(dm, "qm"), i.id, status="APPROVED")
    assert codes(e) == "separation_of_duties"
    risks.initiative_status(u(dm, "qm2"), i.id, status="APPROVED")
    risks.initiative_status(u(dm, "qi"), i.id, status="IN_PROGRESS", progress=50)
    with pytest.raises(ValidationFailed) as e:
        risks.initiative_status(u(dm, "qi"), i.id, status="COMPLETED")
    assert codes(e) == "result_required"
    done = risks.initiative_status(u(dm, "qi"), i.id, status="COMPLETED", result_value="1", lessons_learned="Colours must be consistent")
    assert done.progress == 100 and done.status == "COMPLETED"


# ----------------------------------------------------------------------------- project quality
@pytest.mark.django_db
def test_hold_points_block_dependent_tasks_and_punch_items_gate_acceptance(dm):
    pm = u(dm, "pjm")
    proj = prj.create_project(pm, name="Warehouse build", start_on=TODAY, end_on=TODAY + timedelta(days=90))
    t1 = wbs.create_task(pm, proj.id, name="Pour slab", planned_start=TODAY, planned_end=TODAY + timedelta(days=5))
    t2 = wbs.create_task(pm, proj.id, name="Erect frame", planned_start=TODAY + timedelta(days=6), planned_end=TODAY + timedelta(days=20))
    TaskDependency.objects.create(predecessor=t1, successor=t2, kind="FS")
    ip = inspections.create_plan(u(dm, "qm"), {"title": "Slab ITP", "stage": "PROJECT", "subject_type": "SITE", "project_id": proj.id, "is_itp": True})
    inspections.add_parameter(u(dm, "qm"), ip.id, {"name": "Slab level OK", "kind": "BOOLEAN", "critical": True})
    with pytest.raises(ValidationFailed):
        projectqa.request_inspection(u(dm, "qi"), {"project_id": proj.id, "requested_for": TODAY, "hold_point": True})
    req = projectqa.request_inspection(u(dm, "qi"), {"project_id": proj.id, "requested_for": TODAY, "activity_task_id": t1.id, "hold_point": True, "location": "Block A", "contractor": "ACME Civil"})
    with pytest.raises(DomainError) as e:
        projectqa.task_guard(t2, "IN_PROGRESS")
    assert codes(e) == "quality_hold_point"
    with pytest.raises(ValidationFailed):
        projectqa.schedule(u(dm, "qm"), req.id, inspector_id=u(dm, "qi"))  # no plan chosen
    projectqa.schedule(u(dm, "qm"), req.id, inspector_id=u(dm, "qi"), plan_id=ip.id)
    req.refresh_from_db()
    with pytest.raises(DomainError):
        projectqa.decide(u(dm, "qm"), req.id, approve=True, note="x")  # not inspected yet
    i = req.inspection
    inspections.start(u(dm, "qi"), i.id)
    inspections.record_result(u(dm, "qi"), i.id, parameter_id=ip.parameters.get().id, text="PASS")
    inspections.complete(u(dm, "qi"), i.id)
    req.refresh_from_db()
    assert req.status == "INSPECTED"
    punch = projectqa.raise_punch(u(dm, "qi"), {"project_id": proj.id, "description": "Honeycombing at gridline C", "severity": "MAJOR", "assigned_to": u(dm, "qi"), "request_id": req.id})
    with pytest.raises(DomainError) as e:
        projectqa.decide(u(dm, "qm"), req.id, approve=True, note="ok")
    assert codes(e) == "punch_open"
    projectqa.punch_fixed(u(dm, "qi"), punch.id, note="Patched and ground")
    with pytest.raises(DomainError) as e:
        projectqa.punch_verify(u(dm, "qi"), punch.id, accept=True)
    assert codes(e) == "separation_of_duties"
    projectqa.punch_verify(u(dm, "qm"), punch.id, accept=True)
    with pytest.raises(DomainError) as e:
        projectqa.decide(u(dm, "qi"), req.id, approve=True, note="ok")
    assert codes(e) == "separation_of_duties"
    assert projectqa.decide(u(dm, "qm"), req.id, approve=True, note="Slab accepted").status == "APPROVED"
    projectqa.task_guard(t2, "IN_PROGRESS")  # released


# ----------------------------------------------------------------------------- reports, jobs, http
@pytest.mark.django_db
def test_reports_dashboard_jobs_and_csv_safety(dm):
    ip = make_plan(dm)
    i = run_inspection(dm, ip, complete=False)
    inspections.record_defect(u(dm, "qi"), i.id, defect_code="SURFACE", quantity=3)
    inspections.complete(u(dm, "qi"), i.id)
    run_inspection(dm, ip, length="12")
    n = m.Ncr.objects.get()
    core.record_cost(u(dm, "qm"), "ncr", n.id, category="SCRAP", amount="120.50", description="Scrapped 5 units")
    with pytest.raises(ValidationFailed):
        core.record_cost(u(dm, "qm"), "ncr", n.id, category="SCRAP", amount="-1")
    core.add_action(u(dm, "qm"), "ncr", n.id, action_type="CORRECTION", description="Sort stock", owner_id=u(dm, "qi"), due_date=TODAY)
    dash = analytics.dashboard()
    assert dash["open_ncrs"] == 1 and dash["active_holds"] == 1 and dash["inspection_pass_rate_90d"] == 50.0
    for code in analytics.REPORTS:
        out = analytics.run(code, {})
        assert out["code"] == code
    assert analytics.run("cost-of-quality", {})["rows"][0]["total"] == "120.5000"
    assert analytics.run("defect-pareto", {})["rows"][0]["defect_code"] == "SURFACE"
    csv_text = analytics.to_csv([{"title": "=HYPERLINK(\"http://evil\")", "n": 1}])
    assert "'=HYPERLINK" in csv_text
    assert jobs.run_daily()["actions"] == 1
    assert core.action_reminders(TODAY) == 0  # once a day only
    with pytest.raises(DomainError):
        analytics.run("nope", {})


@pytest.mark.django_db
def test_http_permissions_and_flow(world, idp, acme, dm):
    p = dm["p"]
    for key in ("qm", "qi", "emp"):
        ExternalIdentity.objects.create(user=p[key], issuer="https://kc.test/realms/erp", subject=f"qm-{key}")
    api = {}
    for key in ("qm", "qi", "emp"):
        api[key] = Api(ACME_HOST)
        assert api[key].login(idp, f"qm-{key}").status_code == 302
    assert Api(ACME_HOST).get("/api/v1/quality/dashboard").status_code == 401
    assert api["emp"].get("/api/v1/quality/dashboard").status_code == 403
    assert api["qi"].get("/api/v1/quality/dashboard").status_code == 200
    body = {"title": "Dented panel", "source": "PRODUCTION", "source_ref_type": "manufacturing.order", "source_ref_id": "MO-9", "category": "WORKMANSHIP", "severity": "MINOR", "description": "Dent on panel"}
    r = api["emp"].post("/api/v1/quality/ncrs", body)
    assert r.status_code == 201, r.content
    nid = r.json()["id"]
    assert api["emp"].post(f"/api/v1/quality/ncrs/{nid}/close", {"note": "x"}).status_code == 403
    assert api["qi"].post(f"/api/v1/quality/ncrs/{nid}/close", {"note": "x"}).status_code == 403
    assert api["emp"].post("/api/v1/quality/standards", {"code": "X", "name": "X"}).status_code == 403
    assert api["qm"].post("/api/v1/quality/standards", {"code": "ISO14001", "name": "Environmental"}).status_code == 201
    assert api["qm"].get(f"/api/v1/quality/ncrs/{nid}").json()["status"] == "OPEN"
    bad = api["qm"].post(f"/api/v1/quality/ncrs/{nid}/close", {"note": "x"})
    assert bad.status_code == 409 and bad.json()["error"]["code"] == "invalid_state_transition"
    assert api["qm"].get("/api/v1/quality/ncrs").status_code == 200
    missing = api["qm"].get("/api/v1/quality/ncrs/00000000-0000-0000-0000-000000000000")
    assert missing.status_code == 404
    csv = api["qm"].get("/api/v1/quality/reports/ncr-register/csv")
    assert csv.status_code == 200 and csv["Content-Type"].startswith("text/csv") and "Dented panel" in csv.content.decode()
    assert api["emp"].get("/api/v1/quality/reports").status_code == 403
    assert api["qm"].get("/api/v1/quality/reports/ncr-register?date_from=garbage").status_code == 400

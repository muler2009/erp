"""Quality plans, objectives, control points, standards, requirements and compliance."""
from datetime import timedelta
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from modules.quality import approvals, core, models as m
from shared.api.errors import DomainError, ValidationFailed

SCOPES = ("DEPARTMENT", "PROJECT", "PRODUCT", "PROCESS", "CONTRACT")
EDITABLE = ("DRAFT",)


def dec(v, label="value"):
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        raise ValidationFailed(f"{label} must be a number.", code="invalid_fields")


def plan_dict(p, detail=False):
    d = {"id": str(p.id), "number": p.number, "title": p.title, "scope_type": p.scope_type, "scope_ref": p.scope_ref, "scope_label": p.scope_label, "status": p.status,
         "revision": p.revision, "owner_id": str(p.owner_id), "department_id": str(p.department_id) if p.department_id else None,
         "valid_from": p.valid_from.isoformat() if p.valid_from else None, "valid_to": p.valid_to.isoformat() if p.valid_to else None,
         "approved_at": p.approved_at.isoformat() if p.approved_at else None}
    if detail:
        d["standards"] = p.standards
        d["objectives"] = [objective_dict(o) for o in p.objectives.all()]
        d["control_points"] = [{"id": str(c.id), "name": c.name, "stage": c.stage, "frequency": c.frequency, "acceptance_criteria": c.acceptance_criteria,
                                "responsible_id": str(c.responsible_id), "inspection_plan_id": str(c.inspection_plan_id) if c.inspection_plan_id else None} for c in p.control_points.all()]
        d["revisions"] = [{"revision": r.revision, "reason": r.reason, "changed_by": str(r.changed_by), "at": r.at.isoformat(), "snapshot": r.snapshot} for r in p.revisions.order_by("revision")]
        d["history"] = core.history("plan", p.id)
    return d


def _snapshot(p):
    return {"title": p.title, "scope_type": p.scope_type, "scope_ref": p.scope_ref, "scope_label": p.scope_label, "standards": p.standards, "owner_id": str(p.owner_id),
            "valid_from": p.valid_from.isoformat() if p.valid_from else None, "valid_to": p.valid_to.isoformat() if p.valid_to else None,
            "control_points": [{"name": c.name, "stage": c.stage, "frequency": c.frequency, "acceptance_criteria": c.acceptance_criteria, "responsible_id": str(c.responsible_id)} for c in p.control_points.all()],
            "objectives": [{"name": o.name, "metric": o.metric, "target": str(o.target), "direction": o.direction} for o in p.objectives.all()]}


@transaction.atomic
def create_plan(actor, data):
    core.need(data, "title", "scope_type", "owner_id")
    if data["scope_type"] not in SCOPES:
        raise ValidationFailed("scope_type must be one of " + ", ".join(SCOPES), code="invalid_fields")
    p = m.QualityPlan.objects.create(number=core.number("quality.plan"), title=data["title"][:200], scope_type=data["scope_type"], scope_ref=str(data.get("scope_ref") or "")[:64],
                                     scope_label=(data.get("scope_label") or "")[:200], standards=data.get("standards", ""), owner_id=data["owner_id"], department_id=data.get("department_id"),
                                     valid_from=data.get("valid_from"), valid_to=data.get("valid_to"), created_by=actor)
    core.event("plan", p.id, "CREATED", actor, to_status="DRAFT")
    return p


def get_plan(pk):
    p = m.QualityPlan.objects.filter(pk=pk).first()
    if p is None:
        raise core.nf("Quality plan")
    return p


@transaction.atomic
def update_plan(actor, pk, data):
    p = core.lock(m.QualityPlan, pk, "Quality plan")
    if p.status not in EDITABLE:
        raise core.bad_state("Only a draft plan can be edited. Use a revision to change an approved plan.")
    for f in ("title", "standards", "scope_label", "scope_ref", "owner_id", "department_id", "valid_from", "valid_to"):
        if f in data:
            setattr(p, f, data[f])
    p.save()
    core.event("plan", p.id, "UPDATED", actor)
    return p


@transaction.atomic
def add_objective(actor, plan_id, data):
    p = core.lock(m.QualityPlan, plan_id, "Quality plan")
    if p.status not in EDITABLE:
        raise core.bad_state("Objectives change only in a draft revision.")
    core.need(data, "name", "metric", "target", "owner_id")
    if data.get("direction", "LOWER") not in ("LOWER", "HIGHER"):
        raise ValidationFailed("direction must be LOWER or HIGHER.", code="invalid_fields")
    o = m.Objective.objects.create(plan=p, name=data["name"][:200], metric=data["metric"][:30], target=dec(data["target"], "target"), direction=data.get("direction", "LOWER"), unit=data.get("unit", ""), owner_id=data["owner_id"])
    core.event("plan", p.id, "OBJECTIVE_ADDED", actor, note=o.name)
    return o


def objective_dict(o):
    last = o.measurements.order_by("-period").first()
    value = last.value if last else None
    met = None
    if value is not None:
        met = value <= o.target if o.direction == "LOWER" else value >= o.target
    return {"id": str(o.id), "plan_id": str(o.plan_id), "name": o.name, "metric": o.metric, "target": str(o.target), "direction": o.direction, "unit": o.unit,
            "owner_id": str(o.owner_id), "latest_value": str(value) if value is not None else None, "latest_period": last.period.isoformat() if last else None, "met": met}


@transaction.atomic
def measure_objective(actor, objective_id, *, period, value):
    o = m.Objective.objects.select_related("plan").filter(pk=objective_id).first()
    if o is None:
        raise core.nf("Objective")
    if o.plan.status != "APPROVED":
        raise core.bad_state("Measure only the objectives of an approved plan.")
    obj, created = m.ObjectiveMeasurement.objects.update_or_create(objective=o, period=period, defaults={"value": dec(value), "recorded_by": actor})
    core.event("plan", o.plan_id, "OBJECTIVE_MEASURED", actor, note=f"{o.name}: {value}")
    return obj


@transaction.atomic
def add_control_point(actor, plan_id, data):
    p = core.lock(m.QualityPlan, plan_id, "Quality plan")
    if p.status not in EDITABLE:
        raise core.bad_state("Control points change only in a draft revision.")
    core.need(data, "name", "responsible_id")
    c = m.ControlPoint.objects.create(plan=p, name=data["name"][:200], stage=data.get("stage", ""), frequency=data.get("frequency", ""), acceptance_criteria=data.get("acceptance_criteria", ""),
                                      responsible_id=data["responsible_id"], department_id=data.get("department_id"), inspection_plan_id=data.get("inspection_plan_id"))
    core.event("plan", p.id, "CONTROL_POINT_ADDED", actor, note=c.name)
    return c


@transaction.atomic
def submit_plan(actor, pk, *, comment=""):
    p = core.lock(m.QualityPlan, pk, "Quality plan")
    if p.status != "DRAFT":
        raise core.bad_state("Only a draft plan can be submitted.")
    if not p.control_points.exists() and not p.objectives.exists():
        raise ValidationFailed("Add at least one objective or control point before submitting.", code="plan_incomplete")
    approvals.submit(actor, "quality.plan", p, title=f"Quality plan {p.number} r{p.revision}: {p.title}", comment=comment)
    core.set_status(p, "plan", "PENDING_APPROVAL", actor, "SUBMITTED", note=comment)
    return p


@transaction.atomic
def revise_plan(actor, pk, *, reason):
    """Approved plans are never edited in place: the approved content is stored as a revision and the plan reopens as a draft."""
    p = core.lock(m.QualityPlan, pk, "Quality plan")
    if p.status != "APPROVED":
        raise core.bad_state("Only an approved plan can be revised.")
    if not reason:
        raise ValidationFailed("Give the reason for the revision.", code="invalid_fields")
    m.PlanRevision.objects.create(plan=p, revision=p.revision, snapshot=_snapshot(p), reason=reason[:300], changed_by=actor, approved_by=p.approved_by)
    p.revision += 1
    core.set_status(p, "plan", "DRAFT", actor, "REVISION_STARTED", note=reason, workflow_instance_id=None)
    return p


def list_plans(status=None, scope_type=None):
    qs = m.QualityPlan.objects.all().order_by("-created_at")
    if status:
        qs = qs.filter(status=status)
    if scope_type:
        qs = qs.filter(scope_type=scope_type)
    return qs


# ----------------------------------------------------------------------------- standards
def standard_dict(s, detail=False):
    d = {"id": str(s.id), "code": s.code, "name": s.name, "kind": s.kind, "issuer": s.issuer, "version": s.version, "status": s.status,
         "effective_from": s.effective_from.isoformat() if s.effective_from else None}
    if detail:
        d["requirements"] = [requirement_dict(r) for r in s.requirements.all().order_by("clause")]
        d["changes"] = [{"from_version": c.from_version, "to_version": c.to_version, "summary": c.summary, "effective_on": c.effective_on.isoformat() if c.effective_on else None, "impact": c.impact} for c in s.changes.order_by("created_at")]
    return d


@transaction.atomic
def save_standard(actor, data, pk=None):
    core.need(data, "code", "name")
    if pk:
        s = core.lock(m.Standard, pk, "Standard")
        for f in ("name", "kind", "issuer", "effective_from", "status"):
            if f in data:
                setattr(s, f, data[f])
        s.save()
    else:
        if m.Standard.objects.filter(code=data["code"]).exists():
            raise ValidationFailed("A standard with this code already exists.", code="duplicate")
        s = m.Standard.objects.create(code=data["code"][:40], name=data["name"][:200], kind=data.get("kind", "STANDARD"), issuer=data.get("issuer", ""), version=data.get("version", ""), effective_from=data.get("effective_from"))
    core.audit("quality.standard.saved", actor, "quality.standard", s.id, code=s.code)
    return s


@transaction.atomic
def new_standard_version(actor, pk, *, version, summary, effective_on=None, impact=""):
    """A new version of a standard flags every requirement for re-assessment; the old assessments stay on record."""
    s = core.lock(m.Standard, pk, "Standard")
    core.need({"version": version, "summary": summary}, "version", "summary")
    if version == s.version:
        raise ValidationFailed("This is already the current version.", code="duplicate")
    m.StandardChange.objects.create(standard=s, from_version=s.version, to_version=version, summary=summary[:500], effective_on=effective_on, impact=impact[:500], recorded_by=actor)
    s.version = version
    s.effective_from = effective_on or s.effective_from
    s.save(update_fields=["version", "effective_from", "updated_at"])
    reqs = list(s.requirements.all())
    s.requirements.update(needs_review=True)
    from shared.notifications.services import notify
    for owner in {r.owner_id for r in reqs}:
        notify([owner], "quality.standard_changed", f"{s.code} changed to {version}", summary[:200], ref_type="quality.standard", ref_id=str(s.id))
    core.event("standard", s.id, "NEW_VERSION", actor, note=f"{version}: {summary[:200]}")
    return s


def requirement_dict(r):
    last = r.assessments.order_by("-assessed_on", "-created_at").first()
    return {"id": str(r.id), "standard_id": str(r.standard_id), "clause": r.clause, "text": r.text, "status": r.status, "owner_id": str(r.owner_id),
            "department_id": str(r.department_id) if r.department_id else None, "next_review_on": r.next_review_on.isoformat() if r.next_review_on else None,
            "needs_review": r.needs_review, "documents": [str(x.document_id) for x in r.mappings.all()],
            "last_gap": last.gap if last else ""}


@transaction.atomic
def add_requirement(actor, standard_id, data):
    s = core.lock(m.Standard, standard_id, "Standard")
    core.need(data, "clause", "text", "owner_id")
    if s.requirements.filter(clause=data["clause"]).exists():
        raise ValidationFailed("This clause is already recorded.", code="duplicate")
    r = m.Requirement.objects.create(standard=s, clause=data["clause"][:40], text=data["text"], owner_id=data["owner_id"], department_id=data.get("department_id"), next_review_on=data.get("next_review_on"))
    core.audit("quality.requirement.added", actor, "quality.requirement", r.id)
    return r


@transaction.atomic
def map_document(actor, requirement_id, *, document_id, note=""):
    from modules.documents.models import Document
    r = core.lock(m.Requirement, requirement_id, "Requirement")
    if not Document.objects.filter(pk=document_id).exists():
        raise core.nf("Document")
    obj, _ = m.RequirementMapping.objects.get_or_create(requirement=r, document_id=document_id, defaults={"note": note[:200]})
    return obj


@transaction.atomic
def assess(actor, requirement_id, *, status, gap="", notes="", evidence_document_id=None, next_review_on=None):
    r = core.lock(m.Requirement, requirement_id, "Requirement")
    if status not in ("COMPLIANT", "PARTIAL", "NON_COMPLIANT", "NOT_APPLICABLE"):
        raise ValidationFailed("status must be COMPLIANT, PARTIAL, NON_COMPLIANT or NOT_APPLICABLE.", code="invalid_fields")
    if status in ("PARTIAL", "NON_COMPLIANT") and not gap:
        raise ValidationFailed("Describe the gap.", code="gap_required")
    if status == "NOT_APPLICABLE" and not notes:
        raise ValidationFailed("Explain why the requirement does not apply.", code="invalid_fields")
    a = m.Assessment.objects.create(requirement=r, status=status, assessed_on=core.today(), assessor_id=actor, gap=gap[:500], notes=notes[:500], evidence_document_id=evidence_document_id)
    r.status, r.needs_review = status, False
    r.next_review_on = next_review_on or (core.today() + timedelta(days=365))
    r.save(update_fields=["status", "needs_review", "next_review_on", "updated_at"])
    core.audit("quality.requirement.assessed", actor, "quality.requirement", r.id, status=status)
    return a


def compliance_summary(standard_id=None, department_id=None):
    qs = m.Requirement.objects.all()
    if standard_id:
        qs = qs.filter(standard_id=standard_id)
    if department_id:
        qs = qs.filter(department_id=department_id)
    counts = {k: 0 for k in ("NOT_ASSESSED", "COMPLIANT", "PARTIAL", "NON_COMPLIANT", "NOT_APPLICABLE")}
    for r in qs:
        counts[r.status] += 1
    applicable = sum(v for k, v in counts.items() if k != "NOT_APPLICABLE")
    pct = round(100 * counts["COMPLIANT"] / applicable, 1) if applicable else None
    return {"counts": counts, "total": sum(counts.values()), "compliance_percent": pct,
            "gaps": [requirement_dict(r) for r in qs.filter(status__in=("PARTIAL", "NON_COMPLIANT"))[:100]],
            "due_for_review": qs.filter(next_review_on__lte=core.today()).count() + qs.filter(needs_review=True, next_review_on__gt=core.today()).count()}


def compliance_reminders(on):
    from shared.notifications.services import notify
    n = 0
    for r in m.Requirement.objects.filter(next_review_on__lte=on):
        notify([r.owner_id], "quality.requirement_review", f"Compliance review due: {r.standard.code} {r.clause}", r.text[:150], ref_type="quality.requirement", ref_id=str(r.id))
        r.next_review_on = on + timedelta(days=30)
        r.save(update_fields=["next_review_on"])
        n += 1
    return n

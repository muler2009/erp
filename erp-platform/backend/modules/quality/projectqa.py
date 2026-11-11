"""Project and construction quality: inspection requests, hold points and punch lists."""
from django.db import transaction

from modules.quality import core, inspections, models as m
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify


def _project(pk):
    from modules.projects.models import Project
    p = Project.objects.filter(pk=pk).first()
    if p is None:
        raise core.nf("Project")
    return p


def request_dict(r, detail=False):
    d = {"id": str(r.id), "number": r.number, "project_id": str(r.project_id), "kind": r.kind, "status": r.status, "hold_point": r.hold_point, "location": r.location, "contractor": r.contractor,
         "requested_for": r.requested_for.isoformat(), "activity_task_id": str(r.activity_task_id) if r.activity_task_id else None, "plan_id": str(r.plan_id) if r.plan_id else None,
         "inspection_id": str(r.inspection_id) if r.inspection_id else None, "drawing_document_id": str(r.drawing_document_id) if r.drawing_document_id else None,
         "decision_note": r.decision_note}
    if detail:
        d["punch_items"] = [punch_dict(p) for p in r.punch_items.all()]
        d["history"] = core.history("inspection_request", r.id)
        d["evidence"] = core.list_evidence("inspection_request", r.id)
    return d


def get_request(pk):
    r = m.InspectionRequest.objects.filter(pk=pk).first()
    if r is None:
        raise core.nf("Inspection request")
    return r


@transaction.atomic
def request_inspection(actor, data):
    core.need(data, "project_id", "requested_for")
    _project(data["project_id"])
    kind = data.get("kind", "WORK")
    if kind not in ("WORK", "MATERIAL", "COMPLETION", "HANDOVER"):
        raise ValidationFailed("Unknown request kind.", code="invalid_fields")
    plan = None
    if data.get("plan_id"):
        plan = inspections.get_plan(data["plan_id"])
    if data.get("hold_point") and not data.get("activity_task_id"):
        raise ValidationFailed("A hold point must name the activity it holds.", code="invalid_fields")
    if data.get("activity_task_id"):
        from modules.projects.models import Task
        if not Task.objects.filter(pk=data["activity_task_id"], project_id=data["project_id"]).exists():
            raise core.nf("Task")
    r = m.InspectionRequest.objects.create(number=core.number("quality.inspection_request"), project_id=data["project_id"], plan=plan, kind=kind, activity_task_id=data.get("activity_task_id"),
                                           location=data.get("location", ""), drawing_document_id=data.get("drawing_document_id"), contractor=data.get("contractor", ""), requested_by=actor,
                                           requested_for=data["requested_for"], hold_point=bool(data.get("hold_point")))
    core.event("inspection_request", r.id, "REQUESTED", actor, to_status="REQUESTED")
    notify(list(core.users_with_permission("quality.project.manage") - {actor}), "quality.inspection_requested", f"Inspection request {r.number}", f"{r.location or 'project'} for {r.requested_for}", ref_type="quality.inspection_request", ref_id=str(r.id))
    return r


@transaction.atomic
def schedule(actor, pk, *, inspector_id, scheduled_for=None, plan_id=None, product_id=None):
    r = core.lock(m.InspectionRequest, pk, "Inspection request")
    if r.status != "REQUESTED":
        raise core.bad_state("Only a new request can be scheduled.")
    plan = inspections.get_plan(plan_id) if plan_id else r.plan
    if plan is None:
        raise ValidationFailed("Choose the inspection plan (ITP) to use.", code="plan_required")
    i = inspections.schedule(actor, {"plan_id": plan.id, "scheduled_for": scheduled_for or r.requested_for, "inspector_id": inspector_id, "project_id": r.project_id,
                                     "ref_type": "quality.inspection_request", "ref_id": r.id, "product_id": product_id, "quantity_total": 0})
    r.plan, r.inspection, r.status = plan, i, "SCHEDULED"
    r.save(update_fields=["plan", "inspection", "status", "updated_at"])
    core.event("inspection_request", r.id, "SCHEDULED", actor, to_status="SCHEDULED", note=i.number)
    return r


@transaction.atomic
def decide(actor, pk, *, approve, note):
    """Accept or reject the inspected work. Only a passed (or conditionally passed) inspection can be approved, and not by the inspector alone."""
    r = core.lock(m.InspectionRequest, pk, "Inspection request")
    if r.status != "INSPECTED":
        raise core.bad_state("The work must be inspected before it is accepted or rejected.")
    if not note:
        raise ValidationFailed("Record the decision.", code="invalid_fields")
    i = r.inspection
    if approve:
        if i is None or i.result not in ("PASS", "CONDITIONAL"):
            raise DomainError("The inspection did not pass.", code="inspection_not_passed", status_code=409)
        if i.inspector_id == actor and r.hold_point:
            raise DomainError("A hold point is released by someone other than the inspector.", code="separation_of_duties", status_code=403)
        if r.punch_items.exclude(status="CLOSED").filter(severity="MAJOR").exists():
            raise DomainError("Major punch items are still open.", code="punch_open", status_code=409)
    r.decided_by, r.decision_note = actor, note[:500]
    core.set_status(r, "inspection_request", "APPROVED" if approve else "REJECTED", actor, "APPROVED" if approve else "REJECTED", note=note)
    return r


@transaction.atomic
def cancel(actor, pk, *, reason):
    r = core.lock(m.InspectionRequest, pk, "Inspection request")
    if r.status not in ("REQUESTED", "SCHEDULED"):
        raise core.bad_state("The request can no longer be cancelled.")
    if not reason:
        raise ValidationFailed("Give a reason.", code="invalid_fields")
    if r.inspection_id:
        inspections.cancel(actor, r.inspection_id, reason=reason)
    core.set_status(r, "inspection_request", "CANCELLED", actor, "CANCELLED", note=reason)
    return r


def list_requests(**f):
    qs = m.InspectionRequest.objects.all().order_by("-created_at")
    for k in ("project_id", "status", "kind"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    if f.get("hold_point"):
        qs = qs.filter(hold_point=True)
    return qs


def task_guard(task, new_status):
    """A task cannot start or finish while a predecessor's hold point is not yet approved."""
    from modules.projects.models import TaskDependency
    preds = list(TaskDependency.objects.filter(successor=task).values_list("predecessor_id", flat=True))
    held = m.InspectionRequest.objects.filter(activity_task_id__in=preds, hold_point=True).exclude(status__in=("APPROVED", "CANCELLED"))
    first = held.first()
    if first:
        raise DomainError(f"Hold point {first.number} must be approved before this task can proceed.", code="quality_hold_point", status_code=409)


# ----------------------------------------------------------------------------- punch list
def punch_dict(p):
    return {"id": str(p.id), "number": p.number, "project_id": str(p.project_id), "location": p.location, "description": p.description, "severity": p.severity, "status": p.status,
            "assigned_to": str(p.assigned_to) if p.assigned_to else None, "contractor": p.contractor, "due_date": p.due_date.isoformat() if p.due_date else None,
            "request_id": str(p.request_id) if p.request_id else None, "fixed_note": p.fixed_note}


@transaction.atomic
def raise_punch(actor, data):
    core.need(data, "project_id", "description")
    _project(data["project_id"])
    if data.get("severity", "MINOR") not in ("MINOR", "MAJOR"):
        raise ValidationFailed("severity must be MINOR or MAJOR.", code="invalid_fields")
    if data.get("request_id") and not m.InspectionRequest.objects.filter(pk=data["request_id"], project_id=data["project_id"]).exists():
        raise core.nf("Inspection request")
    p = m.PunchItem.objects.create(number=core.number("quality.punch"), project_id=data["project_id"], location=data.get("location", ""), description=data["description"][:500],
                                   severity=data.get("severity", "MINOR"), assigned_to=data.get("assigned_to"), contractor=data.get("contractor", ""), due_date=data.get("due_date"),
                                   request_id=data.get("request_id"), raised_by=actor)
    core.event("punch", p.id, "RAISED", actor, to_status="OPEN")
    if p.assigned_to:
        notify([p.assigned_to], "quality.punch_assigned", f"Punch item {p.number}", p.description[:150], ref_type="quality.punch", ref_id=str(p.id))
    return p


def get_punch(pk):
    p = m.PunchItem.objects.filter(pk=pk).first()
    if p is None:
        raise core.nf("Punch item")
    return p


@transaction.atomic
def punch_fixed(actor, pk, *, note):
    p = core.lock(m.PunchItem, pk, "Punch item")
    if p.status != "OPEN":
        raise core.bad_state("Only an open item can be marked fixed.")
    if not note:
        raise ValidationFailed("Describe the rectification.", code="invalid_fields")
    core.set_status(p, "punch", "FIXED", actor, "FIXED", note=note, fixed_note=note[:500])
    return p


@transaction.atomic
def punch_verify(actor, pk, *, accept, note=""):
    p = core.lock(m.PunchItem, pk, "Punch item")
    if p.status != "FIXED":
        raise core.bad_state("Only a fixed item can be verified.")
    if p.assigned_to == actor:
        raise DomainError("The person who fixed an item cannot verify it.", code="separation_of_duties", status_code=403)
    if accept:
        core.set_status(p, "punch", "CLOSED", actor, "VERIFIED", note=note, verified_by=actor)
    else:
        if not note:
            raise ValidationFailed("Say what is still wrong.", code="invalid_fields")
        core.set_status(p, "punch", "OPEN", actor, "REJECTED_FIX", note=note)
    return p


def list_punch(**f):
    qs = m.PunchItem.objects.all().order_by("-created_at")
    for k in ("project_id", "status", "severity", "assigned_to", "request_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    return qs

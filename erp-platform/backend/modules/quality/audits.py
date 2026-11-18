"""Audit programme, checklists, findings and follow-up. A finding stays open until its action is closed."""
from django.db import transaction
from django.utils import timezone

from modules.quality import core, ncr, models as m
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify

RESPONSES = ("CONFORMS", "NONCONFORMS", "OBSERVATION", "NOT_APPLICABLE")


def audit_dict(a, detail=False):
    d = {"id": str(a.id), "number": a.number, "program": a.program, "audit_type": a.audit_type, "title": a.title, "status": a.status, "planned_start": a.planned_start.isoformat(),
         "planned_end": a.planned_end.isoformat(), "lead_auditor_id": str(a.lead_auditor_id), "auditee_department_id": str(a.auditee_department_id) if a.auditee_department_id else None,
         "supplier_id": str(a.supplier_id) if a.supplier_id else None, "follow_up_of": str(a.follow_up_of_id) if a.follow_up_of_id else None,
         "findings_open": a.findings.exclude(status="CLOSED").count(), "findings_total": a.findings.count()}
    if detail:
        d.update({"scope": a.scope, "objectives": a.objectives, "criteria": a.criteria, "summary": a.summary,
                  "team": [{"user_id": str(t.user_id), "role": t.role} for t in a.team.all()],
                  "checklist": [checklist_dict(c) for c in a.checklist.order_by("position")],
                  "findings": [finding_dict(f) for f in a.findings.order_by("created_at")], "evidence": core.list_evidence("audit", a.id), "history": core.history("audit", a.id)})
    return d


def checklist_dict(c):
    return {"id": str(c.id), "position": c.position, "question": c.question, "response": c.response, "note": c.note, "requirement_id": str(c.requirement_id) if c.requirement_id else None,
            "procedure_document_id": str(c.procedure_document_id) if c.procedure_document_id else None}


def finding_dict(f):
    return {"id": str(f.id), "number": f.number, "audit_id": str(f.audit_id), "finding_type": f.finding_type, "severity": f.severity, "description": f.description, "requirement_ref": f.requirement_ref,
            "checklist_item_id": str(f.checklist_item_id) if f.checklist_item_id else None, "status": f.status, "due_date": f.due_date.isoformat() if f.due_date else None, "owner_id": str(f.owner_id) if f.owner_id else None, "capa_id": str(f.capa_id) if f.capa_id else None,
            "closure_note": f.closure_note, "actions": core.list_actions("finding", f.id)}


def get_audit(pk):
    a = m.Audit.objects.filter(pk=pk).first()
    if a is None:
        raise core.nf("Audit")
    return a


@transaction.atomic
def save_template(actor, data):
    core.need(data, "name", "audit_type", "questions")
    if not isinstance(data["questions"], list) or not all(isinstance(q, dict) and q.get("question") for q in data["questions"]):
        raise ValidationFailed("questions must be a list of objects with a question.", code="invalid_fields")
    t, _ = m.ChecklistTemplate.objects.update_or_create(name=data["name"][:120], defaults={"audit_type": data["audit_type"], "questions": data["questions"], "is_active": data.get("is_active", True)})
    return t


@transaction.atomic
def schedule(actor, data):
    core.need(data, "audit_type", "title", "scope", "planned_start", "planned_end", "lead_auditor_id")
    core.config_item("AUDIT_TYPE", data["audit_type"])
    if data["planned_end"] < data["planned_start"]:
        raise ValidationFailed("The audit cannot end before it starts.", code="invalid_dates")
    team = [str(x) for x in data.get("team", [])]
    auditee = data.get("auditee_user_ids", [])
    if str(data["lead_auditor_id"]) in [str(x) for x in auditee]:
        raise DomainError("An auditor cannot audit their own area.", code="separation_of_duties", status_code=403)
    a = m.Audit.objects.create(number=core.number("quality.audit"), program=data.get("program", ""), audit_type=data["audit_type"], title=data["title"][:200], scope=data["scope"],
                               objectives=data.get("objectives", ""), criteria=data.get("criteria", ""), planned_start=data["planned_start"], planned_end=data["planned_end"],
                               lead_auditor_id=data["lead_auditor_id"], auditee_department_id=data.get("auditee_department_id"), supplier_id=data.get("supplier_id"),
                               follow_up_of_id=data.get("follow_up_of"), created_by=actor)
    m.AuditMember.objects.create(audit=a, user_id=a.lead_auditor_id, role="LEAD")
    for u in team:
        if u != str(a.lead_auditor_id):
            m.AuditMember.objects.get_or_create(audit=a, user_id=u, defaults={"role": "AUDITOR"})
    if data.get("template_id"):
        t = m.ChecklistTemplate.objects.filter(pk=data["template_id"], is_active=True).first()
        if t is None:
            raise core.nf("Checklist template")
        _from_template(a, t)
    core.event("audit", a.id, "SCHEDULED", actor, to_status="PLANNED")
    notify(list({a.lead_auditor_id, *[t.user_id for t in a.team.all()]} - {actor}), "quality.audit_scheduled", f"Audit {a.number}", f"{a.title} {a.planned_start} to {a.planned_end}", ref_type="quality.audit", ref_id=str(a.id))
    return a


def _from_template(a, t):
    for pos, q in enumerate(t.questions, start=1):
        req = None
        if q.get("requirement") and ":" in q["requirement"]:
            code, clause = q["requirement"].split(":", 1)
            req = m.Requirement.objects.filter(standard__code=code, clause=clause).first()
        m.ChecklistItem.objects.create(audit=a, position=pos, question=q["question"][:500], requirement=req, procedure_document_id=q.get("procedure_document_id"))


def _is_team(actor, a):
    from platform_core.authorization import services as authz
    return a.team.filter(user_id=actor).exists() or authz.has_permission(actor, "quality.capa.verify")


@transaction.atomic
def add_checklist_item(actor, audit_id, *, question, requirement_id=None, procedure_document_id=None):
    a = core.lock(m.Audit, audit_id, "Audit")
    if a.status not in ("PLANNED", "IN_PROGRESS"):
        raise core.bad_state("The checklist is closed.")
    pos = (a.checklist.order_by("-position").values_list("position", flat=True).first() or 0) + 1
    return m.ChecklistItem.objects.create(audit=a, position=pos, question=question[:500], requirement_id=requirement_id, procedure_document_id=procedure_document_id)


@transaction.atomic
def start(actor, pk):
    a = core.lock(m.Audit, pk, "Audit")
    if not _is_team(actor, a):
        raise core.nf("Audit")
    if a.status != "PLANNED":
        raise core.bad_state("Only a planned audit can be started.")
    core.set_status(a, "audit", "IN_PROGRESS", actor, "STARTED")
    return a


@transaction.atomic
def answer(actor, item_id, *, response, note=""):
    item = m.ChecklistItem.objects.select_related("audit").filter(pk=item_id).first()
    if item is None:
        raise core.nf("Checklist item")
    a = core.lock(m.Audit, item.audit_id, "Audit")
    if not _is_team(actor, a):
        raise core.nf("Audit")
    if a.status != "IN_PROGRESS":
        raise core.bad_state("Answers are recorded while the audit is in progress.")
    if response not in RESPONSES:
        raise ValidationFailed("Unknown response.", code="invalid_fields")
    if response in ("NONCONFORMS", "OBSERVATION") and not note:
        raise ValidationFailed("Describe what was observed.", code="invalid_fields")
    item.response, item.note, item.answered_by = response, note[:500], actor
    item.save(update_fields=["response", "note", "answered_by", "updated_at"])
    return item


@transaction.atomic
def raise_finding(actor, audit_id, data):
    a = core.lock(m.Audit, audit_id, "Audit")
    if not _is_team(actor, a):
        raise core.nf("Audit")
    if a.status != "IN_PROGRESS":
        raise core.bad_state("Findings are raised while the audit is in progress.")
    core.need(data, "finding_type", "severity", "description")
    core.config_item("FINDING_TYPE", data["finding_type"])
    core.config_item("SEVERITY", data["severity"])
    item = None
    if data.get("checklist_item_id"):
        item = a.checklist.filter(pk=data["checklist_item_id"]).first()
        if item is None:
            raise core.nf("Checklist item")
    f = m.Finding.objects.create(number=core.number("quality.finding"), audit=a, checklist_item=item, finding_type=data["finding_type"], severity=data["severity"], description=data["description"],
                                 requirement_ref=data.get("requirement_ref", ""), due_date=data.get("due_date"), owner_id=data.get("owner_id"), recorded_by=actor)
    core.event("audit", a.id, "FINDING_RAISED", actor, note=f.number)
    core.event("finding", f.id, "RAISED", actor, to_status="OPEN", note=f.description[:200])
    if f.owner_id:
        notify([f.owner_id], "quality.finding_assigned", f"Audit finding {f.number}", f.description[:200], ref_type="quality.audit", ref_id=str(a.id))
    return f


def get_finding(pk):
    f = m.Finding.objects.filter(pk=pk).first()
    if f is None:
        raise core.nf("Finding")
    return f


@transaction.atomic
def assign_finding(actor, pk, *, owner_id, due_date):
    f = core.lock(m.Finding, pk, "Finding")
    if f.status == "CLOSED":
        raise core.bad_state("The finding is closed.")
    f.owner_id, f.due_date = owner_id, due_date
    f.save(update_fields=["owner_id", "due_date", "updated_at"])
    notify([owner_id], "quality.finding_assigned", f"Audit finding {f.number}", f.description[:200], ref_type="quality.audit", ref_id=str(f.audit_id))
    core.event("finding", f.id, "ASSIGNED", actor)
    return f


@transaction.atomic
def finding_capa(actor, pk, *, owner_id, reviewer_id, due_date, kind="CORRECTIVE"):
    f = core.lock(m.Finding, pk, "Finding")
    if f.capa_id:
        raise ValidationFailed("A CAPA is already linked.", code="duplicate")
    c = ncr.create_capa_record(actor, {"kind": kind, "title": f"CAPA for finding {f.number}", "source_type": "AUDIT_FINDING", "source_id": f.id, "problem": f.description,
                                       "owner_id": owner_id, "reviewer_id": reviewer_id, "due_date": due_date})
    f.capa_id, f.status = c.id, "ACTION_ASSIGNED"
    f.save(update_fields=["capa_id", "status", "updated_at"])
    core.event("finding", f.id, "CAPA_LINKED", actor, to_status="ACTION_ASSIGNED", note=c.number)
    return c


@transaction.atomic
def close_finding(actor, pk, *, note):
    f = core.lock(m.Finding, pk, "Finding")
    a = core.lock(m.Audit, f.audit_id, "Audit")
    if f.status == "CLOSED":
        raise core.bad_state("The finding is already closed.")
    if not _is_team(actor, a):
        raise core.nf("Finding")
    if not note:
        raise ValidationFailed("Record how closure was verified.", code="invalid_fields")
    if f.finding_type == "NONCONFORMITY":
        c = m.Capa.objects.filter(pk=f.capa_id).first() if f.capa_id else None
        has_actions = m.Action.objects.filter(parent_type="finding", parent_id=f.id).exclude(status="CANCELLED").exists()
        if c is None and not has_actions:
            raise DomainError("A non-conformity needs a corrective action before it can be closed.", code="action_required", status_code=409)
        if c is not None and c.status != "CLOSED":
            raise DomainError("The linked CAPA is not closed.", code="capa_open", status_code=409)
        if m.Action.objects.filter(parent_type="finding", parent_id=f.id, status__in=("OPEN", "DONE")).exists():
            raise DomainError("Every action on this finding must be verified.", code="actions_unverified", status_code=409)
    core.set_status(f, "finding", "CLOSED", actor, "CLOSED", note=note, closed_at=timezone.now(), closed_by=actor, closure_note=note[:500])
    return f


@transaction.atomic
def report(actor, pk, *, summary):
    a = core.lock(m.Audit, pk, "Audit")
    if not _is_team(actor, a):
        raise core.nf("Audit")
    if a.status != "IN_PROGRESS":
        raise core.bad_state("Only an audit in progress can be reported.")
    pending = a.checklist.filter(response="PENDING").count()
    if pending:
        raise DomainError(f"{pending} checklist question(s) are unanswered.", code="checklist_incomplete", status_code=409)
    if not summary:
        raise ValidationFailed("Write the audit summary.", code="invalid_fields")
    raised = set(m.Finding.objects.filter(audit=a, checklist_item__isnull=False).values_list("checklist_item_id", flat=True))
    unraised = a.checklist.filter(response="NONCONFORMS").exclude(pk__in=raised).count()
    if unraised:
        raise DomainError(f"{unraised} non-conforming answer(s) have no finding raised.", code="finding_missing", status_code=409)
    core.set_status(a, "audit", "REPORTED", actor, "REPORTED", summary=summary, reported_at=timezone.now())
    notify(list({a.created_by} | {f.owner_id for f in a.findings.all() if f.owner_id}), "quality.audit_reported", f"Audit {a.number} reported", summary[:200], ref_type="quality.audit", ref_id=str(a.id))
    return a


@transaction.atomic
def close_audit(actor, pk):
    a = core.lock(m.Audit, pk, "Audit")
    if a.status != "REPORTED":
        raise core.bad_state("Only a reported audit can be closed.")
    if a.findings.exclude(status="CLOSED").exists():
        raise DomainError("Every finding must be closed before the audit is closed.", code="findings_open", status_code=409)
    core.set_status(a, "audit", "CLOSED", actor, "CLOSED")
    return a


@transaction.atomic
def cancel(actor, pk, *, reason):
    a = core.lock(m.Audit, pk, "Audit")
    if a.status not in ("PLANNED",):
        raise core.bad_state("Only a planned audit can be cancelled.")
    if not reason:
        raise ValidationFailed("Give a reason.", code="invalid_fields")
    core.set_status(a, "audit", "CANCELLED", actor, "CANCELLED", note=reason)
    return a


def list_audits(**f):
    qs = m.Audit.objects.all().order_by("-planned_start")
    for k in ("status", "audit_type", "supplier_id", "lead_auditor_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    return qs


def list_findings(**f):
    qs = m.Finding.objects.all().order_by("-created_at")
    for k in ("status", "severity", "owner_id", "audit_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    if f.get("overdue"):
        qs = qs.exclude(status="CLOSED").filter(due_date__lt=core.today())
    return qs


def reminders(on):
    n = 0
    for f in m.Finding.objects.exclude(status="CLOSED").filter(due_date__lt=on, owner_id__isnull=False):
        if m.Event.objects.filter(record_type="finding", record_id=f.id, action="OVERDUE", at__date=on).exists():
            continue
        core.event("finding", f.id, "OVERDUE", None)
        notify([f.owner_id], "quality.finding_overdue", f"Audit finding {f.number} overdue", f.description[:150], ref_type="quality.audit", ref_id=str(f.audit_id))
        n += 1
    return n

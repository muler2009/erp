"""Non-conformance reports and corrective/preventive actions."""
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from modules.quality import approvals, core, holds, models as m
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.notifications.services import notify

SOURCES = ("INSPECTION", "AUDIT", "PRODUCTION", "PROJECT", "COMPLAINT", "SUPPLIER", "OTHER")
CLOSED_ACTION = ("VERIFIED", "CANCELLED")


def ncr_dict(n, detail=False):
    d = {"id": str(n.id), "number": n.number, "title": n.title, "source": n.source, "source_ref_type": n.source_ref_type, "source_ref_id": n.source_ref_id, "category": n.category,
         "severity": n.severity, "status": n.status, "detected_on": n.detected_on.isoformat(), "department_id": str(n.department_id) if n.department_id else None,
         "product_id": str(n.product_id) if n.product_id else None, "supplier_id": str(n.supplier_id) if n.supplier_id else None, "project_id": str(n.project_id) if n.project_id else None,
         "lot_number": n.lot_number, "investigator_id": str(n.investigator_id) if n.investigator_id else None, "reported_by": str(n.reported_by), "capa_id": str(n.capa_id) if n.capa_id else None,
         "reopened_count": n.reopened_count, "closed_at": n.closed_at.isoformat() if n.closed_at else None}
    if detail:
        d.update({"description": n.description, "affected_items": n.affected_items, "location": n.location, "containment": n.containment, "root_cause": n.root_cause,
                  "proposed_correction": n.proposed_correction, "verification_note": n.verification_note, "actions": core.list_actions("ncr", n.id), "evidence": core.list_evidence("ncr", n.id),
                  "costs": core.costs_for("ncr", n.id), "history": core.history("ncr", n.id),
                  "holds": [h.number for h in m.Hold.objects.filter(source_type="ncr", source_id=n.id)]})
    return d


def get_ncr(pk):
    n = m.Ncr.objects.filter(pk=pk).first()
    if n is None:
        raise core.nf("Non-conformance report")
    return n


@transaction.atomic
def raise_ncr(actor, data):
    core.need(data, "title", "source", "category", "severity", "description")
    if data["source"] not in SOURCES:
        raise ValidationFailed("source must be one of " + ", ".join(SOURCES), code="invalid_fields")
    if data["source"] != "OTHER" and not data.get("source_ref_id"):
        raise ValidationFailed("A non-conformance must be traceable to its source: give source_ref_type and source_ref_id.", code="source_required")
    core.config_item("NCR_CATEGORY", data["category"])
    core.config_item("SEVERITY", data["severity"])
    n = m.Ncr.objects.create(number=core.number("quality.ncr"), title=data["title"][:200], source=data["source"], source_ref_type=data.get("source_ref_type", ""), source_ref_id=str(data.get("source_ref_id") or ""),
                             category=data["category"], severity=data["severity"], department_id=data.get("department_id"), product_id=data.get("product_id"), supplier_id=data.get("supplier_id"),
                             project_id=data.get("project_id"), lot_number=data.get("lot_number", ""), location=data.get("location", ""), detected_on=data.get("detected_on") or core.today(),
                             description=data["description"], affected_items=data.get("affected_items", ""), investigator_id=data.get("investigator_id"), reported_by=actor)
    core.event("ncr", n.id, "RAISED", actor, to_status="OPEN", note=n.title)
    managers = core.users_with_permission("quality.ncr.manage") - {actor}
    if n.investigator_id:
        managers.add(n.investigator_id)
    notify(list(managers), "quality.ncr_raised", f"Non-conformance {n.number}", n.title, ref_type="quality.ncr", ref_id=str(n.id))
    core.audit("quality.ncr.raised", actor, "quality.ncr", n.id, severity=n.severity)
    return n


def raise_from_inspection(actor, inspection, failed_params):
    existing = m.Ncr.objects.filter(source="INSPECTION", source_ref_id=str(inspection.id)).first()
    if existing:
        return existing
    core.seed_config()
    sev = "CRITICAL" if any(p.critical for p in failed_params) else "MAJOR"
    return raise_ncr(actor, {"title": f"Failed inspection {inspection.number}", "source": "INSPECTION", "source_ref_type": "quality.inspection", "source_ref_id": str(inspection.id),
                             "category": "MATERIAL" if inspection.stage == "INCOMING" else "WORKMANSHIP", "severity": sev, "product_id": inspection.product_id, "supplier_id": inspection.supplier_id,
                             "project_id": inspection.project_id, "lot_number": inspection.lot_number, "department_id": inspection.department_id,
                             "description": "Failed parameters: " + ", ".join(p.name for p in failed_params), "affected_items": f"{inspection.quantity_rejected} rejected of {inspection.quantity_inspected or inspection.quantity_total}"})


@transaction.atomic
def update_ncr(actor, pk, data):
    n = core.lock(m.Ncr, pk, "Non-conformance report")
    if n.status in ("CLOSED", "REJECTED"):
        raise core.bad_state("A closed non-conformance cannot be edited.")
    for f in ("title", "description", "affected_items", "location", "department_id", "investigator_id", "root_cause", "proposed_correction"):
        if f in data:
            setattr(n, f, data[f])
    if "severity" in data:
        core.config_item("SEVERITY", data["severity"])
        n.severity = data["severity"]
    n.save()
    core.event("ncr", n.id, "UPDATED", actor)
    return n


@transaction.atomic
def contain(actor, pk, *, containment, place_hold=False):
    n = core.lock(m.Ncr, pk, "Non-conformance report")
    if n.status in ("CLOSED", "REJECTED"):
        raise core.bad_state("The non-conformance is closed.")
    if not containment:
        raise ValidationFailed("Describe the containment.", code="invalid_fields")
    n.containment, n.containment_by = containment[:500], actor
    n.save(update_fields=["containment", "containment_by", "updated_at"])
    core.event("ncr", n.id, "CONTAINED", actor, note=containment)
    if place_hold:
        if not n.product_id:
            raise ValidationFailed("The non-conformance names no product to hold.", code="invalid_fields")
        holds.place_hold(actor, product_id=n.product_id, lot_number=n.lot_number, reason=f"{n.number}: {n.title}", source_type="ncr", source_id=n.id)
    return n


@transaction.atomic
def assign(actor, pk, *, investigator_id):
    n = core.lock(m.Ncr, pk, "Non-conformance report")
    if n.status not in ("OPEN", "INVESTIGATING"):
        raise core.bad_state("The investigator can be changed only before approval.")
    n.investigator_id = investigator_id
    if n.status == "OPEN":
        n.status = "INVESTIGATING"
    n.save(update_fields=["investigator_id", "status", "updated_at"])
    core.event("ncr", n.id, "ASSIGNED", actor, to_status=n.status)
    notify([investigator_id], "quality.ncr_assigned", f"Investigate {n.number}", n.title, ref_type="quality.ncr", ref_id=str(n.id))
    return n


@transaction.atomic
def submit_for_approval(actor, pk, *, comment=""):
    n = core.lock(m.Ncr, pk, "Non-conformance report")
    if n.status not in ("OPEN", "INVESTIGATING"):
        raise core.bad_state("Only an open non-conformance can be submitted.")
    if not n.investigator_id:
        raise ValidationFailed("Assign an investigator first.", code="investigator_required")
    if not n.root_cause or not n.proposed_correction:
        raise ValidationFailed("Record the root cause and the proposed correction before submitting.", code="investigation_incomplete")
    approvals.submit(actor, "quality.ncr", n, title=f"{n.number}: {n.title}", comment=comment)
    core.set_status(n, "ncr", "PENDING_APPROVAL", actor, "SUBMITTED", note=comment)
    return n


@transaction.atomic
def resubmit(actor, pk, *, comment=""):
    approvals.resubmit(actor, "quality.ncr", pk, comment=comment)
    return get_ncr(pk)


@transaction.atomic
def start_implementation(actor, pk):
    n = core.lock(m.Ncr, pk, "Non-conformance report")
    if n.status != "APPROVED":
        raise core.bad_state("Implementation starts after approval.")
    if not core.open_actions("ncr", n.id) and not m.Action.objects.filter(parent_type="ncr", parent_id=n.id, status="VERIFIED").exists():
        raise ValidationFailed("Assign at least one corrective action before implementing.", code="actions_required")
    core.set_status(n, "ncr", "IMPLEMENTING", actor, "IMPLEMENTATION_STARTED")
    return n


@transaction.atomic
def submit_for_verification(actor, pk):
    n = core.lock(m.Ncr, pk, "Non-conformance report")
    if n.status != "IMPLEMENTING":
        raise core.bad_state("Only an NCR being implemented can go to verification.")
    pending = m.Action.objects.filter(parent_type="ncr", parent_id=n.id, status="OPEN").count()
    if pending:
        raise DomainError(f"{pending} action(s) are still open.", code="actions_open", status_code=409)
    core.set_status(n, "ncr", "VERIFYING", actor, "VERIFICATION_REQUESTED")
    return n


@transaction.atomic
def create_capa(actor, pk, *, owner_id, reviewer_id, due_date, kind="CORRECTIVE"):
    n = core.lock(m.Ncr, pk, "Non-conformance report")
    if n.capa_id:
        raise ValidationFailed("A CAPA is already linked.", code="duplicate")
    if n.status in ("CLOSED", "REJECTED"):
        raise core.bad_state("The non-conformance is closed.")
    c = create_capa_record(actor, {"kind": kind, "title": f"CAPA for {n.number}: {n.title}", "source_type": "NCR", "source_id": n.id, "problem": n.description,
                                   "owner_id": owner_id, "reviewer_id": reviewer_id, "due_date": due_date, "department_id": n.department_id, "supplier_id": n.supplier_id})
    n.capa_id = c.id
    n.save(update_fields=["capa_id", "updated_at"])
    core.event("ncr", n.id, "CAPA_LINKED", actor, note=c.number)
    return c


@transaction.atomic
def close_ncr(actor, pk, *, note, disposition=None):
    n = core.lock(m.Ncr, pk, "Non-conformance report")
    if n.status != "VERIFYING":
        raise core.bad_state("Only a non-conformance awaiting verification can be closed.")
    if actor in (n.investigator_id, n.reported_by) and not _is_manager(actor):
        raise DomainError("The investigator or reporter cannot verify and close their own non-conformance.", code="separation_of_duties", status_code=403)
    if actor == n.investigator_id:
        raise DomainError("The investigator cannot verify their own investigation.", code="separation_of_duties", status_code=403)
    if not note:
        raise ValidationFailed("Record the verification.", code="invalid_fields")
    if m.Action.objects.filter(parent_type="ncr", parent_id=n.id, status__in=("OPEN", "DONE")).exists():
        raise DomainError("Every action must be verified before closing.", code="actions_unverified", status_code=409)
    sev = m.ConfigItem.objects.filter(kind="SEVERITY", code=n.severity).first()
    if sev and sev.requires_capa:
        c = m.Capa.objects.filter(pk=n.capa_id).first() if n.capa_id else None
        if c is None or c.status != "CLOSED":
            raise DomainError("This severity requires a closed CAPA before the non-conformance can be closed.", code="capa_required", status_code=409)
        if not core.has_evidence("ncr", n.id):
            raise DomainError("Attach the evidence of correction before closing.", code="evidence_required", status_code=409)
    active = m.Hold.objects.filter(source_type="ncr", source_id=n.id, status="ACTIVE").count()
    if active:
        raise DomainError("Quality hold(s) raised for this non-conformance are still active.", code="hold_active", status_code=409)
    core.set_status(n, "ncr", "CLOSED", actor, "CLOSED", note=note, verified_by=actor, verification_note=note[:500], closed_at=timezone.now())
    events.emit("quality.ncr.closed", {"ncr": str(n.id), "number": n.number}, dedup_key=f"ncr-closed:{n.id}:{n.reopened_count}")
    core.audit("quality.ncr.closed", actor, "quality.ncr", n.id)
    return n


def _is_manager(actor):
    from platform_core.authorization import services as authz
    return authz.has_permission(actor, "quality.capa.verify")


@transaction.atomic
def reopen(actor, pk, *, reason):
    n = core.lock(m.Ncr, pk, "Non-conformance report")
    if n.status != "CLOSED":
        raise core.bad_state("Only a closed non-conformance can be reopened.")
    if not reason:
        raise ValidationFailed("Give the reason for reopening.", code="invalid_fields")
    core.set_status(n, "ncr", "INVESTIGATING", actor, "REOPENED", note=reason, reopened_count=n.reopened_count + 1, closed_at=None, workflow_instance_id=None)
    return n


@transaction.atomic
def reject_ncr(actor, pk, *, reason):
    """The report is not a non-conformance (duplicate, raised in error). It stays on record."""
    n = core.lock(m.Ncr, pk, "Non-conformance report")
    if n.status not in ("OPEN", "INVESTIGATING"):
        raise core.bad_state("Only an open non-conformance can be dismissed.")
    if not reason:
        raise ValidationFailed("Give the reason.", code="invalid_fields")
    core.set_status(n, "ncr", "REJECTED", actor, "DISMISSED", note=reason)
    return n


def list_ncrs(**f):
    qs = m.Ncr.objects.all().order_by("-created_at")
    for k in ("status", "severity", "category", "source", "product_id", "supplier_id", "project_id", "department_id", "investigator_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    if f.get("open"):
        qs = qs.exclude(status__in=("CLOSED", "REJECTED"))
    return qs


# ----------------------------------------------------------------------------- CAPA
def capa_dict(c, detail=False):
    d = {"id": str(c.id), "number": c.number, "kind": c.kind, "title": c.title, "source_type": c.source_type, "source_id": str(c.source_id) if c.source_id else None, "status": c.status,
         "owner_id": str(c.owner_id), "reviewer_id": str(c.reviewer_id), "due_date": c.due_date.isoformat(), "cycles": c.cycles, "overdue": c.status not in ("CLOSED", "CANCELLED") and c.due_date < core.today(),
         "effectiveness_due": c.effectiveness_due.isoformat() if c.effectiveness_due else None, "closed_at": c.closed_at.isoformat() if c.closed_at else None}
    if detail:
        d.update({"problem": c.problem, "justification": c.justification, "containment": c.containment, "correction": c.correction, "corrective": c.corrective, "preventive": c.preventive,
                  "analyses": [{"id": str(a.id), "method": a.method, "details": a.details, "conclusion": a.conclusion, "cycle": a.cycle} for a in c.analyses.order_by("created_at")],
                  "reviews": [{"effective": r.effective, "notes": r.notes, "verified_on": r.verified_on.isoformat(), "verified_by": str(r.verified_by), "cycle": r.cycle} for r in c.reviews.order_by("created_at")],
                  "actions": core.list_actions("capa", c.id), "evidence": core.list_evidence("capa", c.id), "history": core.history("capa", c.id), "costs": core.costs_for("capa", c.id)})
    return d


def get_capa(pk):
    c = m.Capa.objects.filter(pk=pk).first()
    if c is None:
        raise core.nf("CAPA")
    return c


@transaction.atomic
def create_capa_record(actor, data):
    core.need(data, "kind", "title", "source_type", "problem", "owner_id", "reviewer_id", "due_date")
    if data["kind"] not in ("CORRECTIVE", "PREVENTIVE"):
        raise ValidationFailed("kind must be CORRECTIVE or PREVENTIVE.", code="invalid_fields")
    if str(data["owner_id"]) == str(data["reviewer_id"]):
        raise DomainError("The effectiveness reviewer must be a different person from the owner.", code="separation_of_duties", status_code=403)
    if data["source_type"] not in ("NCR", "AUDIT_FINDING", "COMPLAINT", "INSPECTION", "RISK", "IMPROVEMENT", "OTHER"):
        raise ValidationFailed("Unknown source type.", code="invalid_fields")
    if data["source_type"] != "OTHER" and not data.get("source_id"):
        raise ValidationFailed("A CAPA must reference the record that triggered it.", code="source_required")
    c = m.Capa.objects.create(number=core.number("quality.capa"), kind=data["kind"], title=data["title"][:200], source_type=data["source_type"], source_id=data.get("source_id"), problem=data["problem"],
                              justification=data.get("justification", ""), owner_id=data["owner_id"], reviewer_id=data["reviewer_id"], due_date=data["due_date"], department_id=data.get("department_id"),
                              supplier_id=data.get("supplier_id"), created_by=actor, status="ANALYSIS")
    core.event("capa", c.id, "CREATED", actor, to_status="ANALYSIS", note=c.title)
    notify([c.owner_id], "quality.capa_assigned", f"CAPA {c.number} assigned", c.title, ref_type="quality.capa", ref_id=str(c.id))
    return c


@transaction.atomic
def update_capa(actor, pk, data):
    c = core.lock(m.Capa, pk, "CAPA")
    if c.status not in ("DRAFT", "ANALYSIS"):
        raise core.bad_state("The plan can be edited only before approval.")
    for f in ("title", "justification", "containment", "correction", "corrective", "preventive", "due_date"):
        if f in data:
            setattr(c, f, data[f])
    c.save()
    core.event("capa", c.id, "UPDATED", actor)
    return c


@transaction.atomic
def add_root_cause(actor, pk, *, method, conclusion, details=None):
    c = core.lock(m.Capa, pk, "CAPA")
    if c.status not in ("ANALYSIS", "DRAFT"):
        raise core.bad_state("Root cause analysis belongs to the analysis stage.")
    core.config_item("ANALYSIS_METHOD", method)
    if not conclusion:
        raise ValidationFailed("Record the conclusion.", code="invalid_fields")
    a = m.RootCause.objects.create(capa=c, method=method, details=details or {}, conclusion=conclusion, analysed_by=actor, cycle=c.cycles)
    core.event("capa", c.id, "ROOT_CAUSE_RECORDED", actor, note=f"{method}: {conclusion[:200]}")
    return a


@transaction.atomic
def submit_capa(actor, pk, *, comment=""):
    c = core.lock(m.Capa, pk, "CAPA")
    if c.status != "ANALYSIS":
        raise core.bad_state("Only a CAPA in analysis can be submitted.")
    if not c.analyses.filter(cycle=c.cycles).exists():
        raise ValidationFailed("Record a root cause analysis first.", code="analysis_required")
    if not (c.corrective or c.preventive):
        raise ValidationFailed("Describe the corrective or preventive action.", code="plan_required")
    if not m.Action.objects.filter(parent_type="capa", parent_id=c.id, action_type__in=("CORRECTIVE", "PREVENTIVE")).exclude(status="CANCELLED").exists():
        raise ValidationFailed("Assign at least one corrective or preventive action with an owner and due date.", code="actions_required")
    approvals.submit(actor, "quality.capa", c, title=f"{c.number}: {c.title}", comment=comment)
    core.set_status(c, "capa", "PENDING_APPROVAL", actor, "SUBMITTED", note=comment)
    return c


@transaction.atomic
def resubmit_capa(actor, pk, *, comment=""):
    approvals.resubmit(actor, "quality.capa", pk, comment=comment)
    return get_capa(pk)


@transaction.atomic
def start_capa(actor, pk):
    c = core.lock(m.Capa, pk, "CAPA")
    if c.status != "APPROVED":
        raise core.bad_state("Implementation starts after approval.")
    core.set_status(c, "capa", "IMPLEMENTING", actor, "IMPLEMENTATION_STARTED")
    return c


@transaction.atomic
def mark_implemented(actor, pk, *, note=""):
    c = core.lock(m.Capa, pk, "CAPA")
    if c.status != "IMPLEMENTING":
        raise core.bad_state("Only a CAPA being implemented can be marked implemented.")
    if m.Action.objects.filter(parent_type="capa", parent_id=c.id, status="OPEN").exists():
        raise DomainError("Every action must be completed first.", code="actions_open", status_code=409)
    if not core.has_evidence("capa", c.id):
        raise DomainError("Attach the evidence of implementation first.", code="evidence_required", status_code=409)
    days = int(org.get_setting("quality.capa_effectiveness_days", 90))
    core.set_status(c, "capa", "VERIFYING", actor, "IMPLEMENTED", note=note, implemented_at=timezone.now(), effectiveness_due=core.today() + timedelta(days=days))
    notify([c.reviewer_id], "quality.capa_verify", f"Verify effectiveness of {c.number}", f"Due {c.effectiveness_due}", ref_type="quality.capa", ref_id=str(c.id))
    return c


@transaction.atomic
def verify_effectiveness(actor, pk, *, effective, notes):
    c = core.lock(m.Capa, pk, "CAPA")
    if c.status != "VERIFYING":
        raise core.bad_state("Effectiveness is verified after implementation.")
    if actor != c.reviewer_id:
        raise DomainError("Only the assigned effectiveness reviewer can verify this CAPA.", code="separation_of_duties", status_code=403)
    if actor == c.owner_id:
        raise DomainError("The owner cannot verify their own CAPA.", code="separation_of_duties", status_code=403)
    if not notes:
        raise ValidationFailed("Record the effectiveness evidence.", code="invalid_fields")
    m.EffectivenessReview.objects.create(capa=c, verified_by=actor, verified_on=core.today(), effective=bool(effective), notes=notes[:500], cycle=c.cycles)
    if effective:
        if m.Action.objects.filter(parent_type="capa", parent_id=c.id, status="DONE").exists():
            raise DomainError("Verify the completed actions before closing.", code="actions_unverified", status_code=409)
        core.set_status(c, "capa", "CLOSED", actor, "CLOSED", note=notes, closed_at=timezone.now())
        events.emit("quality.capa.closed", {"capa": str(c.id), "number": c.number}, dedup_key=f"capa-closed:{c.id}:{c.cycles}")
        core.audit("quality.capa.closed", actor, "quality.capa", c.id)
    else:
        core.set_status(c, "capa", "ANALYSIS", actor, "NOT_EFFECTIVE", note=notes, cycles=c.cycles + 1, workflow_instance_id=None, implemented_at=None, effectiveness_due=None)
        notify([c.owner_id], "quality.capa_reopened", f"{c.number} was not effective", notes[:200], ref_type="quality.capa", ref_id=str(c.id))
    return c


@transaction.atomic
def cancel_capa(actor, pk, *, reason):
    c = core.lock(m.Capa, pk, "CAPA")
    if c.status in ("CLOSED", "CANCELLED"):
        raise core.bad_state("The CAPA is already finished.")
    if not reason:
        raise ValidationFailed("Give the reason.", code="invalid_fields")
    core.set_status(c, "capa", "CANCELLED", actor, "CANCELLED", note=reason)
    return c


def list_capas(**f):
    qs = m.Capa.objects.all().order_by("-created_at")
    for k in ("status", "kind", "owner_id", "reviewer_id", "source_type", "supplier_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    if f.get("overdue"):
        qs = qs.exclude(status__in=("CLOSED", "CANCELLED")).filter(due_date__lt=core.today())
    return qs


def reminders(on):
    n = 0
    for c in m.Capa.objects.filter(status="VERIFYING", effectiveness_due__lte=on):
        if m.Event.objects.filter(record_type="capa", record_id=c.id, action="EFFECTIVENESS_DUE", at__date=on).exists():
            continue
        core.event("capa", c.id, "EFFECTIVENESS_DUE", None)
        notify([c.reviewer_id], "quality.capa_verify_due", f"Effectiveness review due: {c.number}", c.title[:150], ref_type="quality.capa", ref_id=str(c.id))
        n += 1
    for c in m.Capa.objects.exclude(status__in=("CLOSED", "CANCELLED")).filter(due_date__lt=on):
        if m.Event.objects.filter(record_type="capa", record_id=c.id, action="OVERDUE", at__date=on).exists():
            continue
        core.event("capa", c.id, "OVERDUE", None)
        notify([c.owner_id], "quality.capa_overdue", f"CAPA {c.number} is overdue", c.title[:150], ref_type="quality.capa", ref_id=str(c.id))
        n += 1
    return n

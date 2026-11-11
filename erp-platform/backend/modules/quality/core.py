"""Shared quality helpers: history, evidence, owned actions, costs, configurable lists, reminders."""
from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from modules.quality import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.files import services as files
from shared.notifications.services import notify
from shared.tenancy import current_tenant

CONFIG_KINDS = ("NCR_CATEGORY", "SEVERITY", "ANALYSIS_METHOD", "AUDIT_TYPE", "COMPLAINT_TYPE", "FINDING_TYPE", "RISK_CATEGORY", "DEFECT_TYPE", "IMPROVEMENT_CATEGORY")
DEFAULTS = {
    "SEVERITY": [("MINOR", "Minor", 1, False), ("MAJOR", "Major", 2, True), ("CRITICAL", "Critical", 3, True)],
    "NCR_CATEGORY": [("MATERIAL", "Material", 1, False), ("WORKMANSHIP", "Workmanship", 1, False), ("PROCESS", "Process", 1, False), ("DOCUMENTATION", "Documentation", 1, False)],
    "ANALYSIS_METHOD": [("FIVE_WHYS", "5 Whys", 1, False), ("FISHBONE", "Fishbone", 1, False), ("FAULT_TREE", "Fault tree", 1, False), ("OTHER", "Other", 1, False)],
    "AUDIT_TYPE": [("INTERNAL", "Internal", 1, False), ("SUPPLIER", "Supplier", 1, False), ("PROCESS", "Process", 1, False), ("PROJECT", "Project", 1, False), ("CERTIFICATION", "Certification", 1, False)],
    "COMPLAINT_TYPE": [("PRODUCT", "Product quality", 1, False), ("SERVICE", "Service", 1, False), ("DELIVERY", "Delivery", 1, False)],
    "FINDING_TYPE": [("NONCONFORMITY", "Non-conformity", 1, False), ("OBSERVATION", "Observation", 1, False), ("OPPORTUNITY", "Opportunity for improvement", 1, False)],
    "RISK_CATEGORY": [("PROCESS", "Process", 1, False), ("PRODUCT", "Product", 1, False), ("SUPPLIER", "Supplier", 1, False), ("PROJECT", "Project", 1, False)],
    "DEFECT_TYPE": [("DIMENSION", "Dimensional", 1, False), ("SURFACE", "Surface", 1, False), ("FUNCTION", "Functional", 1, False)],
    "IMPROVEMENT_CATEGORY": [("PROCESS", "Process", 1, False), ("PRODUCT", "Product", 1, False), ("SAFETY", "Safety", 1, False)],
}


def today():
    return timezone.now().date()


def nf(label="Record"):
    return DomainError(f"{label} not found.", code="not_found", status_code=404)


def bad_state(msg):
    return DomainError(msg, code="invalid_state_transition")


def audit(action, actor, target_type, target_id, **meta):
    record_tenant_event(current_tenant(), action, actor_user_id=actor, target_type=target_type, target_id=target_id, metadata={k: str(v) for k, v in meta.items()})


def event(rec_type, rec_id, action, actor=None, *, from_status="", to_status="", note=""):
    return m.Event.objects.create(record_type=rec_type, record_id=rec_id, action=action, actor_id=actor, from_status=from_status, to_status=to_status, note=(note or "")[:500])


def set_status(obj, rec_type, to, actor, action, note="", **fields):
    old = obj.status
    obj.status = to
    for k, v in fields.items():
        setattr(obj, k, v)
    obj.save()
    event(rec_type, obj.id, action, actor, from_status=old, to_status=to, note=note)
    return obj


def history(rec_type, rec_id):
    return [{"action": e.action, "from": e.from_status, "to": e.to_status, "actor": str(e.actor_id) if e.actor_id else None, "note": e.note, "at": e.at.isoformat()}
            for e in m.Event.objects.filter(record_type=rec_type, record_id=rec_id).order_by("at", "id")]


def number(code):
    from shared.sequences.services import next_number
    return next_number(code)


def lock(model, pk, label="Record"):
    obj = model.objects.select_for_update().filter(pk=pk).first()
    if obj is None:
        raise nf(label)
    return obj


def need(data, *names):
    missing = [n for n in names if data.get(n) in (None, "", [])]
    if missing:
        raise ValidationFailed(f"Required: {', '.join(missing)}.", code="invalid_fields")


def seed_config():
    for kind, rows in DEFAULTS.items():
        for code, name, rank, capa in rows:
            m.ConfigItem.objects.get_or_create(kind=kind, code=code, defaults={"name": name, "rank": rank, "requires_capa": capa})


def config_items(kind, active_only=True):
    if not m.ConfigItem.objects.filter(kind=kind).exists():
        seed_config()
    qs = m.ConfigItem.objects.filter(kind=kind)
    return qs.filter(is_active=True) if active_only else qs


def config_item(kind, code):
    it = config_items(kind).filter(code=code).first()
    if it is None:
        raise ValidationFailed(f"{code!r} is not a valid {kind.lower().replace('_', ' ')}.", code="invalid_config_value")
    return it


@transaction.atomic
def save_config(actor, *, kind, code, name, rank=1, requires_capa=False, is_active=True):
    if kind not in CONFIG_KINDS:
        raise ValidationFailed("Unknown list.", code="invalid_fields")
    seed_config()
    obj, _ = m.ConfigItem.objects.update_or_create(kind=kind, code=code.upper(), defaults={"name": name, "rank": int(rank), "requires_capa": bool(requires_capa), "is_active": bool(is_active)})
    audit("quality.config.saved", actor, "quality.config", obj.id, kind=kind, code=code)
    return obj


def config_dict(c):
    return {"id": str(c.id), "kind": c.kind, "code": c.code, "name": c.name, "rank": c.rank, "requires_capa": c.requires_capa, "is_active": c.is_active}


# ----------------------------------------------------------------------------- evidence
@transaction.atomic
def add_evidence(actor, rec_type, rec_id, *, filename, data, kind="EVIDENCE", description=""):
    sf = files.upload(actor, filename, data, ref_type=f"quality.{rec_type}", ref_id=str(rec_id))
    ev = m.Evidence.objects.create(record_type=rec_type, record_id=rec_id, file_id=sf.id, file_name=filename, kind=kind, description=description[:300], uploaded_by=actor)
    event(rec_type, rec_id, "EVIDENCE_ADDED", actor, note=filename)
    return ev


def list_evidence(rec_type, rec_id):
    return [{"id": str(e.id), "file_id": str(e.file_id), "file_name": e.file_name, "kind": e.kind, "description": e.description, "uploaded_by": str(e.uploaded_by), "at": e.created_at.isoformat()}
            for e in m.Evidence.objects.filter(record_type=rec_type, record_id=rec_id).order_by("created_at")]


def has_evidence(rec_type, rec_id):
    return m.Evidence.objects.filter(record_type=rec_type, record_id=rec_id).exists()


def _file_access(user_id, ref_id):
    from platform_core.authorization import services as authz
    return authz.has_permission(user_id, "quality.view")


# ----------------------------------------------------------------------------- owned actions
ACTION_TYPES = ("CONTAINMENT", "CORRECTION", "CORRECTIVE", "PREVENTIVE", "MITIGATION")


@transaction.atomic
def add_action(actor, parent_type, parent_id, *, action_type, description, owner_id, due_date):
    if action_type not in ACTION_TYPES:
        raise ValidationFailed("Unknown action type.", code="invalid_fields")
    if not description or not owner_id or not due_date:
        raise ValidationFailed("An action needs a description, an owner and a due date.", code="invalid_fields")
    a = m.Action.objects.create(parent_type=parent_type, parent_id=parent_id, action_type=action_type, description=description[:500], owner_id=owner_id, due_date=due_date)
    event(parent_type, parent_id, "ACTION_ADDED", actor, note=f"{action_type}: {description[:200]}")
    notify([owner_id], "quality.action_assigned", "Quality action assigned", description[:200], ref_type=f"quality.{parent_type}", ref_id=str(parent_id))
    return a


@transaction.atomic
def complete_action(actor, action_id, *, note=""):
    a = lock(m.Action, action_id, "Action")
    if a.owner_id != actor:
        from platform_core.authorization import services as authz
        if not authz.has_permission(actor, "quality.capa.manage"):
            raise nf("Action")
    if a.status != "OPEN":
        raise bad_state("Only an open action can be completed.")
    a.status, a.completed_at, a.completion_note = "DONE", timezone.now(), note[:500]
    a.save(update_fields=["status", "completed_at", "completion_note", "updated_at"])
    event(a.parent_type, a.parent_id, "ACTION_DONE", actor, note=a.description[:200])
    return a


@transaction.atomic
def verify_action(actor, action_id):
    a = lock(m.Action, action_id, "Action")
    if a.status != "DONE":
        raise bad_state("Only a completed action can be verified.")
    if a.owner_id == actor:
        raise DomainError("The person who did the work cannot verify it.", code="separation_of_duties", status_code=403)
    a.status, a.verified_by = "VERIFIED", actor
    a.save(update_fields=["status", "verified_by", "updated_at"])
    event(a.parent_type, a.parent_id, "ACTION_VERIFIED", actor, note=a.description[:200])
    return a


@transaction.atomic
def cancel_action(actor, action_id, *, reason):
    a = lock(m.Action, action_id, "Action")
    if a.status not in ("OPEN",):
        raise bad_state("Only an open action can be cancelled.")
    if not reason:
        raise ValidationFailed("Give a reason.", code="invalid_fields")
    a.status = "CANCELLED"
    a.completion_note = reason[:500]
    a.save(update_fields=["status", "completion_note", "updated_at"])
    event(a.parent_type, a.parent_id, "ACTION_CANCELLED", actor, note=reason)
    return a


def open_actions(parent_type, parent_id, types=None):
    qs = m.Action.objects.filter(parent_type=parent_type, parent_id=parent_id, status__in=("OPEN", "DONE"))
    return qs.filter(action_type__in=types) if types else qs


def action_dict(a):
    return {"id": str(a.id), "parent_type": a.parent_type, "parent_id": str(a.parent_id), "action_type": a.action_type, "description": a.description, "owner_id": str(a.owner_id),
            "due_date": a.due_date.isoformat(), "status": a.status, "completed_at": a.completed_at.isoformat() if a.completed_at else None,
            "completion_note": a.completion_note, "overdue": a.status == "OPEN" and a.due_date < today()}


def list_actions(parent_type, parent_id):
    return [action_dict(a) for a in m.Action.objects.filter(parent_type=parent_type, parent_id=parent_id).order_by("due_date", "created_at")]


def my_actions(user_id):
    return [action_dict(a) for a in m.Action.objects.filter(owner_id=user_id, status__in=("OPEN", "DONE")).order_by("due_date")]


# ----------------------------------------------------------------------------- costs
COST_CATEGORIES = ("SCRAP", "REWORK", "RETURN", "WARRANTY", "INSPECTION", "PREVENTION", "OTHER")


@transaction.atomic
def record_cost(actor, ref_type, ref_id, *, category, amount, incurred_on=None, description=""):
    from decimal import Decimal, InvalidOperation
    if category not in COST_CATEGORIES:
        raise ValidationFailed("Unknown cost category.", code="invalid_fields")
    try:
        amt = Decimal(str(amount))
    except (InvalidOperation, ValueError):
        raise ValidationFailed("amount must be a number.", code="invalid_fields")
    if amt <= 0:
        raise ValidationFailed("amount must be positive.", code="invalid_fields")
    c = m.CostEntry.objects.create(ref_type=ref_type, ref_id=ref_id, category=category, amount=amt, incurred_on=incurred_on or today(), description=description[:300], recorded_by=actor)
    event(ref_type, ref_id, "COST_RECORDED", actor, note=f"{category} {amt}")
    return c


def costs_for(ref_type, ref_id):
    return [{"id": str(c.id), "category": c.category, "amount": str(c.amount), "incurred_on": c.incurred_on.isoformat(), "description": c.description} for c in m.CostEntry.objects.filter(ref_type=ref_type, ref_id=ref_id).order_by("incurred_on")]


# ----------------------------------------------------------------------------- reminders
def users_with_permission(code):
    from modules.documents.review import users_with_permission as u
    return u(code)


def action_reminders(on):
    """Owners hear about actions that are near due or overdue; the quality managers hear once when one is overdue."""
    notice = int(org.get_setting("quality.action_reminder_days", 3))
    sent = 0
    qs = m.Action.objects.filter(status="OPEN", due_date__lte=on + timedelta(days=notice)).filter(Q(last_reminder_on__isnull=True) | Q(last_reminder_on__lt=on))
    for a in qs:
        late = a.due_date < on
        notify([a.owner_id], "quality.action_due", "Quality action " + ("overdue" if late else "due soon"), f"{a.description[:150]} (due {a.due_date})", ref_type=f"quality.{a.parent_type}", ref_id=str(a.parent_id))
        a.last_reminder_on = on
        fields = ["last_reminder_on"]
        if late and a.escalated_at is None:
            managers = users_with_permission("quality.capa.verify")
            managers.discard(a.owner_id)
            if managers:
                notify(list(managers), "quality.action_escalated", "Overdue quality action", f"{a.description[:150]} (due {a.due_date})", ref_type=f"quality.{a.parent_type}", ref_id=str(a.parent_id))
            a.escalated_at = timezone.now()
            fields.append("escalated_at")
        a.save(update_fields=fields)
        sent += 1
    return sent

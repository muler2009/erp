"""Inspection templates, scheduled inspections, findings with corrective actions, photo evidence and condition reporting."""
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from modules.assets import maintenance as mt
from modules.assets import models as m
from modules.assets import services as svc
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify

SEVERITIES = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
KINDS = ("PASS_FAIL", "READING")


def _clean_items(items):
    out = []
    for i in items or []:
        text, kind = (i.get("text") or "").strip(), i.get("kind", "PASS_FAIL")
        if not text or kind not in KINDS:
            raise ValidationFailed("Each checklist item needs text and a kind of PASS_FAIL or READING.", code="invalid_items")
        out.append({"text": text[:200], "kind": kind})
    if not out:
        raise ValidationFailed("A checklist needs at least one item.", code="invalid_items")
    return out


@transaction.atomic
def create_template(actor_id, *, code, name, items, category_id=None):
    if not (code or "").strip() or not (name or "").strip():
        raise ValidationFailed("Code and name are required.", code="invalid_template")
    if m.InspectionTemplate.objects.filter(code=code.strip().upper()).exists():
        raise DomainError("This template code already exists.", code="duplicate_code")
    if category_id and not m.AssetCategory.objects.filter(pk=category_id).exists():
        raise ValidationFailed("Unknown category.", code="invalid_category")
    return m.InspectionTemplate.objects.create(code=code.strip().upper(), name=name[:160], items=_clean_items(items), category_id=category_id)


@transaction.atomic
def schedule(actor_id, asset_id, *, scheduled_on, template_id=None, inspector_id=None):
    a = svc._get(asset_id)
    if a.status in ("DISPOSED", "RETIRED", "REQUESTED", "ORDERED", "RECEIVED"):
        raise DomainError("Only an asset in the register can be inspected.", code="asset_not_maintainable")
    t = None
    if template_id:
        t = m.InspectionTemplate.objects.filter(pk=template_id, is_active=True).first()
        if t is None:
            raise ValidationFailed("Unknown or inactive template.", code="invalid_template")
    i = m.Inspection.objects.create(asset=a, template=t, scheduled_on=scheduled_on, inspector_id=inspector_id)
    svc.log(a, "INSPECTION_SCHEDULED", actor_id=actor_id, on=scheduled_on)
    return i


def _get_inspection(pk, lock=False):
    qs = m.Inspection.objects.select_for_update(of=("self",)) if lock else m.Inspection.objects
    i = qs.select_related("asset", "template").filter(pk=pk).first()
    if i is None:
        raise DomainError("Inspection not found.", code="not_found", status_code=404)
    return i


@transaction.atomic
def complete(actor_id, inspection_id, *, results, condition, notes="", findings=None, performed_on=None):
    i = _get_inspection(inspection_id, lock=True)
    if i.status != "SCHEDULED":
        raise DomainError("This inspection is already finished or cancelled.", code="invalid_state")
    if condition not in m.CONDITIONS:
        raise ValidationFailed("Condition must be one of " + ", ".join(m.CONDITIONS) + ".", code="invalid_condition")
    items = i.template.items if i.template else []
    results = results or []
    if items:
        if len(results) != len(items):
            raise ValidationFailed("Answer every checklist item.", code="incomplete_checklist")
        merged = []
        for it, r in zip(items, results):
            v = str(r.get("result", "")).strip() if isinstance(r, dict) else str(r).strip()
            if it["kind"] == "PASS_FAIL" and v not in ("PASS", "FAIL"):
                raise ValidationFailed(f"'{it['text']}' must be PASS or FAIL.", code="invalid_result")
            if it["kind"] == "READING" and not v:
                raise ValidationFailed(f"'{it['text']}' needs a reading.", code="invalid_result")
            merged.append({**it, "result": v})
        results = merged
    failed = [r for r in results if r.get("kind") == "PASS_FAIL" and r["result"] == "FAIL"]
    findings = list(findings or [])
    if failed and not findings:
        raise ValidationFailed("Failed checklist items must be recorded as findings.", code="finding_required")
    for f in findings:
        if not (f.get("description") or "").strip() or f.get("severity", "MEDIUM") not in SEVERITIES:
            raise ValidationFailed("Each finding needs a description and a severity of LOW, MEDIUM, HIGH or CRITICAL.", code="invalid_finding")
    i.status, i.results, i.condition_result, i.notes = "COMPLETED", results, condition, notes
    i.performed_on, i.performed_by = performed_on or timezone.now().date(), actor_id
    i.save()
    a = svc._get(i.asset_id, lock=True)
    old, a.condition = a.condition, condition
    a.save(update_fields=["condition", "updated_at"])
    svc.log(a, "INSPECTED", actor_id=actor_id, condition=condition, old_condition=old, findings=len(findings))
    for f in findings:
        m.InspectionFinding.objects.create(inspection=i, description=f["description"], severity=f.get("severity", "MEDIUM"))
    if any(f.get("severity") in ("HIGH", "CRITICAL") for f in findings):
        notify(mt._staff_user_ids(), "assets.inspection_finding", f"Serious inspection finding on {a.number}", findings[0]["description"][:200], ref_type="assets.inspection", ref_id=str(i.id))
    return i


@transaction.atomic
def cancel(actor_id, inspection_id, reason=""):
    i = _get_inspection(inspection_id, lock=True)
    if i.status != "SCHEDULED":
        raise DomainError("Only a scheduled inspection can be cancelled.", code="invalid_state")
    i.status, i.notes = "CANCELLED", reason[:300]
    i.save()
    return i


@transaction.atomic
def raise_corrective_action(actor_id, finding_id, *, estimated_cost=0, assigned_to_id=None):
    f = m.InspectionFinding.objects.select_for_update(of=("self",)).select_related("inspection__asset").filter(pk=finding_id).first()
    if f is None:
        raise DomainError("Finding not found.", code="not_found", status_code=404)
    if f.status != "OPEN" or f.work_order_id:
        raise DomainError("This finding already has a corrective action or is resolved.", code="already_pending")
    wo = mt.create_work_order(actor_id, f.inspection.asset_id, kind="CORRECTIVE", description=f"Inspection finding: {f.description}", estimated_cost=estimated_cost, assigned_to_id=assigned_to_id, priority="HIGH" if f.severity in ("HIGH", "CRITICAL") else "MEDIUM")
    f.work_order = wo
    f.save(update_fields=["work_order", "updated_at"])
    return wo


@transaction.atomic
def resolve_finding(actor_id, finding_id, *, notes):
    f = m.InspectionFinding.objects.select_for_update(of=("self",)).select_related("work_order").filter(pk=finding_id).first()
    if f is None:
        raise DomainError("Finding not found.", code="not_found", status_code=404)
    if f.status != "OPEN":
        raise DomainError("This finding is already resolved.", code="invalid_state")
    if f.work_order_id and f.work_order.status not in ("VERIFIED", "CANCELLED"):
        raise DomainError("The corrective work order must be finished and verified first.", code="corrective_action_open")
    if not (notes or "").strip():
        raise ValidationFailed("Record how the finding was resolved.", code="notes_required")
    f.status, f.resolution_notes, f.resolved_by = "RESOLVED", notes[:300], actor_id
    f.save()
    return f


@transaction.atomic
def add_evidence(actor_id, inspection_id, *, filename, data, caption=""):
    from shared.files import services as files

    i = _get_inspection(inspection_id)
    f = files.upload(actor_id, filename, data, ref_type="assets.inspection", ref_id=str(i.id))
    return m.InspectionEvidence.objects.create(inspection=i, file_id=f.id, caption=caption[:200], uploaded_by=actor_id)


def can_read_evidence(user_id, ref_id):
    from platform_core.authorization import services as authz

    return bool(m.Inspection.objects.filter(pk=ref_id).exists() and authz.has_permission(user_id, "assets.view"))


@transaction.atomic
def schedule_due(actor_id=None, today=None, lead_days=7):
    """Schedule the next inspection for assets whose category sets an interval; one open inspection per asset."""
    today = today or timezone.now().date()
    made = 0
    for a in m.Asset.objects.select_related("category").filter(category__inspection_interval_days__isnull=False, status__in=("AVAILABLE", "ASSIGNED", "IN_USE", "UNDER_MAINTENANCE")):
        if m.Inspection.objects.filter(asset=a, status="SCHEDULED").exists():
            continue
        last = m.Inspection.objects.filter(asset=a, status="COMPLETED").order_by("-performed_on").values_list("performed_on", flat=True).first() or a.capitalized_on or today
        due = last + timedelta(days=a.category.inspection_interval_days)
        if due - timedelta(days=lead_days) > today:
            continue
        t = m.InspectionTemplate.objects.filter(is_active=True, category=a.category).first() or m.InspectionTemplate.objects.filter(is_active=True, category__isnull=True).first()
        m.Inspection.objects.create(asset=a, template=t, scheduled_on=max(due, today))
        made += 1
    return made


def overdue(today=None):
    today = today or timezone.now().date()
    return [{"id": str(i.id), "asset": i.asset.number, "scheduled_on": str(i.scheduled_on), "days_overdue": (today - i.scheduled_on).days} for i in m.Inspection.objects.filter(status="SCHEDULED", scheduled_on__lt=today).select_related("asset").order_by("scheduled_on")]


def condition_report():
    """Asset count by condition and category, plus assets that were never inspected."""
    rows = {}
    for a in m.Asset.objects.select_related("category").exclude(status__in=("DISPOSED", "RETIRED", "REQUESTED", "ORDERED", "RECEIVED")):
        r = rows.setdefault(a.category.code, {c: 0 for c in m.CONDITIONS})
        r[a.condition] += 1
    never = m.Asset.objects.exclude(status__in=("DISPOSED", "RETIRED", "REQUESTED", "ORDERED", "RECEIVED")).exclude(inspections__status="COMPLETED").count()
    return {"by_category": [{"category": k, **v} for k, v in sorted(rows.items())], "never_inspected": never, "open_findings": m.InspectionFinding.objects.filter(status="OPEN").count()}

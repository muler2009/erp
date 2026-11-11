"""Inspection plans, inspections, measured results, defects and the quality consequences of a failed inspection."""
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from modules.quality import core, holds, models as m
from modules.quality.planning import dec
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.notifications.services import notify

SAMPLING = ("ALL", "PERCENT", "FIXED")


def plan_dict(p, detail=False):
    d = {"id": str(p.id), "number": p.number, "title": p.title, "stage": p.stage, "subject_type": p.subject_type, "product_id": str(p.product_id) if p.product_id else None,
         "project_id": str(p.project_id) if p.project_id else None, "frequency": p.frequency, "sampling": p.sampling, "sample_value": str(p.sample_value) if p.sample_value is not None else None,
         "is_itp": p.is_itp, "revision": p.revision, "status": p.status, "inspector_id": str(p.inspector_id) if p.inspector_id else None}
    if detail:
        d["parameters"] = [param_dict(x) for x in p.parameters.filter(is_active=True).order_by("position")]
    return d


def param_dict(x):
    return {"id": str(x.id), "name": x.name, "kind": x.kind, "lower": str(x.lower) if x.lower is not None else None, "upper": str(x.upper) if x.upper is not None else None,
            "target": str(x.target) if x.target is not None else None, "unit": x.unit, "mandatory": x.mandatory, "critical": x.critical, "position": x.position}


@transaction.atomic
def create_plan(actor, data):
    core.need(data, "title", "stage", "subject_type")
    if data["stage"] not in m.STAGES:
        raise ValidationFailed("stage must be one of " + ", ".join(m.STAGES), code="invalid_fields")
    sampling = data.get("sampling", "ALL")
    if sampling not in SAMPLING:
        raise ValidationFailed("sampling must be ALL, PERCENT or FIXED.", code="invalid_fields")
    if sampling != "ALL" and not data.get("sample_value"):
        raise ValidationFailed("Give the sample size.", code="invalid_fields")
    if sampling == "PERCENT" and not (0 < dec(data["sample_value"]) <= 100):
        raise ValidationFailed("A percentage sample must be between 0 and 100.", code="invalid_fields")
    p = m.InspectionPlan.objects.create(number=core.number("quality.inspection_plan"), title=data["title"][:200], stage=data["stage"], subject_type=data["subject_type"],
                                        product_id=data.get("product_id"), project_id=data.get("project_id"), frequency=data.get("frequency", ""), sampling=sampling,
                                        sample_value=dec(data["sample_value"]) if data.get("sample_value") else None, department_id=data.get("department_id"),
                                        inspector_id=data.get("inspector_id"), is_itp=bool(data.get("is_itp")), created_by=actor)
    core.event("inspection_plan", p.id, "CREATED", actor)
    return p


def get_plan(pk):
    p = m.InspectionPlan.objects.filter(pk=pk).first()
    if p is None:
        raise core.nf("Inspection plan")
    return p


@transaction.atomic
def add_parameter(actor, plan_id, data):
    p = core.lock(m.InspectionPlan, plan_id, "Inspection plan")
    core.need(data, "name")
    kind = data.get("kind", "NUMERIC")
    if kind not in ("NUMERIC", "BOOLEAN", "TEXT"):
        raise ValidationFailed("kind must be NUMERIC, BOOLEAN or TEXT.", code="invalid_fields")
    lower = dec(data["lower"]) if data.get("lower") not in (None, "") else None
    upper = dec(data["upper"]) if data.get("upper") not in (None, "") else None
    if kind == "NUMERIC" and lower is None and upper is None:
        raise ValidationFailed("A numeric parameter needs a lower or an upper limit.", code="invalid_fields")
    if lower is not None and upper is not None and lower > upper:
        raise ValidationFailed("The lower limit is above the upper limit.", code="invalid_fields")
    pos = (p.parameters.order_by("-position").values_list("position", flat=True).first() or 0) + 1
    x = m.Parameter.objects.create(plan=p, name=data["name"][:120], kind=kind, lower=lower, upper=upper, target=dec(data["target"]) if data.get("target") not in (None, "") else None,
                                   unit=data.get("unit", ""), mandatory=data.get("mandatory", True), critical=bool(data.get("critical")), position=pos)
    if m.Inspection.objects.filter(plan=p).exists():
        p.revision += 1  # parameters changed after use: older inspections keep their own results, the plan moves on
        p.save(update_fields=["revision", "updated_at"])
    core.event("inspection_plan", p.id, "PARAMETER_ADDED", actor, note=x.name)
    return x


@transaction.atomic
def retire_parameter(actor, parameter_id):
    x = core.lock(m.Parameter, parameter_id, "Parameter")
    x.is_active = False
    x.save(update_fields=["is_active", "updated_at"])
    p = x.plan
    p.revision += 1
    p.save(update_fields=["revision", "updated_at"])
    core.event("inspection_plan", p.id, "PARAMETER_RETIRED", actor, note=x.name)
    return x


# ----------------------------------------------------------------------------- inspections
def inspection_dict(i, detail=False):
    d = {"id": str(i.id), "number": i.number, "plan_id": str(i.plan_id), "stage": i.stage, "status": i.status, "result": i.result, "scheduled_for": i.scheduled_for.isoformat(),
         "inspector_id": str(i.inspector_id), "ref_type": i.ref_type, "ref_id": i.ref_id, "product_id": str(i.product_id) if i.product_id else None,
         "supplier_id": str(i.supplier_id) if i.supplier_id else None, "project_id": str(i.project_id) if i.project_id else None, "lot_number": i.lot_number,
         "quantity_total": str(i.quantity_total), "quantity_inspected": str(i.quantity_inspected), "quantity_accepted": str(i.quantity_accepted), "quantity_rejected": str(i.quantity_rejected),
         "summary": i.summary, "conditional_note": i.conditional_note, "reinspection_of": str(i.reinspection_of_id) if i.reinspection_of_id else None,
         "completed_at": i.completed_at.isoformat() if i.completed_at else None}
    if detail:
        d["results"] = [result_dict(r) for r in i.results.select_related("parameter").order_by("parameter__position", "created_at")]
        d["defects"] = [{"id": str(x.id), "defect_code": x.defect_code, "quantity": str(x.quantity), "note": x.note} for x in i.defects.all()]
        d["equipment"] = [{"id": str(e.equipment_id), "tag": e.equipment.tag} for e in i.equipment_used.select_related("equipment")]
        d["evidence"] = core.list_evidence("inspection", i.id)
        d["history"] = core.history("inspection", i.id)
        d["ncr_ids"] = [str(n) for n in m.Ncr.objects.filter(source="INSPECTION", source_ref_id=str(i.id)).values_list("id", flat=True)]
        d["holds"] = [h.number for h in m.Hold.objects.filter(source_type="inspection", source_id=i.id)]
    return d


def result_dict(r):
    return {"id": str(r.id), "parameter_id": str(r.parameter_id), "parameter": r.parameter.name, "value": str(r.value) if r.value is not None else None, "text": r.text,
            "passed": r.passed, "comment": r.comment, "is_current": r.is_current, "correction_reason": r.correction_reason, "recorded_by": str(r.recorded_by), "at": r.created_at.isoformat()}


def _sample_size(plan, total):
    if plan.sampling == "ALL":
        return total
    if plan.sampling == "FIXED":
        return min(total, plan.sample_value)
    return (total * plan.sample_value / 100).quantize(Decimal("1"))


@transaction.atomic
def schedule(actor, data):
    core.need(data, "plan_id", "scheduled_for", "inspector_id")
    plan = get_plan(data["plan_id"])
    if plan.status != "ACTIVE":
        raise core.bad_state("The inspection plan is not active.")
    total = dec(data.get("quantity_total", 0), "quantity_total")
    if total < 0:
        raise ValidationFailed("quantity_total cannot be negative.", code="invalid_fields")
    i = m.Inspection.objects.create(number=core.number("quality.inspection"), plan=plan, stage=plan.stage, scheduled_for=data["scheduled_for"], inspector_id=data["inspector_id"],
                                    department_id=data.get("department_id") or plan.department_id, ref_type=data.get("ref_type", ""), ref_id=str(data.get("ref_id") or ""),
                                    product_id=data.get("product_id") or plan.product_id, supplier_id=data.get("supplier_id"), project_id=data.get("project_id") or plan.project_id,
                                    lot_number=data.get("lot_number", ""), quantity_total=total, quantity_inspected=_sample_size(plan, total) if total else 0,
                                    reinspection_of_id=data.get("reinspection_of"), created_by=actor)
    core.event("inspection", i.id, "SCHEDULED", actor, to_status="SCHEDULED")
    notify([i.inspector_id], "quality.inspection_assigned", f"Inspection {i.number}", f"{plan.title} on {i.scheduled_for}", ref_type="quality.inspection", ref_id=str(i.id))
    return i


def get_inspection(pk):
    i = m.Inspection.objects.filter(pk=pk).first()
    if i is None:
        raise core.nf("Inspection")
    return i


def _mine(actor, i):
    from platform_core.authorization import services as authz
    if i.inspector_id != actor and not authz.has_permission(actor, "quality.ncr.manage"):
        raise core.nf("Inspection")


@transaction.atomic
def start(actor, pk, *, equipment_ids=()):
    i = core.lock(m.Inspection, pk, "Inspection")
    _mine(actor, i)
    if i.status != "SCHEDULED":
        raise core.bad_state("Only a scheduled inspection can be started.")
    for eid in equipment_ids or ():
        e = m.Equipment.objects.filter(pk=eid).first()
        if e is None:
            raise core.nf("Equipment")
        check_usable(e)
        m.InspectionEquipment.objects.get_or_create(inspection=i, equipment=e)
    i.status, i.started_at = "IN_PROGRESS", timezone.now()
    i.save(update_fields=["status", "started_at", "updated_at"])
    core.event("inspection", i.id, "STARTED", actor, from_status="SCHEDULED", to_status="IN_PROGRESS")
    return i


def check_usable(e):
    if e.status != "ACTIVE":
        raise DomainError(f"Equipment {e.tag} is not in service.", code="equipment_not_usable", status_code=409)
    if e.next_due_on and e.next_due_on < core.today():
        raise DomainError(f"Equipment {e.tag} is overdue for calibration.", code="equipment_overdue", status_code=409)


def _evaluate(param, value, text):
    if param.kind == "NUMERIC":
        if value is None:
            raise ValidationFailed(f"{param.name}: a measured value is required.", code="value_required")
        ok = (param.lower is None or value >= param.lower) and (param.upper is None or value <= param.upper)
        return ok
    if param.kind == "BOOLEAN":
        if text not in ("PASS", "FAIL"):
            raise ValidationFailed(f"{param.name}: record PASS or FAIL in text.", code="value_required")
        return text == "PASS"
    return text != "FAIL"


@transaction.atomic
def record_result(actor, inspection_id, *, parameter_id, value=None, text="", comment="", correction_reason=""):
    i = core.lock(m.Inspection, inspection_id, "Inspection")
    _mine(actor, i)
    if i.status != "IN_PROGRESS":
        raise core.bad_state("Results can be recorded only while the inspection is in progress.")
    param = m.Parameter.objects.filter(pk=parameter_id, plan_id=i.plan_id, is_active=True).first()
    if param is None:
        raise core.nf("Parameter")
    v = dec(value, "value") if value not in (None, "") else None
    passed = _evaluate(param, v, text)
    if not passed and not (comment or text == "FAIL" and comment):
        pass
    old = m.Result.objects.select_for_update().filter(inspection=i, parameter=param, is_current=True).first()
    if old and not correction_reason:
        raise ValidationFailed("A result is already recorded; give the reason for correcting it.", code="correction_reason_required")
    if old:
        old.is_current = False
        old.save(update_fields=["is_current", "updated_at"])
    new = m.Result.objects.create(inspection=i, parameter=param, value=v, text=text[:300], passed=passed, comment=comment[:500], recorded_by=actor, correction_reason=correction_reason[:300])
    if old:
        old.superseded_by = new
        old.save(update_fields=["superseded_by", "updated_at"])
        core.event("inspection", i.id, "RESULT_CORRECTED", actor, note=f"{param.name}: {old.value or old.text} -> {new.value or new.text}; {correction_reason}")
    else:
        core.event("inspection", i.id, "RESULT_RECORDED", actor, note=f"{param.name}: {new.value if new.value is not None else new.text} {'PASS' if passed else 'FAIL'}")
    return new


@transaction.atomic
def record_defect(actor, inspection_id, *, defect_code, quantity, note="", lot_number=""):
    i = core.lock(m.Inspection, inspection_id, "Inspection")
    _mine(actor, i)
    if i.status != "IN_PROGRESS":
        raise core.bad_state("Defects are recorded while the inspection is in progress.")
    core.config_item("DEFECT_TYPE", defect_code)
    q = dec(quantity, "quantity")
    if q <= 0:
        raise ValidationFailed("quantity must be positive.", code="invalid_fields")
    return m.Defect.objects.create(inspection=i, product_id=i.product_id, defect_code=defect_code, quantity=q, lot_number=lot_number or i.lot_number, note=note[:300], recorded_by=actor, occurred_on=core.today())


@transaction.atomic
def complete(actor, pk, *, quantity_accepted=None, quantity_rejected=None, summary="", accept_conditionally=False, conditional_note=""):
    """Decide the result from the recorded results. A failed inspection puts the goods on hold and raises an NCR; it never releases anything."""
    i = core.lock(m.Inspection, pk, "Inspection")
    _mine(actor, i)
    if i.status != "IN_PROGRESS":
        raise core.bad_state("Only an inspection in progress can be completed.")
    params = list(i.plan.parameters.filter(is_active=True))
    current = {r.parameter_id: r for r in i.results.filter(is_current=True)}
    missing = [p.name for p in params if p.mandatory and p.id not in current]
    if missing:
        raise ValidationFailed("Mandatory results missing: " + ", ".join(missing), code="results_incomplete")
    failed = [p for p in params if p.id in current and not current[p.id].passed]
    critical = any(p.critical for p in failed)
    total = i.quantity_total
    insp = i.quantity_inspected or total
    acc = dec(quantity_accepted) if quantity_accepted not in (None, "") else (insp if not failed else Decimal(0))
    rej = dec(quantity_rejected) if quantity_rejected not in (None, "") else (Decimal(0) if not failed else insp)
    if acc < 0 or rej < 0 or acc + rej > max(total, insp):
        raise ValidationFailed("Accepted and rejected quantities must be non-negative and within the quantity inspected.", code="invalid_quantities")
    if failed and rej == 0 and total and not accept_conditionally:
        raise ValidationFailed("A failed inspection must record the rejected quantity.", code="invalid_quantities")
    if not failed:
        result = "PASS"
    elif accept_conditionally and not critical:
        if not conditional_note:
            raise ValidationFailed("Explain the conditions for accepting.", code="invalid_fields")
        result = "CONDITIONAL"
    else:
        if accept_conditionally and critical:
            raise DomainError("A failed critical parameter cannot be accepted conditionally.", code="critical_failure", status_code=409)
        result = "FAIL"
    i.status, i.result, i.completed_at, i.summary, i.conditional_note = "COMPLETED", result, timezone.now(), summary[:500], conditional_note[:500]
    i.quantity_accepted, i.quantity_rejected = acc, rej
    i.save()
    core.event("inspection", i.id, "COMPLETED", actor, from_status="IN_PROGRESS", to_status="COMPLETED", note=result)
    events.emit("quality.inspection.completed", {"inspection": str(i.id), "result": result, "product": str(i.product_id or ""), "supplier": str(i.supplier_id or "")}, dedup_key=f"inspection-done:{i.id}")
    if result in ("FAIL", "CONDITIONAL") and i.product_id:
        holds.place_hold(actor, product_id=i.product_id, lot_number=i.lot_number, quantity=rej or total, reason=f"Inspection {i.number} {result.lower()}: {', '.join(p.name for p in failed)}", source_type="inspection", source_id=i.id)
    if result == "FAIL" and org.get_setting("quality.fail_requires_ncr", True):
        from modules.quality import ncr
        ncr.raise_from_inspection(actor, i, failed)
    _link_request(actor, i)
    return i


def _link_request(actor, i):
    r = m.InspectionRequest.objects.filter(inspection=i, status__in=("SCHEDULED", "REQUESTED")).first()
    if r:
        r.status = "INSPECTED"
        r.save(update_fields=["status", "updated_at"])
        core.event("inspection_request", r.id, "INSPECTED", actor, to_status="INSPECTED", note=i.result)


def is_passed(inspection_id):
    return m.Inspection.objects.filter(pk=inspection_id, status="COMPLETED", result__in=("PASS", "CONDITIONAL")).exists()


@transaction.atomic
def cancel(actor, pk, *, reason):
    i = core.lock(m.Inspection, pk, "Inspection")
    if i.status not in ("SCHEDULED", "IN_PROGRESS"):
        raise core.bad_state("A completed inspection is a permanent record and cannot be cancelled.")
    if not reason:
        raise ValidationFailed("Give a reason.", code="invalid_fields")
    core.set_status(i, "inspection", "CANCELLED", actor, "CANCELLED", note=reason)
    return i


@transaction.atomic
def reinspect(actor, pk, *, scheduled_for, inspector_id=None):
    """Schedule a re-inspection of a failed one. The original inspection and its results stay untouched."""
    i = get_inspection(pk)
    if i.status != "COMPLETED" or i.result not in ("FAIL", "CONDITIONAL"):
        raise core.bad_state("Only a failed or conditional inspection is re-inspected.")
    new = schedule(actor, {"plan_id": i.plan_id, "scheduled_for": scheduled_for, "inspector_id": inspector_id or i.inspector_id, "ref_type": i.ref_type, "ref_id": i.ref_id,
                           "product_id": i.product_id, "supplier_id": i.supplier_id, "project_id": i.project_id, "lot_number": i.lot_number, "quantity_total": i.quantity_total,
                           "reinspection_of": i.id})
    m.Hold.objects.filter(source_type="inspection", source_id=i.id, status="ACTIVE", reinspection_id__isnull=True).update(reinspection_id=new.id)
    return new


def list_inspections(**f):
    qs = m.Inspection.objects.all().order_by("-scheduled_for", "-created_at")
    for k in ("status", "result", "stage", "product_id", "supplier_id", "project_id", "inspector_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    return qs


def list_plans(**f):
    qs = m.InspectionPlan.objects.all().order_by("-created_at")
    for k in ("stage", "status", "product_id", "project_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    return qs


def reminders(on):
    n = 0
    for i in m.Inspection.objects.filter(status="SCHEDULED", scheduled_for__lt=on):
        notify([i.inspector_id], "quality.inspection_overdue", f"Inspection {i.number} overdue", f"Scheduled for {i.scheduled_for}", ref_type="quality.inspection", ref_id=str(i.id))
        n += 1
    return n

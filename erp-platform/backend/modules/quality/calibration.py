"""Measuring equipment and calibration. Overdue or failed equipment cannot be used for inspections."""
from datetime import timedelta

from django.db import transaction

from modules.quality import core, models as m
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify


def equipment_dict(e, detail=False):
    d = {"id": str(e.id), "tag": e.tag, "name": e.name, "status": e.status, "responsible_id": str(e.responsible_id), "interval_days": e.interval_days,
         "last_calibrated_on": e.last_calibrated_on.isoformat() if e.last_calibrated_on else None, "next_due_on": e.next_due_on.isoformat() if e.next_due_on else None,
         "overdue": bool(e.next_due_on and e.next_due_on < core.today()), "location": e.location, "hold_reason": e.hold_reason, "asset_id": str(e.asset_id) if e.asset_id else None}
    if detail:
        d.update({"manufacturer": e.manufacturer, "model": e.model, "serial_number": e.serial_number, "calibrations": [calibration_dict(c) for c in e.calibrations.order_by("-scheduled_for", "-created_at")],
                  "history": core.history("equipment", e.id)})
    return d


def calibration_dict(c):
    return {"id": str(c.id), "equipment_id": str(c.equipment_id), "status": c.status, "scheduled_for": c.scheduled_for.isoformat(), "performed_on": c.performed_on.isoformat() if c.performed_on else None,
            "performed_by": c.performed_by, "result": c.result, "as_found": c.as_found, "certificate_ref": c.certificate_ref, "out_of_tolerance": c.out_of_tolerance,
            "impacts": [{"id": str(i.id), "inspection_id": str(i.inspection_id), "status": i.status, "note": i.note} for i in c.impacts.all()]}


def get(pk):
    e = m.Equipment.objects.filter(pk=pk).first()
    if e is None:
        raise core.nf("Equipment")
    return e


@transaction.atomic
def register(actor, data):
    core.need(data, "tag", "name", "responsible_id", "interval_days")
    if m.Equipment.objects.filter(tag=data["tag"]).exists():
        raise ValidationFailed("This equipment tag is already registered.", code="duplicate")
    if int(data["interval_days"]) <= 0:
        raise ValidationFailed("interval_days must be positive.", code="invalid_fields")
    e = m.Equipment.objects.create(tag=data["tag"][:40], name=data["name"][:200], manufacturer=data.get("manufacturer", ""), model=data.get("model", ""), serial_number=data.get("serial_number", ""),
                                   department_id=data.get("department_id"), location=data.get("location", ""), responsible_id=data["responsible_id"], asset_id=data.get("asset_id"),
                                   interval_days=int(data["interval_days"]), last_calibrated_on=data.get("last_calibrated_on"))
    e.next_due_on = (e.last_calibrated_on + timedelta(days=e.interval_days)) if e.last_calibrated_on else core.today()
    e.save(update_fields=["next_due_on"])
    core.event("equipment", e.id, "REGISTERED", actor)
    return e


@transaction.atomic
def schedule(actor, equipment_id, *, scheduled_for):
    e = core.lock(m.Equipment, equipment_id, "Equipment")
    if e.status == "RETIRED":
        raise core.bad_state("The equipment is retired.")
    if m.Calibration.objects.filter(equipment=e, status="SCHEDULED").exists():
        raise ValidationFailed("A calibration is already scheduled.", code="duplicate")
    c = m.Calibration.objects.create(equipment=e, scheduled_for=scheduled_for)
    core.event("equipment", e.id, "CALIBRATION_SCHEDULED", actor, note=str(scheduled_for))
    return c


@transaction.atomic
def record(actor, calibration_id, *, performed_on, performed_by, result, certificate_ref="", as_found="", certificate_file=None):
    c = m.Calibration.objects.select_for_update().filter(pk=calibration_id).first()
    if c is None:
        raise core.nf("Calibration")
    e = core.lock(m.Equipment, c.equipment_id, "Equipment")
    if c.status != "SCHEDULED":
        raise core.bad_state("The calibration is already recorded.")
    if result not in ("PASS", "FAIL", "ADJUSTED"):
        raise ValidationFailed("result must be PASS, FAIL or ADJUSTED.", code="invalid_fields")
    if performed_on > core.today():
        raise ValidationFailed("The calibration date is in the future.", code="invalid_dates")
    if not performed_by or not certificate_ref:
        raise ValidationFailed("Record who calibrated it and the certificate reference.", code="invalid_fields")
    oot = result == "FAIL" or (result == "ADJUSTED" and bool(as_found))
    if oot and not as_found:
        raise ValidationFailed("Record the as-found condition.", code="as_found_required")
    c.status, c.performed_on, c.performed_by, c.result, c.certificate_ref, c.as_found, c.out_of_tolerance, c.recorded_by = "DONE", performed_on, performed_by[:200], result, certificate_ref[:100], as_found[:500], oot, actor
    c.next_due_on = performed_on + timedelta(days=e.interval_days)
    c.save()
    if certificate_file:
        core.add_evidence(actor, "equipment", e.id, filename=certificate_file[0], data=certificate_file[1], kind="CERTIFICATE")
    if oot:
        prev = e.last_calibrated_on or (performed_on - timedelta(days=e.interval_days))
        used = m.Inspection.objects.filter(equipment_used__equipment=e, status="COMPLETED", completed_at__date__gte=prev, completed_at__date__lte=performed_on).distinct()
        for i in used:
            m.ImpactAssessment.objects.get_or_create(calibration=c, inspection=i)
        e.status, e.hold_reason = "ON_HOLD", f"Out of tolerance at calibration {performed_on}"
        e.save(update_fields=["status", "hold_reason", "updated_at"])
        core.event("equipment", e.id, "OUT_OF_TOLERANCE", actor, to_status="ON_HOLD", note=f"{used.count()} inspection(s) to assess")
        notify(list(core.users_with_permission("quality.calibration.manage") | {e.responsible_id}), "quality.calibration_failed", f"Equipment {e.tag} out of tolerance", f"{used.count()} inspection(s) need an impact assessment", ref_type="quality.equipment", ref_id=str(e.id))
    else:
        e.last_calibrated_on, e.next_due_on, e.last_reminder_on = performed_on, c.next_due_on, None
        e.save(update_fields=["last_calibrated_on", "next_due_on", "last_reminder_on", "updated_at"])
    if not oot:
        core.event("equipment", e.id, "CALIBRATED", actor, note=result)
    return c


@transaction.atomic
def assess_impact(actor, impact_id, *, affected, note):
    i = m.ImpactAssessment.objects.select_for_update().filter(pk=impact_id).first()
    if i is None:
        raise core.nf("Impact assessment")
    if i.status != "PENDING":
        raise core.bad_state("This inspection was already assessed.")
    if not note:
        raise ValidationFailed("Record the assessment.", code="invalid_fields")
    i.status, i.note, i.assessed_by, i.assessed_at = ("REINSPECT" if affected else "NOT_AFFECTED"), note[:500], actor, core.timezone.now()
    i.save()
    core.event("equipment", i.calibration.equipment_id, "IMPACT_ASSESSED", actor, note=f"{i.inspection.number}: {i.status}")
    return i


@transaction.atomic
def return_to_service(actor, equipment_id, *, calibration_id, note=""):
    """After a failure the equipment returns only with a passing re-calibration and every affected inspection assessed."""
    e = core.lock(m.Equipment, equipment_id, "Equipment")
    if e.status != "ON_HOLD":
        raise core.bad_state("The equipment is not on hold.")
    good = m.Calibration.objects.filter(pk=calibration_id, equipment=e, status="DONE", result__in=("PASS", "ADJUSTED"), out_of_tolerance=False).first()
    if good is None:
        raise DomainError("Record a passing calibration first.", code="calibration_required", status_code=409)
    failed = m.Calibration.objects.filter(equipment=e, out_of_tolerance=True).order_by("-performed_on").first()
    if failed and failed.impacts.filter(status="PENDING").exists():
        raise DomainError("Assess the impact on every affected inspection first.", code="impact_pending", status_code=409)
    e.status, e.hold_reason, e.last_calibrated_on, e.next_due_on = "ACTIVE", "", good.performed_on, good.next_due_on
    e.save()
    core.event("equipment", e.id, "RETURNED_TO_SERVICE", actor, to_status="ACTIVE", note=note)
    return e


@transaction.atomic
def retire(actor, equipment_id, *, reason):
    e = core.lock(m.Equipment, equipment_id, "Equipment")
    if not reason:
        raise ValidationFailed("Give the reason.", code="invalid_fields")
    core.set_status(e, "equipment", "RETIRED", actor, "RETIRED", note=reason)
    return e


def list_equipment(**f):
    qs = m.Equipment.objects.all().order_by("next_due_on", "tag")
    if f.get("status"):
        qs = qs.filter(status=f["status"])
    if f.get("overdue"):
        qs = qs.filter(next_due_on__lt=core.today()).exclude(status="RETIRED")
    if f.get("due_within"):
        qs = qs.filter(next_due_on__lte=core.today() + timedelta(days=int(f["due_within"]))).exclude(status="RETIRED")
    return qs


def reminders(on):
    n = 0
    notice = int(org.get_setting("quality.calibration_notice_days", 14))
    qs = m.Equipment.objects.filter(status="ACTIVE", next_due_on__lte=on + timedelta(days=notice))
    for e in qs:
        if e.last_reminder_on and e.last_reminder_on > on - timedelta(days=7):
            continue
        late = e.next_due_on < on
        notify([e.responsible_id], "quality.calibration_due", f"Calibration {'overdue' if late else 'due'}: {e.tag}", f"{e.name}: due {e.next_due_on}", ref_type="quality.equipment", ref_id=str(e.id))
        e.last_reminder_on = on
        e.save(update_fields=["last_reminder_on"])
        n += 1
    return n

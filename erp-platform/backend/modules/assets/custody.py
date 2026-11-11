"""Assignment and custody, handover forms, returns, and transfers between locations, departments, custodians and projects."""
from datetime import timedelta
from html import escape

from django.db import transaction
from django.utils import timezone

from modules.assets import models as m
from modules.assets import services as svc
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ASSIGNEE_TYPES = ("EMPLOYEE", "DEPARTMENT", "PROJECT", "LOCATION")
OPEN = ("REQUESTED", "APPROVED", "ACTIVE")


def _cond(c, name="condition"):
    if c not in m.CONDITIONS:
        raise ValidationFailed(f"{name} must be one of {', '.join(m.CONDITIONS)}.", code="invalid_condition")
    return c


def _employee(eid):
    from modules.hr.models import Employee

    e = Employee.objects.filter(pk=eid).first()
    if e is None or e.status in ("TERMINATED",):
        raise ValidationFailed("The employee does not exist or has left the company.", code="invalid_employee")
    return e


def _assign(pk, lock=True):
    qs = m.AssetAssignment.objects.select_for_update(of=("self",)) if lock else m.AssetAssignment.objects
    a = qs.select_related("asset").filter(pk=pk).first()
    if a is None:
        raise DomainError("Assignment not found.", code="not_found", status_code=404)
    return a


def _has(user_id, code):
    from platform_core.authorization import services as authz

    return authz.has_permission(user_id, code)


# ----------------------------------------------------------------------------- assignment
@transaction.atomic
def request_assignment(actor_id, asset_id, *, assignee_type, assignee_id=None, assignee_ref="", kind="PERMANENT", assigned_on, expected_return_on=None, purpose=""):
    asset = svc._get(asset_id, lock=True)
    if asset.status != "AVAILABLE":
        raise DomainError(f"Only an available asset can be assigned (this one is {asset.status}).", code="asset_not_available")
    if m.AssetAssignment.objects.filter(asset=asset, status__in=OPEN).exists():
        raise DomainError("This asset already has an open assignment.", code="already_pending")
    if assignee_type not in ASSIGNEE_TYPES:
        raise ValidationFailed("Unknown assignee type.", code="invalid_assignee")
    if kind not in ("TEMPORARY", "PERMANENT"):
        raise ValidationFailed("Assignment kind must be TEMPORARY or PERMANENT.", code="invalid_kind")
    if kind == "TEMPORARY" and (expected_return_on is None or expected_return_on < assigned_on):
        raise ValidationFailed("A temporary assignment needs an expected return date on or after the start.", code="return_date_required")
    if assignee_type == "EMPLOYEE":
        _employee(assignee_id)
    elif assignee_type == "DEPARTMENT":
        from platform_core.organizations.models import Department

        if not Department.objects.filter(pk=assignee_id).exists():
            raise ValidationFailed("Department not found.", code="invalid_assignee")
    elif assignee_type == "LOCATION":
        if not m.AssetLocation.objects.filter(pk=assignee_id, is_active=True).exists():
            raise ValidationFailed("Location not found.", code="invalid_assignee")
    elif not (assignee_ref or "").strip():
        raise ValidationFailed("A project reference is required.", code="invalid_assignee")
    a = m.AssetAssignment.objects.create(number=sequences.next_number("assets.assignment", on_date=assigned_on, for_type="AssetAssignment"), asset=asset, assignee_type=assignee_type, assignee_id=assignee_id, assignee_ref=assignee_ref[:60], kind=kind, assigned_on=assigned_on, expected_return_on=expected_return_on, purpose=purpose[:300], requested_by=actor_id)
    svc.log(asset, "ASSIGNMENT_REQUESTED", actor_id=actor_id, number=a.number, assignee_type=assignee_type, assignee=assignee_id or assignee_ref)
    return a


@transaction.atomic
def approve_assignment(actor_id, assignment_id, *, approve=True, note=""):
    a = _assign(assignment_id)
    if a.status != "REQUESTED":
        raise DomainError("Only a requested assignment can be decided.", code="invalid_state")
    if a.requested_by == actor_id:
        raise DomainError("Separation of duties: someone else must approve the assignment.", code="separation_of_duties", status_code=403)
    if not approve and not (note or "").strip():
        raise ValidationFailed("A reason is required to reject.", code="reason_required")
    a.status, a.approved_by = ("APPROVED" if approve else "REJECTED"), actor_id
    a.save(update_fields=["status", "approved_by", "updated_at"])
    return a


@transaction.atomic
def hand_over(actor_id, assignment_id, *, condition, notes=""):
    a = _assign(assignment_id)
    asset = svc._get(a.asset_id, lock=True)
    if a.status != "APPROVED":
        raise DomainError("Only an approved assignment can be handed over.", code="invalid_state")
    if asset.status != "AVAILABLE":
        raise DomainError("The asset is no longer available.", code="asset_not_available")
    a.condition_out, a.notes_out, a.handed_over_by, a.status = _cond(condition), notes[:300], actor_id, "ACTIVE"
    a.save()
    asset.condition = a.condition_out
    if a.assignee_type == "EMPLOYEE":
        e = _employee(a.assignee_id)
        asset.custodian_id = e.id
        asset.department_id = e.department_id or asset.department_id
    elif a.assignee_type == "DEPARTMENT":
        asset.department_id = a.assignee_id
    elif a.assignee_type == "LOCATION":
        asset.location_id = a.assignee_id
    asset.save()
    svc.set_status(actor_id, asset.id, "ASSIGNED", reason=f"Assignment {a.number}")
    svc.log(asset, "HANDED_OVER", actor_id=actor_id, number=a.number, condition=a.condition_out)
    return a


@transaction.atomic
def acknowledge_custody(actor_id, assignment_id):
    a = _assign(assignment_id)
    if a.status != "ACTIVE":
        raise DomainError("Only an active assignment can be acknowledged.", code="invalid_state")
    if a.acknowledged_at:
        raise DomainError("Custody was already acknowledged.", code="already_recorded")
    if a.assignee_type == "EMPLOYEE":
        if _employee(a.assignee_id).user_id != actor_id:
            raise DomainError("Only the employee receiving the asset can acknowledge custody.", code="not_the_assignee", status_code=403)
    elif not _has(actor_id, "assets.custody.manage"):
        raise DomainError("Custody of a department, location or project asset is acknowledged by asset staff on its behalf.", code="not_authorised", status_code=403)
    a.acknowledged_by, a.acknowledged_at = actor_id, timezone.now()
    a.save(update_fields=["acknowledged_by", "acknowledged_at", "updated_at"])
    svc.log(a.asset, "CUSTODY_ACKNOWLEDGED", actor_id=actor_id, number=a.number)
    return a


@transaction.atomic
def record_return(actor_id, assignment_id, *, condition, notes="", returned_on=None):
    a = _assign(assignment_id)
    asset = svc._get(a.asset_id, lock=True)
    if a.status != "ACTIVE":
        raise DomainError("Only an active assignment can be returned.", code="invalid_state")
    cond = _cond(condition)
    if cond in ("POOR", "DAMAGED") and not (notes or "").strip():
        raise ValidationFailed("Describe the damage or wear on return.", code="notes_required")
    a.condition_in, a.notes_in, a.returned_by, a.returned_on, a.status = cond, notes[:300], actor_id, returned_on or timezone.now().date(), "RETURNED"
    a.save()
    asset.condition, asset.custodian_id = cond, None
    asset.save(update_fields=["condition", "custodian_id", "updated_at"])
    svc.set_status(actor_id, asset.id, "UNDER_MAINTENANCE" if cond == "DAMAGED" else "AVAILABLE", reason=f"Returned from {a.number} in {cond} condition")
    svc.log(asset, "RETURNED", actor_id=actor_id, number=a.number, condition=cond)
    return a


@transaction.atomic
def cancel_assignment(actor_id, assignment_id):
    a = _assign(assignment_id)
    if a.status not in ("REQUESTED", "APPROVED"):
        raise DomainError("Only an assignment that has not been handed over can be cancelled.", code="invalid_state")
    a.status = "CANCELLED"
    a.save(update_fields=["status", "updated_at"])
    return a


def unreturned(today=None):
    today = today or timezone.now().date()
    return [{"assignment": a.number, "asset": a.asset.number, "name": a.asset.name, "assignee_type": a.assignee_type, "assignee_id": None if not a.assignee_id else str(a.assignee_id), "expected_return_on": str(a.expected_return_on), "days_overdue": (today - a.expected_return_on).days}
            for a in m.AssetAssignment.objects.filter(status="ACTIVE", kind="TEMPORARY", expected_return_on__lt=today).select_related("asset").order_by("expected_return_on")]


def unacknowledged():
    return [{"assignment": a.number, "asset": a.asset.number, "assignee_type": a.assignee_type, "since": str(a.assigned_on)} for a in m.AssetAssignment.objects.filter(status="ACTIVE", acknowledged_at__isnull=True).select_related("asset")]


def custody_report(*, employee_id=None, department_id=None):
    qs = m.AssetAssignment.objects.filter(status="ACTIVE").select_related("asset")
    if employee_id:
        qs = qs.filter(assignee_type="EMPLOYEE", assignee_id=employee_id)
    if department_id:
        qs = qs.filter(assignee_type="DEPARTMENT", assignee_id=department_id)
    return [{"assignment": a.number, "asset": a.asset.number, "name": a.asset.name, "assignee_type": a.assignee_type, "assignee_id": None if not a.assignee_id else str(a.assignee_id), "project": a.assignee_ref, "kind": a.kind, "since": str(a.assigned_on), "expected_return_on": None if not a.expected_return_on else str(a.expected_return_on), "condition_out": a.condition_out, "acknowledged": bool(a.acknowledged_at)} for a in qs.order_by("asset__number")]


def employee_equipment(employee_id):
    return custody_report(employee_id=employee_id)


def handover_form(assignment_id):
    a = _assign(assignment_id, lock=False)
    asset = a.asset
    return {"number": a.number, "asset": {"number": asset.number, "name": asset.name, "serial_number": asset.serial_number, "manufacturer": asset.manufacturer, "model": asset.model}, "assignee_type": a.assignee_type, "assignee_id": None if not a.assignee_id else str(a.assignee_id), "project": a.assignee_ref, "kind": a.kind,
            "assigned_on": str(a.assigned_on), "expected_return_on": None if not a.expected_return_on else str(a.expected_return_on), "condition_out": a.condition_out, "notes_out": a.notes_out, "status": a.status, "acknowledged": bool(a.acknowledged_at),
            "terms": "The receiver is responsible for the asset, will use it for company purposes only and will return it on request or on leaving the company."}


def handover_html(assignment_id):
    f = handover_form(assignment_id)
    rows = "".join(f"<tr><th>{escape(k)}</th><td>{escape(str(v))}</td></tr>" for k, v in (("Handover", f["number"]), ("Asset", f"{f['asset']['number']} {f['asset']['name']}"), ("Serial", f["asset"]["serial_number"]), ("Assigned to", f"{f['assignee_type']} {f['assignee_id'] or f['project']}"), ("Type", f["kind"]), ("From", f["assigned_on"]), ("Expected return", f["expected_return_on"] or "-"), ("Condition at handover", f["condition_out"] or "-")))
    return f"<!doctype html><html><head><meta charset='utf-8'><title>{escape(f['number'])}</title></head><body><h1>Asset handover {escape(f['number'])}</h1><table>{rows}</table><p>{escape(f['terms'])}</p><p>Receiver signature: ____________________ Date: ____________</p></body></html>"


@transaction.atomic
def run_reminders(today=None):
    """Remind assignees/requesters about assets past their return date, at most once a week per assignment."""
    today = today or timezone.now().date()
    sent = 0
    for a in m.AssetAssignment.objects.select_for_update().filter(status="ACTIVE", kind="TEMPORARY", expected_return_on__lt=today).select_related("asset"):
        if a.last_reminder_on and (today - a.last_reminder_on).days < 7:
            continue
        ids = [a.requested_by]
        if a.assignee_type == "EMPLOYEE":
            e = _employee(a.assignee_id)
            if e.user_id:
                ids.append(e.user_id)
        notify(ids, "assets.return_overdue", f"{a.asset.number} was due back {a.expected_return_on}", a.asset.name, ref_type="assets.assignment", ref_id=str(a.id))
        a.last_reminder_on = today
        a.save(update_fields=["last_reminder_on", "updated_at"])
        sent += 1
    return sent


# ----------------------------------------------------------------------------- transfers
def _tr(pk):
    t = m.AssetTransfer.objects.select_for_update(of=("self",)).select_related("asset").filter(pk=pk).first()
    if t is None:
        raise DomainError("Transfer not found.", code="not_found", status_code=404)
    return t


@transaction.atomic
def request_transfer(actor_id, asset_id, *, reason, effective_date, to_location_id=None, to_department_id=None, to_custodian_id=None, to_project_ref=""):
    asset = svc._get(asset_id, lock=True)
    if asset.status != "AVAILABLE":
        raise DomainError("Only an available asset can be transferred; return it from any assignment first.", code="asset_not_available")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    if not (to_location_id or to_department_id or to_custodian_id or to_project_ref):
        raise ValidationFailed("Say where the asset is going.", code="destination_required")
    if to_location_id and not m.AssetLocation.objects.filter(pk=to_location_id, is_active=True).exists():
        raise ValidationFailed("Unknown destination location.", code="invalid_location")
    if to_custodian_id:
        _employee(to_custodian_id)
    if m.AssetTransfer.objects.filter(asset=asset, status__in=("REQUESTED", "APPROVED", "IN_TRANSIT")).exists():
        raise DomainError("This asset already has an open transfer.", code="already_pending")
    t = m.AssetTransfer.objects.create(number=sequences.next_number("assets.transfer", on_date=effective_date, for_type="AssetTransfer"), asset=asset, reason=reason[:300], effective_date=effective_date, from_location_id=asset.location_id, from_department_id=asset.department_id, from_custodian_id=asset.custodian_id,
                                       to_location_id=to_location_id, to_department_id=to_department_id, to_custodian_id=to_custodian_id, to_project_ref=to_project_ref[:60], requested_by=actor_id)
    svc.log(asset, "TRANSFER_REQUESTED", actor_id=actor_id, number=t.number, to_location=to_location_id, to_department=to_department_id, to_custodian=to_custodian_id)
    return t


@transaction.atomic
def decide_transfer(actor_id, transfer_id, *, approve, note=""):
    t = _tr(transfer_id)
    if t.status != "REQUESTED":
        raise DomainError("Only a requested transfer can be decided.", code="invalid_state")
    if t.requested_by == actor_id:
        raise DomainError("Separation of duties: someone else must approve the transfer.", code="separation_of_duties", status_code=403)
    if not approve and not (note or "").strip():
        raise ValidationFailed("A reason is required to reject.", code="reason_required")
    t.status, t.approved_by, t.decision_note = ("APPROVED" if approve else "REJECTED"), actor_id, note[:300]
    t.save()
    return t


@transaction.atomic
def dispatch_transfer(actor_id, transfer_id, *, condition):
    t = _tr(transfer_id)
    if t.status != "APPROVED":
        raise DomainError("Only an approved transfer can be dispatched.", code="invalid_state")
    asset = svc._get(t.asset_id, lock=True)
    if asset.status != "AVAILABLE":
        raise DomainError("The asset is no longer available.", code="asset_not_available")
    t.condition_out, t.dispatched_by, t.status = _cond(condition), actor_id, "IN_TRANSIT"
    t.save()
    asset.condition = t.condition_out
    asset.save(update_fields=["condition", "updated_at"])
    svc.set_status(actor_id, asset.id, "TRANSFERRED", reason=f"Transfer {t.number} dispatched")
    return t


@transaction.atomic
def receive_transfer(actor_id, transfer_id, *, condition, notes=""):
    """The receiving person acknowledges; only now do ownership, custody and location change."""
    t = _tr(transfer_id)
    if t.status != "IN_TRANSIT":
        raise DomainError("Only a transfer in transit can be received.", code="invalid_state")
    if t.to_custodian_id:
        if _employee(t.to_custodian_id).user_id != actor_id:
            raise DomainError("The receiving custodian must acknowledge this transfer.", code="not_the_assignee", status_code=403)
    elif actor_id == t.requested_by or actor_id == t.dispatched_by:
        raise DomainError("Separation of duties: the receiver must differ from the sender.", code="separation_of_duties", status_code=403)
    cond = _cond(condition)
    if cond != t.condition_out and not (notes or "").strip():
        raise ValidationFailed("Explain why the condition changed in transit.", code="notes_required")
    asset = svc._get(t.asset_id, lock=True)
    changes = {}
    if t.to_location_id:
        changes["location_id"] = t.to_location_id
    if t.to_department_id:
        changes["department_id"] = t.to_department_id
    if t.to_custodian_id:
        changes["custodian_id"] = t.to_custodian_id
    for k, v in changes.items():
        svc.log(asset, "OWNERSHIP_CHANGED", actor_id=actor_id, field=k, old=getattr(asset, k), new=v, transfer=t.number)
        setattr(asset, k, v)
    asset.condition = cond
    asset.version += 1
    asset.save()
    t.condition_in, t.notes_in, t.received_by, t.status = cond, notes[:300], actor_id, "COMPLETED"
    t.save()
    svc.set_status(actor_id, asset.id, "UNDER_MAINTENANCE" if cond == "DAMAGED" else "AVAILABLE", reason=f"Transfer {t.number} received")
    svc.log(asset, "TRANSFER_COMPLETED", actor_id=actor_id, number=t.number, condition=cond)
    return t


@transaction.atomic
def cancel_transfer(actor_id, transfer_id):
    t = _tr(transfer_id)
    if t.status not in ("REQUESTED", "APPROVED"):
        raise DomainError("Only a transfer that has not been dispatched can be cancelled.", code="invalid_state")
    t.status = "CANCELLED"
    t.save(update_fields=["status", "updated_at"])
    return t


def transfer_history(asset_id=None):
    qs = m.AssetTransfer.objects.select_related("asset", "from_location", "to_location").order_by("-created_at")
    if asset_id:
        qs = qs.filter(asset_id=asset_id)
    return [{"number": t.number, "asset": t.asset.number, "status": t.status, "reason": t.reason, "effective_date": str(t.effective_date), "from_location": t.from_location.code if t.from_location else None, "to_location": t.to_location.code if t.to_location else None,
             "from_department": None if not t.from_department_id else str(t.from_department_id), "to_department": None if not t.to_department_id else str(t.to_department_id), "condition_out": t.condition_out, "condition_in": t.condition_in} for t in qs[:500]]

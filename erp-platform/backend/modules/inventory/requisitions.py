"""Material requisitions and issue vouchers: request -> approval -> reservation -> (partial) issue -> consumption return."""
from decimal import Decimal

from django.db import transaction

from modules.inventory import availability
from modules.inventory import models as m
from modules.inventory import services as svc
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant
from shared.workflows import services as workflows

SUBJECT = "inventory.requisition"
DESTINATIONS = {"DEPARTMENT", "PROJECT", "COST_CENTER", "EQUIPMENT", "PRODUCTION"}
REF = "inventory.requisition"


def _dec(v, name="quantity"):
    try:
        return Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")


def _req(req_id, lock=False):
    qs = m.MaterialRequisition.objects.select_for_update(of=("self",)) if lock else m.MaterialRequisition.objects
    r = qs.select_related("warehouse").filter(pk=req_id).first()
    if not r:
        raise DomainError("Requisition not found.", code="not_found", status_code=404)
    return r


def _outstanding(line):
    return line.quantity - line.issued_quantity


@transaction.atomic
def create(actor_id, *, warehouse_id, lines, destination_type="DEPARTMENT", destination_ref="", department_id=None, purpose="", needed_by=None):
    wh = svc._get(m.Warehouse, warehouse_id, "Warehouse")
    if destination_type not in DESTINATIONS:
        raise ValidationFailed("Invalid destination type.", code="invalid_destination")
    if destination_type != "DEPARTMENT" and not destination_ref:
        raise ValidationFailed("A destination reference (project, cost centre, equipment...) is required.", code="destination_required")
    if not lines:
        raise ValidationFailed("At least one line is required.", code="no_lines")
    r = m.MaterialRequisition.objects.create(number=sequences.next_number("inventory.requisition", for_type="MaterialRequisition"), requester_id=actor_id, department_id=department_id, destination_type=destination_type, destination_ref=destination_ref, warehouse=wh, purpose=purpose[:300], needed_by=needed_by)
    for ln in lines:
        product, qty = svc._product(ln.get("product")), _dec(ln.get("quantity"))
        if qty <= 0:
            raise ValidationFailed("Line quantity must be positive.", code="invalid_amount")
        if not product.is_stocked:
            raise ValidationFailed(f"{product.sku} is not a stocked item.", code="not_stocked")
        m.MaterialRequisitionLine.objects.create(requisition=r, product=product, quantity=qty)
    return r


def line_availability(req_id):
    r = _req(req_id)
    return [{"line": str(l.id), "sku": l.product.sku, "requested": str(l.quantity), "available": availability.availability(l.product_id, r.warehouse_id)["available"]} for l in r.lines.select_related("product")]


@transaction.atomic
def submit(actor_id, req_id):
    r = _req(req_id, lock=True)
    if r.requester_id != actor_id:
        raise DomainError("Requisition not found.", code="not_found", status_code=404)
    if r.status != "DRAFT":
        raise DomainError("Only a draft can be submitted.", code="invalid_state")
    r.status = "SUBMITTED"
    if workflows.WorkflowDefinition.objects.filter(subject_type=SUBJECT, is_active=True).exists():
        inst = workflows.submit(actor_id, SUBJECT, str(r.id), amount=None, title=f"Material requisition {r.number}")
        r.workflow_instance_id = inst.id
    r.save()
    return r


def _reserve(r):
    """Hold what is available for the outstanding quantities; the shortfall stays a backorder."""
    availability.release_by_ref(None, REF, r.id, status="RELEASED")
    for l in r.lines.all():
        need = _outstanding(l)
        if need <= 0:
            continue
        have = Decimal(availability.availability(l.product_id, r.warehouse_id)["available"])
        take = min(need, have)
        if take > 0:
            availability.reserve(None, product_id=l.product_id, quantity=take, warehouse_id=r.warehouse_id, ref_type=REF, ref_id=str(r.id), note=r.number)


def _approved(r, approver):
    r.status, r.approved_by = "APPROVED", approver
    r.save(update_fields=["status", "approved_by", "updated_at"])
    _reserve(r)
    notify([r.requester_id], "inventory.requisition.approved", f"Requisition {r.number} approved", "", ref_type=REF, ref_id=str(r.id))


@transaction.atomic
def approve(actor_id, req_id, *, note=""):
    r = _req(req_id, lock=True)
    if r.status != "SUBMITTED":
        raise DomainError("Only a submitted requisition can be approved.", code="invalid_state")
    if r.workflow_instance_id:
        raise DomainError("This requisition is governed by an approval workflow; decide it in the approval inbox.", code="workflow_governed")
    if r.requester_id == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own requisition.", code="separation_of_duties", status_code=403)
    r.decision_note = note[:300]
    _approved(r, actor_id)
    return r


@transaction.atomic
def reject(actor_id, req_id, *, note):
    r = _req(req_id, lock=True)
    if r.status != "SUBMITTED" or r.workflow_instance_id:
        raise DomainError("Only a directly-approved submitted requisition can be rejected here.", code="invalid_state")
    if not (note or "").strip():
        raise ValidationFailed("A reason is required.", code="note_required")
    r.status, r.decision_note = "REJECTED", note[:300]
    r.save(update_fields=["status", "decision_note", "updated_at"])
    notify([r.requester_id], "inventory.requisition.rejected", f"Requisition {r.number} rejected", note, ref_type=REF, ref_id=str(r.id))
    return r


def on_workflow_outcome(instance):
    with transaction.atomic():
        r = m.MaterialRequisition.objects.select_for_update(of=("self",)).filter(pk=instance.subject_id).first()
        if r is None or r.workflow_instance_id != instance.id or r.status != "SUBMITTED":
            return
        if instance.status == "APPROVED":
            last = instance.actions.filter(action="APPROVED").order_by("-created_at").first()
            _approved(r, last.actor_id if last else None)
        else:
            r.status, r.workflow_instance_id = "DRAFT", None
            r.save(update_fields=["status", "workflow_instance_id", "updated_at"])


@transaction.atomic
def cancel(actor_id, req_id):
    r = _req(req_id, lock=True)
    if r.requester_id != actor_id:
        raise DomainError("Requisition not found.", code="not_found", status_code=404)
    if r.status not in ("DRAFT", "SUBMITTED", "APPROVED"):
        raise DomainError("This requisition can no longer be cancelled.", code="invalid_state")
    if r.workflow_instance_id:
        inst = workflows.WorkflowInstance.objects.filter(pk=r.workflow_instance_id, status__in=workflows.WorkflowInstance.ACTIVE).first()
        if inst:
            r.workflow_instance_id = None
            r.save(update_fields=["workflow_instance_id"])
            workflows.cancel(actor_id, inst.id, comment="Requisition cancelled")
    availability.release_by_ref(actor_id, REF, r.id, status="RELEASED")
    r.status = "CANCELLED"
    r.save(update_fields=["status", "updated_at"])
    return r


@transaction.atomic
def issue(actor_id, req_id, *, location_id, lines=None, received_by="", notes=""):
    """Issue (part of) the outstanding quantities from one location. `lines` = [{line, quantity, lot_code}]; default: everything outstanding that is on hand."""
    r = _req(req_id, lock=True)
    if r.status not in ("APPROVED", "PARTIALLY_ISSUED"):
        raise DomainError("Only an approved requisition can be issued against.", code="invalid_state")
    loc = svc._location(location_id)
    if loc.warehouse_id != r.warehouse_id:
        raise ValidationFailed("Issue from a location of the requisition's warehouse.", code="wrong_warehouse")
    rl = {str(l.id): l for l in r.lines.select_for_update().select_related("product")}
    if lines is None:
        lines = []
        for l in rl.values():
            have = svc.on_hand(l.product_id, location_id=loc.id)
            q = min(_outstanding(l), have)
            if q > 0:
                lines.append({"line": str(l.id), "quantity": q})
    if not lines:
        raise DomainError("Nothing available to issue at this location.", code="nothing_to_issue")
    v = m.IssueVoucher.objects.create(number=sequences.next_number("inventory.issue_voucher", for_type="IssueVoucher"), requisition=r, issued_by=actor_id, received_by=received_by[:120], notes=notes[:300])
    for it in lines:
        l = rl.get(str(it.get("line")))
        if l is None:
            raise ValidationFailed("Unknown requisition line.", code="unknown_line")
        qty = _dec(it.get("quantity"))
        if qty <= 0 or qty > _outstanding(l):
            raise DomainError(f"{l.product.sku}: only {_outstanding(l)} outstanding.", code="over_issue")
        mv = svc.issue_stock(actor_id, product_id=l.product_id, location_id=loc.id, quantity=qty, lot_code=it.get("lot_code") or None, reason=f"Issue {v.number} for {r.number}", ref_type="inventory.issue_voucher", ref_id=str(v.id))
        m.IssueVoucherLine.objects.create(voucher=v, requisition_line=l, product=l.product, location=loc, lot_code=it.get("lot_code") or "", quantity=qty, unit_cost=mv.unit_cost)
        l.issued_quantity += qty
        l.save(update_fields=["issued_quantity"])
    r.status = "ISSUED" if all(_outstanding(l) <= 0 for l in rl.values()) else "PARTIALLY_ISSUED"
    r.save(update_fields=["status", "updated_at"])
    _reserve(r)  # shrink the hold to what is still outstanding
    record_tenant_event(current_tenant(), "inventory.issue_voucher.created", actor_user_id=actor_id, target_type="IssueVoucher", target_id=v.id, metadata={"number": v.number, "requisition": r.number})
    return v


@transaction.atomic
def return_issued(actor_id, voucher_line_id, *, quantity, location_id, reason, lot_code=None):
    """Unused material comes back to stock at its original issue cost (credits the consumption account)."""
    vl = m.IssueVoucherLine.objects.select_for_update(of=("self",)).select_related("voucher", "product", "requisition_line").filter(pk=voucher_line_id).first()
    if vl is None:
        raise DomainError("Voucher line not found.", code="not_found", status_code=404)
    qty = _dec(quantity)
    if qty <= 0 or qty > vl.quantity - vl.returned_quantity:
        raise DomainError(f"Only {vl.quantity - vl.returned_quantity} can still be returned.", code="over_return")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    svc.receive_stock(actor_id, product_id=vl.product_id, location_id=location_id, quantity=qty, unit_cost=vl.unit_cost, lot_code=lot_code or vl.lot_code or None, ref_type="inventory.issue_return", ref_id=str(vl.voucher_id), reason=reason, counter="cogs")
    vl.returned_quantity += qty
    vl.save(update_fields=["returned_quantity"])
    rl = vl.requisition_line
    rl.returned_quantity += qty
    rl.save(update_fields=["returned_quantity"])
    return vl


@transaction.atomic
def close(actor_id, req_id):
    """Close a part-issued requisition: the remaining backorder is abandoned and its reservation released."""
    r = _req(req_id, lock=True)
    if r.status not in ("APPROVED", "PARTIALLY_ISSUED"):
        raise DomainError("Nothing to close.", code="invalid_state")
    availability.release_by_ref(actor_id, REF, r.id, status="RELEASED")
    r.status = "CLOSED"
    r.save(update_fields=["status", "updated_at"])
    return r


def detail(req_id):
    r = _req(req_id)
    return {"id": str(r.id), "number": r.number, "status": r.status, "warehouse": r.warehouse.code, "destination_type": r.destination_type, "destination_ref": r.destination_ref, "purpose": r.purpose, "requester": str(r.requester_id), "approved_by": None if not r.approved_by else str(r.approved_by), "needed_by": None if not r.needed_by else str(r.needed_by),
            "lines": [{"id": str(l.id), "sku": l.product.sku, "quantity": str(l.quantity), "issued": str(l.issued_quantity), "returned": str(l.returned_quantity), "backorder": str(max(Decimal("0"), l.quantity - l.issued_quantity))} for l in r.lines.select_related("product")],
            "vouchers": [{"id": str(v.id), "number": v.number, "lines": [{"id": str(x.id), "sku": x.product.sku, "quantity": str(x.quantity), "unit_cost": str(x.unit_cost), "returned": str(x.returned_quantity)} for x in v.lines.select_related("product")]} for v in r.vouchers.all()]}

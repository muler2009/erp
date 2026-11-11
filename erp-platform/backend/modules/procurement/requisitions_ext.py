"""Requisition extensions: priority/emergency rules, stock check, reorder generation, consolidation, partial ordering, recurring, attachments."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

from modules.inventory import availability
from modules.inventory import models as im
from modules.inventory import services as inv
from modules.procurement import budgets
from modules.procurement import models as m
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.tenancy import current_tenant

ZERO = Decimal("0")
EXTRA = {"budget_id", "priority", "emergency_justification", "project_ref", "cost_center_ref", "procurement_type", "recurring_every_days"}
PRIORITIES, TYPES = {"NORMAL", "URGENT", "EMERGENCY"}, {"GOODS", "SERVICES", "WORKS"}


def clean(extra, today=None):
    bad = set(extra) - EXTRA
    if bad:
        raise ValidationFailed(f"Unknown requisition attribute '{sorted(bad)[0]}'.", code="unknown_attribute")
    if extra.get("priority", "NORMAL") not in PRIORITIES:
        raise ValidationFailed("Invalid priority.", code="invalid_priority")
    if extra.get("procurement_type", "GOODS") not in TYPES:
        raise ValidationFailed("Invalid procurement type.", code="invalid_type")
    if extra.get("priority") == "EMERGENCY" and not (extra.get("emergency_justification") or "").strip():
        raise ValidationFailed("An emergency requisition needs a written justification.", code="justification_required")
    every = extra.get("recurring_every_days")
    if every not in (None, ""):
        if int(every) < 1 or int(every) > 366:
            raise ValidationFailed("Recurrence must be between 1 and 366 days.", code="invalid_recurrence")
        extra["recurring_every_days"] = int(every)
        extra["next_run_on"] = (today or timezone.now().date()) + timedelta(days=int(every))
    else:
        extra.pop("recurring_every_days", None)
    return extra


def on_submitted(req):
    """Emergency requisitions are flagged to every procurement manager the moment they are submitted."""
    if req.priority == "EMERGENCY":
        from platform_core.authorization.models import RoleAssignment

        ids = list(RoleAssignment.objects.filter(role__name="procurement_manager").values_list("user_id", flat=True).distinct())
        if ids:
            notify(ids, "procurement.requisition.emergency", f"EMERGENCY requisition {req.number}", req.emergency_justification, ref_type="procurement.requisition", ref_id=str(req.id))
        record_tenant_event(current_tenant(), "procurement.requisition.emergency", actor_user_id=req.requester_id, target_type="Requisition", target_id=req.id, metadata={"number": req.number})


def stock_check(req_id):
    """For each stocked line: how much is available in stores, and whether a material requisition could cover it instead of buying."""
    req = m.Requisition.objects.filter(pk=req_id).first()
    if not req:
        raise DomainError("Requisition not found.", code="not_found", status_code=404)
    out = []
    for l in req.lines.select_related("product"):
        if not l.product_id or not l.product.is_stocked:
            out.append({"line": l.line_no, "description": l.description, "stock_item": False, "recommendation": "PURCHASE"})
            continue
        avail = Decimal(availability.availability(l.product_id)["available"])
        need = l.quantity - l.ordered_quantity
        out.append({"line": l.line_no, "description": l.description, "stock_item": True, "needed": str(need), "available": str(avail), "recommendation": "ISSUE_FROM_STOCK" if avail >= need else "PARTIAL_FROM_STOCK" if avail > 0 else "PURCHASE", "shortfall": str(max(ZERO, need - avail))})
    return out


def _on_order(product_id):
    q = m.PurchaseOrderLine.objects.filter(product_id=product_id, order__status__in=["PENDING_APPROVAL", "APPROVED", "PARTIALLY_RECEIVED"]).aggregate(t=Sum(F("quantity") - F("received_quantity")))["t"]
    return q or ZERO


@transaction.atomic
def generate_from_reorder(actor_id, *, title="Automatic replenishment"):
    """One draft requisition for every stocked item at or below its reorder level (counting what is already on order).
    Items already on an open auto-generated requisition are skipped, so running it twice creates nothing new."""
    from modules.procurement import services

    open_prods = set(m.RequisitionLine.objects.filter(requisition__source="REORDER", requisition__status__in=["DRAFT", "SUBMITTED", "APPROVED", "PARTIALLY_ORDERED"]).values_list("product_id", flat=True))
    lines = []
    for p in im.Product.objects.filter(is_stocked=True, is_active=True).exclude(status__in=["INACTIVE", "DISCONTINUED"]).exclude(reorder_level__isnull=True):
        if p.id in open_prods:
            continue
        have = inv.on_hand(p.id) + _on_order(p.id)
        if have > p.reorder_level:
            continue
        target = p.max_stock if p.max_stock is not None else (p.reorder_level * 2)
        qty = target - have
        if qty > 0:
            lines.append({"product": p.id, "quantity": qty, "estimated_unit_price": p.purchase_price or 0})
    if not lines:
        return None
    req = services.create_requisition(actor_id, title=title, lines=lines)
    req.source = "REORDER"
    req.save(update_fields=["source", "updated_at"])
    return req


def consolidate(req_ids):
    """Combine the outstanding quantities of approved requisitions (same product, or same free-text description) for joint sourcing."""
    reqs = list(m.Requisition.objects.filter(pk__in=req_ids, status__in=["APPROVED", "PARTIALLY_ORDERED"]))
    if len(reqs) != len(set(map(str, req_ids))):
        raise ValidationFailed("Only approved requisitions can be consolidated.", code="invalid_requisitions")
    groups = {}
    for r in reqs:
        for l in r.lines.select_related("product"):
            out = l.quantity - l.ordered_quantity
            if out <= 0:
                continue
            key = str(l.product_id) if l.product_id else l.description.strip().lower()
            g = groups.setdefault(key, {"product": l.product_id, "description": l.description, "quantity": ZERO, "sources": []})
            g["quantity"] += out
            g["sources"].append({"requisition": r.number, "line": l.line_no, "quantity": str(out)})
    return list(groups.values())


@transaction.atomic
def create_consolidated_rfq(actor_id, req_ids, *, title, supplier_ids, due_date=None):
    from modules.procurement import services

    lines = consolidate(req_ids)
    if not lines:
        raise DomainError("Nothing outstanding to source.", code="nothing_outstanding")
    rfq = services.create_rfq(actor_id, title=title, supplier_ids=supplier_ids, lines=[{"product": l["product"], "description": l["description"], "quantity": l["quantity"]} for l in lines], due_date=due_date)
    rfq.source_requisition_ids = [str(i) for i in req_ids]
    rfq.save(update_fields=["source_requisition_ids"])
    return rfq


def link_po_lines(order, raw_lines):
    """After a PO is created: record which requisition lines it orders, cap over-ordering, and set the requisition to
    PARTIALLY_ORDERED / CONVERTED. Returns True when any line was linked (otherwise legacy whole-requisition conversion applies)."""
    linked = False
    po_lines = list(order.lines.order_by("line_no"))
    touched = {}
    for pol, raw in zip(po_lines, raw_lines):
        rl_id = raw.get("requisition_line") if isinstance(raw, dict) else None
        if not rl_id:
            continue
        rl = m.RequisitionLine.objects.select_for_update().filter(pk=rl_id).select_related("requisition").first()
        if rl is None or (order.requisition_id and rl.requisition_id != order.requisition_id):
            raise ValidationFailed("Unknown requisition line.", code="invalid_requisition_line")
        if rl.ordered_quantity + pol.quantity > rl.quantity:
            raise DomainError(f"Line {rl.line_no} of {rl.requisition.number}: only {rl.quantity - rl.ordered_quantity} left to order.", code="over_order")
        rl.ordered_quantity += pol.quantity
        rl.save(update_fields=["ordered_quantity"])
        pol.requisition_line = rl
        pol.save(update_fields=["requisition_line"])
        touched[rl.requisition_id] = rl.requisition
        linked = True
    for req in touched.values():
        done = not req.lines.filter(ordered_quantity__lt=F("quantity")).exists()
        req.status = "CONVERTED" if done else "PARTIALLY_ORDERED"
        req.save(update_fields=["status", "updated_at"])
        budgets.sync_requisition(req)
    return linked


def release_po_lines(order):
    """A cancelled PO gives its quantities back to the requisition lines."""
    for pol in order.lines.select_related("requisition_line__requisition"):
        rl = pol.requisition_line
        if rl is None:
            continue
        rl.ordered_quantity = max(ZERO, rl.ordered_quantity - pol.quantity)
        rl.save(update_fields=["ordered_quantity"])
        req = rl.requisition
        if req.status in ("CONVERTED", "PARTIALLY_ORDERED"):
            req.status = "PARTIALLY_ORDERED" if req.lines.filter(ordered_quantity__gt=0).exists() else "APPROVED"
            req.save(update_fields=["status", "updated_at"])
            budgets.sync_requisition(req)


def run_recurring(today=None):
    from modules.procurement import services

    today = today or timezone.now().date()
    n = 0
    for src in m.Requisition.objects.filter(recurring_every_days__isnull=False, next_run_on__lte=today).exclude(status__in=["CANCELLED", "DRAFT", "SUBMITTED"]):
        lines = [{"product": l.product_id, "description": l.description, "quantity": l.quantity, "estimated_unit_price": l.estimated_unit_price} for l in src.lines.all()]
        with transaction.atomic():
            new = services.create_requisition(src.requester_id, title=src.title, lines=lines, department_id=src.department_id, needed_by=None)
            m.Requisition.objects.filter(pk=new.pk).update(source="RECURRING", project_ref=src.project_ref, cost_center_ref=src.cost_center_ref, procurement_type=src.procurement_type, priority="NORMAL")
            src.next_run_on = today + timedelta(days=src.recurring_every_days)
            src.save(update_fields=["next_run_on", "updated_at"])
            notify([src.requester_id], "procurement.requisition.recurring", f"Recurring requisition {new.number} drafted", src.title, ref_type="procurement.requisition", ref_id=str(new.id))
        n += 1
    return n


def stop_recurring(actor_id, req_id):
    r = m.Requisition.objects.select_for_update().filter(pk=req_id, requester_id=actor_id).first()
    if not r:
        raise DomainError("Requisition not found.", code="not_found", status_code=404)
    r.recurring_every_days = r.next_run_on = None
    r.save(update_fields=["recurring_every_days", "next_run_on", "updated_at"])
    return r


def attach_file(actor_id, req_id, filename, data):
    from shared.files import services as files

    r = m.Requisition.objects.filter(pk=req_id).first()
    if not r or not can_read_attachment(actor_id, r.id):
        raise DomainError("Requisition not found.", code="not_found", status_code=404)
    return files.upload(actor_id, filename, data, ref_type="procurement.requisition", ref_id=str(r.id))


def can_read_attachment(user_id, ref_id):
    from platform_core.authorization import services as authz

    r = m.Requisition.objects.filter(pk=ref_id).first()
    return bool(r and (r.requester_id == user_id or authz.has_permission(user_id, "procurement.view")))

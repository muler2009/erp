"""Return requests: customer asks to send goods back -> manager approves -> warehouse receives with a disposition
per line (restock / quarantine / dispose) -> credit note (existing return processing) and an optional replacement order."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from modules.crm import models as cm
from modules.crm import services as crm
from modules.sales import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

REASONS = ("DEFECTIVE", "WRONG_ITEM", "DAMAGED", "NOT_NEEDED", "OTHER")
DISPOSITIONS = ("RESTOCK", "QUARANTINE", "DISPOSE")


def _get(pk, lock=False):
    qs = m.ReturnRequest.objects.select_for_update(of=("self",)).select_related("order") if lock else m.ReturnRequest.objects.select_related("order")
    r = qs.filter(pk=pk).first()
    if r is None:
        raise DomainError("Return request not found.", code="not_found", status_code=404)
    return r


def get(user_id, pk):
    r = _get(pk)
    crm._own(cm.CrmAccount, r.order.account_id, user_id, "Return request")
    return r


def _approver(actor_id):
    if not authz.has_permission(actor_id, "sales.order.approve"):
        raise DomainError("Only a sales manager can decide return requests.", code="permission_denied", status_code=403)


@transaction.atomic
def request_return(actor_id, order_id, *, reason, reason_code="OTHER", lines, replacement=False, today=None):
    from modules.sales import services as sales

    order = sales._get(m.SalesOrder, order_id, "Order", lock=True)
    crm._own(cm.CrmAccount, order.account_id, actor_id, "Order")
    if not (reason or "").strip() or reason_code not in REASONS:
        raise ValidationFailed("A reason and a known reason code are required.", code="reason_required")
    last = order.deliveries.filter(status__in=("DISPATCHED", "DELIVERED")).order_by("-delivery_date").first()
    if last is None:
        raise DomainError("Nothing was delivered on this order.", code="invalid_state_transition")
    today = today or timezone.now().date()
    window = int(org.get_setting("sales.return_window_days", 30))
    if (today - last.delivery_date).days > window and not authz.has_permission(actor_id, "sales.order.approve"):
        raise DomainError(f"The {window}-day return window has passed; ask a sales manager.", code="return_window_expired", status_code=409)
    if not lines:
        raise ValidationFailed("At least one line is required.", code="no_lines")
    olines = {str(l.id): l for l in order.lines.all()}
    pending = {}
    for r in m.ReturnRequestLine.objects.filter(request__order=order, request__status__in=("PENDING", "APPROVED")):
        pending[str(r.order_line_id)] = pending.get(str(r.order_line_id), Decimal(0)) + r.quantity
    rows, seen = [], set()
    for raw in lines:
        ol = olines.get(str(raw.get("order_line")))
        disp = raw.get("disposition", "RESTOCK")
        try:
            qty = Decimal(str(raw.get("quantity")))
        except Exception:
            qty = Decimal(0)
        if ol is None or str(ol.id) in seen or qty <= 0 or disp not in DISPOSITIONS:
            raise ValidationFailed("Each line needs a distinct order line, a positive quantity and a valid disposition.", code="invalid_line")
        seen.add(str(ol.id))
        if ol.returned_quantity + pending.get(str(ol.id), Decimal(0)) + qty > ol.delivered_quantity:
            raise ValidationFailed(f"Line {ol.line_no}: only {ol.delivered_quantity - ol.returned_quantity - pending.get(str(ol.id), Decimal(0))} can still be returned.", code="over_return")
        rows.append((ol, qty, disp))
    rr = m.ReturnRequest.objects.create(number=sequences.next_number("sales.return_request", on_date=today, for_type="ReturnRequest"), order=order, reason=reason.strip()[:300], reason_code=reason_code, wants_replacement=bool(replacement), requested_by=actor_id)
    m.ReturnRequestLine.objects.bulk_create([m.ReturnRequestLine(request=rr, order_line=ol, quantity=q, disposition=d) for ol, q, d in rows])
    return rr


@transaction.atomic
def decide(actor_id, pk, approve, note=""):
    _approver(actor_id)
    rr = _get(pk, lock=True)
    if rr.status != "PENDING":
        raise DomainError("This request was already decided.", code="invalid_state_transition")
    if rr.requested_by == actor_id:
        raise DomainError("You cannot decide a return request you raised.", code="separation_of_duties", status_code=403)
    if not approve and not (note or "").strip():
        raise ValidationFailed("A reason is required to reject.", code="reason_required")
    rr.status, rr.decided_by, rr.decided_at, rr.decision_note = ("APPROVED" if approve else "REJECTED"), actor_id, timezone.now(), (note or "")[:300]
    rr.save()
    notify([rr.requested_by], "sales.return.approved" if approve else "sales.return.rejected", f"Return request {rr.number} {rr.status.lower()}", rr.decision_note or "You can now receive the goods.", ref_type="ReturnRequest", ref_id=str(rr.id))
    record_tenant_event(current_tenant(), "sales.return_request.decided", actor_user_id=actor_id, target_type="ReturnRequest", target_id=rr.id, metadata={"status": rr.status})
    return rr


@transaction.atomic
def cancel(actor_id, pk):
    rr = _get(pk, lock=True)
    crm._own(cm.CrmAccount, rr.order.account_id, actor_id, "Return request")
    if rr.status not in ("PENDING", "APPROVED"):
        raise DomainError("This request can no longer be cancelled.", code="invalid_state_transition")
    rr.status = "CANCELLED"
    rr.save(update_fields=["status", "updated_at"])
    return rr


@transaction.atomic
def receive(actor_id, pk, *, location_id, return_date, quarantine_location_id=None):
    """Warehouse takes the goods back.  Runs the standard return processing with each line's disposition."""
    from modules.sales import services as sales

    if not authz.has_permission(actor_id, "sales.delivery.manage"):
        raise DomainError("You may not receive returned goods.", code="permission_denied", status_code=403)
    rr = _get(pk, lock=True)
    if rr.status != "APPROVED":
        raise DomainError("Only an approved return can be received.", code="invalid_state_transition")
    rma = sales.process_return(actor_id, rr.order_id, location_id=location_id, return_date=return_date, reason=f"{rr.number}: {rr.reason}", quarantine_location_id=quarantine_location_id,
                               lines=[{"order_line": str(l.order_line_id), "quantity": l.quantity, "disposition": l.disposition} for l in rr.lines.all()])
    rr.sales_return, rr.status = rma, "RECEIVED"
    rr.save()
    if rr.wants_replacement:
        _replacement(rr)
    return rr


def _replacement(rr):
    from modules.sales import orders_ext, services as sales

    lines = [{"product": str(l.order_line.product_id), "description": l.order_line.description, "quantity": l.quantity, "unit_price": l.order_line.net_unit_price, "discount_percent": 100, "tax_rate": None} for l in rr.lines.select_related("order_line")]
    order = sales.create_order(rr.requested_by, account_id=rr.order.account_id, currency=rr.order.currency, order_date=timezone.now().date(), lines=lines, agreed=True)
    order.replacement_for = rr
    order.save(update_fields=["replacement_for", "updated_at"])
    sales._confirm(order, rr.decided_by)  # the approved return is the approval; stock is reserved straight away
    return order


def report(user_id, date_from=None, date_to=None):
    qs = crm.scope(m.ReturnRequest.objects.all(), user_id, owner_field="order__account__owner_id")
    if date_from:
        qs = qs.filter(created_at__date__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__date__lte=date_to)
    by_status, by_reason, by_disp = {}, {}, {}
    for r in qs:
        by_status[r.status] = by_status.get(r.status, 0) + 1
        by_reason[r.reason_code] = by_reason.get(r.reason_code, 0) + 1
    for l in m.ReturnRequestLine.objects.filter(request__in=qs, request__status="RECEIVED"):
        by_disp[l.disposition] = by_disp.get(l.disposition, Decimal(0)) + l.quantity
    return {"total": sum(by_status.values()), "by_status": by_status, "by_reason": by_reason, "received_by_disposition": {k: str(v) for k, v in by_disp.items()}}

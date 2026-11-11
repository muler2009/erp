"""Purchase-order extensions: delivery schedules, amendments with approval, acknowledgment, blanket orders and releases, closing, printable document."""
from decimal import Decimal

from django.db import transaction
from django.db.models import F
from django.utils import timezone
from django.utils.html import escape

from modules.procurement import budgets
from modules.procurement import models as m
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.tenancy import current_tenant

ZERO = Decimal("0")


def _dec(v, name="amount"):
    try:
        return Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")


def _order(order_id, lock=True):
    qs = m.PurchaseOrder.objects.select_for_update() if lock else m.PurchaseOrder.objects
    o = qs.filter(pk=order_id).first()
    if not o:
        raise DomainError("Purchase order not found.", code="not_found", status_code=404)
    return o


# ------------------------------------------------------------------ terms / schedule / acknowledgment
@transaction.atomic
def set_terms(actor_id, order_id, *, payment_terms=None, delivery_terms=None, delivery_address=None):
    o = _order(order_id)
    if o.status != "DRAFT":
        raise DomainError("Terms can be edited on a draft order; amend an approved one.", code="invalid_state_transition")
    for k, v in (("payment_terms", payment_terms), ("delivery_terms", delivery_terms), ("delivery_address", delivery_address)):
        if v is not None:
            setattr(o, k, v[:300])
    o.save()
    return o


@transaction.atomic
def set_schedule(actor_id, line_id, rows):
    """Split a line into dated deliveries. The scheduled quantities may not exceed the ordered quantity."""
    line = m.PurchaseOrderLine.objects.select_for_update(of=("self",)).select_related("order").filter(pk=line_id).first()
    if not line:
        raise DomainError("Order line not found.", code="not_found", status_code=404)
    if line.order.status not in ("DRAFT", "APPROVED", "PARTIALLY_RECEIVED"):
        raise DomainError("This order can no longer be scheduled.", code="invalid_state_transition")
    clean, total = [], ZERO
    for r in rows:
        q = _dec(r.get("quantity"), "quantity")
        if q <= 0 or not r.get("due_date"):
            raise ValidationFailed("Each delivery needs a date and a positive quantity.", code="invalid_schedule")
        clean.append((r["due_date"], q))
        total += q
    if total > line.quantity:
        raise ValidationFailed(f"Scheduled {total} exceeds the ordered {line.quantity}.", code="schedule_exceeds_order")
    line.schedule.all().delete()
    for d, q in clean:
        m.DeliverySchedule.objects.create(po_line=line, due_date=d, quantity=q)
    return line


@transaction.atomic
def acknowledge(actor_id, order_id, *, reference, promised_date=None, note=""):
    o = _order(order_id)
    if o.status not in ("APPROVED", "PARTIALLY_RECEIVED"):
        raise DomainError("Only an approved order can be acknowledged.", code="invalid_state_transition")
    if not (reference or "").strip():
        raise ValidationFailed("The supplier's acknowledgment reference is required.", code="reference_required")
    o.acknowledged_at, o.acknowledgment_ref, o.promised_date, o.acknowledgment_note = timezone.now(), reference[:80], promised_date, note[:300]
    o.save(update_fields=["acknowledged_at", "acknowledgment_ref", "promised_date", "acknowledgment_note", "updated_at"])
    return o


# ------------------------------------------------------------------ amendments
@transaction.atomic
def request_amendment(actor_id, order_id, *, reason, lines=None, expected_date=None):
    o = _order(order_id)
    if o.kind == "BLANKET":
        raise DomainError("Amend releases, or raise a revised blanket order.", code="invalid_state_transition")
    if o.status not in ("APPROVED", "PARTIALLY_RECEIVED"):
        raise DomainError("Only an approved order can be amended (edit a draft directly).", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    if o.amendments.filter(status="PENDING").exists():
        raise DomainError("An amendment is already awaiting approval.", code="amendment_pending")
    pol = {str(l.id): l for l in o.lines.all()}
    new_total = o.total
    changes = {"lines": []}
    for ch in lines or []:
        l = pol.get(str(ch.get("line")))
        if l is None:
            raise ValidationFailed("Unknown order line.", code="invalid_line")
        q = _dec(ch.get("quantity", l.quantity), "quantity")
        p = _dec(ch.get("unit_price", l.unit_price), "unit_price")
        if q < l.received_quantity or q <= 0:
            raise ValidationFailed(f"Line {l.line_no}: the quantity cannot go below what was received ({l.received_quantity}).", code="below_received")
        if p != l.unit_price and l.received_quantity > 0:
            raise ValidationFailed(f"Line {l.line_no}: the price cannot change once goods were received.", code="price_locked")
        if p < 0:
            raise ValidationFailed("Prices cannot be negative.", code="invalid_amount")
        new_total += q * p - l.quantity * l.unit_price
        changes["lines"].append({"line": str(l.id), "quantity": str(q), "unit_price": str(p)})
    if expected_date:
        changes["expected_date"] = str(expected_date)
    if not changes["lines"] and not expected_date:
        raise ValidationFailed("Nothing to amend.", code="nothing_to_amend")
    if new_total < o.invoiced_value:
        raise DomainError(f"The new total {new_total} is below the value already invoiced ({o.invoiced_value}).", code="below_invoiced")
    n = (o.amendments.order_by("-number").values_list("number", flat=True).first() or 0) + 1
    return m.PoAmendment.objects.create(order=o, number=n, changes=changes, reason=reason[:300], old_total=o.total, new_total=new_total, requested_by=actor_id)


@transaction.atomic
def decide_amendment(actor_id, amendment_id, *, approve, note=""):
    a = m.PoAmendment.objects.select_for_update().select_related("order").filter(pk=amendment_id).first()
    if not a:
        raise DomainError("Amendment not found.", code="not_found", status_code=404)
    if a.status != "PENDING":
        raise DomainError("This amendment was already decided.", code="invalid_state")
    if a.requested_by == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own amendment.", code="separation_of_duties", status_code=403)
    if not approve and not (note or "").strip():
        raise ValidationFailed("A reason is required to reject.", code="note_required")
    a.decided_by, a.decision_note = actor_id, note[:300]
    if not approve:
        a.status = "REJECTED"
        a.save()
        notify([a.requested_by], "procurement.po.amendment.rejected", f"Amendment {a.number} of {a.order.number} rejected", note, ref_type="procurement.po", ref_id=str(a.order_id))
        return a
    o = _order(a.order_id)
    pol = {str(l.id): l for l in o.lines.select_for_update()}
    for ch in a.changes.get("lines", []):
        l = pol[ch["line"]]
        q, p = Decimal(ch["quantity"]), Decimal(ch["unit_price"])
        if q < l.received_quantity:
            raise DomainError("Goods were received after the amendment was requested; request it again.", code="stale_amendment")
        l.quantity, l.unit_price = q, p
        l.save(update_fields=["quantity", "unit_price"])
    if a.changes.get("expected_date"):
        o.expected_date = a.changes["expected_date"]
    o.total = sum((l.quantity * l.unit_price for l in o.lines.all()), ZERO)
    o.version += 1
    complete = not o.lines.filter(received_quantity__lt=F("quantity")).exists()
    if o.status == "PARTIALLY_RECEIVED" and complete:
        o.status = "RECEIVED"
    o.save()
    budgets.sync_po(o)  # a BLOCK budget refuses an amendment that overspends
    a.status = "APPLIED"
    a.save()
    record_tenant_event(current_tenant(), "procurement.po.amended", actor_user_id=actor_id, target_type="PurchaseOrder", target_id=o.id, metadata={"number": o.number, "amendment": str(a.number), "old": str(a.old_total), "new": str(o.total)})
    return a


# ------------------------------------------------------------------ blanket orders
@transaction.atomic
def create_blanket(actor_id, *, supplier_id, currency, order_date, valid_to, lines, **kw):
    """A framework agreement with agreed prices and ceiling quantities; goods are ordered and received through releases."""
    from modules.procurement import services

    if valid_to < order_date:
        raise ValidationFailed("The blanket order cannot end before it starts.", code="invalid_dates")
    o = services.create_po(actor_id, supplier_id=supplier_id, currency=currency, order_date=order_date, lines=lines, **kw)
    o.kind, o.valid_to = "BLANKET", valid_to
    o.save(update_fields=["kind", "valid_to", "updated_at"])
    budgets.sync_po(o)
    return o


@transaction.atomic
def release_blanket(actor_id, blanket_id, lines, *, order_date=None, expected_date=None):
    from modules.procurement import services

    b = _order(blanket_id)
    order_date = order_date or timezone.now().date()
    if b.kind != "BLANKET" or b.status != "APPROVED":
        raise DomainError("Releases can be raised against an approved blanket order.", code="invalid_state_transition")
    if b.valid_to and order_date > b.valid_to:
        raise DomainError("The blanket order has expired.", code="blanket_expired")
    bl = {str(l.id): l for l in b.lines.select_for_update()}
    rows = []
    for r in lines:
        l = bl.get(str(r.get("blanket_line")))
        q = _dec(r.get("quantity"), "quantity")
        if l is None or q <= 0:
            raise ValidationFailed("Each release line needs a blanket line and a positive quantity.", code="invalid_line")
        if l.released_quantity + q > l.quantity:
            raise DomainError(f"Line {l.line_no}: only {l.quantity - l.released_quantity} left on the blanket order.", code="over_release")
        l.released_quantity += q
        l.save(update_fields=["released_quantity"])
        rows.append({"product": str(l.product_id) if l.product_id else None, "description": l.description, "quantity": q, "unit_price": l.unit_price})
    rel = services.create_po(actor_id, supplier_id=b.supplier_id, currency=b.currency, order_date=order_date, lines=rows, expected_date=expected_date, budget_id=b.budget_id)
    rel.kind, rel.blanket = "RELEASE", b
    rel.payment_terms, rel.delivery_terms = b.payment_terms, b.delivery_terms
    rel.save(update_fields=["kind", "blanket", "payment_terms", "delivery_terms", "updated_at"])
    return rel


def release_blanket_lines(order):
    """A cancelled release returns its quantity to the blanket order."""
    if order.kind != "RELEASE" or not order.blanket_id:
        return
    bl = {(l.product_id, l.description): l for l in order.blanket.lines.select_for_update()}
    for l in order.lines.all():
        t = bl.get((l.product_id, l.description))
        if t:
            t.released_quantity = max(ZERO, t.released_quantity - l.quantity)
            t.save(update_fields=["released_quantity"])


# ------------------------------------------------------------------ closing
@transaction.atomic
def close_po(actor_id, order_id, *, reason):
    """Short-close: the unreceived balance is abandoned and its budget commitment released."""
    o = _order(order_id)
    if o.status not in ("APPROVED", "PARTIALLY_RECEIVED", "RECEIVED"):
        raise DomainError("Only an approved order can be closed.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    o.status, o.closed_reason = "CLOSED", reason[:300]
    o.save(update_fields=["status", "closed_reason", "updated_at"])
    budgets.sync_po(o)
    record_tenant_event(current_tenant(), "procurement.po.closed", actor_user_id=actor_id, target_type="PurchaseOrder", target_id=o.id, metadata={"reason": reason[:200]})
    return o


def overdue_lines(today=None):
    """Open quantities whose scheduled (or order-level expected) delivery date has passed."""
    today = today or timezone.now().date()
    out = []
    for o in m.PurchaseOrder.objects.select_related("supplier").filter(status__in=["APPROVED", "PARTIALLY_RECEIVED"]).exclude(kind="BLANKET"):
        for l in o.lines.all():
            open_q = l.quantity - l.received_quantity
            if open_q <= 0:
                continue
            sched = list(l.schedule.order_by("due_date"))
            if sched:
                remaining_received, due_open, first_due = l.received_quantity, ZERO, None
                for s in sched:  # received goods are applied to the earliest deliveries first
                    take = min(remaining_received, s.quantity)
                    remaining_received -= take
                    if s.due_date < today and s.quantity - take > 0:
                        due_open += s.quantity - take
                        first_due = first_due or s.due_date
                if due_open:
                    out.append({"po": o.number, "supplier": o.supplier.name, "line": l.line_no, "open_quantity": str(due_open), "due_date": str(first_due), "days_late": (today - first_due).days})
            elif o.expected_date and o.expected_date < today:
                out.append({"po": o.number, "supplier": o.supplier.name, "line": l.line_no, "open_quantity": str(open_q), "due_date": str(o.expected_date), "days_late": (today - o.expected_date).days})
    return sorted(out, key=lambda r: -r["days_late"])


# ------------------------------------------------------------------ document
def document(order_id):
    o = m.PurchaseOrder.objects.select_related("supplier", "blanket").filter(pk=order_id).first()
    if not o:
        raise DomainError("Purchase order not found.", code="not_found", status_code=404)
    if o.status in ("DRAFT", "PENDING_APPROVAL"):
        raise DomainError("The purchase order document is issued once the order is approved.", code="not_approved")
    from platform_core.organizations import services as org

    company = org.get_company()
    return {"number": o.number, "version": o.version, "date": str(o.order_date), "status": o.status, "kind": o.kind, "buyer": getattr(company, "legal_name", "") or getattr(company, "name", ""), "supplier": {"name": o.supplier.name, "tax_id": o.supplier.tax_id, "address": o.supplier.address}, "currency": o.currency,
            "payment_terms": o.payment_terms or f"Net {o.supplier.payment_terms_days}", "delivery_terms": o.delivery_terms, "delivery_address": o.delivery_address, "expected_date": None if not o.expected_date else str(o.expected_date), "blanket": None if not o.blanket_id else o.blanket.number,
            "lines": [{"no": l.line_no, "description": l.description, "quantity": str(l.quantity), "unit_price": str(l.unit_price), "amount": str(l.quantity * l.unit_price), "schedule": [{"due_date": str(s.due_date), "quantity": str(s.quantity)} for s in l.schedule.order_by("due_date")]} for l in o.lines.order_by("line_no")],
            "total": str(o.total), "approved_by": None if not o.approved_by else str(o.approved_by)}


def document_html(order_id):
    d = document(order_id)
    e = escape
    rows = "".join(f"<tr><td>{l['no']}</td><td>{e(l['description'])}</td><td>{l['quantity']}</td><td>{l['unit_price']}</td><td>{l['amount']}</td></tr>" for l in d["lines"])
    return (f"<!doctype html><html><head><meta charset='utf-8'><title>{e(d['number'])}</title></head><body><h1>Purchase Order {e(d['number'])} (v{d['version']})</h1>"
            f"<p>Date: {d['date']}<br>Supplier: {e(d['supplier']['name'])}<br>Payment terms: {e(d['payment_terms'])}<br>Delivery terms: {e(d['delivery_terms'])}<br>Deliver to: {e(d['delivery_address'])}</p>"
            f"<table border='1' cellpadding='4'><tr><th>#</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr>{rows}</table><p><b>Total {e(d['currency'])} {d['total']}</b></p></body></html>")

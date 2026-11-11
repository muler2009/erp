"""Returns to suppliers and supplier claims."""
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.inventory import models as im
from modules.inventory import services as inventory
from modules.procurement import models as m
from modules.procurement import receiving
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")
RETURNABLE = ("APPROVED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED")
CLAIM_KINDS = ("DAMAGE", "SHORTAGE", "QUALITY", "LATE", "PRICE", "OTHER")


def _dec(v, name="quantity"):
    try:
        return Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")


def _ret(pk, lock=True):
    qs = m.SupplierReturn.objects.select_for_update(of=("self",)) if lock else m.SupplierReturn.objects
    r = qs.filter(pk=pk).select_related("order", "supplier").first()
    if r is None:
        raise DomainError("Return not found.", code="not_found", status_code=404)
    return r


@transaction.atomic
def create_return(actor_id, order_id, *, location_id, return_date, reason, lines):
    order = m.PurchaseOrder.objects.select_for_update().filter(pk=order_id).select_related("supplier").first()
    if order is None:
        raise DomainError("Purchase order not found.", code="not_found", status_code=404)
    if order.status not in RETURNABLE:
        raise DomainError("Only goods received on an approved order can be returned.", code="invalid_state")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    if not lines:
        raise ValidationFailed("At least one line is required.", code="no_lines")
    loc = im.Location.objects.filter(pk=location_id).first()
    if loc is None:
        raise DomainError("Location not found.", code="not_found", status_code=404)
    po_lines = {str(l.id): l for l in m.PurchaseOrderLine.objects.select_for_update(of=("self",)).filter(order=order)}
    # quantities already promised on other open returns count against what can still go back
    pending = {}
    for rl in m.SupplierReturnLine.objects.filter(supplier_return__order=order, supplier_return__status__in=("DRAFT", "APPROVED")):
        pending[str(rl.po_line_id)] = pending.get(str(rl.po_line_id), ZERO) + rl.quantity
    ret = m.SupplierReturn.objects.create(number=sequences.next_number("procurement.supplier_return", on_date=return_date, for_type="SupplierReturn"), supplier=order.supplier, order=order, location=loc, return_date=return_date, reason=reason[:300], created_by=actor_id)
    seen, value = set(), ZERO
    for raw in lines:
        key = str(raw.get("po_line"))
        l = po_lines.get(key)
        qty = _dec(raw.get("quantity"))
        if l is None or key in seen or qty <= 0:
            raise ValidationFailed("Unknown, duplicated or non-positive return line.", code="invalid_line")
        seen.add(key)
        if not (l.product and l.product.is_stocked):
            raise ValidationFailed("Only stocked goods can be returned; raise a claim for services.", code="not_returnable")
        if qty > l.received_quantity - pending.get(key, ZERO):
            raise ValidationFailed(f"Line {l.line_no}: only {l.received_quantity - pending.get(key, ZERO)} can still be returned.", code="over_return")
        m.SupplierReturnLine.objects.create(supplier_return=ret, po_line=l, quantity=qty, lot_code=raw.get("lot_code") or "")
        value += qty * l.unit_price
    ret.return_value = value
    ret.save(update_fields=["return_value"])
    return ret


@transaction.atomic
def approve_return(actor_id, return_id):
    r = _ret(return_id)
    if r.status != "DRAFT":
        raise DomainError("Only a draft return can be approved.", code="invalid_state")
    if r.created_by == actor_id:
        raise DomainError("Separation of duties: someone else must approve the return.", code="separation_of_duties", status_code=403)
    r.status, r.approved_by = "APPROVED", actor_id
    r.save(update_fields=["status", "approved_by", "updated_at"])
    return r


@transaction.atomic
def cancel_return(actor_id, return_id):
    r = _ret(return_id)
    if r.status not in ("DRAFT", "APPROVED"):
        raise DomainError("Only an undispatched return can be cancelled.", code="invalid_state")
    r.status = "CANCELLED"
    r.save(update_fields=["status", "updated_at"])
    return r


@transaction.atomic
def dispatch_return(actor_id, return_id, *, serials=None):
    """Goods physically leave: stock is issued against the goods-received accrual and the quantity is re-opened on the order."""
    r = _ret(return_id)
    if r.status != "APPROVED":
        raise DomainError("Only an approved return can be dispatched.", code="invalid_state")
    order = m.PurchaseOrder.objects.select_for_update().get(pk=r.order_id)
    for rl in r.lines.select_related("po_line__product"):
        l = m.PurchaseOrderLine.objects.select_for_update().get(pk=rl.po_line_id)
        if rl.quantity > l.received_quantity:
            raise DomainError("The quantity to return exceeds what is recorded as received.", code="over_return")
        mv = inventory.issue_stock(actor_id, product_id=l.product_id, location_id=r.location_id, quantity=rl.quantity, lot_code=rl.lot_code or None, reason=f"Return to supplier {r.number}", ref_type="supplier_return", ref_id=r.number, on_date=timezone.now().date(), serials=serials, allow_expired=True, counter="grni")
        rl.stock_movement_id = mv.id
        rl.save(update_fields=["stock_movement_id"])
        l.received_quantity -= rl.quantity
        l.returned_quantity += rl.quantity
        l.save(update_fields=["received_quantity", "returned_quantity"])
    receiving._refresh_order_status(order)
    received_value = sum((x.received_quantity * x.unit_price for x in m.PurchaseOrderLine.objects.filter(order=order)), ZERO)
    r.credit_due = min(r.return_value, max(order.invoiced_value - received_value, ZERO))
    r.status, r.dispatched_by = "DISPATCHED", actor_id
    r.save(update_fields=["status", "dispatched_by", "credit_due", "updated_at"])
    record_tenant_event(current_tenant(), "procurement.supplier_return.dispatched", actor_user_id=actor_id, target_type="SupplierReturn", target_id=r.id, metadata={"number": r.number, "credit_due": str(r.credit_due)})
    return r


@transaction.atomic
def link_credit(actor_id, return_id, credit_note_id):
    """Record the supplier credit note that settles an invoiced return and free the credited value on the order for re-invoicing."""
    from modules.finance import models as fm

    r = _ret(return_id)
    if r.status != "DISPATCHED":
        raise DomainError("Only a dispatched return can be credited.", code="invalid_state")
    if r.credit_due <= 0:
        raise DomainError("Nothing was invoiced for these goods; close the return instead.", code="no_credit_due")
    cn = fm.Invoice.objects.filter(pk=credit_note_id, kind="SUPPLIER_CREDIT_NOTE", partner_id=r.supplier.partner_id, currency=r.order.currency).first()
    if cn is None:
        raise ValidationFailed("Credit note not found for this supplier and currency.", code="credit_note_invalid")
    if cn.total < r.credit_due:
        raise ValidationFailed(f"The credit note ({cn.total}) is less than the credit due ({r.credit_due}).", code="credit_too_small")
    order = m.PurchaseOrder.objects.select_for_update().get(pk=r.order_id)
    order.invoiced_value -= r.credit_due
    order.save(update_fields=["invoiced_value"])
    from modules.procurement import budgets

    budgets.sync_po_consumed(order)
    r.status, r.credit_note_id = "CREDITED", cn.id
    r.save(update_fields=["status", "credit_note_id", "updated_at"])
    return r


@transaction.atomic
def close_return(actor_id, return_id):
    r = _ret(return_id)
    if r.status != "DISPATCHED":
        raise DomainError("Only a dispatched return can be closed.", code="invalid_state")
    if r.credit_due > 0:
        raise DomainError("The returned goods were invoiced: link a supplier credit note first.", code="credit_required")
    r.status = "CLOSED"
    r.save(update_fields=["status", "updated_at"])
    return r


# ----------------------------------------------------------------------------- claims
@transaction.atomic
def create_claim(actor_id, *, supplier_id, kind, description, amount, order_id=None, return_id=None):
    s = m.Supplier.objects.filter(pk=supplier_id).first()
    if s is None:
        raise DomainError("Supplier not found.", code="not_found", status_code=404)
    if kind not in CLAIM_KINDS:
        raise ValidationFailed("Unknown claim kind.", code="invalid_kind")
    amt = _dec(amount, "amount")
    if amt <= 0:
        raise ValidationFailed("The claimed amount must be positive.", code="invalid_amount")
    order = m.PurchaseOrder.objects.filter(pk=order_id).first() if order_id else None
    ret = m.SupplierReturn.objects.filter(pk=return_id).first() if return_id else None
    if (order_id and order is None) or (return_id and ret is None):
        raise DomainError("Referenced order or return not found.", code="not_found", status_code=404)
    if order and order.supplier_id != s.id or ret and ret.supplier_id != s.id:
        raise ValidationFailed("The order or return belongs to a different supplier.", code="supplier_mismatch")
    if not (description or "").strip():
        raise ValidationFailed("A description is required.", code="description_required")
    currency = order.currency if order else (ret.order.currency if ret else s.currency or "")
    if not currency:
        raise ValidationFailed("Link the claim to an order, or set the supplier currency.", code="currency_required")
    return m.SupplierClaim.objects.create(number=sequences.next_number("procurement.claim", for_type="SupplierClaim"), supplier=s, order=order or (ret.order if ret else None), supplier_return=ret, kind=kind, description=description, currency=currency, amount_claimed=amt, created_by=actor_id)


def _claim(pk):
    c = m.SupplierClaim.objects.select_for_update().filter(pk=pk).first()
    if c is None:
        raise DomainError("Claim not found.", code="not_found", status_code=404)
    return c


@transaction.atomic
def submit_claim(actor_id, claim_id):
    c = _claim(claim_id)
    if c.status != "OPEN":
        raise DomainError("Only an open claim can be submitted.", code="invalid_state")
    c.status = "SUBMITTED"
    c.save(update_fields=["status", "updated_at"])
    return c


@transaction.atomic
def decide_claim(actor_id, claim_id, *, accept, amount=None, note=""):
    c = _claim(claim_id)
    if c.status != "SUBMITTED":
        raise DomainError("Only a submitted claim can be decided.", code="invalid_state")
    if c.created_by == actor_id:
        raise DomainError("Separation of duties: someone else must record the supplier's response.", code="separation_of_duties", status_code=403)
    if accept:
        amt = c.amount_claimed if amount in (None, "") else _dec(amount, "amount")
        if amt <= 0 or amt > c.amount_claimed:
            raise ValidationFailed("The accepted amount must be positive and not above the claim.", code="invalid_amount")
        c.status, c.amount_accepted = "ACCEPTED", amt
    else:
        if not (note or "").strip():
            raise ValidationFailed("A reason is required when a claim is rejected.", code="reason_required")
        c.status = "REJECTED"
    c.decided_by, c.decision_note = actor_id, note[:300]
    c.save()
    return c


@transaction.atomic
def settle_claim(actor_id, claim_id, credit_note_id):
    from modules.finance import models as fm

    c = _claim(claim_id)
    if c.status != "ACCEPTED":
        raise DomainError("Only an accepted claim can be settled.", code="invalid_state")
    cn = fm.Invoice.objects.filter(pk=credit_note_id, kind="SUPPLIER_CREDIT_NOTE", partner_id=c.supplier.partner_id, currency=c.currency).first()
    if cn is None or cn.total < c.amount_accepted:
        raise ValidationFailed("A supplier credit note covering the accepted amount is required.", code="credit_note_invalid")
    c.status, c.credit_note_id = "SETTLED", cn.id
    c.save(update_fields=["status", "credit_note_id", "updated_at"])
    return c


def summary(date_from=None, date_to=None):
    rows = {}
    for r in m.SupplierReturn.objects.exclude(status__in=("DRAFT", "CANCELLED")).select_related("supplier"):
        x = rows.setdefault(r.supplier_id, {"supplier": r.supplier.name, "returns": 0, "return_value": ZERO, "claims": 0, "claimed": ZERO, "accepted": ZERO})
        x["returns"] += 1
        x["return_value"] += r.return_value
    for c in m.SupplierClaim.objects.exclude(status="OPEN").select_related("supplier"):
        x = rows.setdefault(c.supplier_id, {"supplier": c.supplier.name, "returns": 0, "return_value": ZERO, "claims": 0, "claimed": ZERO, "accepted": ZERO})
        x["claims"] += 1
        x["claimed"] += c.amount_claimed
        x["accepted"] += c.amount_accepted or ZERO
    return [{**v, "return_value": str(v["return_value"]), "claimed": str(v["claimed"]), "accepted": str(v["accepted"])} for v in sorted(rows.values(), key=lambda v: v["supplier"])]

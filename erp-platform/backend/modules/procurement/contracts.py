"""Supplier contracts: lifecycle, contracted prices, ceilings, renewal and expiry handling."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.procurement import models as m
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")
COUNTED = ("DRAFT", "PENDING_APPROVAL", "APPROVED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED")


def _dec(v, name="amount"):
    try:
        return Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")


def _contract(cid, lock=True):
    qs = m.SupplierContract.objects.select_for_update() if lock else m.SupplierContract.objects
    c = qs.filter(pk=cid).first()
    if not c:
        raise DomainError("Contract not found.", code="not_found", status_code=404)
    return c


@transaction.atomic
def create(actor_id, *, supplier_id, title, start_date, end_date, currency, prices, value_limit=None, payment_terms="", terms_text="", auto_renew=False, renewal_notice_days=60):
    s = m.Supplier.objects.filter(pk=supplier_id).first()
    if not s:
        raise DomainError("Supplier not found.", code="not_found", status_code=404)
    if end_date < start_date:
        raise ValidationFailed("The contract cannot end before it starts.", code="invalid_dates")
    if not prices:
        raise ValidationFailed("A contract needs at least one contracted price.", code="no_prices")
    limit = None if value_limit in (None, "") else _dec(value_limit, "value_limit")
    if limit is not None and limit <= 0:
        raise ValidationFailed("The value limit must be positive.", code="invalid_amount")
    c = m.SupplierContract.objects.create(number=sequences.next_number("procurement.contract", on_date=start_date, for_type="SupplierContract"), supplier=s, title=title[:200], start_date=start_date, end_date=end_date, currency=currency, value_limit=limit, payment_terms=payment_terms[:120], terms_text=terms_text, auto_renew=auto_renew, renewal_notice_days=renewal_notice_days, created_by=actor_id)
    for pr in prices:
        price = _dec(pr.get("unit_price"), "unit_price")
        if price < 0:
            raise ValidationFailed("Prices cannot be negative.", code="invalid_amount")
        m.ContractPrice.objects.create(contract=c, product_id=pr.get("product"), unit_price=price)
    return c


@transaction.atomic
def activate(actor_id, contract_id):
    c = _contract(contract_id)
    if c.status != "DRAFT":
        raise DomainError("Only a draft contract can be activated.", code="invalid_state")
    if c.created_by == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own contract.", code="separation_of_duties", status_code=403)
    if c.supplier.status != "QUALIFIED":
        raise DomainError("The supplier must be qualified.", code="supplier_not_qualified")
    c.status, c.approved_by = "ACTIVE", actor_id
    c.save(update_fields=["status", "approved_by", "updated_at"])
    record_tenant_event(current_tenant(), "procurement.contract.activated", actor_user_id=actor_id, target_type="SupplierContract", target_id=c.id, metadata={"number": c.number})
    return c


@transaction.atomic
def terminate(actor_id, contract_id, *, reason):
    c = _contract(contract_id)
    if c.status != "ACTIVE":
        raise DomainError("Only an active contract can be terminated.", code="invalid_state")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    c.status, c.terminated_reason = "TERMINATED", reason[:300]
    c.save(update_fields=["status", "terminated_reason", "updated_at"])
    return c


@transaction.atomic
def extend(actor_id, contract_id, *, new_end_date, value_limit=None, reason):
    c = _contract(contract_id)
    if c.status not in ("ACTIVE", "EXPIRED"):
        raise DomainError("Only an active or just-expired contract can be extended.", code="invalid_state")
    if new_end_date <= c.end_date:
        raise ValidationFailed("The new end date must be later than the current one.", code="invalid_dates")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    c.end_date, c.status = new_end_date, "ACTIVE"
    if value_limit is not None:
        c.value_limit = _dec(value_limit, "value_limit")
    c.save()
    record_tenant_event(current_tenant(), "procurement.contract.extended", actor_user_id=actor_id, target_type="SupplierContract", target_id=c.id, metadata={"end": str(new_end_date), "reason": reason[:200]})
    return c


def consumed(contract):
    return m.PurchaseOrder.objects.filter(contract=contract, status__in=COUNTED).exclude(kind="BLANKET").aggregate(t=Sum("total"))["t"] or ZERO


def price_lines(contract_id, supplier_id, currency, order_date, rows):
    """Validate PO lines against a contract and fill in missing prices. `rows` are mutable dicts; returns the extra value being ordered."""
    c = m.SupplierContract.objects.select_for_update().filter(pk=contract_id).first()
    if not c:
        raise DomainError("Contract not found.", code="not_found", status_code=404)
    if c.status != "ACTIVE" or not (c.start_date <= order_date <= c.end_date):
        raise DomainError("The contract is not active on the order date.", code="contract_not_active")
    if c.supplier_id != supplier_id:
        raise ValidationFailed("The contract belongs to a different supplier.", code="contract_supplier_mismatch")
    if c.currency != currency:
        raise ValidationFailed(f"Orders under this contract are placed in {c.currency}.", code="contract_currency_mismatch")
    prices = {p.product_id: p.unit_price for p in c.prices.all()}
    total = ZERO
    for r in rows:
        pid = r.get("product")
        key = next((k for k in prices if str(k) == str(pid)), None)
        if key is None:
            raise ValidationFailed("Every line must be a product covered by the contract.", code="not_in_contract")
        if r.get("unit_price") in (None, ""):
            r["unit_price"] = prices[key]
        elif _dec(r["unit_price"], "unit_price") > prices[key]:
            raise ValidationFailed(f"The price exceeds the contracted price of {prices[key]}.", code="price_exceeds_contract")
        total += _dec(r["quantity"], "quantity") * _dec(r["unit_price"], "unit_price")
    if c.value_limit is not None and consumed(c) + total > c.value_limit:
        raise DomainError(f"The contract ceiling would be exceeded (remaining {c.value_limit - consumed(c)}).", code="contract_ceiling")
    return total


def status_report(contract_id):
    c = _contract(contract_id, lock=False)
    used = consumed(c)
    return {"number": c.number, "supplier": c.supplier.name, "status": c.status, "start_date": str(c.start_date), "end_date": str(c.end_date), "currency": c.currency, "value_limit": None if c.value_limit is None else str(c.value_limit), "consumed": str(used.quantize(Decimal("0.0001"))), "remaining": None if c.value_limit is None else str((c.value_limit - used).quantize(Decimal("0.0001"))), "days_left": (c.end_date - timezone.now().date()).days,
            "prices": [{"product": str(p.product_id), "unit_price": str(p.unit_price)} for p in c.prices.all()]}


def expiring(days=60, today=None):
    today = today or timezone.now().date()
    return [{"number": c.number, "supplier": c.supplier.name, "end_date": str(c.end_date), "days_left": (c.end_date - today).days, "auto_renew": c.auto_renew} for c in m.SupplierContract.objects.select_related("supplier").filter(status="ACTIVE", end_date__lte=today + timedelta(days=days)).order_by("end_date")]


def run_daily(today=None):
    """Expire lapsed contracts, renew the auto-renewing ones for another term, and warn managers once per contract inside the notice window."""
    from platform_core.authorization.models import RoleAssignment

    today = today or timezone.now().date()
    ids = list(RoleAssignment.objects.filter(role__name="procurement_manager").values_list("user_id", flat=True).distinct())
    expired = renewed = warned = 0
    for c in m.SupplierContract.objects.select_for_update().filter(status="ACTIVE"):
        if c.end_date < today:
            if c.auto_renew:
                term = (c.end_date - c.start_date).days or 365
                c.start_date, c.end_date = c.end_date + timedelta(days=1), c.end_date + timedelta(days=term + 1)
                c.last_notice_on = None
                c.save()
                renewed += 1
            else:
                c.status = "EXPIRED"
                c.save(update_fields=["status", "updated_at"])
                expired += 1
        elif (c.end_date - today).days <= c.renewal_notice_days and c.last_notice_on is None:
            if ids:
                notify(ids, "procurement.contract.expiring", f"Contract {c.number} ends {c.end_date}", c.title, ref_type="procurement.contract", ref_id=str(c.id))
            c.last_notice_on = today
            c.save(update_fields=["last_notice_on", "updated_at"])
            warned += 1
    return {"expired": expired, "renewed": renewed, "warned": warned}

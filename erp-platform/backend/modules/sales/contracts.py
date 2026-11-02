"""Sales contracts / framework agreements: versions, activation (agreed prices become a CONTRACT price list),
renewal and expiry, reminders, obligations and utilisation against the committed value."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.crm import models as cm
from modules.crm import services as crm
from modules.inventory import models as im
from modules.sales import models as m
from modules.sales import pricing
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")
TEXT = ("payment_terms", "delivery_terms", "terms")


def _get(pk, lock=False):
    qs = m.SalesContract.objects.select_for_update() if lock else m.SalesContract.objects
    c = qs.filter(pk=pk).first()
    if c is None:
        raise DomainError("Contract not found.", code="not_found", status_code=404)
    return c


def _visible(c, actor_id):
    crm._own(cm.CrmAccount, c.account_id, actor_id, "Contract")


def _approver(actor_id):
    if not authz.has_permission(actor_id, "sales.order.approve"):
        raise DomainError("Only a sales manager can do this to a contract.", code="permission_denied", status_code=403)


def _snapshot(c, actor_id, event):
    m.ContractRevision.objects.create(contract=c, version=c.version, event=event, created_by=actor_id, snapshot={
        "status": c.status, "title": c.title, "start_date": str(c.start_date), "end_date": str(c.end_date), "committed_value": str(c.committed_value) if c.committed_value is not None else None,
        **{k: getattr(c, k) for k in TEXT}, "auto_renew": c.auto_renew,
        "items": [{"product": str(i.product_id), "min_quantity": str(i.min_quantity), "unit_price": str(i.unit_price)} for i in c.items.all()]})


def _set_items(c, items):
    c.items.all().delete()
    seen = set()
    for it in items or []:
        product = im.Product.objects.filter(pk=it.get("product"), is_active=True).first()
        try:
            price, qty = Decimal(str(it.get("unit_price"))), Decimal(str(it.get("min_quantity", 1)))
        except Exception:
            raise ValidationFailed("Items need numeric prices and quantities.", code="invalid_item")
        if product is None or price < 0 or qty <= 0 or (product.id, qty) in seen:
            raise ValidationFailed("Items need an active product, a non-negative price, a positive quantity and no duplicates.", code="invalid_item")
        seen.add((product.id, qty))
        m.ContractItem.objects.create(contract=c, product=product, min_quantity=qty, unit_price=price)


def _check_dates(start, end):
    if start is None or end is None or end < start:
        raise ValidationFailed("Contract dates are required and the end must not precede the start.", code="invalid_dates")


@transaction.atomic
def create(actor_id, *, account_id, title, start_date, end_date, currency, items=(), committed_value=None, auto_renew=False, renewal_term_months=12, renewal_notice_days=30, **text):
    from modules.sales import services as sales

    account = crm._own(cm.CrmAccount, account_id, actor_id, "Account")
    if not (title or "").strip():
        raise ValidationFailed("A title is required.", code="invalid_contract")
    _check_dates(start_date, end_date)
    sales._currency(currency)
    if renewal_term_months < 1 or renewal_notice_days < 0:
        raise ValidationFailed("Renewal settings are invalid.", code="invalid_contract")
    c = m.SalesContract.objects.create(number=sequences.next_number("sales.contract", on_date=start_date, for_type="SalesContract"), account=account, title=title.strip()[:200], start_date=start_date, end_date=end_date, currency=currency,
                                       committed_value=Decimal(str(committed_value)) if committed_value not in (None, "") else None, auto_renew=bool(auto_renew), renewal_term_months=renewal_term_months, renewal_notice_days=renewal_notice_days, created_by=actor_id, **{k: (text.get(k) or "") for k in TEXT})
    _set_items(c, items)
    return c


@transaction.atomic
def update(actor_id, pk, *, items=None, **fields):
    """Drafts are edited freely.  An active contract can only have its wording and renewal settings changed (new version, old one kept)."""
    c = _get(pk, lock=True)
    _visible(c, actor_id)
    if c.status not in ("DRAFT", "ACTIVE"):
        raise DomainError("This contract can no longer be changed.", code="invalid_state_transition")
    active = c.status == "ACTIVE"
    allowed = set(TEXT) | {"auto_renew", "renewal_term_months", "renewal_notice_days"} | (set() if active else {"title", "start_date", "end_date", "committed_value"})
    bad = [k for k, v in fields.items() if v is not None and k not in allowed]
    if bad or (active and items is not None):
        raise DomainError("An active contract's prices, dates and value are fixed; terminate or renew it instead.", code="contract_locked")
    if active:
        _approver(actor_id)
        _snapshot(c, actor_id, "AMENDED")
        c.version += 1
    for k, v in fields.items():
        if v is not None and k in allowed:
            setattr(c, k, Decimal(str(v)) if k == "committed_value" else v)
    _check_dates(c.start_date, c.end_date)
    c.save()
    if items is not None:
        _set_items(c, items)
    return c


def _activate(c, actor_id):
    items = [{"product": i.product_id, "min_quantity": i.min_quantity, "unit_price": i.unit_price} for i in c.items.all()]
    if items:
        c.price_list = pricing.create_list(actor_id, name=f"{c.number} {c.title}"[:100], currency=c.currency, kind="CONTRACT", account_id=c.account_id, items=items, valid_from=c.start_date, valid_to=c.end_date)
    c.status, c.activated_by = "ACTIVE", actor_id
    _snapshot(c, actor_id, "ACTIVATED")
    c.save()


@transaction.atomic
def activate(actor_id, pk):
    c = _get(pk, lock=True)
    _approver(actor_id)
    if c.status != "DRAFT":
        raise DomainError("Only a draft contract can be activated.", code="invalid_state_transition")
    if c.end_date < timezone.now().date():
        raise ValidationFailed("The contract has already ended.", code="invalid_dates")
    if m.SalesContract.objects.filter(account=c.account, status="ACTIVE", start_date__lte=c.end_date, end_date__gte=c.start_date, currency=c.currency, items__product__in=c.items.values("product")).exclude(pk=c.pk).exists():
        raise DomainError("Another active contract already prices some of these products for the customer in that period.", code="contract_overlap", status_code=409)
    _activate(c, actor_id)
    record_tenant_event(current_tenant(), "sales.contract.activated", actor_user_id=actor_id, target_type="SalesContract", target_id=c.id, metadata={"number": c.number})
    return c


@transaction.atomic
def terminate(actor_id, pk, reason):
    c = _get(pk, lock=True)
    _approver(actor_id)
    if c.status != "ACTIVE":
        raise DomainError("Only an active contract can be terminated.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    c.status, c.terminated_reason = "TERMINATED", reason.strip()[:300]
    c.save(update_fields=["status", "terminated_reason", "updated_at"])
    if c.price_list_id:
        pricing.set_list_active(actor_id, c.price_list_id, False)  # contract prices stop applying immediately
    _snapshot(c, actor_id, "TERMINATED")
    return c


def _renew(c, actor_id):
    term = c.renewal_term_months
    start = c.end_date + timedelta(days=1)
    y, mo = divmod(start.month - 1 + term, 12)
    try:
        end = start.replace(year=start.year + y, month=mo + 1) - timedelta(days=1)
    except ValueError:  # 29-31 in a shorter month
        end = start.replace(year=start.year + y, month=mo + 1, day=28) - timedelta(days=1)
    n = m.SalesContract.objects.create(number=sequences.next_number("sales.contract", on_date=start, for_type="SalesContract"), account_id=c.account_id, title=c.title, start_date=start, end_date=end, currency=c.currency, committed_value=c.committed_value,
                                       auto_renew=c.auto_renew, renewal_term_months=c.renewal_term_months, renewal_notice_days=c.renewal_notice_days, version=1, created_by=actor_id, renews=c, **{k: getattr(c, k) for k in TEXT})
    for i in c.items.all():
        m.ContractItem.objects.create(contract=n, product_id=i.product_id, min_quantity=i.min_quantity, unit_price=i.unit_price)
    c.status = "RENEWED"
    c.save(update_fields=["status", "updated_at"])
    return n


@transaction.atomic
def renew(actor_id, pk):
    """Create the successor draft (starting the day after this one ends, same prices and wording); activate it separately."""
    c = _get(pk, lock=True)
    _approver(actor_id)
    if c.status not in ("ACTIVE", "EXPIRED"):
        raise DomainError("Only an active or expired contract can be renewed.", code="invalid_state_transition")
    n = _renew(c, actor_id)
    _snapshot(c, actor_id, "RENEWED")
    return n


def run_daily(today=None):
    """Expire or auto-renew contracts that ended, send renewal-notice and obligation reminders.  Idempotent."""
    today = today or timezone.now().date()
    out = {"expired": 0, "auto_renewed": 0, "renewal_reminders": 0, "obligation_reminders": 0}
    for c in m.SalesContract.objects.select_for_update().filter(status="ACTIVE", end_date__lt=today):
        renewed = False
        if c.auto_renew:
            try:
                with transaction.atomic():
                    n = _renew(c, c.activated_by or c.created_by)
                    if n.end_date >= today:
                        _activate(n, c.activated_by or c.created_by)
                renewed = True
                out["auto_renewed"] += 1
            except DomainError:
                c.refresh_from_db()
                notify([c.created_by], "sales.contract.renewal_failed", f"Automatic renewal of {c.number} failed", "Renew it manually.", ref_type="SalesContract", ref_id=str(c.id))
        if not renewed:
            c.status = "EXPIRED"
            c.save(update_fields=["status", "updated_at"])
            out["expired"] += 1
    for c in m.SalesContract.objects.filter(status="ACTIVE", renewal_reminded_at__isnull=True).select_related("account"):
        if c.end_date - timedelta(days=c.renewal_notice_days) <= today <= c.end_date:
            notify([u for u in {c.created_by, c.account.owner_id} if u], "sales.contract.renewal_due", f"Contract {c.number} ends {c.end_date}", "Renew it or let it lapse." if not c.auto_renew else "It will renew automatically.", ref_type="SalesContract", ref_id=str(c.id))
            c.renewal_reminded_at = timezone.now()
            c.save(update_fields=["renewal_reminded_at"])
            out["renewal_reminders"] += 1
    for o in m.ContractObligation.objects.filter(done_at__isnull=True, reminded_at__isnull=True, due_date__lte=today + timedelta(days=7), contract__status="ACTIVE").select_related("contract__account"):
        notify([u for u in {o.contract.created_by, o.contract.account.owner_id} if u], "sales.contract.obligation_due", f"Obligation due {o.due_date}: {o.description[:80]}", o.contract.number, ref_type="SalesContract", ref_id=str(o.contract_id))
        o.reminded_at = timezone.now()
        o.save(update_fields=["reminded_at"])
        out["obligation_reminders"] += 1
    return out


def add_obligation(actor_id, pk, description, due_date, party="US"):
    c = _get(pk)
    _visible(c, actor_id)
    if c.status not in ("DRAFT", "ACTIVE") or not (description or "").strip() or due_date is None or party not in ("US", "CUSTOMER"):
        raise ValidationFailed("An obligation needs a description, a due date and a party (US or CUSTOMER) on a live contract.", code="invalid_obligation")
    return m.ContractObligation.objects.create(contract=c, description=description.strip()[:300], due_date=due_date, party=party)


def complete_obligation(actor_id, obligation_id):
    o = m.ContractObligation.objects.select_related("contract").filter(pk=obligation_id).first()
    if o is None:
        raise DomainError("Obligation not found.", code="not_found", status_code=404)
    _visible(o.contract, actor_id)
    if o.done_at is None:
        o.done_at = timezone.now()
        o.save(update_fields=["done_at", "updated_at"])
    return o


def utilisation(actor_id, pk):
    c = _get(pk)
    _visible(c, actor_id)
    used = m.SalesOrder.objects.filter(account_id=c.account_id, currency=c.currency, order_date__gte=c.start_date, order_date__lte=c.end_date, status__in=("CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED", "INVOICED")).aggregate(t=Sum("total"))["t"] or ZERO
    return {"contract": c.number, "currency": c.currency, "ordered": str(used), "committed": str(c.committed_value) if c.committed_value is not None else None,
            "percent": round(float(used / c.committed_value * 100), 1) if c.committed_value else None, "remaining": str(c.committed_value - used) if c.committed_value is not None else None,
            "obligations_open": c.obligations.filter(done_at__isnull=True).count(), "obligations_overdue": c.obligations.filter(done_at__isnull=True, due_date__lt=timezone.now().date()).count()}


def history(actor_id, pk):
    c = _get(pk)
    _visible(c, actor_id)
    return list(c.revisions.order_by("created_at"))

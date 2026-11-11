"""Supplier master: profile, contacts, bank details (dual control), compliance documents, standing, catalogue and price history."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from modules.inventory import models as im
from modules.procurement import models as m
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

RISK = {"LOW", "MEDIUM", "HIGH"}
PROFILE_FIELDS = {"name", "legal_name", "tax_id", "registration_no", "email", "phone", "website", "category", "address", "payment_terms_days", "currency", "risk_level", "is_preferred", "early_discount_percent", "early_discount_days", "wht_percent"}


def _supplier(supplier_id, lock=False):
    qs = m.Supplier.objects.select_for_update() if lock else m.Supplier.objects
    s = qs.filter(pk=supplier_id).first()
    if not s:
        raise DomainError("Supplier not found.", code="not_found", status_code=404)
    return s


def clean_profile(a):
    bad = set(a) - PROFILE_FIELDS
    if bad:
        raise ValidationFailed(f"Unknown supplier attribute '{sorted(bad)[0]}'.", code="unknown_attribute")
    if "risk_level" in a and a["risk_level"] not in RISK:
        raise ValidationFailed("Invalid risk level.", code="invalid_risk_level")
    if "payment_terms_days" in a:
        try:
            a["payment_terms_days"] = int(a["payment_terms_days"])
        except (TypeError, ValueError):
            raise ValidationFailed("Payment terms must be a whole number of days.", code="invalid_terms")
        if not 0 <= a["payment_terms_days"] <= 365:
            raise ValidationFailed("Payment terms must be between 0 and 365 days.", code="invalid_terms")
    for k, hi in (("early_discount_percent", 20), ("wht_percent", 50)):
        if k in a:
            try:
                a[k] = Decimal(str(a[k]))
            except Exception:
                raise ValidationFailed(f"{k} must be a number.", code="invalid_percent")
            if not 0 <= a[k] <= hi:
                raise ValidationFailed(f"{k} must be between 0 and {hi}.", code="invalid_percent")
    if "early_discount_days" in a:
        try:
            a["early_discount_days"] = int(a["early_discount_days"])
        except (TypeError, ValueError):
            raise ValidationFailed("early_discount_days must be a whole number.", code="invalid_terms")
        if not 0 <= a["early_discount_days"] <= 365:
            raise ValidationFailed("early_discount_days must be between 0 and 365.", code="invalid_terms")
    if "address" in a and not isinstance(a["address"], dict):
        raise ValidationFailed("address must be an object.", code="invalid_address")
    if "name" in a and not str(a["name"]).strip():
        raise ValidationFailed("name is required.", code="invalid_name")
    return a


@transaction.atomic
def update_supplier(actor_id, supplier_id, **attrs):
    s = _supplier(supplier_id, lock=True)
    for k, v in clean_profile({k: v for k, v in attrs.items() if v is not None}).items():
        setattr(s, k, v)
    s.save()
    return s


@transaction.atomic
def add_contact(actor_id, supplier_id, *, name, role="", email="", phone="", is_primary=False):
    s = _supplier(supplier_id, lock=True)
    if not (name or "").strip():
        raise ValidationFailed("A contact name is required.", code="invalid_name")
    if is_primary:
        s.contacts.update(is_primary=False)
    return m.SupplierContact.objects.create(supplier=s, name=name.strip(), role=role, email=email, phone=phone, is_primary=is_primary or not s.contacts.exists())


@transaction.atomic
def add_bank_account(actor_id, supplier_id, *, bank_name, account_name, account_number, currency="", is_default=False):
    s = _supplier(supplier_id, lock=True)
    if not (bank_name and account_name and account_number):
        raise ValidationFailed("Bank name, account name and account number are required.", code="invalid_bank")
    b = m.SupplierBank.objects.create(supplier=s, bank_name=bank_name, account_name=account_name, account_number=str(account_number).replace(" ", ""), currency=currency, is_default=is_default, created_by=actor_id)
    record_tenant_event(current_tenant(), "procurement.supplier.bank_added", actor_user_id=actor_id, target_type="Supplier", target_id=s.id, metadata={"bank": bank_name})
    return b


@transaction.atomic
def verify_bank_account(actor_id, bank_id):
    b = m.SupplierBank.objects.select_for_update().filter(pk=bank_id).first()
    if not b:
        raise DomainError("Bank account not found.", code="not_found", status_code=404)
    if b.created_by == actor_id:
        raise DomainError("Dual control: someone other than the person who entered the bank details must verify them.", code="separation_of_duties", status_code=403)
    b.verified_by, b.verified_at = actor_id, timezone.now()
    b.save(update_fields=["verified_by", "verified_at", "updated_at"])
    return b


def mask(number):
    return "*" * max(0, len(number) - 4) + number[-4:]


def payable_bank_account(supplier_id, currency=None):
    """The verified default account a payment may use; unverified details are never payable."""
    qs = m.SupplierBank.objects.filter(supplier_id=supplier_id, verified_at__isnull=False)
    if currency:
        qs = qs.filter(currency__in=[currency, ""])
    return qs.order_by("-is_default", "-verified_at").first()


@transaction.atomic
def add_document(actor_id, supplier_id, *, doc_type, reference="", expiry_date=None, file_id=None):
    s = _supplier(supplier_id)
    if not (doc_type or "").strip():
        raise ValidationFailed("A document type is required.", code="invalid_doc_type")
    return m.SupplierDocument.objects.create(supplier=s, doc_type=doc_type.upper()[:40], reference=reference, expiry_date=expiry_date, file_id=file_id)


def expiring_documents(days=30, today=None):
    today = today or timezone.now().date()
    qs = m.SupplierDocument.objects.select_related("supplier").filter(expiry_date__isnull=False, expiry_date__lte=today + timedelta(days=days)).order_by("expiry_date")
    return [{"supplier": d.supplier.name, "supplier_id": str(d.supplier_id), "doc_type": d.doc_type, "reference": d.reference, "expiry_date": str(d.expiry_date), "status": "EXPIRED" if d.expiry_date < today else "EXPIRING"} for d in qs]


@transaction.atomic
def set_standing(actor_id, supplier_id, standing, *, reason="", until=None):
    if standing not in ("GOOD", "SUSPENDED", "BLACKLISTED"):
        raise ValidationFailed("Invalid standing.", code="invalid_standing")
    s = _supplier(supplier_id, lock=True)
    if standing != "GOOD" and not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    if standing == "GOOD" and s.standing == "BLACKLISTED" and not (reason or "").strip():
        raise ValidationFailed("Lifting a blacklisting needs a documented reason.", code="reason_required")
    s.standing, s.standing_reason, s.suspended_until = standing, reason[:300], until if standing == "SUSPENDED" else None
    s.save(update_fields=["standing", "standing_reason", "suspended_until", "updated_at"])
    record_tenant_event(current_tenant(), "procurement.supplier.standing", actor_user_id=actor_id, target_type="Supplier", target_id=s.id, metadata={"standing": standing, "reason": reason[:200]})
    return s


def effective_standing(s, today=None):
    today = today or timezone.now().date()
    if s.standing == "SUSPENDED" and s.suspended_until and s.suspended_until < today:
        return "GOOD"
    return s.standing


def assert_can_transact(s):
    if s.status != "QUALIFIED" or s.partner_id is None:
        raise DomainError("Purchase orders can only be raised to qualified suppliers.", code="supplier_not_qualified")
    st = effective_standing(s)
    if st != "GOOD":
        raise DomainError(f"Supplier is {st.lower()}: {s.standing_reason or 'no new orders'}.", code="supplier_not_in_good_standing")


@transaction.atomic
def set_catalogue_price(actor_id, supplier_id, product_id, *, unit_price, currency, valid_from=None, min_order_quantity=1, lead_time_days=0, supplier_sku="", is_preferred=False):
    s = _supplier(supplier_id)
    p = im.Product.objects.filter(pk=product_id).first()
    if not p:
        raise DomainError("Product not found.", code="not_found", status_code=404)
    try:
        price, moq = Decimal(str(unit_price)), Decimal(str(min_order_quantity))
    except Exception:
        raise ValidationFailed("Price and minimum quantity must be numbers.", code="invalid_amount")
    if price < 0 or moq <= 0:
        raise ValidationFailed("Price must be non-negative and the minimum quantity positive.", code="invalid_amount")
    start = valid_from or timezone.now().date()
    prev = m.SupplierItem.objects.filter(supplier=s, product=p, valid_to__isnull=True).order_by("-valid_from").first()
    if prev:
        if start <= prev.valid_from:
            raise ValidationFailed("The new price must start after the current one.", code="invalid_dates")
        prev.valid_to = start - timedelta(days=1)
        prev.save(update_fields=["valid_to", "updated_at"])
    return m.SupplierItem.objects.create(supplier=s, product=p, supplier_sku=supplier_sku, unit_price=price, currency=currency, min_order_quantity=moq, lead_time_days=lead_time_days, valid_from=start, is_preferred=is_preferred)


def current_price(supplier_id, product_id, on_date=None):
    on_date = on_date or timezone.now().date()
    return m.SupplierItem.objects.filter(supplier_id=supplier_id, product_id=product_id, valid_from__lte=on_date).exclude(valid_to__lt=on_date).order_by("-valid_from").first()


def price_history(product_id, supplier_id=None):
    qs = m.SupplierItem.objects.select_related("supplier").filter(product_id=product_id)
    if supplier_id:
        qs = qs.filter(supplier_id=supplier_id)
    return [{"supplier": i.supplier.name, "unit_price": str(i.unit_price), "currency": i.currency, "valid_from": str(i.valid_from), "valid_to": None if not i.valid_to else str(i.valid_to), "lead_time_days": i.lead_time_days} for i in qs.order_by("supplier__name", "-valid_from")]


def preferred_suppliers(product_id, today=None):
    """Suppliers for a product in good standing, preferred first, then cheapest (current catalogue prices, mixed currencies are listed as-is)."""
    today = today or timezone.now().date()
    items = [i for i in m.SupplierItem.objects.select_related("supplier").filter(product_id=product_id, valid_from__lte=today).exclude(valid_to__lt=today) if i.supplier.status == "QUALIFIED" and effective_standing(i.supplier, today) == "GOOD"]
    items.sort(key=lambda i: (not (i.is_preferred or i.supplier.is_preferred), i.unit_price))
    return [{"supplier": i.supplier.name, "supplier_id": str(i.supplier_id), "unit_price": str(i.unit_price), "currency": i.currency, "lead_time_days": i.lead_time_days, "preferred": bool(i.is_preferred or i.supplier.is_preferred)} for i in items]


def risk_report():
    out = []
    today = timezone.now().date()
    for s in m.Supplier.objects.all().order_by("name"):
        expired = s.documents.filter(expiry_date__lt=today).count()
        out.append({"supplier": s.name, "status": s.status, "standing": effective_standing(s, today), "risk_level": s.risk_level, "expired_documents": expired, "verified_bank": s.bank_accounts.filter(verified_at__isnull=False).exists()})
    return out


def profile(s):
    from modules.procurement import services

    return {"id": str(s.id), "name": s.name, "legal_name": s.legal_name, "tax_id": s.tax_id, "registration_no": s.registration_no, "email": s.email, "phone": s.phone, "website": s.website, "category": s.category, "address": s.address, "payment_terms_days": s.payment_terms_days, "early_discount_percent": str(s.early_discount_percent), "early_discount_days": s.early_discount_days, "wht_percent": str(s.wht_percent), "currency": s.currency, "risk_level": s.risk_level, "is_preferred": s.is_preferred, "status": s.status, "standing": effective_standing(s), "standing_reason": s.standing_reason, "scorecard": services.supplier_scorecard(s.id),
            "contacts": [{"id": str(c.id), "name": c.name, "role": c.role, "email": c.email, "phone": c.phone, "primary": c.is_primary} for c in s.contacts.all()],
            "documents": [{"id": str(d.id), "type": d.doc_type, "reference": d.reference, "expiry_date": None if not d.expiry_date else str(d.expiry_date)} for d in s.documents.all()]}

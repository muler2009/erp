"""Sales catalog and pricing rules: commercial product profile, bundles, customer / contract / promotional price
lists with precedence, price-change history, discount ceilings, price floors and the price-override guard."""
from decimal import Decimal

from django.db import transaction
from django.db.models import Case, IntegerField, Q, Sum, Value, When

from modules.crm import models as cm
from modules.inventory import models as im
from modules.sales import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

ZERO = Decimal("0")
KINDS = ("STANDARD", "PROMOTIONAL", "CUSTOMER", "CONTRACT")
RANK = {"CONTRACT": 0, "CUSTOMER": 1, "PROMOTIONAL": 2, "STANDARD": 3}  # lower wins
OVERRIDE = "sales.price.override"


def _dec(v, field):
    try:
        d = Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{field} must be a number.", code="invalid_amount")
    if not d.is_finite():
        raise ValidationFailed(f"{field} must be a number.", code="invalid_amount")
    return d


def _manager(actor_id):
    if not authz.has_permission(actor_id, "sales.pricelist.manage"):
        raise DomainError("You may not manage pricing.", code="permission_denied", status_code=403)


def can_override(user_id):
    return bool(user_id) and authz.has_permission(user_id, OVERRIDE)


# ----------------------------------------------------------------------------- catalog
def set_profile(actor_id, product_id, *, is_sellable=None, is_discontinued=None, description=None, min_price=None, min_margin_percent=None, max_discount_percent=None, default_tax_rate_id=None, clear=()):
    _manager(actor_id)
    product = im.Product.objects.filter(pk=product_id).first()
    if product is None:
        raise DomainError("Product not found.", code="not_found", status_code=404)
    prof, _ = m.ProductSales.objects.get_or_create(product=product)
    if is_sellable is not None:
        prof.is_sellable = bool(is_sellable)
    if is_discontinued is not None:
        prof.is_discontinued = bool(is_discontinued)
    if description is not None:
        prof.description = description
    for name, val, lo, hi in (("min_price", min_price, 0, None), ("min_margin_percent", min_margin_percent, 0, 100), ("max_discount_percent", max_discount_percent, 0, 100)):
        if val is None:
            continue
        d = _dec(val, name)
        if d < lo or (hi is not None and d > hi):
            raise ValidationFailed(f"{name} is out of range.", code="invalid_amount")
        setattr(prof, name, d)
    if default_tax_rate_id:
        from modules.finance import models as fm

        tax = fm.TaxRate.objects.filter(pk=default_tax_rate_id, is_active=True, kind="SALES").first()
        if tax is None:
            raise ValidationFailed("Unknown or inactive sales tax rate.", code="invalid_tax_rate")
        prof.default_tax_rate = tax
    for f in clear:
        if f in ("min_price", "min_margin_percent", "max_discount_percent", "default_tax_rate"):
            setattr(prof, f, None)
    prof.save()
    record_tenant_event(current_tenant(), "sales.product.profile_changed", actor_user_id=actor_id, target_type="Product", target_id=product.id, metadata={"sellable": str(prof.is_sellable), "discontinued": str(prof.is_discontinued)})
    return prof


def is_sellable(product):
    prof = m.ProductSales.objects.filter(product=product).first()
    return product.is_active and (prof is None or (prof.is_sellable and not prof.is_discontinued))


def available_quantity(product_id):
    return im.StockLevel.objects.filter(product_id=product_id).aggregate(q=Sum("quantity"))["q"] or ZERO


def catalog(*, search="", category="", only_sellable=True):
    qs = im.Product.objects.filter(is_active=True).select_related("sales_profile").order_by("name")
    if search:
        qs = qs.filter(Q(name__icontains=search) | Q(sku__icontains=search))
    if category:
        qs = qs.filter(category=category)
    out = []
    for p in qs[:500]:
        prof = getattr(p, "sales_profile", None)
        ok = is_sellable(p)
        if only_sellable and not ok:
            continue
        out.append({"id": str(p.id), "sku": p.sku, "name": p.name, "category": p.category, "uom": p.uom, "sellable": ok, "discontinued": bool(prof and prof.is_discontinued),
                    "min_price": str(prof.min_price) if prof and prof.min_price is not None else None, "max_discount_percent": str(prof.max_discount_percent) if prof and prof.max_discount_percent is not None else None,
                    "available": str(available_quantity(p.id)) if p.is_stocked else None, "is_bundle": hasattr(p, "bundle")})
    return out


# ----------------------------------------------------------------------------- bundles
@transaction.atomic
def set_bundle(actor_id, product_id, items):
    _manager(actor_id)
    product = im.Product.objects.filter(pk=product_id, is_active=True).first()
    if product is None:
        raise DomainError("Product not found.", code="not_found", status_code=404)
    if not items:
        raise ValidationFailed("A bundle needs at least one component.", code="no_items")
    seen = set()
    rows = []
    for it in items:
        comp = im.Product.objects.filter(pk=it.get("product"), is_active=True).first()
        qty = _dec(it.get("quantity"), "quantity")
        if comp is None or comp.id == product.id or comp.id in seen or qty <= 0 or hasattr(comp, "bundle"):
            raise ValidationFailed("Components must be distinct, active, non-bundle products with positive quantities.", code="invalid_bundle")
        seen.add(comp.id)
        rows.append((comp, qty))
    b, _ = m.Bundle.objects.get_or_create(product=product)
    b.items.all().delete()
    m.BundleItem.objects.bulk_create([m.BundleItem(bundle=b, product=c, quantity=q) for c, q in rows])
    return b


def expand_bundles(raw_lines):
    """Replace each bundle line by its components (quantities multiplied); other lines pass through unchanged."""
    out = []
    for r in raw_lines:
        pid = r.get("product")
        b = m.Bundle.objects.filter(product_id=pid, is_active=True).prefetch_related("items__product").first() if pid else None
        if b is None:
            out.append(r)
            continue
        qty = _dec(r.get("quantity", 0), "quantity")
        for it in b.items.all():
            out.append({"product": str(it.product_id), "quantity": str(qty * it.quantity), "discount_percent": r.get("discount_percent", 0), "tax_rate": r.get("tax_rate")})
    return out


# ----------------------------------------------------------------------------- price lists
@transaction.atomic
def create_list(actor_id, *, name, currency, kind="STANDARD", account_id=None, items=(), valid_from=None, valid_to=None):
    from modules.sales import services as sales

    _manager(actor_id)
    if kind not in KINDS:
        raise ValidationFailed("Unknown price list kind.", code="invalid_kind")
    if kind in ("CUSTOMER", "CONTRACT") and not account_id:
        raise ValidationFailed("Customer and contract price lists need an account.", code="account_required")
    if kind in ("STANDARD", "PROMOTIONAL") and account_id:
        raise ValidationFailed("Standard and promotional lists apply to everyone.", code="invalid_kind")
    if kind in ("PROMOTIONAL", "CONTRACT") and not (valid_from and valid_to):
        raise ValidationFailed("Promotional and contract lists need a validity period.", code="dates_required")
    account = None
    if account_id:
        account = cm.CrmAccount.objects.filter(pk=account_id).first()
        if account is None:
            raise DomainError("Account not found.", code="not_found", status_code=404)
    pl = sales.create_price_list(actor_id, name=name, currency=currency, items=list(items), valid_from=valid_from, valid_to=valid_to)
    pl.kind, pl.account = kind, account
    pl.save(update_fields=["kind", "account", "updated_at"])
    for it in pl.items.all():
        m.PriceChange.objects.create(price_list=pl, product=it.product, min_quantity=it.min_quantity, old_price=None, new_price=it.unit_price, changed_by=actor_id)
    return pl


@transaction.atomic
def set_item_price(actor_id, price_list_id, product_id, unit_price, min_quantity=1):
    _manager(actor_id)
    pl = m.PriceList.objects.select_for_update().filter(pk=price_list_id).first()
    product = im.Product.objects.filter(pk=product_id).first()
    if pl is None or product is None:
        raise DomainError("Price list or product not found.", code="not_found", status_code=404)
    price, qty = _dec(unit_price, "unit_price"), _dec(min_quantity, "min_quantity")
    if price < 0 or qty <= 0:
        raise ValidationFailed("Price must be non-negative and quantity positive.", code="invalid_amount")
    item = m.PriceListItem.objects.filter(price_list=pl, product=product, min_quantity=qty).first()
    old = item.unit_price if item else None
    if item:
        item.unit_price = price
        item.save(update_fields=["unit_price"])
    else:
        item = m.PriceListItem.objects.create(price_list=pl, product=product, min_quantity=qty, unit_price=price)
    if old != price:
        m.PriceChange.objects.create(price_list=pl, product=product, min_quantity=qty, old_price=old, new_price=price, changed_by=actor_id)
    return item


@transaction.atomic
def remove_item(actor_id, price_list_id, product_id, min_quantity=1):
    _manager(actor_id)
    item = m.PriceListItem.objects.select_for_update().filter(price_list_id=price_list_id, product_id=product_id, min_quantity=_dec(min_quantity, "min_quantity")).first()
    if item is None:
        raise DomainError("Price entry not found.", code="not_found", status_code=404)
    m.PriceChange.objects.create(price_list_id=price_list_id, product_id=product_id, min_quantity=item.min_quantity, old_price=item.unit_price, new_price=None, changed_by=actor_id)
    item.delete()


def set_list_active(actor_id, price_list_id, active):
    _manager(actor_id)
    n = m.PriceList.objects.filter(pk=price_list_id).update(is_active=bool(active))
    if not n:
        raise DomainError("Price list not found.", code="not_found", status_code=404)


def price_history(actor_id, *, product_id=None, price_list_id=None):
    _manager(actor_id)
    qs = m.PriceChange.objects.all().order_by("-changed_at")
    if product_id:
        qs = qs.filter(product_id=product_id)
    if price_list_id:
        qs = qs.filter(price_list_id=price_list_id)
    return qs[:200]


def best_price(product_id, currency, quantity, on_date, account_id=None):
    """Winning list entry: contract > customer > promotional > standard, then the largest quantity break, then the lowest price.
    Customer / contract lists only apply to their own account."""
    from modules.sales.services import models_q_valid

    qs = m.PriceListItem.objects.filter(price_list__is_active=True, price_list__currency=currency, product_id=product_id, min_quantity__lte=quantity).filter(models_q_valid(on_date))
    qs = qs.filter(Q(price_list__account__isnull=True) | Q(price_list__account_id=account_id)) if account_id else qs.filter(price_list__account__isnull=True)
    rank = Case(*[When(price_list__kind=k, then=Value(v)) for k, v in RANK.items()], default=Value(9), output_field=IntegerField())
    return qs.annotate(rank=rank).order_by("rank", "-min_quantity", "unit_price").select_related("price_list").first()


# ----------------------------------------------------------------------------- discount rules and checks
def set_discount_rule(actor_id, scope, key, max_percent, active=True):
    _manager(actor_id)
    if scope not in ("CATEGORY", "CLASSIFICATION") or not key.strip():
        raise ValidationFailed("Scope must be CATEGORY or CLASSIFICATION with a key.", code="invalid_rule")
    pct = _dec(max_percent, "max_percent")
    if not (0 <= pct <= 100):
        raise ValidationFailed("max_percent must be between 0 and 100.", code="invalid_amount")
    r, _ = m.DiscountRule.objects.update_or_create(scope=scope, key=key.strip(), defaults={"max_percent": pct, "is_active": bool(active)})
    return r


def discount_ceiling(product, account):
    ceilings = []
    prof = getattr(product, "sales_profile", None) if product else None
    if prof and prof.max_discount_percent is not None:
        ceilings.append(prof.max_discount_percent)
    rules = m.DiscountRule.objects.filter(is_active=True)
    if product and product.category:
        ceilings += list(rules.filter(scope="CATEGORY", key=product.category).values_list("max_percent", flat=True))
    if account is not None and account.classification:
        ceilings += list(rules.filter(scope="CLASSIFICATION", key=account.classification).values_list("max_percent", flat=True))
    return min(ceilings) if ceilings else None


def check_line(i, *, product, account, actor_id, currency, on_date, net, disc, supplied_price, list_price):
    """Raise unless the line respects catalog and pricing rules (or the actor holds the override permission)."""
    if product is not None and not is_sellable(product):
        raise ValidationFailed(f"Line {i}: {product.sku} is not available for sale.", code="not_sellable")
    if actor_id is None or can_override(actor_id):
        return
    if supplied_price is not None and list_price is not None and supplied_price != list_price:
        raise ValidationFailed(f"Line {i}: changing the list price needs the price-override permission.", code="price_override_denied")
    if product is None:
        return
    ceil = discount_ceiling(product, account)
    if ceil is not None and disc > ceil:
        raise ValidationFailed(f"Line {i}: discount {disc}% exceeds the {ceil}% limit for this product or customer.", code="discount_limit_exceeded")
    prof = getattr(product, "sales_profile", None)
    if prof is None:
        return
    rate = org.get_rate(currency, on_date)
    base_net = net * rate
    if prof.min_price is not None and base_net < prof.min_price:
        raise ValidationFailed(f"Line {i}: price is below the minimum selling price.", code="below_minimum_price")
    if prof.min_margin_percent is not None:
        cost = im.ProductCost.objects.filter(product=product).first()
        if cost and cost.quantity > 0:
            avg = cost.total_value / cost.quantity
            if base_net < avg * (1 + prof.min_margin_percent / 100):
                raise ValidationFailed(f"Line {i}: price is below the minimum margin.", code="below_minimum_margin")

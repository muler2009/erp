"""Item master support: units of measure and conversions, item categories, item attribute validation."""
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction

from modules.inventory import models as m
from shared.api.errors import DomainError, ValidationFailed

ITEM_TYPES = {"RAW_MATERIAL", "FINISHED_GOOD", "CONSUMABLE", "SPARE_PART", "TOOL", "SERVICE"}
STATUSES = {"ACTIVE", "INACTIVE", "DISCONTINUED"}
STOCK_CONTROLS = {"STOCKED", "NON_STOCK", "CONSUMABLE"}
COSTING = {"AVG", "FIFO"}
_DEC = ("min_stock", "max_stock", "reorder_level", "safety_stock", "purchase_price")
_ALLOWED = {"description", "specifications", "subcategory", "item_type", "status", "stock_control", "qr_code", "min_stock", "max_stock", "reorder_level", "safety_stock", "tracks_expiry", "costing_method", "preferred_supplier_id", "purchase_price", "purchase_lead_days"}


def clean_extra(extra, *, uom, product=None):
    """Validate the optional item-master attributes; unknown keys are rejected."""
    out = {}
    for k, v in extra.items():
        if k not in _ALLOWED:
            raise ValidationFailed(f"Unknown product attribute '{k}'.", code="unknown_attribute")
        if k in _DEC and v not in (None, ""):
            try:
                v = Decimal(str(v))
            except InvalidOperation:
                raise ValidationFailed(f"{k} must be a number.", code="invalid_number")
            if v < 0:
                raise ValidationFailed(f"{k} cannot be negative.", code="invalid_number")
        elif k in _DEC:
            v = None
        if k == "qr_code" and not v:
            v = None
        out[k] = v
    for key, allowed in (("item_type", ITEM_TYPES), ("status", STATUSES), ("stock_control", STOCK_CONTROLS), ("costing_method", COSTING)):
        if key in out and out[key] not in allowed:
            raise ValidationFailed(f"Invalid {key}.", code=f"invalid_{key}")
    qr = out.get("qr_code")
    if qr and m.Product.objects.filter(qr_code=qr).exclude(pk=getattr(product, "pk", None)).exists():
        raise DomainError("This QR code is already assigned.", code="qr_taken")
    lo, hi = out.get("min_stock", getattr(product, "min_stock", None)), out.get("max_stock", getattr(product, "max_stock", None))
    if lo is not None and hi is not None and lo > hi:
        raise ValidationFailed("Minimum stock cannot exceed maximum stock.", code="invalid_levels")
    if "costing_method" in out and product is not None and out["costing_method"] != product.costing_method and product.levels.filter(quantity__gt=0).exists():
        raise DomainError("The costing method cannot change while stock is on hand.", code="costing_locked")
    if "stock_control" in out:
        out["is_stocked"] = out["stock_control"] == "STOCKED"
    return out


@transaction.atomic
def define_uom(actor_id, *, code, name):
    code = (code or "").strip()
    if not code:
        raise ValidationFailed("A unit code is required.", code="invalid_uom")
    obj, _ = m.UnitOfMeasure.objects.update_or_create(code=code, defaults={"name": name or code, "is_active": True})
    return obj


@transaction.atomic
def set_conversion(actor_id, *, from_uom, to_uom, factor, product_id=None):
    try:
        factor = Decimal(str(factor))
    except InvalidOperation:
        raise ValidationFailed("The factor must be a number.", code="invalid_factor")
    if factor <= 0 or from_uom == to_uom:
        raise ValidationFailed("A conversion needs two different units and a positive factor.", code="invalid_factor")
    for u in (from_uom, to_uom):
        if not m.UnitOfMeasure.objects.filter(code=u, is_active=True).exists():
            raise ValidationFailed(f"Unknown unit '{u}'.", code="unknown_uom")
    if product_id:
        product = m.Product.objects.filter(pk=product_id).first()
        if not product:
            raise DomainError("Product not found.", code="not_found", status_code=404)
    else:
        product = None
    row = m.UomConversion.objects.filter(product=product, from_uom=from_uom, to_uom=to_uom).first()
    if row:
        row.factor = factor
        row.save(update_fields=["factor"])
    else:
        row = m.UomConversion.objects.create(product=product, from_uom=from_uom, to_uom=to_uom, factor=factor)
    return row


def convert(quantity, from_uom, to_uom, *, product_id=None):
    """Convert a quantity between units (direct, inverse, or via the product-specific row first)."""
    q = Decimal(str(quantity))
    if from_uom == to_uom:
        return q
    for pid in ([product_id] if product_id else []) + [None]:
        r = m.UomConversion.objects.filter(product_id=pid, from_uom=from_uom, to_uom=to_uom).first()
        if r:
            return q * r.factor
        r = m.UomConversion.objects.filter(product_id=pid, from_uom=to_uom, to_uom=from_uom).first()
        if r:
            return q / r.factor
    raise DomainError(f"No conversion between {from_uom} and {to_uom}.", code="no_conversion")


@transaction.atomic
def save_category(actor_id, *, code, name, parent_id=None, category_id=None):
    parent = None
    if parent_id:
        parent = m.ItemCategory.objects.filter(pk=parent_id).first()
        if not parent:
            raise DomainError("Parent category not found.", code="not_found", status_code=404)
    if category_id:
        c = m.ItemCategory.objects.filter(pk=category_id).first()
        if not c:
            raise DomainError("Category not found.", code="not_found", status_code=404)
        p = parent
        while p:
            if p.pk == c.pk:
                raise ValidationFailed("A category cannot sit under itself.", code="category_cycle")
            p = p.parent
        c.name, c.parent = name, parent
        c.save()
        return c
    try:
        return m.ItemCategory.objects.create(code=code, name=name, parent=parent)
    except IntegrityError:
        raise DomainError("A category with this code already exists.", code="code_taken")

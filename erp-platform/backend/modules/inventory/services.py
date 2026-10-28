"""Inventory services: transactional stock movements with weighted-average valuation and GL integration.
Quantities are never overwritten; every change is an immutable StockMovement plus balances updated under
row locks in the same transaction (and guarded by a non-negative CHECK constraint)."""
import uuid
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.utils import timezone

from modules.finance import services as finance
from modules.inventory import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.tenancy import current_tenant

ZERO = Decimal("0")


def _dec(value, field="quantity"):
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValidationFailed(f"{field} must be a decimal number.", code="invalid_amount")


def _q(value, decimals=4):
    return Decimal(value).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def _get(model, pk, label):
    obj = model.objects.filter(pk=pk).first()
    if obj is None:
        raise DomainError(f"{label} not found.", code="not_found", status_code=404)
    return obj


# ----------------------------------------------------------------------------- master data
@transaction.atomic
def create_product(actor_id, *, sku, name, uom="unit", barcode=None, category="", tracking="NONE", is_stocked=True, variant_of_id=None, attributes=None):
    sku = sku.strip()
    if not sku or m.Product.objects.filter(sku=sku).exists():
        raise DomainError("A product with this SKU already exists.", code="sku_taken")
    if barcode and m.Product.objects.filter(barcode=barcode).exists():
        raise DomainError("This barcode is already assigned.", code="barcode_taken")
    if tracking not in m.Product.Tracking.values:
        raise ValidationFailed("Invalid tracking mode.", code="invalid_tracking")
    parent = _get(m.Product, variant_of_id, "Parent product") if variant_of_id else None
    if parent and parent.variant_of_id:
        raise ValidationFailed("Variants cannot have variants.", code="invalid_variant")
    product = m.Product.objects.create(sku=sku, name=name, uom=uom, barcode=barcode or None, category=category, tracking=tracking, is_stocked=is_stocked, variant_of=parent, attributes=attributes or {})
    record_tenant_event(current_tenant(), "inventory.product.created", actor_user_id=actor_id, target_type="Product", target_id=product.id, metadata={"sku": sku})
    return product


@transaction.atomic
def update_product(actor_id, product_id, *, name=None, barcode=None, category=None, is_active=None):
    p = m.Product.objects.select_for_update().filter(pk=product_id).first() or _get(m.Product, product_id, "Product")
    if name is not None:
        p.name = name
    if category is not None:
        p.category = category
    if barcode is not None:
        if barcode and m.Product.objects.filter(barcode=barcode).exclude(pk=p.pk).exists():
            raise DomainError("This barcode is already assigned.", code="barcode_taken")
        p.barcode = barcode or None
    if is_active is False and p.levels.filter(quantity__gt=0).exists():
        raise DomainError("A product with stock on hand cannot be deactivated.", code="stock_on_hand")
    if is_active is not None:
        p.is_active = is_active
    p.save()
    return p


@transaction.atomic
def create_warehouse(actor_id, *, code, name):
    if m.Warehouse.objects.filter(code=code).exists():
        raise DomainError("A warehouse with this code already exists.", code="code_taken")
    return m.Warehouse.objects.create(code=code, name=name)


@transaction.atomic
def create_location(actor_id, *, warehouse_id, code, name=""):
    wh = _get(m.Warehouse, warehouse_id, "Warehouse")
    if m.Location.objects.filter(warehouse=wh, code=code).exists():
        raise DomainError("A location with this code already exists in the warehouse.", code="code_taken")
    return m.Location.objects.create(warehouse=wh, code=code, name=name)


@transaction.atomic
def set_reorder_rule(actor_id, *, product_id, warehouse_id, min_quantity, reorder_quantity):
    product, wh = _get(m.Product, product_id, "Product"), _get(m.Warehouse, warehouse_id, "Warehouse")
    mn, rq = _dec(min_quantity, "min_quantity"), _dec(reorder_quantity, "reorder_quantity")
    if mn < 0 or rq <= 0:
        raise ValidationFailed("min_quantity must be >= 0 and reorder_quantity > 0.", code="invalid_amount")
    rule, _ = m.ReorderRule.objects.update_or_create(product=product, warehouse=wh, defaults={"min_quantity": mn, "reorder_quantity": rq})
    return rule


# ----------------------------------------------------------------------------- movement core
def _product(product_id):
    p = m.Product.objects.filter(pk=product_id).first()
    if p is None or not p.is_active:
        raise DomainError("Product not found or inactive.", code="not_found", status_code=404)
    if not p.is_stocked:
        raise ValidationFailed("This product is not stocked.", code="not_stocked")
    return p


def _location(location_id):
    loc = m.Location.objects.select_related("warehouse").filter(pk=location_id).first()
    if loc is None or not loc.is_active or not loc.warehouse.is_active:
        raise DomainError("Location not found or inactive.", code="not_found", status_code=404)
    return loc


def _lot(product, lot_code, expiry=None, create=False):
    if product.tracking == "LOT":
        if not lot_code:
            raise ValidationFailed("This product is lot-tracked: a lot code is required.", code="lot_required")
        lot = m.Lot.objects.filter(product=product, code=lot_code).first()
        if lot is None:
            if not create:
                raise DomainError("Unknown lot for this product.", code="lot_not_found", status_code=404)
            lot = m.Lot.objects.create(product=product, code=lot_code, expiry_date=expiry)
        return lot
    if lot_code:
        raise ValidationFailed("This product is not lot-tracked.", code="lot_not_allowed")
    return None


def _cost_row(product):
    try:
        with transaction.atomic():
            m.ProductCost.objects.get_or_create(product=product)
    except IntegrityError:
        pass
    return m.ProductCost.objects.select_for_update().get(product=product)


def _level_row(product, location, lot):
    filt = dict(product=product, location=location, lot=lot)
    try:
        with transaction.atomic():
            m.StockLevel.objects.get_or_create(**filt)
    except IntegrityError:
        pass
    return m.StockLevel.objects.select_for_update().get(**filt)


def _move(actor_id, product, location, lot, mtype, signed_qty, unit_cost, *, ref_type="", ref_id="", reason="", group_id=None, journal_id=None):
    return m.StockMovement.objects.create(product=product, location=location, lot=lot, movement_type=mtype, quantity=signed_qty, unit_cost=unit_cost, ref_type=ref_type, ref_id=str(ref_id), reason=reason[:300], group_id=group_id, journal_entry_id=journal_id, created_by=actor_id)


def _take(cost, qty):
    """Value of `qty` leaving stock at weighted-average cost; keeps the cost row consistent (no drift)."""
    if qty > cost.quantity:
        raise DomainError("Insufficient stock.", code="insufficient_stock")
    value = cost.total_value if qty == cost.quantity else _q(qty * cost.total_value / cost.quantity)
    cost.quantity -= qty
    cost.total_value -= value
    cost.save(update_fields=["quantity", "total_value"])
    return value


def _decimals():
    return finance.base_currency().decimals


@transaction.atomic
def receive_stock(actor_id, *, product_id, location_id, quantity, unit_cost, lot_code=None, expiry_date=None, ref_type="", ref_id="", reason="", counter="inventory_adjustment", on_date=None):
    """Put stock in at a known base-currency unit cost. `counter` is the GL system account credited
    (`grni` for purchase receipts; `inventory_adjustment` for opening balances / manual receipts)."""
    qty, cost_each = _dec(quantity), _dec(unit_cost, "unit_cost")
    if qty <= 0 or cost_each < 0:
        raise ValidationFailed("quantity must be positive and unit_cost non-negative.", code="invalid_amount")
    product, loc = _product(product_id), _location(location_id)
    lot = _lot(product, lot_code, expiry_date, create=True)
    on_date = on_date or timezone.now().date()
    cost = _cost_row(product)
    level = _level_row(product, loc, lot)
    value = _q(qty * cost_each, _decimals())
    level.quantity += qty
    level.save(update_fields=["quantity", "updated_at"])
    cost.quantity += qty
    cost.total_value += value
    cost.save(update_fields=["quantity", "total_value"])
    entry = finance.post_system_journal(actor_id, on_date, f"Stock receipt {product.sku}", "inventory", f"{ref_type}:{ref_id}", [("inventory", "debit", value), (counter, "credit", value)])
    return _move(actor_id, product, loc, lot, "RECEIPT", qty, cost_each, ref_type=ref_type, ref_id=ref_id, reason=reason, journal_id=entry.id if entry else None)


@transaction.atomic
def issue_stock(actor_id, *, product_id, location_id, quantity, lot_code=None, reason="", ref_type="", ref_id="", on_date=None):
    qty = _dec(quantity)
    if qty <= 0:
        raise ValidationFailed("quantity must be positive.", code="invalid_amount")
    product, loc = _product(product_id), _location(location_id)
    lot = _lot(product, lot_code)
    cost = _cost_row(product)
    level = _level_row(product, loc, lot)
    if level.quantity < qty:
        raise DomainError(f"Insufficient stock at this location (on hand {level.quantity}).", code="insufficient_stock")
    value = _take(cost, qty)
    level.quantity -= qty
    level.save(update_fields=["quantity", "updated_at"])
    entry = finance.post_system_journal(actor_id, on_date or timezone.now().date(), f"Stock issue {product.sku}", "inventory", f"{ref_type}:{ref_id}", [("cogs", "debit", value), ("inventory", "credit", value)])
    return _move(actor_id, product, loc, lot, "ISSUE", -qty, _q(value / qty), ref_type=ref_type, ref_id=ref_id, reason=reason, journal_id=entry.id if entry else None)


@transaction.atomic
def transfer_stock(actor_id, *, product_id, from_location_id, to_location_id, quantity, lot_code=None, reason=""):
    qty = _dec(quantity)
    if qty <= 0 or str(from_location_id) == str(to_location_id):
        raise ValidationFailed("Transfer needs a positive quantity and two different locations.", code="invalid_transfer")
    product, src, dst = _product(product_id), _location(from_location_id), _location(to_location_id)
    lot = _lot(product, lot_code)
    cost = _cost_row(product)
    # lock both level rows in a stable order so two opposite transfers cannot deadlock
    for loc in sorted([src, dst], key=lambda l: str(l.id)):
        _level_row(product, loc, lot)
    src_level = m.StockLevel.objects.select_for_update().get(product=product, location=src, lot=lot)
    dst_level = m.StockLevel.objects.select_for_update().get(product=product, location=dst, lot=lot)
    if src_level.quantity < qty:
        raise DomainError(f"Insufficient stock at the source location (on hand {src_level.quantity}).", code="insufficient_stock")
    src_level.quantity -= qty
    dst_level.quantity += qty
    src_level.save(update_fields=["quantity", "updated_at"])
    dst_level.save(update_fields=["quantity", "updated_at"])
    avg = cost.average
    gid = uuid.uuid4()
    _move(actor_id, product, src, lot, "TRANSFER_OUT", -qty, avg, reason=reason, group_id=gid)
    return _move(actor_id, product, dst, lot, "TRANSFER_IN", qty, avg, reason=reason, group_id=gid)


@transaction.atomic
def adjust_stock(actor_id, *, product_id, location_id, delta=None, counted_quantity=None, lot_code=None, unit_cost=None, reason, on_date=None):
    """Manual correction. Pass `delta`, or `counted_quantity` (cycle count: adjusts to the counted figure)."""
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required for stock adjustments.", code="reason_required")
    if (delta is None) == (counted_quantity is None):
        raise ValidationFailed("Provide exactly one of delta or counted_quantity.", code="invalid_amount")
    product, loc = _product(product_id), _location(location_id)
    lot = _lot(product, lot_code, create=True)
    cost = _cost_row(product)
    level = _level_row(product, loc, lot)
    change = _dec(delta, "delta") if delta is not None else _dec(counted_quantity, "counted_quantity") - level.quantity
    if counted_quantity is not None and _dec(counted_quantity, "counted_quantity") < 0:
        raise ValidationFailed("counted_quantity cannot be negative.", code="invalid_amount")
    if change == 0:
        raise DomainError("The counted quantity equals the system quantity; nothing to adjust.", code="no_difference")
    on_date = on_date or timezone.now().date()
    if change > 0:
        each = _dec(unit_cost, "unit_cost") if unit_cost is not None else cost.average
        value = _q(change * each, _decimals())
        level.quantity += change
        cost.quantity += change
        cost.total_value += value
        legs = [("inventory", "debit", value), ("inventory_adjustment", "credit", value)]
    else:
        if level.quantity < -change:
            raise DomainError(f"Insufficient stock at this location (on hand {level.quantity}).", code="insufficient_stock")
        value = _take(cost, -change)
        level.quantity += change
        each = _q(value / -change)
        legs = [("inventory_adjustment", "debit", value), ("inventory", "credit", value)]
    level.save(update_fields=["quantity", "updated_at"])
    if change > 0:
        cost.save(update_fields=["quantity", "total_value"])
    entry = finance.post_system_journal(actor_id, on_date, f"Stock adjustment {product.sku}: {reason}", "inventory", f"adjust:{product.sku}", legs)
    mv = _move(actor_id, product, loc, lot, "ADJUSTMENT", change, each, reason=reason, journal_id=entry.id if entry else None)
    record_tenant_event(current_tenant(), "inventory.stock.adjusted", actor_user_id=actor_id, target_type="Product", target_id=product.id, metadata={"delta": str(change), "reason": reason[:200], "location": loc.code})
    events.emit("inventory.stock.adjusted", {"product_id": str(product.id), "location_id": str(loc.id), "delta": str(change)})
    return mv


# ----------------------------------------------------------------------------- reads
def on_hand(product_id, location_id=None, warehouse_id=None):
    qs = m.StockLevel.objects.filter(product_id=product_id)
    if location_id:
        qs = qs.filter(location_id=location_id)
    if warehouse_id:
        qs = qs.filter(location__warehouse_id=warehouse_id)
    return qs.aggregate(q=Sum("quantity"))["q"] or ZERO


def valuation():
    rows, total = [], ZERO
    for c in m.ProductCost.objects.select_related("product").filter(quantity__gt=0).order_by("product__sku"):
        rows.append({"sku": c.product.sku, "name": c.product.name, "quantity": str(c.quantity), "average_cost": str(_q(c.average)), "value": str(c.total_value)})
        total += c.total_value
    return {"rows": rows, "total_value": str(total)}


def reorder_report():
    out = []
    for r in m.ReorderRule.objects.select_related("product", "warehouse"):
        have = on_hand(r.product_id, warehouse_id=r.warehouse_id)
        if have < r.min_quantity:
            out.append({"sku": r.product.sku, "warehouse": r.warehouse.code, "on_hand": str(have), "min_quantity": str(r.min_quantity), "suggested_order_quantity": str(r.reorder_quantity)})
    return out

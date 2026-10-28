"""Inventory & warehouse (module 7). Stock is a ledger of immutable movements; StockLevel/ProductCost are
derived balances maintained under row locks in the same transaction as the movement that changes them."""
import uuid

from django.db import models
from django.db.models import F, Q
from django.utils import timezone

QTY = dict(max_digits=18, decimal_places=4)
MONEY = dict(max_digits=20, decimal_places=4)


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Product(Base):
    class Tracking(models.TextChoices):
        NONE = "NONE"
        LOT = "LOT"

    sku = models.CharField(max_length=60, unique=True)
    name = models.CharField(max_length=200)
    uom = models.CharField(max_length=20, default="unit")
    barcode = models.CharField(max_length=64, null=True, blank=True, unique=True)
    category = models.CharField(max_length=80, blank=True)
    tracking = models.CharField(max_length=4, choices=Tracking.choices, default=Tracking.NONE)
    is_stocked = models.BooleanField(default=True)  # services/non-stock items never create stock
    variant_of = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="variants")
    attributes = models.JSONField(default=dict, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=~Q(variant_of=F("id")), name="product_not_own_variant")]


class Warehouse(Base):
    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=120)
    is_active = models.BooleanField(default=True)


class Location(Base):
    warehouse = models.ForeignKey(Warehouse, on_delete=models.PROTECT, related_name="locations")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=120, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["warehouse", "code"], name="location_code_per_warehouse")]


class Lot(Base):
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="lots")
    code = models.CharField(max_length=60)
    expiry_date = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["product", "code"], name="lot_code_per_product")]


class StockLevel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="levels")
    location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="levels")
    lot = models.ForeignKey(Lot, null=True, blank=True, on_delete=models.PROTECT, related_name="levels")
    quantity = models.DecimalField(default=0, **QTY)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["product", "location", "lot"], condition=Q(lot__isnull=False), name="level_unique_with_lot"),
            models.UniqueConstraint(fields=["product", "location"], condition=Q(lot__isnull=True), name="level_unique_no_lot"),
            models.CheckConstraint(condition=Q(quantity__gte=0), name="stock_never_negative"),
        ]


class ProductCost(models.Model):
    """Weighted-average valuation per product (all locations)."""

    product = models.OneToOneField(Product, primary_key=True, on_delete=models.PROTECT, related_name="cost")
    quantity = models.DecimalField(default=0, **QTY)
    total_value = models.DecimalField(default=0, **MONEY)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gte=0, total_value__gte=0), name="cost_non_negative")]

    @property
    def average(self):
        return (self.total_value / self.quantity) if self.quantity else 0


class StockMovement(models.Model):
    """Append-only (database trigger). Signed quantity: positive = into the location."""

    class Type(models.TextChoices):
        RECEIPT = "RECEIPT"
        ISSUE = "ISSUE"
        TRANSFER_OUT = "TRANSFER_OUT"
        TRANSFER_IN = "TRANSFER_IN"
        ADJUSTMENT = "ADJUSTMENT"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="movements")
    location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="movements")
    lot = models.ForeignKey(Lot, null=True, blank=True, on_delete=models.PROTECT, related_name="movements")
    movement_type = models.CharField(max_length=12, choices=Type.choices)
    quantity = models.DecimalField(**QTY)
    unit_cost = models.DecimalField(**MONEY)
    ref_type = models.CharField(max_length=40, blank=True)
    ref_id = models.CharField(max_length=64, blank=True)
    group_id = models.UUIDField(null=True, blank=True)  # ties the two legs of a transfer together
    reason = models.CharField(max_length=300, blank=True)
    journal_entry_id = models.UUIDField(null=True, blank=True)
    created_by = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=~Q(quantity=0), name="movement_nonzero")]
        indexes = [models.Index(fields=["product", "created_at"], name="movement_product_time_idx"), models.Index(fields=["ref_type", "ref_id"], name="movement_ref_idx")]
        ordering = ["created_at", "id"]


class ReorderRule(Base):
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="reorder_rules")
    warehouse = models.ForeignKey(Warehouse, on_delete=models.CASCADE, related_name="+")
    min_quantity = models.DecimalField(**QTY)
    reorder_quantity = models.DecimalField(**QTY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["product", "warehouse"], name="reorder_rule_uniq"), models.CheckConstraint(condition=Q(min_quantity__gte=0, reorder_quantity__gt=0), name="reorder_rule_positive")]

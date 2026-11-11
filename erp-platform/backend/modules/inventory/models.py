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
        SERIAL = "SERIAL"

    sku = models.CharField(max_length=60, unique=True)
    name = models.CharField(max_length=200)
    uom = models.CharField(max_length=20, default="unit")
    barcode = models.CharField(max_length=64, null=True, blank=True, unique=True)
    category = models.CharField(max_length=80, blank=True)
    tracking = models.CharField(max_length=6, choices=Tracking.choices, default=Tracking.NONE)
    is_stocked = models.BooleanField(default=True)  # services/non-stock items never create stock
    variant_of = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="variants")
    attributes = models.JSONField(default=dict, blank=True)
    is_active = models.BooleanField(default=True)  # False only for INACTIVE; a DISCONTINUED item may still be issued until stock runs out
    description = models.TextField(blank=True)
    specifications = models.TextField(blank=True)
    subcategory = models.CharField(max_length=80, blank=True)
    item_type = models.CharField(max_length=14, default="FINISHED_GOOD")  # RAW_MATERIAL / FINISHED_GOOD / CONSUMABLE / SPARE_PART / TOOL / SERVICE
    status = models.CharField(max_length=12, default="ACTIVE", db_index=True)  # ACTIVE / INACTIVE / DISCONTINUED
    stock_control = models.CharField(max_length=10, default="STOCKED")  # STOCKED / NON_STOCK / CONSUMABLE
    qr_code = models.CharField(max_length=64, null=True, blank=True, unique=True)
    min_stock = models.DecimalField(null=True, blank=True, max_digits=18, decimal_places=4)
    max_stock = models.DecimalField(null=True, blank=True, max_digits=18, decimal_places=4)
    reorder_level = models.DecimalField(null=True, blank=True, max_digits=18, decimal_places=4)
    safety_stock = models.DecimalField(null=True, blank=True, max_digits=18, decimal_places=4)
    tracks_expiry = models.BooleanField(default=False)
    costing_method = models.CharField(max_length=4, default="AVG")  # AVG (weighted average) / FIFO
    preferred_supplier_id = models.UUIDField(null=True, blank=True)  # procurement.Supplier (no cross-module FK)
    purchase_price = models.DecimalField(null=True, blank=True, max_digits=20, decimal_places=4)  # standard purchase price, base currency
    purchase_lead_days = models.PositiveSmallIntegerField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=~Q(variant_of=F("id")), name="product_not_own_variant")]


class Warehouse(Base):
    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=120)
    is_active = models.BooleanField(default=True)
    warehouse_type = models.CharField(max_length=12, default="MAIN")  # MAIN / BRANCH / TRANSIT / QUARANTINE / VIRTUAL
    branch_id = models.UUIDField(null=True, blank=True)  # organizations.Branch (no cross-module FK)
    manager_id = models.UUIDField(null=True, blank=True)  # user responsible for the warehouse
    address = models.TextField(blank=True)
    policies = models.JSONField(default=dict, blank=True)  # e.g. {"picking": "FEFO", "allow_partial_issue": true}


class Location(Base):
    warehouse = models.ForeignKey(Warehouse, on_delete=models.PROTECT, related_name="locations")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=120, blank=True)
    is_active = models.BooleanField(default=True)
    kind = models.CharField(max_length=10, default="STORAGE")  # STORAGE / QUARANTINE / RESTRICTED / TRANSIT
    zone = models.CharField(max_length=30, blank=True)
    aisle = models.CharField(max_length=30, blank=True)
    rack = models.CharField(max_length=30, blank=True)
    shelf = models.CharField(max_length=30, blank=True)
    bin = models.CharField(max_length=30, blank=True)
    capacity = models.DecimalField(null=True, blank=True, max_digits=18, decimal_places=4)  # max units held; null = unlimited
    is_blocked = models.BooleanField(default=False)  # blocked locations cannot be issued or transferred from

    class Meta:
        constraints = [models.UniqueConstraint(fields=["warehouse", "code"], name="location_code_per_warehouse")]


class Lot(Base):
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="lots")
    code = models.CharField(max_length=60)
    expiry_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=12, default="AVAILABLE", db_index=True)  # AVAILABLE / QUARANTINED / BLOCKED / RECALLED
    manufacture_date = models.DateField(null=True, blank=True)
    supplier_id = models.UUIDField(null=True, blank=True)
    status_note = models.CharField(max_length=300, blank=True)

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


class UnitOfMeasure(models.Model):
    code = models.CharField(max_length=20, primary_key=True)
    name = models.CharField(max_length=60)
    is_active = models.BooleanField(default=True)


class UomConversion(models.Model):
    """1 `from_uom` = `factor` `to_uom`.  A row with a product overrides the generic one (e.g. 1 box = 12 units for that item only)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product = models.ForeignKey(Product, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    from_uom = models.CharField(max_length=20)
    to_uom = models.CharField(max_length=20)
    factor = models.DecimalField(max_digits=20, decimal_places=8)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["product", "from_uom", "to_uom"], name="uom_conv_uniq"), models.UniqueConstraint(fields=["from_uom", "to_uom"], condition=Q(product__isnull=True), name="uom_conv_generic_uniq"), models.CheckConstraint(condition=Q(factor__gt=0), name="uom_factor_positive")]


class ItemCategory(Base):
    code = models.CharField(max_length=40, unique=True)
    name = models.CharField(max_length=120)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    is_active = models.BooleanField(default=True)


class StockReservation(Base):
    """A soft hold on available stock (project, maintenance job, internal use...). Sales orders keep their own OrderReservation."""
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="reservations")
    warehouse = models.ForeignKey(Warehouse, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(**QTY)
    status = models.CharField(max_length=10, default="ACTIVE", db_index=True)  # ACTIVE / RELEASED / CONSUMED / EXPIRED
    ref_type = models.CharField(max_length=40, blank=True)
    ref_id = models.CharField(max_length=64, blank=True)
    note = models.CharField(max_length=300, blank=True)
    expires_on = models.DateField(null=True, blank=True)
    reserved_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="stock_reservation_positive")]
        indexes = [models.Index(fields=["product", "status"], name="stockres_product_status")]


class TransferOrder(Base):
    """Warehouse-to-warehouse transfer: request -> approve -> dispatch (stock goes in transit) -> receive (possibly in parts)."""
    number = models.CharField(max_length=30, unique=True)
    from_warehouse = models.ForeignKey(Warehouse, on_delete=models.PROTECT, related_name="+")
    to_warehouse = models.ForeignKey(Warehouse, on_delete=models.PROTECT, related_name="+")
    status = models.CharField(max_length=18, default="DRAFT", db_index=True)  # DRAFT/REQUESTED/APPROVED/REJECTED/IN_TRANSIT/PARTIALLY_RECEIVED/RECEIVED/CANCELLED
    reason = models.CharField(max_length=300, blank=True)
    expected_date = models.DateField(null=True, blank=True)
    requested_by = models.UUIDField(null=True, blank=True)
    approved_by = models.UUIDField(null=True, blank=True)
    dispatched_at = models.DateTimeField(null=True, blank=True)
    carrier = models.CharField(max_length=120, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=~Q(from_warehouse=F("to_warehouse")), name="transfer_distinct_warehouses")]


class TransferLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(TransferOrder, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="+")
    from_location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="+")
    lot_code = models.CharField(max_length=60, blank=True)
    quantity = models.DecimalField(**QTY)
    dispatched_quantity = models.DecimalField(default=0, **QTY)
    received_quantity = models.DecimalField(default=0, **QTY)
    rejected_quantity = models.DecimalField(default=0, **QTY)  # refused at destination, returned to the source location
    damaged_quantity = models.DecimalField(default=0, **QTY)  # received damaged, moved to the destination quarantine location

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="transfer_line_positive")]


class MaterialRequisition(Base):
    """Internal request for materials from a warehouse (department, project, cost centre, equipment or production use)."""
    number = models.CharField(max_length=30, unique=True)
    requester_id = models.UUIDField()
    department_id = models.UUIDField(null=True, blank=True)
    destination_type = models.CharField(max_length=12, default="DEPARTMENT")  # DEPARTMENT / PROJECT / COST_CENTER / EQUIPMENT / PRODUCTION
    destination_ref = models.CharField(max_length=80, blank=True)
    warehouse = models.ForeignKey(Warehouse, on_delete=models.PROTECT, related_name="+")
    purpose = models.CharField(max_length=300, blank=True)
    needed_by = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=16, default="DRAFT", db_index=True)  # DRAFT/SUBMITTED/APPROVED/REJECTED/PARTIALLY_ISSUED/ISSUED/CANCELLED/CLOSED
    approved_by = models.UUIDField(null=True, blank=True)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)


class MaterialRequisitionLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    requisition = models.ForeignKey(MaterialRequisition, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(**QTY)
    issued_quantity = models.DecimalField(default=0, **QTY)
    returned_quantity = models.DecimalField(default=0, **QTY)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0, issued_quantity__gte=0, returned_quantity__gte=0), name="matreq_line_quantities")]


class IssueVoucher(Base):
    number = models.CharField(max_length=30, unique=True)
    requisition = models.ForeignKey(MaterialRequisition, on_delete=models.PROTECT, related_name="vouchers")
    issued_by = models.UUIDField(null=True, blank=True)
    received_by = models.CharField(max_length=120, blank=True)  # person who collected the goods
    notes = models.CharField(max_length=300, blank=True)


class IssueVoucherLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    voucher = models.ForeignKey(IssueVoucher, on_delete=models.CASCADE, related_name="lines")
    requisition_line = models.ForeignKey(MaterialRequisitionLine, on_delete=models.PROTECT, related_name="voucher_lines")
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="+")
    location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="+")
    lot_code = models.CharField(max_length=60, blank=True)
    quantity = models.DecimalField(**QTY)
    unit_cost = models.DecimalField(**MONEY)
    returned_quantity = models.DecimalField(default=0, **QTY)


class InventorySetting(models.Model):
    key = models.CharField(max_length=60, primary_key=True)
    value = models.JSONField(default=dict)


class AdjustmentRequest(Base):
    """A stock adjustment above the approval threshold waits here until someone other than the requester approves it."""
    number = models.CharField(max_length=30, unique=True)
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="+")
    location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="+")
    lot_code = models.CharField(max_length=60, blank=True)
    delta = models.DecimalField(**QTY)
    unit_cost = models.DecimalField(null=True, blank=True, **MONEY)
    estimated_value = models.DecimalField(**MONEY)
    reason_code = models.CharField(max_length=12, default="OTHER")  # DAMAGE / LOSS / THEFT / FOUND / EXPIRY / COUNT / OTHER
    reason = models.CharField(max_length=300)
    status = models.CharField(max_length=10, default="PENDING", db_index=True)  # PENDING / POSTED / REJECTED
    requested_by = models.UUIDField(null=True, blank=True)
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    movement_id = models.UUIDField(null=True, blank=True)


class StockCount(Base):
    """A stocktaking session (cycle count or full count) over a warehouse, optionally freezing movements at the counted locations."""
    number = models.CharField(max_length=30, unique=True)
    warehouse = models.ForeignKey(Warehouse, on_delete=models.PROTECT, related_name="+")
    kind = models.CharField(max_length=6, default="CYCLE")  # CYCLE / FULL
    status = models.CharField(max_length=12, default="DRAFT", db_index=True)  # DRAFT / IN_PROGRESS / SUBMITTED / APPROVED / CANCELLED
    freeze = models.BooleanField(default=False)
    planned_date = models.DateField(null=True, blank=True)
    created_by = models.UUIDField(null=True, blank=True)
    approved_by = models.UUIDField(null=True, blank=True)
    note = models.CharField(max_length=300, blank=True)
    scope = models.JSONField(default=dict, blank=True)  # {"locations": [...], "products": [...]}


class StockCountLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    count = models.ForeignKey(StockCount, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="+")
    location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="+")
    lot_code = models.CharField(max_length=60, blank=True)
    system_quantity = models.DecimalField(**QTY)
    counted_quantity = models.DecimalField(null=True, blank=True, **QTY)
    assigned_to = models.UUIDField(null=True, blank=True)
    counted_by = models.UUIDField(null=True, blank=True)
    recount = models.BooleanField(default=False)
    note = models.CharField(max_length=300, blank=True)
    variance_value = models.DecimalField(null=True, blank=True, **MONEY)  # set when posted

    class Meta:
        indexes = [models.Index(fields=["location"], name="countline_location")]


class CostLayer(models.Model):
    """FIFO layer: one per receipt (or positive adjustment) of a FIFO-costed product. remaining_value carries landed-cost uplifts."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="cost_layers")
    movement_id = models.UUIDField(null=True, blank=True, db_index=True)
    received_at = models.DateTimeField(default=timezone.now, db_index=True)
    quantity = models.DecimalField(**QTY)
    remaining = models.DecimalField(**QTY)
    remaining_value = models.DecimalField(**MONEY)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(remaining__gte=0, remaining_value__gte=0), name="cost_layer_non_negative")]
        indexes = [models.Index(fields=["product", "received_at"], name="costlayer_fifo")]


class LandedCost(Base):
    """Freight, duty, insurance etc. spread over the items of a goods receipt. Posts Dr Inventory / Dr COGS (the part already sold) / Cr Landed Costs Payable."""
    number = models.CharField(max_length=30, unique=True)
    ref_type = models.CharField(max_length=40)
    ref_id = models.CharField(max_length=64)
    description = models.CharField(max_length=200)
    amount = models.DecimalField(**MONEY)
    basis = models.CharField(max_length=8, default="VALUE")  # QUANTITY / VALUE
    posted_on = models.DateField()
    journal_entry_id = models.UUIDField(null=True, blank=True)
    created_by = models.UUIDField(null=True, blank=True)


class LandedCostAllocation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    landed_cost = models.ForeignKey(LandedCost, on_delete=models.CASCADE, related_name="allocations")
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="+")
    movement_id = models.UUIDField()
    location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="+")
    share = models.DecimalField(**MONEY)
    to_inventory = models.DecimalField(**MONEY)
    to_cogs = models.DecimalField(**MONEY)


class SerialNumber(Base):
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="serials")
    serial = models.CharField(max_length=80)
    location = models.ForeignKey(Location, null=True, blank=True, on_delete=models.PROTECT, related_name="+")  # null once issued
    status = models.CharField(max_length=10, default="IN_STOCK", db_index=True)  # IN_STOCK / ISSUED / SCRAPPED
    received_ref = models.CharField(max_length=80, blank=True)
    issued_ref = models.CharField(max_length=80, blank=True)
    warranty_until = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["product", "serial"], name="serial_unique_per_product")]

"""Manufacturing & production (module 9). Product references point at inventory.Product; costs are posted
through finance system accounts (wip, production_absorbed, production_variance, scrap_loss)."""
import uuid

from django.db import models
from django.db.models import F, Q
from django.utils import timezone

QTY = dict(max_digits=18, decimal_places=4)
MONEY = dict(max_digits=20, decimal_places=4)

ORDER_STATUSES = ("DRAFT", "RELEASED", "IN_PROGRESS", "COMPLETED", "CLOSED", "CANCELLED")


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class ProductionLine(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=120)
    facility = models.CharField(max_length=120, blank=True)
    is_active = models.BooleanField(default=True)


class ItemProfile(models.Model):
    """How a product is sourced; drives MRP (purchased and subcontracted items are bought even if a BOM exists)."""
    product = models.OneToOneField("inventory.Product", primary_key=True, on_delete=models.CASCADE, related_name="+")
    supply_type = models.CharField(max_length=13, default="MANUFACTURED")  # MANUFACTURED / SUBCONTRACTED / PURCHASED
    drawing_ref = models.CharField(max_length=200, blank=True)
    method = models.TextField(blank=True)  # manufacturing method / production requirements


class WorkCenter(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=120)
    capacity_hours_per_day = models.DecimalField(max_digits=6, decimal_places=2, default=8)
    labor_rate = models.DecimalField(default=0, **MONEY)      # per hour
    machine_rate = models.DecimalField(default=0, **MONEY)    # per hour
    overhead_rate = models.DecimalField(default=0, **MONEY)   # per hour
    efficiency_percent = models.DecimalField(max_digits=5, decimal_places=2, default=100)
    is_active = models.BooleanField(default=True)
    line = models.ForeignKey("ProductionLine", null=True, blank=True, on_delete=models.PROTECT, related_name="work_centers")
    asset_id = models.UUIDField(null=True, blank=True)  # assets.Asset: the machine behind this work center
    working_days = models.JSONField(default=list, blank=True)  # weekday numbers (Mon=0); empty = Monday-Friday

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(capacity_hours_per_day__gt=0, labor_rate__gte=0, machine_rate__gte=0, overhead_rate__gte=0, efficiency_percent__gt=0), name="mfg_wc_positive")]

    @property
    def hourly_cost(self):
        return self.labor_rate + self.machine_rate + self.overhead_rate


class Bom(Base):
    """A versioned product structure. Exactly one ACTIVE version per product; approved versions are frozen."""
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    version = models.PositiveIntegerField(default=1)
    name = models.CharField(max_length=200, blank=True)
    quantity = models.DecimalField(default=1, **QTY)  # output quantity the lines and routing are stated for
    status = models.CharField(max_length=10, default="DRAFT", db_index=True)  # DRAFT / ACTIVE / ARCHIVED
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    effective_from = models.DateField(null=True, blank=True)
    effective_to = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["product", "version"], name="mfg_bom_version_uniq"),
            models.UniqueConstraint(fields=["product"], condition=Q(status="ACTIVE"), name="mfg_bom_one_active"),
            models.CheckConstraint(condition=Q(quantity__gt=0), name="mfg_bom_qty_positive"),
        ]


class BomLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bom = models.ForeignKey(Bom, on_delete=models.CASCADE, related_name="lines")
    component = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(**QTY)
    scrap_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["bom", "component"], name="mfg_bomline_uniq"),
            models.CheckConstraint(condition=Q(quantity__gt=0, scrap_percent__gte=0, scrap_percent__lt=100), name="mfg_bomline_positive"),
        ]


class BomSubstitute(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    line = models.ForeignKey(BomLine, on_delete=models.CASCADE, related_name="substitutes")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    ratio = models.DecimalField(default=1, max_digits=10, decimal_places=4)  # units of the original this substitute replaces per unit used

    class Meta:
        constraints = [models.UniqueConstraint(fields=["line", "product"], name="mfg_subst_uniq"), models.CheckConstraint(condition=Q(ratio__gt=0), name="mfg_subst_ratio")]


class BomByproduct(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bom = models.ForeignKey(Bom, on_delete=models.CASCADE, related_name="byproducts")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(**QTY)  # expected per BOM output quantity


class RoutingStep(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bom = models.ForeignKey(Bom, on_delete=models.CASCADE, related_name="steps")
    sequence = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=120)
    work_center = models.ForeignKey(WorkCenter, on_delete=models.PROTECT, related_name="+")
    setup_hours = models.DecimalField(max_digits=8, decimal_places=2, default=0)
    run_hours = models.DecimalField(max_digits=8, decimal_places=4, default=0)  # for the BOM output quantity
    required_skill = models.CharField(max_length=120, blank=True)
    tools = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["bom", "sequence"], name="mfg_step_seq_uniq"),
            models.CheckConstraint(condition=Q(setup_hours__gte=0, run_hours__gte=0), name="mfg_step_positive"),
        ]


class BomCheck(models.Model):
    """A quality check the BOM requires; copied onto every production order released from it."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bom = models.ForeignKey(Bom, on_delete=models.CASCADE, related_name="checks")
    name = models.CharField(max_length=160)
    step_sequence = models.PositiveSmallIntegerField(null=True, blank=True)  # null = final inspection
    specification = models.CharField(max_length=300, blank=True)
    lower_limit = models.DecimalField(null=True, blank=True, max_digits=18, decimal_places=6)
    upper_limit = models.DecimalField(null=True, blank=True, max_digits=18, decimal_places=6)


class ProductionOrder(Base):
    number = models.CharField(max_length=30, unique=True)
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    bom = models.ForeignKey(Bom, on_delete=models.PROTECT, related_name="orders")  # rework orders reference the original BOM
    quantity = models.DecimalField(**QTY)
    status = models.CharField(max_length=12, default="DRAFT", db_index=True)
    location = models.ForeignKey("inventory.Location", on_delete=models.PROTECT, related_name="+")  # components drawn from / goods delivered to
    planned_start = models.DateField()
    planned_end = models.DateField()
    sales_order_id = models.UUIDField(null=True, blank=True)
    parent_order = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    standard_unit_cost = models.DecimalField(default=0, **MONEY)
    produced_quantity = models.DecimalField(default=0, **QTY)
    scrapped_quantity = models.DecimalField(default=0, **QTY)
    material_cost = models.DecimalField(default=0, **MONEY)
    conversion_cost = models.DecimalField(default=0, **MONEY)
    received_value = models.DecimalField(default=0, **MONEY)
    scrap_cost = models.DecimalField(default=0, **MONEY)
    variance = models.DecimalField(default=0, **MONEY)
    created_by = models.UUIDField()
    released_by = models.UUIDField(null=True, blank=True)
    closed_by = models.UUIDField(null=True, blank=True)
    actual_start = models.DateField(null=True, blank=True)
    actual_end = models.DateField(null=True, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)
    priority = models.PositiveSmallIntegerField(default=3)  # 1 (urgent) .. 5 (low)
    approved_by = models.UUIDField(null=True, blank=True)
    hold_reason = models.CharField(max_length=300, blank=True)
    prior_status = models.CharField(max_length=12, blank=True)
    instructions = models.TextField(blank=True)
    rework_of = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="rework_orders")
    rework_receipt_id = models.UUIDField(null=True, blank=True)
    std_material_unit = models.DecimalField(default=0, **MONEY)
    std_conversion_unit = models.DecimalField(default=0, **MONEY)
    plan_line_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0, produced_quantity__gte=0, scrapped_quantity__gte=0), name="mfg_order_qty"),
            models.CheckConstraint(condition=Q(planned_end__gte=F("planned_start")), name="mfg_order_dates"),
        ]


class OrderComponent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(ProductionOrder, on_delete=models.CASCADE, related_name="components")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    required_quantity = models.DecimalField(**QTY)
    issued_quantity = models.DecimalField(default=0, **QTY)
    returned_quantity = models.DecimalField(default=0, **QTY)
    issued_cost = models.DecimalField(default=0, **MONEY)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["order", "product"], name="mfg_comp_uniq"),
            models.CheckConstraint(condition=Q(required_quantity__gt=0, issued_quantity__gte=0, returned_quantity__gte=0, returned_quantity__lte=F("issued_quantity")), name="mfg_comp_qty"),
        ]

    @property
    def net_issued(self):
        return self.issued_quantity - self.returned_quantity


class Operation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(ProductionOrder, on_delete=models.CASCADE, related_name="operations")
    sequence = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=120)
    work_center = models.ForeignKey(WorkCenter, on_delete=models.PROTECT, related_name="+")
    planned_hours = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    actual_hours = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    status = models.CharField(max_length=12, default="PENDING")  # PENDING / IN_PROGRESS / DONE
    planned_start = models.DateField(null=True, blank=True)
    planned_end = models.DateField(null=True, blank=True)
    absorbed_cost = models.DecimalField(default=0, **MONEY)
    completed_by = models.UUIDField(null=True, blank=True)
    labor_cost = models.DecimalField(default=0, **MONEY)
    machine_cost = models.DecimalField(default=0, **MONEY)
    overhead_cost = models.DecimalField(default=0, **MONEY)
    operator_id = models.UUIDField(null=True, blank=True)
    supervisor_id = models.UUIDField(null=True, blank=True)
    is_paused = models.BooleanField(default=False)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    good_quantity = models.DecimalField(default=0, **QTY)
    defective_quantity = models.DecimalField(default=0, **QTY)
    rework_quantity = models.DecimalField(default=0, **QTY)
    approved_by = models.UUIDField(null=True, blank=True)
    notes = models.CharField(max_length=500, blank=True)
    required_skill = models.CharField(max_length=120, blank=True)
    tools = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["order", "sequence"], name="mfg_op_seq_uniq"), models.CheckConstraint(condition=Q(planned_hours__gte=0, actual_hours__gte=0), name="mfg_op_hours")]


class ProductionReceipt(Base):
    order = models.ForeignKey(ProductionOrder, on_delete=models.CASCADE, related_name="receipts")
    quantity = models.DecimalField(**QTY)
    unit_cost = models.DecimalField(**MONEY)
    lot_code = models.CharField(max_length=60, blank=True)
    received_by = models.UUIDField()
    stock_movement_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=10, default="ACCEPTED")  # ACCEPTED / ON_HOLD / RELEASED / SCRAPPED / REWORK
    location = models.ForeignKey("inventory.Location", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    disposition_by = models.UUIDField(null=True, blank=True)
    disposition_note = models.CharField(max_length=300, blank=True)


class ScrapRecord(Base):
    order = models.ForeignKey(ProductionOrder, on_delete=models.CASCADE, related_name="scraps")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    kind = models.CharField(max_length=10)  # OUTPUT (finished/semi-finished units) / MATERIAL
    quantity = models.DecimalField(**QTY)
    cost = models.DecimalField(default=0, **MONEY)
    reason = models.CharField(max_length=300)
    reported_by = models.UUIDField()


class QualityCheck(Base):
    order = models.ForeignKey(ProductionOrder, on_delete=models.CASCADE, related_name="checks")
    name = models.CharField(max_length=160)
    step_sequence = models.PositiveSmallIntegerField(null=True, blank=True)
    specification = models.CharField(max_length=300, blank=True)
    lower_limit = models.DecimalField(null=True, blank=True, max_digits=18, decimal_places=6)
    upper_limit = models.DecimalField(null=True, blank=True, max_digits=18, decimal_places=6)
    result = models.CharField(max_length=12, default="PENDING")  # PENDING / PASS / FAIL / CONDITIONAL
    measured = models.CharField(max_length=120, blank=True)
    note = models.CharField(max_length=300, blank=True)
    checked_by = models.UUIDField(null=True, blank=True)
    checked_at = models.DateTimeField(null=True, blank=True)


class Consumption(models.Model):
    """Append-only record of every material issue/return against an order, so actual consumption never overwrites the plan."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(ProductionOrder, on_delete=models.CASCADE, related_name="consumptions")
    component = models.ForeignKey(OrderComponent, null=True, blank=True, on_delete=models.PROTECT, related_name="+")  # null = additional usage
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")  # what was actually used
    kind = models.CharField(max_length=10)  # ISSUE / RETURN / SUBSTITUTE / ADDITIONAL
    quantity = models.DecimalField(**QTY)
    cost = models.DecimalField(**MONEY)
    lot_code = models.CharField(max_length=60, blank=True)
    stock_movement_id = models.UUIDField(null=True, blank=True)
    recorded_by = models.UUIDField()
    recorded_at = models.DateTimeField(default=timezone.now)


class Interruption(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    operation = models.ForeignKey(Operation, on_delete=models.CASCADE, related_name="interruptions")
    reason = models.CharField(max_length=300)
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)


class ByproductRecord(Base):
    order = models.ForeignKey(ProductionOrder, on_delete=models.CASCADE, related_name="byproducts")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    kind = models.CharField(max_length=10, default="BYPRODUCT")  # BYPRODUCT / RECOVERED
    quantity = models.DecimalField(**QTY)
    unit_cost = models.DecimalField(**MONEY)
    decision = models.CharField(max_length=10, default="REUSE")  # REUSE / RECYCLE / DISPOSE (documented intent; stock is received for REUSE/RECYCLE)
    recorded_by = models.UUIDField()


class Downtime(Base):
    work_center = models.ForeignKey(WorkCenter, on_delete=models.PROTECT, related_name="downtimes")
    category = models.CharField(max_length=12)  # BREAKDOWN / MAINTENANCE / SETUP / NO_MATERIAL / NO_OPERATOR / OTHER
    reason = models.CharField(max_length=300)
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)
    order = models.ForeignKey(ProductionOrder, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    breakdown_id = models.UUIDField(null=True, blank=True)  # assets.Breakdown raised for it
    reported_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(ended_at__isnull=True) | Q(ended_at__gte=F("started_at")), name="mfg_downtime_range")]

    @property
    def minutes(self):
        end = self.ended_at or timezone.now()
        return int((end - self.started_at).total_seconds() // 60)


class ProductionPlan(Base):
    number = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=200)
    period_start = models.DateField()
    period_end = models.DateField()
    status = models.CharField(max_length=10, default="DRAFT", db_index=True)  # DRAFT / APPROVED / RELEASED / CANCELLED
    revision = models.PositiveIntegerField(default=1)
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(period_end__gte=F("period_start")), name="mfg_plan_period")]


class PlanLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    plan = models.ForeignKey(ProductionPlan, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(**QTY)
    required_date = models.DateField()
    priority = models.PositiveSmallIntegerField(default=3)
    sales_order_id = models.UUIDField(null=True, blank=True)
    order = models.ForeignKey(ProductionOrder, null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="mfg_planline_qty")]


class PlanRevision(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    plan = models.ForeignKey(ProductionPlan, on_delete=models.CASCADE, related_name="revisions")
    revision = models.PositiveIntegerField()
    changed_by = models.UUIDField()
    changed_at = models.DateTimeField(default=timezone.now)
    reason = models.CharField(max_length=300)
    snapshot = models.JSONField(default=list)  # the lines as they stood before the change

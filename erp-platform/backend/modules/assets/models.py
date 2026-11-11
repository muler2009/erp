import uuid

from django.db import models
from django.db.models import Q
from django.utils import timezone

MONEY = dict(max_digits=20, decimal_places=4)
QTY = dict(max_digits=18, decimal_places=4)

ASSET_CLASSES = ("FIXED", "MOVABLE", "EQUIPMENT", "VEHICLE", "FURNITURE", "IT", "TOOL", "MACHINERY")
STATUSES = ("REQUESTED", "ORDERED", "RECEIVED", "AVAILABLE", "ASSIGNED", "IN_USE", "UNDER_MAINTENANCE", "TRANSFERRED", "DISPOSED", "RETIRED")


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class AssetCategory(Base):
    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=120)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    prefix = models.CharField(max_length=10)  # asset numbers are PREFIX-000001
    next_seq = models.PositiveIntegerField(default=1)
    asset_class = models.CharField(max_length=10, default="EQUIPMENT")
    purpose = models.CharField(max_length=120, blank=True)
    operational_function = models.CharField(max_length=120, blank=True)
    capitalization_threshold = models.DecimalField(default=0, **MONEY)  # cost at or above this is capitalized into the fixed asset register
    depreciation_method = models.CharField(max_length=3, default="SL")  # SL straight-line / RB reducing-balance / NON
    useful_life_months = models.PositiveIntegerField(default=60)
    residual_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    reducing_rate_percent = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)  # annual rate for reducing balance
    tracking = models.CharField(max_length=8, default="BARCODE")  # NONE / BARCODE / QR / RFID
    requires_serial = models.BooleanField(default=False)
    requires_insurance = models.BooleanField(default=False)
    maintenance_interval_days = models.PositiveIntegerField(null=True, blank=True)
    inspection_interval_days = models.PositiveIntegerField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(residual_percent__gte=0, residual_percent__lte=100), name="asset_category_residual_pct")]


class AssetLocation(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=120)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    branch_id = models.UUIDField(null=True, blank=True)
    address = models.CharField(max_length=300, blank=True)
    is_active = models.BooleanField(default=True)


class Asset(Base):
    number = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    category = models.ForeignKey(AssetCategory, on_delete=models.PROTECT, related_name="assets")
    asset_class = models.CharField(max_length=10)
    status = models.CharField(max_length=18, default="REQUESTED", db_index=True)
    manufacturer = models.CharField(max_length=120, blank=True)
    model = models.CharField(max_length=120, blank=True)
    serial_number = models.CharField(max_length=120, blank=True)
    supplier_id = models.UUIDField(null=True, blank=True)
    acquisition_date = models.DateField(null=True, blank=True)
    purchase_cost = models.DecimalField(default=0, **MONEY)
    currency = models.CharField(max_length=3, blank=True)
    location = models.ForeignKey(AssetLocation, null=True, blank=True, on_delete=models.PROTECT, related_name="assets")
    legal_entity_id = models.UUIDField(null=True, blank=True)  # owning legal entity
    department_id = models.UUIDField(null=True, blank=True)
    custodian_id = models.UUIDField(null=True, blank=True)  # employee holding the asset
    responsible_id = models.UUIDField(null=True, blank=True)  # employee accountable for it
    barcode = models.CharField(max_length=64, blank=True)
    qr_code = models.CharField(max_length=120, blank=True)
    rfid_tag = models.CharField(max_length=64, blank=True)
    condition = models.CharField(max_length=8, default="GOOD")  # NEW / GOOD / FAIR / POOR / DAMAGED
    is_capitalized = models.BooleanField(default=False)
    capitalized_cost = models.DecimalField(default=0, **MONEY)  # asset currency: purchase cost + capitalizable costs + later improvements
    capitalized_on = models.DateField(null=True, blank=True)
    # value register, always in base currency so it reconciles to the ledger
    gross_value = models.DecimalField(default=0, **MONEY)
    accumulated_depreciation = models.DecimalField(default=0, **MONEY)
    impairment_total = models.DecimalField(default=0, **MONEY)
    revaluation_surplus = models.DecimalField(default=0, **MONEY)
    residual_value = models.DecimalField(default=0, **MONEY)
    depreciation_method = models.CharField(max_length=3, default="NON")
    useful_life_months = models.PositiveIntegerField(default=0)
    reducing_rate_percent = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    depreciation_start = models.DateField(null=True, blank=True)
    depreciated_months = models.PositiveIntegerField(default=0)
    meter_reading = models.DecimalField(default=0, **QTY)  # operating hours or kilometres
    meter_unit = models.CharField(max_length=6, default="HOURS")  # HOURS / KM
    created_by = models.UUIDField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["barcode"], condition=~Q(barcode=""), name="asset_barcode_uniq"),
            models.UniqueConstraint(fields=["qr_code"], condition=~Q(qr_code=""), name="asset_qr_uniq"),
            models.UniqueConstraint(fields=["rfid_tag"], condition=~Q(rfid_tag=""), name="asset_rfid_uniq"),
            models.UniqueConstraint(fields=["manufacturer", "model", "serial_number"], condition=~Q(serial_number=""), name="asset_serial_uniq"),
            models.CheckConstraint(condition=Q(purchase_cost__gte=0), name="asset_cost_non_negative"),
            models.CheckConstraint(condition=Q(accumulated_depreciation__gte=0, impairment_total__gte=0, gross_value__gte=0), name="asset_values_non_negative"),
        ]
        indexes = [models.Index(fields=["category", "status"]), models.Index(fields=["location", "status"]), models.Index(fields=["custodian_id"])]


class AssetDocument(Base):
    asset = models.ForeignKey(Asset, on_delete=models.CASCADE, related_name="documents")
    doc_type = models.CharField(max_length=12)  # IMAGE / INVOICE / WARRANTY / CERTIFICATE / MANUAL / OTHER
    title = models.CharField(max_length=200)
    file_id = models.UUIDField()
    uploaded_by = models.UUIDField(null=True, blank=True)


class AssetHistory(models.Model):
    """Append-only record of everything that happens to an asset: ownership, custody, location, status and value events."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="history")
    event_type = models.CharField(max_length=40, db_index=True)
    detail = models.JSONField(default=dict)
    note = models.CharField(max_length=300, blank=True)
    actor_id = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["created_at"]

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise RuntimeError("Asset history is immutable.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise RuntimeError("Asset history is immutable.")


class AssetAcquisition(Base):
    asset = models.OneToOneField(Asset, on_delete=models.PROTECT, related_name="acquisition")
    source = models.CharField(max_length=12)  # PURCHASE / DONATION / CONSTRUCTION / TRANSFER / OPENING
    po_id = models.UUIDField(null=True, blank=True)
    goods_receipt_id = models.UUIDField(null=True, blank=True)
    invoice_id = models.UUIDField(null=True, blank=True)
    contract_id = models.UUIDField(null=True, blank=True)
    reference_note = models.CharField(max_length=300, blank=True)
    cost = models.DecimalField(**MONEY)
    delivered_on = models.DateField(null=True, blank=True)
    accepted_by = models.UUIDField(null=True, blank=True)
    accepted_on = models.DateField(null=True, blank=True)
    commissioned_on = models.DateField(null=True, blank=True)
    commissioned_by = models.UUIDField(null=True, blank=True)
    commissioning_passed = models.BooleanField(null=True)
    commissioning_notes = models.CharField(max_length=300, blank=True)
    recorded_by = models.UUIDField(null=True, blank=True)


class AcquisitionCost(Base):
    """Additional capitalizable cost (freight, installation, duties...) added to the asset's cost basis."""

    acquisition = models.ForeignKey(AssetAcquisition, on_delete=models.CASCADE, related_name="extra_costs")
    kind = models.CharField(max_length=12)  # FREIGHT / INSTALLATION / DUTY / TESTING / OTHER
    description = models.CharField(max_length=200)
    amount = models.DecimalField(**MONEY)
    invoice_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="acquisition_cost_positive")]


class CapitalizationRequest(Base):
    number = models.CharField(max_length=30, unique=True)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="capitalization_requests")
    status = models.CharField(max_length=10, default="SUBMITTED", db_index=True)  # SUBMITTED / APPROVED / REJECTED / CANCELLED
    capitalize = models.BooleanField()  # False: below threshold, registered and tracked but not capitalized
    total_cost = models.DecimalField(**MONEY)
    base_amount = models.DecimalField(default=0, **MONEY)
    capitalization_date = models.DateField()
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    journal_entry_id = models.UUIDField(null=True, blank=True)


CONDITIONS = ("NEW", "GOOD", "FAIR", "POOR", "DAMAGED")


class AssetAssignment(Base):
    number = models.CharField(max_length=30, unique=True)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="assignments")
    assignee_type = models.CharField(max_length=10)  # EMPLOYEE / DEPARTMENT / PROJECT / LOCATION
    assignee_id = models.UUIDField(null=True, blank=True)  # employee, department or location id
    assignee_ref = models.CharField(max_length=60, blank=True)  # project reference
    kind = models.CharField(max_length=10, default="PERMANENT")  # TEMPORARY / PERMANENT
    status = models.CharField(max_length=10, default="REQUESTED", db_index=True)  # REQUESTED / APPROVED / ACTIVE / RETURNED / REJECTED / CANCELLED
    assigned_on = models.DateField()
    expected_return_on = models.DateField(null=True, blank=True)
    returned_on = models.DateField(null=True, blank=True)
    purpose = models.CharField(max_length=300, blank=True)
    condition_out = models.CharField(max_length=8, blank=True)
    notes_out = models.CharField(max_length=300, blank=True)
    condition_in = models.CharField(max_length=8, blank=True)
    notes_in = models.CharField(max_length=300, blank=True)
    requested_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    handed_over_by = models.UUIDField(null=True, blank=True)
    acknowledged_by = models.UUIDField(null=True, blank=True)
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    returned_by = models.UUIDField(null=True, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["asset"], condition=Q(status__in=["REQUESTED", "APPROVED", "ACTIVE"]), name="one_open_assignment_per_asset"),
            models.CheckConstraint(condition=Q(kind="PERMANENT") | Q(expected_return_on__isnull=False), name="temporary_assignment_needs_return_date"),
        ]


class AssetTransfer(Base):
    number = models.CharField(max_length=30, unique=True)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="transfers")
    status = models.CharField(max_length=10, default="REQUESTED", db_index=True)  # REQUESTED / APPROVED / IN_TRANSIT / COMPLETED / REJECTED / CANCELLED
    reason = models.CharField(max_length=300)
    effective_date = models.DateField()
    from_location = models.ForeignKey(AssetLocation, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    from_department_id = models.UUIDField(null=True, blank=True)
    from_custodian_id = models.UUIDField(null=True, blank=True)
    to_location = models.ForeignKey(AssetLocation, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    to_department_id = models.UUIDField(null=True, blank=True)
    to_custodian_id = models.UUIDField(null=True, blank=True)
    to_project_ref = models.CharField(max_length=60, blank=True)
    condition_out = models.CharField(max_length=8, blank=True)
    condition_in = models.CharField(max_length=8, blank=True)
    notes_in = models.CharField(max_length=300, blank=True)
    requested_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    dispatched_by = models.UUIDField(null=True, blank=True)
    received_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)


class AssetValueEntry(models.Model):
    """Immutable ledger of value movements; the register's gross value, depreciation and impairment are sums of these."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="value_entries")
    entry_date = models.DateField(db_index=True)
    kind = models.CharField(max_length=24)  # CAPITALIZATION / IMPROVEMENT / REVALUATION / IMPAIRMENT / DEPRECIATION / DEPRECIATION_REVERSAL / DISPOSAL
    gross_delta = models.DecimalField(default=0, **MONEY)
    depreciation_delta = models.DecimalField(default=0, **MONEY)
    impairment_delta = models.DecimalField(default=0, **MONEY)
    surplus_delta = models.DecimalField(default=0, **MONEY)
    ref = models.CharField(max_length=60, blank=True)
    journal_entry_id = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise RuntimeError("Value entries are immutable.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise RuntimeError("Value entries are immutable.")


class ValuationAdjustment(Base):
    """Capital improvement, revaluation or impairment: requested by one person, approved by another, then posted."""

    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="adjustments")
    kind = models.CharField(max_length=12)  # IMPROVEMENT / REVALUATION / IMPAIRMENT
    status = models.CharField(max_length=10, default="REQUESTED", db_index=True)  # REQUESTED / APPROVED / REJECTED
    effective_date = models.DateField()
    amount = models.DecimalField(**MONEY)  # improvement cost, impairment amount, or the new carrying value for a revaluation
    extend_life_months = models.PositiveIntegerField(default=0)
    reason = models.CharField(max_length=300)
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    journal_entry_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gte=0), name="valuation_adjustment_non_negative")]


class DepreciationRun(Base):
    year = models.PositiveSmallIntegerField()
    month = models.PositiveSmallIntegerField()
    status = models.CharField(max_length=10, default="POSTED")  # POSTED / REVERSED
    total_amount = models.DecimalField(**MONEY)
    asset_count = models.PositiveIntegerField(default=0)
    journal_entry_id = models.UUIDField(null=True, blank=True)
    reversal_entry_id = models.UUIDField(null=True, blank=True)
    run_by = models.UUIDField(null=True, blank=True)
    reversed_by = models.UUIDField(null=True, blank=True)
    reversal_reason = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["year", "month"], condition=Q(status="POSTED"), name="one_posted_depreciation_run_per_period"),
            models.CheckConstraint(condition=Q(month__gte=1, month__lte=12), name="depreciation_run_month"),
        ]


class DepreciationLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    run = models.ForeignKey(DepreciationRun, on_delete=models.CASCADE, related_name="lines")
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="depreciation_lines")
    months = models.PositiveSmallIntegerField()
    amount = models.DecimalField(**MONEY)
    nbv_before = models.DecimalField(**MONEY)
    nbv_after = models.DecimalField(**MONEY)


class MeterReading(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="meter_readings")
    reading = models.DecimalField(**QTY)
    read_on = models.DateField()
    recorded_by = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["read_on", "created_at"]


class MaintenancePlan(Base):
    asset = models.ForeignKey(Asset, on_delete=models.CASCADE, related_name="maintenance_plans")
    name = models.CharField(max_length=160)
    kind = models.CharField(max_length=10, default="PREVENTIVE")  # PREVENTIVE / INSPECTION
    trigger = models.CharField(max_length=6, default="TIME")  # TIME / USAGE (meter based: hours or km)
    interval_days = models.PositiveIntegerField(null=True, blank=True)
    interval_usage = models.DecimalField(null=True, blank=True, **QTY)
    lead_days = models.PositiveIntegerField(default=7)
    lead_usage = models.DecimalField(default=0, **QTY)
    checklist = models.TextField(blank=True)
    estimated_cost = models.DecimalField(default=0, **MONEY)
    assigned_to_id = models.UUIDField(null=True, blank=True)  # employee
    provider_supplier_id = models.UUIDField(null=True, blank=True)  # external service provider
    last_done_on = models.DateField(null=True, blank=True)
    last_done_meter = models.DecimalField(null=True, blank=True, **QTY)
    next_due_on = models.DateField(null=True, blank=True)
    next_due_meter = models.DecimalField(null=True, blank=True, **QTY)
    is_active = models.BooleanField(default=True)


class Breakdown(Base):
    number = models.CharField(max_length=30, unique=True)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="breakdowns")
    reported_at = models.DateTimeField()
    reported_by = models.UUIDField()
    symptoms = models.TextField()
    cause = models.TextField(blank=True)
    failure_code = models.CharField(max_length=40, blank=True)
    severity = models.CharField(max_length=8, default="MEDIUM")  # LOW / MEDIUM / HIGH / CRITICAL
    status = models.CharField(max_length=10, default="REPORTED", db_index=True)  # REPORTED / DIAGNOSED / IN_REPAIR / RESTORED / CLOSED
    prior_status = models.CharField(max_length=18, blank=True)
    restored_at = models.DateTimeField(null=True, blank=True)
    downtime_hours = models.DecimalField(null=True, blank=True, **QTY)


class WorkOrder(Base):
    number = models.CharField(max_length=30, unique=True)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="work_orders")
    plan = models.ForeignKey(MaintenancePlan, null=True, blank=True, on_delete=models.SET_NULL, related_name="work_orders")
    breakdown = models.ForeignKey(Breakdown, null=True, blank=True, on_delete=models.PROTECT, related_name="work_orders")
    kind = models.CharField(max_length=10)  # PREVENTIVE / CORRECTIVE / REPAIR / INSPECTION
    status = models.CharField(max_length=18, default="OPEN", db_index=True)  # AWAITING_APPROVAL / OPEN / IN_PROGRESS / COMPLETED / VERIFIED / CANCELLED
    priority = models.CharField(max_length=8, default="MEDIUM")
    description = models.TextField()
    scheduled_on = models.DateField(null=True, blank=True)
    due_on = models.DateField(null=True, blank=True)
    assigned_to_id = models.UUIDField(null=True, blank=True)
    provider_supplier_id = models.UUIDField(null=True, blank=True)
    estimated_cost = models.DecimalField(default=0, **MONEY)
    labor_hours = models.DecimalField(default=0, **QTY)
    labor_cost = models.DecimalField(default=0, **MONEY)
    material_cost = models.DecimalField(default=0, **MONEY)
    external_cost = models.DecimalField(default=0, **MONEY)
    external_invoice_id = models.UUIDField(null=True, blank=True)
    prior_status = models.CharField(max_length=18, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_on = models.DateField(null=True, blank=True)
    completion_notes = models.TextField(blank=True)
    requested_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    completed_by = models.UUIDField(null=True, blank=True)
    verified_by = models.UUIDField(null=True, blank=True)
    verified_at = models.DateTimeField(null=True, blank=True)
    verification_notes = models.CharField(max_length=300, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)

    @property
    def total_cost(self):
        return self.labor_cost + self.material_cost + self.external_cost


class WorkOrderMaterial(Base):
    work_order = models.ForeignKey(WorkOrder, on_delete=models.CASCADE, related_name="materials")
    product_id = models.UUIDField(null=True, blank=True)  # inventory spare part
    description = models.CharField(max_length=200)
    quantity = models.DecimalField(**QTY)
    unit_cost = models.DecimalField(**MONEY)
    stock_movement_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="work_order_material_positive")]


# ----------------------------------------------------------------------------- inspections and condition (A-F)
class InspectionTemplate(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=160)
    category = models.ForeignKey(AssetCategory, null=True, blank=True, on_delete=models.PROTECT, related_name="inspection_templates")
    items = models.JSONField(default=list)  # [{"text": "...", "kind": "PASS_FAIL" | "READING"}]
    is_active = models.BooleanField(default=True)


class Inspection(Base):
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="inspections")
    template = models.ForeignKey(InspectionTemplate, null=True, blank=True, on_delete=models.PROTECT, related_name="inspections")
    status = models.CharField(max_length=10, default="SCHEDULED", db_index=True)  # SCHEDULED / COMPLETED / CANCELLED
    scheduled_on = models.DateField()
    inspector_id = models.UUIDField(null=True, blank=True)
    performed_on = models.DateField(null=True, blank=True)
    performed_by = models.UUIDField(null=True, blank=True)
    results = models.JSONField(default=list)  # [{"text", "kind", "result": "PASS"|"FAIL"|<reading>}]
    condition_result = models.CharField(max_length=8, blank=True)
    notes = models.TextField(blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)


class InspectionFinding(Base):
    inspection = models.ForeignKey(Inspection, on_delete=models.CASCADE, related_name="findings")
    description = models.TextField()
    severity = models.CharField(max_length=8, default="MEDIUM")  # LOW / MEDIUM / HIGH / CRITICAL
    status = models.CharField(max_length=10, default="OPEN", db_index=True)  # OPEN / RESOLVED
    work_order = models.ForeignKey(WorkOrder, null=True, blank=True, on_delete=models.PROTECT, related_name="findings")
    resolution_notes = models.CharField(max_length=300, blank=True)
    resolved_by = models.UUIDField(null=True, blank=True)


class InspectionEvidence(Base):
    inspection = models.ForeignKey(Inspection, on_delete=models.CASCADE, related_name="evidence")
    file_id = models.UUIDField()
    caption = models.CharField(max_length=200, blank=True)
    uploaded_by = models.UUIDField(null=True, blank=True)


# ----------------------------------------------------------------------------- warranty and insurance (A-F)
class Warranty(Base):
    asset = models.ForeignKey(Asset, on_delete=models.CASCADE, related_name="warranties")
    provider_supplier_id = models.UUIDField(null=True, blank=True)
    provider_name = models.CharField(max_length=160)
    reference = models.CharField(max_length=60, blank=True)
    start_on = models.DateField()
    end_on = models.DateField()
    coverage = models.TextField(blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(end_on__gte=models.F("start_on")), name="warranty_dates_ordered")]


class WarrantyClaim(Base):
    warranty = models.ForeignKey(Warranty, on_delete=models.PROTECT, related_name="claims")
    breakdown = models.ForeignKey(Breakdown, null=True, blank=True, on_delete=models.PROTECT, related_name="warranty_claims")
    claim_date = models.DateField()
    description = models.TextField()
    status = models.CharField(max_length=10, default="FILED", db_index=True)  # FILED / ACCEPTED / REJECTED / SETTLED
    amount_claimed = models.DecimalField(default=0, **MONEY)
    amount_recovered = models.DecimalField(default=0, **MONEY)
    provider_reference = models.CharField(max_length=60, blank=True)
    decided_by = models.UUIDField(null=True, blank=True)


class InsurancePolicy(Base):
    policy_number = models.CharField(max_length=60, unique=True)
    insurer = models.CharField(max_length=160)
    start_on = models.DateField()
    end_on = models.DateField()
    premium = models.DecimalField(default=0, **MONEY)
    coverage_amount = models.DecimalField(default=0, **MONEY)
    notes = models.TextField(blank=True)
    renewed_from = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="renewals")
    last_reminder_on = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(end_on__gte=models.F("start_on")), name="insurance_dates_ordered")]


class PolicyAsset(Base):
    policy = models.ForeignKey(InsurancePolicy, on_delete=models.CASCADE, related_name="covered")
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="policy_links")
    insured_value = models.DecimalField(default=0, **MONEY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["policy", "asset"], name="policy_asset_uniq")]


class InsuranceClaim(Base):
    policy = models.ForeignKey(InsurancePolicy, on_delete=models.PROTECT, related_name="claims")
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="insurance_claims")
    incident_date = models.DateField()
    description = models.TextField()
    amount_claimed = models.DecimalField(default=0, **MONEY)
    amount_recovered = models.DecimalField(default=0, **MONEY)
    status = models.CharField(max_length=10, default="FILED", db_index=True)  # FILED / ACCEPTED / REJECTED / SETTLED
    decided_by = models.UUIDField(null=True, blank=True)


# ----------------------------------------------------------------------------- allocation, utilization and fleet (A-G)
class AssetAllocation(Base):
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="allocations")
    target_kind = models.CharField(max_length=12)  # PROJECT / DEPARTMENT / COST_CENTER
    target_id = models.UUIDField()
    start_on = models.DateField()
    end_on = models.DateField(null=True, blank=True)
    share_percent = models.DecimalField(max_digits=5, decimal_places=2, default=100)
    status = models.CharField(max_length=8, default="ACTIVE", db_index=True)  # ACTIVE / ENDED
    notes = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(share_percent__gt=0, share_percent__lte=100), name="allocation_share_range"),
            models.CheckConstraint(condition=Q(end_on__isnull=True) | Q(end_on__gte=models.F("start_on")), name="allocation_dates_ordered"),
        ]


class UsageLog(Base):
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="usage_logs")
    allocation = models.ForeignKey(AssetAllocation, null=True, blank=True, on_delete=models.PROTECT, related_name="usage_logs")
    logged_on = models.DateField()
    hours = models.DecimalField(**QTY)
    recorded_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(hours__gt=0, hours__lte=24), name="usage_hours_range")]


class Vehicle(Base):
    asset = models.OneToOneField(Asset, on_delete=models.PROTECT, related_name="vehicle")
    plate_number = models.CharField(max_length=20, unique=True)
    vin = models.CharField(max_length=40, blank=True)
    fuel_type = models.CharField(max_length=10, default="DIESEL")  # PETROL / DIESEL / ELECTRIC / HYBRID
    registration_expiry = models.DateField(null=True, blank=True)
    driver_id = models.UUIDField(null=True, blank=True)  # employee
    driver_license_expiry = models.DateField(null=True, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)


class FuelLog(Base):
    vehicle = models.ForeignKey(Vehicle, on_delete=models.PROTECT, related_name="fuel_logs")
    filled_on = models.DateField()
    liters = models.DecimalField(**QTY)
    cost = models.DecimalField(**MONEY)
    odometer = models.DecimalField(**QTY)
    recorded_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(liters__gt=0, cost__gte=0), name="fuel_log_positive")]


class VehicleIncident(Base):
    vehicle = models.ForeignKey(Vehicle, on_delete=models.PROTECT, related_name="incidents")
    occurred_on = models.DateField()
    description = models.TextField()
    severity = models.CharField(max_length=8, default="MINOR")  # MINOR / MAJOR / TOTAL_LOSS
    driver_id = models.UUIDField(null=True, blank=True)
    damage_cost = models.DecimalField(default=0, **MONEY)
    status = models.CharField(max_length=8, default="OPEN")  # OPEN / CLOSED
    reported_by = models.UUIDField(null=True, blank=True)


# ----------------------------------------------------------------------------- physical verification and disposal (A-H)
class AssetDisposal(Base):
    number = models.CharField(max_length=30, unique=True)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="disposals")
    method = models.CharField(max_length=10)  # SALE / SCRAP / DONATION / WRITE_OFF
    status = models.CharField(max_length=10, default="REQUESTED", db_index=True)  # REQUESTED / APPROVED / REJECTED / COMPLETED / CANCELLED
    reason = models.TextField()
    proposed_on = models.DateField()
    expected_proceeds = models.DecimalField(default=0, **MONEY)
    buyer = models.CharField(max_length=160, blank=True)
    buyer_reference = models.CharField(max_length=60, blank=True)
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    executed_on = models.DateField(null=True, blank=True)
    executed_by = models.UUIDField(null=True, blank=True)
    proceeds = models.DecimalField(default=0, **MONEY)
    nbv_at_disposal = models.DecimalField(null=True, blank=True, **MONEY)
    gain_loss = models.DecimalField(null=True, blank=True, **MONEY)  # positive = gain
    journal_entry_id = models.UUIDField(null=True, blank=True)
    count_line = models.ForeignKey("CountLine", null=True, blank=True, on_delete=models.PROTECT, related_name="disposals")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["asset"], condition=Q(status__in=["REQUESTED", "APPROVED"]), name="one_open_disposal_per_asset"),
            models.CheckConstraint(condition=Q(proceeds__gte=0, expected_proceeds__gte=0), name="disposal_proceeds_non_negative"),
        ]


class VerificationCount(Base):
    number = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=160)
    scope_location = models.ForeignKey(AssetLocation, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    scope_category = models.ForeignKey(AssetCategory, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    status = models.CharField(max_length=10, default="OPEN", db_index=True)  # OPEN / IN_REVIEW / CLOSED / CANCELLED
    started_on = models.DateField()
    created_by = models.UUIDField()
    counted_by = models.UUIDField(null=True, blank=True)  # who finished the count; cannot also resolve its discrepancies
    closed_by = models.UUIDField(null=True, blank=True)


class CountLine(Base):
    count = models.ForeignKey(VerificationCount, on_delete=models.CASCADE, related_name="lines")
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="count_lines")
    expected_location_id = models.UUIDField(null=True, blank=True)
    expected_custodian_id = models.UUIDField(null=True, blank=True)
    expected = models.BooleanField(default=True)  # False = scanned although not part of the expected set
    found = models.BooleanField(null=True)  # None until scanned or the count completes
    scanned_at = models.DateTimeField(null=True, blank=True)
    scanned_by = models.UUIDField(null=True, blank=True)
    found_location_id = models.UUIDField(null=True, blank=True)
    found_condition = models.CharField(max_length=8, blank=True)
    discrepancy = models.CharField(max_length=20, blank=True)  # MISSING / FOUND_ELSEWHERE / CONDITION_CHANGED / UNEXPECTED
    resolution = models.CharField(max_length=20, blank=True)  # LOCATION_UPDATED / CONFIRMED_LOCATION / FOUND / WRITE_OFF_REQUESTED / CONDITION_UPDATED
    resolution_notes = models.CharField(max_length=300, blank=True)
    resolved_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["count", "asset"], name="count_line_asset_uniq")]


# ----------------------------------------------------------------------------- replacement planning and capex budget (A-I)
class CapexBudget(Base):
    year = models.PositiveSmallIntegerField()
    category = models.ForeignKey(AssetCategory, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    amount = models.DecimalField(**MONEY)
    status = models.CharField(max_length=10, default="PROPOSED")  # PROPOSED / APPROVED / REJECTED
    notes = models.CharField(max_length=300, blank=True)
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="capex_budget_positive"),
            models.UniqueConstraint(fields=["year", "category"], condition=Q(status__in=["PROPOSED", "APPROVED"]), name="capex_budget_year_category_uniq"),
        ]


class ReplacementItem(Base):
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="replacement_items")
    planned_year = models.PositiveSmallIntegerField()
    estimated_cost = models.DecimalField(**MONEY)
    reason = models.CharField(max_length=300)
    status = models.CharField(max_length=10, default="PLANNED")  # PLANNED / APPROVED / DONE / CANCELLED
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["asset"], condition=Q(status__in=["PLANNED", "APPROVED"]), name="one_open_replacement_per_asset")]

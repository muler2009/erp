"""Supply chain & logistics (module 8): demand forecasts, replenishment suggestions, carriers, routes, shipments with tracking,
logistics costs and delivery exceptions. Other modules are referenced by id/FK to inventory.Product only."""
import uuid

from django.db import models
from django.db.models import Q
from django.utils import timezone

QTY = dict(max_digits=18, decimal_places=4)
MONEY = dict(max_digits=20, decimal_places=4)


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Carrier(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=120)
    mode = models.CharField(max_length=8, default="ROAD")  # ROAD / AIR / SEA / RAIL / COURIER
    contact = models.CharField(max_length=200, blank=True)
    is_active = models.BooleanField(default=True)


class Route(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=120)
    origin = models.CharField(max_length=120)
    destination = models.CharField(max_length=120)
    distance_km = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    transit_days = models.PositiveSmallIntegerField(default=1)
    carrier = models.ForeignKey(Carrier, null=True, blank=True, on_delete=models.PROTECT, related_name="routes")
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(distance_km__gte=0), name="sc_route_distance")]


class Shipment(Base):
    number = models.CharField(max_length=30, unique=True)
    kind = models.CharField(max_length=8, default="OUTBOUND")  # OUTBOUND / INBOUND / TRANSFER
    status = models.CharField(max_length=10, default="PLANNED", db_index=True)  # PLANNED / DISPATCHED / IN_TRANSIT / DELIVERED / CANCELLED
    carrier = models.ForeignKey(Carrier, null=True, blank=True, on_delete=models.PROTECT, related_name="shipments")
    route = models.ForeignKey(Route, null=True, blank=True, on_delete=models.PROTECT, related_name="shipments")
    origin = models.CharField(max_length=200)
    destination = models.CharField(max_length=200)
    planned_dispatch = models.DateField()
    planned_arrival = models.DateField()
    actual_dispatch = models.DateTimeField(null=True, blank=True)
    actual_arrival = models.DateTimeField(null=True, blank=True)
    tracking_ref = models.CharField(max_length=80, blank=True)
    weight_kg = models.DecimalField(default=0, max_digits=12, decimal_places=2)
    volume_m3 = models.DecimalField(default=0, max_digits=12, decimal_places=3)
    vehicle = models.CharField(max_length=60, blank=True)
    driver = models.CharField(max_length=120, blank=True)
    sales_delivery_id = models.UUIDField(null=True, blank=True)   # sales.Delivery
    purchase_order_id = models.UUIDField(null=True, blank=True)   # procurement.PurchaseOrder
    transfer_order_id = models.UUIDField(null=True, blank=True)   # inventory.TransferOrder
    vehicle_ref = models.ForeignKey("Vehicle", null=True, blank=True, on_delete=models.PROTECT, related_name="shipments")
    consolidated_into = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="consolidated_from")
    pod_received_by = models.CharField(max_length=120, blank=True)
    pod_at = models.DateTimeField(null=True, blank=True)
    pod_note = models.CharField(max_length=300, blank=True)
    pod_file_id = models.UUIDField(null=True, blank=True)   # files.StoredFile (signed delivery note)
    created_by = models.UUIDField()
    last_reminder_on = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(planned_arrival__gte=models.F("planned_dispatch"), weight_kg__gte=0, volume_m3__gte=0), name="sc_shipment_valid")]


class ShipmentLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    shipment = models.ForeignKey(Shipment, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey("inventory.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    description = models.CharField(max_length=300)
    quantity = models.DecimalField(**QTY)
    received_quantity = models.DecimalField(null=True, blank=True, **QTY)
    damaged_quantity = models.DecimalField(default=0, **QTY)
    discrepancy_note = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="sc_shipline_positive")]


class TrackingEvent(models.Model):
    """Append-only trail of where a shipment is."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    shipment = models.ForeignKey(Shipment, on_delete=models.CASCADE, related_name="events")
    status = models.CharField(max_length=10)
    location = models.CharField(max_length=200, blank=True)
    note = models.CharField(max_length=300, blank=True)
    occurred_at = models.DateTimeField(default=timezone.now)
    recorded_by = models.UUIDField(null=True, blank=True)


class ShipmentCost(Base):
    shipment = models.ForeignKey(Shipment, on_delete=models.CASCADE, related_name="costs")
    cost_type = models.CharField(max_length=10)  # FREIGHT / FUEL / HANDLING / CUSTOMS / INSURANCE / OTHER
    amount = models.DecimalField(**MONEY)
    description = models.CharField(max_length=300, blank=True)
    journal_entry_id = models.UUIDField(null=True, blank=True)
    recorded_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="sc_cost_positive")]


class DeliveryException(Base):
    shipment = models.ForeignKey(Shipment, on_delete=models.CASCADE, related_name="exceptions")
    kind = models.CharField(max_length=10)  # DELAY / DAMAGE / LOSS / WRONG_ITEM / REFUSED / OTHER
    severity = models.CharField(max_length=8, default="MEDIUM")  # LOW / MEDIUM / HIGH / CRITICAL
    description = models.CharField(max_length=500)
    status = models.CharField(max_length=8, default="OPEN", db_index=True)  # OPEN / RESOLVED
    resolution = models.CharField(max_length=500, blank=True)
    auto_detected = models.BooleanField(default=False)
    reported_by = models.UUIDField(null=True, blank=True)
    resolved_by = models.UUIDField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)


class DemandForecast(Base):
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    period_start = models.DateField()  # first day of the month
    quantity = models.DecimalField(**QTY)
    method = models.CharField(max_length=10, default="MANUAL")  # MANUAL / HISTORY
    status = models.CharField(max_length=8, default="DRAFT")  # DRAFT / APPROVED
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["product", "period_start"], name="sc_forecast_uniq"), models.CheckConstraint(condition=Q(quantity__gte=0), name="sc_forecast_qty")]


class SupplyPlan(Base):
    """One replenishment run: its suggestions, approval and the revision history of any manual adjustment."""
    number = models.CharField(max_length=30, unique=True)
    run_id = models.UUIDField(unique=True)
    plan_date = models.DateField()
    status = models.CharField(max_length=10, default="DRAFT", db_index=True)  # DRAFT / APPROVED / SUPERSEDED
    revision = models.PositiveIntegerField(default=1)
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    balance = models.JSONField(default=dict, blank=True)  # demand vs supply snapshot at the time of the run


class PlanChange(models.Model):
    """Append-only revision history of a supply plan."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    plan = models.ForeignKey(SupplyPlan, on_delete=models.CASCADE, related_name="changes")
    revision = models.PositiveIntegerField()
    suggestion_id = models.UUIDField(null=True, blank=True)
    field = models.CharField(max_length=30)
    old_value = models.CharField(max_length=60)
    new_value = models.CharField(max_length=60)
    reason = models.CharField(max_length=300)
    changed_by = models.UUIDField()
    changed_at = models.DateTimeField(default=timezone.now)


class Demand(Base):
    """Demand captured outside the sales orders and production plans that the planner already reads live (so nothing is counted twice)."""
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("inventory.Warehouse", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    source = models.CharField(max_length=20)  # CUSTOMER_FORECAST / PROJECT / MANUFACTURING / DEPARTMENT / MANUAL
    source_ref = models.CharField(max_length=64, blank=True)
    customer = models.CharField(max_length=200, blank=True)
    kind = models.CharField(max_length=9, default="CONFIRMED")  # CONFIRMED / FORECAST
    quantity = models.DecimalField(**QTY)
    required_date = models.DateField()
    priority = models.PositiveSmallIntegerField(default=3)
    status = models.CharField(max_length=10, default="DRAFT", db_index=True)  # DRAFT / APPROVED / CANCELLED
    revision = models.PositiveIntegerField(default=1)
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    cancel_reason = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0), name="sc_demand_qty"),
            models.UniqueConstraint(fields=["source", "source_ref"], condition=~Q(source_ref="") & ~Q(status="CANCELLED"), name="sc_demand_source_uniq"),
        ]


class DemandRevision(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    demand = models.ForeignKey(Demand, on_delete=models.CASCADE, related_name="revisions")
    revision = models.PositiveIntegerField()
    old_quantity = models.DecimalField(**QTY)
    old_required_date = models.DateField()
    old_priority = models.PositiveSmallIntegerField()
    reason = models.CharField(max_length=300)
    changed_by = models.UUIDField()
    changed_at = models.DateTimeField(default=timezone.now)


class SupplyRisk(Base):
    number = models.CharField(max_length=30, unique=True)
    category = models.CharField(max_length=10)  # SUPPLIER / LOGISTICS / INVENTORY / PRODUCTION / OTHER
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    supplier_id = models.UUIDField(null=True, blank=True)
    product = models.ForeignKey("inventory.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    likelihood = models.PositiveSmallIntegerField()  # 1-5
    impact = models.PositiveSmallIntegerField()  # 1-5
    financial_impact = models.DecimalField(default=0, **MONEY)
    status = models.CharField(max_length=10, default="OPEN", db_index=True)  # OPEN / MITIGATING / ACCEPTED / CLOSED
    owner_id = models.UUIDField()
    created_by = models.UUIDField()
    last_reminder_on = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(likelihood__gte=1, likelihood__lte=5, impact__gte=1, impact__lte=5), name="sc_risk_scale")]

    @property
    def score(self):
        return self.likelihood * self.impact


class MitigationAction(Base):
    risk = models.ForeignKey(SupplyRisk, on_delete=models.CASCADE, related_name="actions")
    description = models.CharField(max_length=300)
    owner_id = models.UUIDField()
    due_date = models.DateField()
    status = models.CharField(max_length=10, default="OPEN")  # OPEN / DONE / CANCELLED
    completed_at = models.DateTimeField(null=True, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)


class Disruption(Base):
    """A supply incident and what it cost; the history is kept."""
    category = models.CharField(max_length=10)  # SUPPLIER / LOGISTICS / INVENTORY / PRODUCTION / OTHER
    title = models.CharField(max_length=200)
    cause = models.CharField(max_length=500)
    started_on = models.DateField()
    ended_on = models.DateField(null=True, blank=True)
    supplier_id = models.UUIDField(null=True, blank=True)
    product = models.ForeignKey("inventory.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    shipment = models.ForeignKey("Shipment", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    risk = models.ForeignKey(SupplyRisk, null=True, blank=True, on_delete=models.PROTECT, related_name="disruptions")
    operational_impact = models.CharField(max_length=500, blank=True)
    financial_impact = models.DecimalField(default=0, **MONEY)
    status = models.CharField(max_length=8, default="OPEN")  # OPEN / RESOLVED
    resolution = models.CharField(max_length=500, blank=True)
    reported_by = models.UUIDField()


class CriticalMaterial(models.Model):
    product = models.OneToOneField("inventory.Product", primary_key=True, on_delete=models.CASCADE, related_name="+")
    reason = models.CharField(max_length=300)
    min_sources = models.PositiveSmallIntegerField(default=2)


class AlternativeSource(Base):
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    supplier_id = models.UUIDField()
    rank = models.PositiveSmallIntegerField(default=1)
    lead_time_days = models.PositiveSmallIntegerField(default=0)
    notes = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["product", "supplier_id"], name="sc_altsource_uniq")]


class Vehicle(Base):
    code = models.CharField(max_length=30, unique=True)
    plate = models.CharField(max_length=30, blank=True)
    vehicle_type = models.CharField(max_length=40, blank=True)
    capacity_kg = models.DecimalField(default=0, max_digits=12, decimal_places=2)
    capacity_m3 = models.DecimalField(default=0, max_digits=12, decimal_places=3)
    carrier = models.ForeignKey(Carrier, null=True, blank=True, on_delete=models.PROTECT, related_name="vehicles")
    is_active = models.BooleanField(default=True)


class ReplenishmentSuggestion(Base):
    plan = models.ForeignKey(SupplyPlan, null=True, blank=True, on_delete=models.CASCADE, related_name="suggestions")
    run_id = models.UUIDField(db_index=True)
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    action = models.CharField(max_length=4)  # BUY / MAKE
    quantity = models.DecimalField(**QTY)
    need_by = models.DateField()
    start_by = models.DateField()
    lead_days = models.PositiveSmallIntegerField(default=0)
    supplier_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=10, default="OPEN", db_index=True)  # OPEN / CONVERTED / DISMISSED / SUPERSEDED
    converted_ref_type = models.CharField(max_length=40, blank=True)
    converted_ref_id = models.UUIDField(null=True, blank=True)
    decided_by = models.UUIDField(null=True, blank=True)
    note = models.CharField(max_length=300, blank=True)
    run_by = models.UUIDField()

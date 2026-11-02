"""Sales & order management (module 5). Prices, discounts, totals and approval state are always computed
on the server; nothing monetary from the client is trusted."""
import uuid

from django.db import models
from django.db.models import Q
from django.utils import timezone

MONEY = dict(max_digits=20, decimal_places=4)
QTY = dict(max_digits=18, decimal_places=4)


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class PriceList(Base):
    name = models.CharField(max_length=100)
    currency = models.CharField(max_length=3)
    valid_from = models.DateField(null=True, blank=True)
    valid_to = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    kind = models.CharField(max_length=11, default="STANDARD")  # STANDARD / PROMOTIONAL / CUSTOMER / CONTRACT
    account = models.ForeignKey("crm.CrmAccount", null=True, blank=True, on_delete=models.PROTECT, related_name="+")  # customer-specific lists


class PriceListItem(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    price_list = models.ForeignKey(PriceList, on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    min_quantity = models.DecimalField(default=1, **QTY)
    unit_price = models.DecimalField(**MONEY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["price_list", "product", "min_quantity"], name="price_item_uniq"), models.CheckConstraint(condition=Q(unit_price__gte=0, min_quantity__gt=0), name="price_item_positive")]


class LineMixin(models.Model):
    line_no = models.PositiveSmallIntegerField()
    product = models.ForeignKey("inventory.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    description = models.CharField(max_length=300)
    quantity = models.DecimalField(**QTY)
    unit_price = models.DecimalField(**MONEY)  # list / agreed price before discount
    discount_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    net_unit_price = models.DecimalField(**MONEY)  # unit_price after discount; what is invoiced
    tax_rate = models.ForeignKey("finance.TaxRate", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    line_total = models.DecimalField(**MONEY)
    tax_amount = models.DecimalField(default=0, **MONEY)

    class Meta:
        abstract = True


class Quotation(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        SENT = "SENT"
        ACCEPTED = "ACCEPTED"
        REJECTED = "REJECTED"
        CONVERTED = "CONVERTED"
        PENDING_APPROVAL = "PENDING_APPROVAL"
        EXPIRED = "EXPIRED"

    number = models.CharField(max_length=30, unique=True)
    account = models.ForeignKey("crm.CrmAccount", on_delete=models.PROTECT, related_name="quotations")
    opportunity = models.ForeignKey("crm.Opportunity", null=True, blank=True, on_delete=models.PROTECT, related_name="quotations")
    currency = models.CharField(max_length=3)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.DRAFT, db_index=True)
    valid_until = models.DateField(null=True, blank=True)
    subtotal = models.DecimalField(default=0, **MONEY)
    tax_total = models.DecimalField(default=0, **MONEY)
    total = models.DecimalField(default=0, **MONEY)
    created_by = models.UUIDField()
    version = models.PositiveIntegerField(default=1)
    payment_terms = models.CharField(max_length=200, blank=True)
    delivery_terms = models.CharField(max_length=200, blank=True)
    terms = models.TextField(blank=True)
    notes = models.TextField(blank=True)
    max_discount = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    approved_by = models.UUIDField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    expired_at = models.DateTimeField(null=True, blank=True)


class QuotationRevision(models.Model):
    """Immutable snapshot of a quotation as it was before it was changed or when it was sent."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    quotation = models.ForeignKey(Quotation, on_delete=models.CASCADE, related_name="revisions")
    version = models.PositiveIntegerField()
    event = models.CharField(max_length=20)  # EDITED / SENT / REVISED
    snapshot = models.JSONField()
    created_by = models.UUIDField(null=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)


class QuotationLine(LineMixin):
    quotation = models.ForeignKey(Quotation, on_delete=models.CASCADE, related_name="lines")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["quotation", "line_no"], name="quote_line_no_uniq")]


class SalesOrder(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        PENDING_APPROVAL = "PENDING_APPROVAL"
        CONFIRMED = "CONFIRMED"
        PARTIALLY_DELIVERED = "PARTIALLY_DELIVERED"
        DELIVERED = "DELIVERED"
        INVOICED = "INVOICED"
        CANCELLED = "CANCELLED"

    number = models.CharField(max_length=30, unique=True)
    account = models.ForeignKey("crm.CrmAccount", on_delete=models.PROTECT, related_name="orders")
    quotation = models.OneToOneField(Quotation, null=True, blank=True, on_delete=models.PROTECT, related_name="order")
    opportunity = models.ForeignKey("crm.Opportunity", null=True, blank=True, on_delete=models.PROTECT, related_name="orders")
    currency = models.CharField(max_length=3)
    order_date = models.DateField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT, db_index=True)
    subtotal = models.DecimalField(default=0, **MONEY)
    tax_total = models.DecimalField(default=0, **MONEY)
    total = models.DecimalField(default=0, **MONEY)
    max_discount = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    approval_required = models.BooleanField(default=False)
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)
    hold_reason = models.CharField(max_length=40, blank=True)
    replacement_for = models.OneToOneField("ReturnRequest", null=True, blank=True, on_delete=models.PROTECT, related_name="replacement_order")  # why approval was forced beyond discount/value limits (customer_on_hold, credit_limit_exceeded)


class SalesOrderLine(LineMixin):
    order = models.ForeignKey(SalesOrder, on_delete=models.CASCADE, related_name="lines")
    delivered_quantity = models.DecimalField(default=0, **QTY)
    returned_quantity = models.DecimalField(default=0, **QTY)
    invoiced_quantity = models.DecimalField(default=0, **QTY)
    credited_quantity = models.DecimalField(default=0, **QTY)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["order", "line_no"], name="so_line_no_uniq"),
            models.CheckConstraint(condition=Q(quantity__gt=0, delivered_quantity__gte=0, returned_quantity__gte=0, invoiced_quantity__gte=0, credited_quantity__gte=0), name="so_line_quantities_valid"),
            models.CheckConstraint(condition=Q(delivered_quantity__lte=models.F("quantity")), name="so_delivered_within_ordered"),
            models.CheckConstraint(condition=Q(returned_quantity__lte=models.F("delivered_quantity")), name="so_returned_within_delivered"),
        ]

    @property
    def net_invoiced(self):
        return self.invoiced_quantity - self.credited_quantity

    @property
    def invoiceable(self):
        return max(self.delivered_quantity - self.returned_quantity - self.net_invoiced, 0)


class Delivery(Base):
    number = models.CharField(max_length=30, unique=True)
    order = models.ForeignKey(SalesOrder, on_delete=models.PROTECT, related_name="deliveries")
    location = models.ForeignKey("inventory.Location", on_delete=models.PROTECT, related_name="+")
    delivery_date = models.DateField()
    carrier = models.CharField(max_length=80, blank=True)
    tracking_ref = models.CharField(max_length=80, blank=True)
    delivered_by = models.UUIDField()
    status = models.CharField(max_length=10, default="DISPATCHED", db_index=True)  # DISPATCHED (stock issued, in transit) / DELIVERED / FAILED
    expected_date = models.DateField(null=True, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    received_by = models.CharField(max_length=120, blank=True)
    pod_note = models.CharField(max_length=300, blank=True)
    failure_reason = models.CharField(max_length=300, blank=True)
    late_notified_at = models.DateTimeField(null=True, blank=True)


class DeliveryLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    delivery = models.ForeignKey(Delivery, on_delete=models.CASCADE, related_name="lines")
    order_line = models.ForeignKey(SalesOrderLine, on_delete=models.PROTECT, related_name="delivery_lines")
    quantity = models.DecimalField(**QTY)
    lot_code = models.CharField(max_length=60, blank=True)
    unit_cost = models.DecimalField(default=0, **MONEY)  # base-currency cost at issue, reused when goods come back
    stock_movement_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="delivery_line_positive")]


class SalesReturn(Base):
    number = models.CharField(max_length=30, unique=True)
    order = models.ForeignKey(SalesOrder, on_delete=models.PROTECT, related_name="returns")
    location = models.ForeignKey("inventory.Location", on_delete=models.PROTECT, related_name="+")
    return_date = models.DateField()
    reason = models.CharField(max_length=300)
    credit_note = models.ForeignKey("finance.Invoice", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    processed_by = models.UUIDField()


class SalesReturnLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sales_return = models.ForeignKey(SalesReturn, on_delete=models.CASCADE, related_name="lines")
    order_line = models.ForeignKey(SalesOrderLine, on_delete=models.PROTECT, related_name="return_lines")
    quantity = models.DecimalField(**QTY)
    credit_quantity = models.DecimalField(default=0, **QTY)  # part of the return that was already invoiced
    lot_code = models.CharField(max_length=60, blank=True)
    disposition = models.CharField(max_length=10, default="RESTOCK")  # RESTOCK / QUARANTINE / DISPOSE

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="return_line_positive")]


class InvoicedLine(models.Model):
    """What each draft/posted customer invoice took from which order line (released if the invoice is voided)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    invoice = models.ForeignKey("finance.Invoice", on_delete=models.PROTECT, related_name="order_lines")
    order_line = models.ForeignKey(SalesOrderLine, on_delete=models.PROTECT, related_name="invoiced_lines")
    quantity = models.DecimalField(**QTY)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="invoiced_line_positive"), models.UniqueConstraint(fields=["invoice", "order_line"], name="invoiced_line_uniq")]


# ----------------------------------------------------------------------------- catalog & pricing rules (slice F)
class ProductSales(models.Model):
    """Commercial profile of an inventory product: whether it may be sold, price floors, discount ceilings, default tax."""
    product = models.OneToOneField("inventory.Product", primary_key=True, on_delete=models.CASCADE, related_name="sales_profile")
    is_sellable = models.BooleanField(default=True)
    is_discontinued = models.BooleanField(default=False)
    description = models.TextField(blank=True)
    min_price = models.DecimalField(null=True, blank=True, **MONEY)  # floor per unit, base currency
    min_margin_percent = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)  # over average cost, base currency
    max_discount_percent = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    default_tax_rate = models.ForeignKey("finance.TaxRate", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(min_price__isnull=True) | Q(min_price__gte=0), name="sales_profile_min_price_ok"),
            models.CheckConstraint(condition=Q(max_discount_percent__isnull=True) | Q(max_discount_percent__gte=0, max_discount_percent__lte=100), name="sales_profile_max_disc_ok"),
        ]


class Bundle(Base):
    """A sellable kit: the bundle product expands into its component lines."""
    product = models.OneToOneField("inventory.Product", on_delete=models.PROTECT, related_name="bundle")
    is_active = models.BooleanField(default=True)


class BundleItem(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bundle = models.ForeignKey(Bundle, on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(**QTY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["bundle", "product"], name="bundle_item_uniq"), models.CheckConstraint(condition=Q(quantity__gt=0), name="bundle_item_qty_pos")]


class PriceChange(models.Model):
    """Append-only history of every price list entry change."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    price_list = models.ForeignKey(PriceList, on_delete=models.CASCADE, related_name="changes")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    min_quantity = models.DecimalField(**QTY)
    old_price = models.DecimalField(null=True, blank=True, **MONEY)
    new_price = models.DecimalField(null=True, blank=True, **MONEY)  # null = entry removed
    changed_by = models.UUIDField(null=True)
    changed_at = models.DateTimeField(default=timezone.now, db_index=True)


class DiscountRule(Base):
    """Maximum discount for a product category or customer classification (the lowest applicable ceiling wins)."""
    scope = models.CharField(max_length=14)  # CATEGORY / CLASSIFICATION
    key = models.CharField(max_length=80)
    max_percent = models.DecimalField(max_digits=5, decimal_places=2)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["scope", "key"], name="discount_rule_uniq"), models.CheckConstraint(condition=Q(max_percent__gte=0, max_percent__lte=100), name="discount_rule_pct_ok")]


# ----------------------------------------------------------------------------- order reservations and amendments (slice H)
class OrderReservation(models.Model):
    """Stock set aside for one order line.  Quantity never exceeds the line's open quantity; the rest is a backorder."""
    order_line = models.OneToOneField(SalesOrderLine, primary_key=True, on_delete=models.CASCADE, related_name="reservation")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(default=0, **QTY)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gte=0), name="reservation_non_negative")]


class OrderAmendment(Base):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        APPLIED = "APPLIED"
        REJECTED = "REJECTED"

    order = models.ForeignKey(SalesOrder, on_delete=models.CASCADE, related_name="amendments")
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.PENDING, db_index=True)
    reason = models.CharField(max_length=300)
    changes = models.JSONField()  # {"quantities": {line_id: qty}, "add": [raw lines]}
    total_before = models.DecimalField(**MONEY)
    total_after = models.DecimalField(null=True, blank=True, **MONEY)
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    decided_at = models.DateTimeField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    before_snapshot = models.JSONField(null=True, blank=True)


# ----------------------------------------------------------------------------- sales contracts (slice I)
class SalesContract(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        ACTIVE = "ACTIVE"
        EXPIRED = "EXPIRED"
        TERMINATED = "TERMINATED"
        RENEWED = "RENEWED"

    number = models.CharField(max_length=30, unique=True)
    account = models.ForeignKey("crm.CrmAccount", on_delete=models.PROTECT, related_name="contracts")
    title = models.CharField(max_length=200)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT, db_index=True)
    start_date = models.DateField()
    end_date = models.DateField()
    currency = models.CharField(max_length=3)
    committed_value = models.DecimalField(null=True, blank=True, **MONEY)
    payment_terms = models.CharField(max_length=200, blank=True)
    delivery_terms = models.CharField(max_length=200, blank=True)
    terms = models.TextField(blank=True)
    auto_renew = models.BooleanField(default=False)
    renewal_term_months = models.PositiveSmallIntegerField(default=12)
    renewal_notice_days = models.PositiveSmallIntegerField(default=30)
    renewal_reminded_at = models.DateTimeField(null=True, blank=True)
    price_list = models.OneToOneField(PriceList, null=True, blank=True, on_delete=models.PROTECT, related_name="contract")
    renews = models.OneToOneField("self", null=True, blank=True, on_delete=models.PROTECT, related_name="renewed_by")
    version = models.PositiveIntegerField(default=1)
    created_by = models.UUIDField()
    activated_by = models.UUIDField(null=True, blank=True)
    terminated_reason = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(end_date__gte=models.F("start_date")), name="sales_contract_dates_ordered")]


class ContractItem(models.Model):
    """Agreed price for a product under the contract; becomes a CONTRACT price list entry when the contract is activated."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    contract = models.ForeignKey(SalesContract, on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    min_quantity = models.DecimalField(default=1, **QTY)
    unit_price = models.DecimalField(**MONEY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["contract", "product", "min_quantity"], name="contract_item_uniq")]


class ContractObligation(Base):
    contract = models.ForeignKey(SalesContract, on_delete=models.CASCADE, related_name="obligations")
    description = models.CharField(max_length=300)
    due_date = models.DateField()
    party = models.CharField(max_length=10, default="US")  # US / CUSTOMER
    done_at = models.DateTimeField(null=True, blank=True)
    reminded_at = models.DateTimeField(null=True, blank=True)


class ContractRevision(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    contract = models.ForeignKey(SalesContract, on_delete=models.CASCADE, related_name="revisions")
    version = models.PositiveIntegerField()
    event = models.CharField(max_length=20)
    snapshot = models.JSONField()
    created_by = models.UUIDField(null=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)


class DeliveryDiscrepancy(Base):
    """Something wrong at hand-over: short, damaged or wrong goods.  Opens a customer service case."""
    delivery = models.ForeignKey(Delivery, on_delete=models.CASCADE, related_name="discrepancies")
    order_line = models.ForeignKey(SalesOrderLine, on_delete=models.PROTECT, related_name="+")
    kind = models.CharField(max_length=8)  # SHORT / DAMAGED / WRONG
    quantity = models.DecimalField(**QTY)
    note = models.CharField(max_length=300, blank=True)
    case_id = models.UUIDField(null=True, blank=True)
    recorded_by = models.UUIDField()


# ----------------------------------------------------------------------------- billing extras (slice K)
class OrderMilestone(Base):
    """Billing plan entry: a share of the order value invoiced on a date or event, independent of deliveries."""
    order = models.ForeignKey(SalesOrder, on_delete=models.CASCADE, related_name="milestones")
    description = models.CharField(max_length=200)
    percent = models.DecimalField(max_digits=5, decimal_places=2)
    due_date = models.DateField(null=True, blank=True)
    invoice = models.OneToOneField("finance.Invoice", null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(percent__gt=0, percent__lte=100), name="milestone_percent_ok")]


class InvoiceReminder(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    invoice = models.ForeignKey("finance.Invoice", on_delete=models.CASCADE, related_name="+")
    level = models.PositiveSmallIntegerField()
    sent_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["invoice", "level"], name="invoice_reminder_level_uniq")]


# ----------------------------------------------------------------------------- return requests (slice L)
class ReturnRequest(Base):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        APPROVED = "APPROVED"
        REJECTED = "REJECTED"
        RECEIVED = "RECEIVED"
        CANCELLED = "CANCELLED"

    number = models.CharField(max_length=30, unique=True)
    order = models.ForeignKey(SalesOrder, on_delete=models.PROTECT, related_name="return_requests")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    reason = models.CharField(max_length=300)
    reason_code = models.CharField(max_length=12, default="OTHER")  # DEFECTIVE / WRONG_ITEM / DAMAGED / NOT_NEEDED / OTHER
    wants_replacement = models.BooleanField(default=False)
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    decided_at = models.DateTimeField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    sales_return = models.OneToOneField(SalesReturn, null=True, blank=True, on_delete=models.PROTECT, related_name="request")


class ReturnRequestLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    request = models.ForeignKey(ReturnRequest, on_delete=models.CASCADE, related_name="lines")
    order_line = models.ForeignKey(SalesOrderLine, on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(**QTY)
    disposition = models.CharField(max_length=10, default="RESTOCK")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["request", "order_line"], name="return_req_line_uniq"), models.CheckConstraint(condition=Q(quantity__gt=0), name="return_req_qty_pos")]


# ----------------------------------------------------------------------------- targets and commissions (slice M)
class SalesTarget(Base):
    owner_id = models.UUIDField(db_index=True)
    period_start = models.DateField()
    period_end = models.DateField()
    amount = models.DecimalField(**MONEY)  # base currency net sales
    set_by = models.UUIDField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner_id", "period_start", "period_end"], name="sales_target_uniq"), models.CheckConstraint(condition=Q(amount__gt=0, period_end__gte=models.F("period_start")), name="sales_target_valid")]


class CommissionPlan(Base):
    name = models.CharField(max_length=100, unique=True)
    tiers = models.JSONField(default=list)  # [{"from": "0", "rate": "2"}, ...] marginal rates (percent) on net sales
    category_rates = models.JSONField(default=dict)  # {"Services": "5"} flat rate for those product categories (replaces tiers for them)
    is_active = models.BooleanField(default=True)


class PlanAssignment(models.Model):
    owner_id = models.UUIDField(primary_key=True)
    plan = models.ForeignKey(CommissionPlan, on_delete=models.PROTECT, related_name="assignments")
    assigned_by = models.UUIDField()
    updated_at = models.DateTimeField(auto_now=True)


class CommissionStatement(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        APPROVED = "APPROVED"
        TRANSFERRED = "TRANSFERRED"
        CANCELLED = "CANCELLED"

    owner_id = models.UUIDField(db_index=True)
    plan = models.ForeignKey(CommissionPlan, on_delete=models.PROTECT, related_name="+")
    period_start = models.DateField()
    period_end = models.DateField()
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.DRAFT, db_index=True)
    sales_amount = models.DecimalField(**MONEY)
    returns_amount = models.DecimalField(**MONEY)
    commission = models.DecimalField(**MONEY)
    details = models.JSONField(default=dict)
    calculated_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    payroll_input_id = models.UUIDField(null=True, blank=True)  # hr.PayrollInput created on transfer

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner_id", "period_start", "period_end"], condition=~Q(status="CANCELLED"), name="commission_period_uniq")]

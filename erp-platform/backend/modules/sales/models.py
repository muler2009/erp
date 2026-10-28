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

    number = models.CharField(max_length=30, unique=True)
    account = models.ForeignKey("crm.CrmAccount", on_delete=models.PROTECT, related_name="quotations")
    opportunity = models.ForeignKey("crm.Opportunity", null=True, blank=True, on_delete=models.PROTECT, related_name="quotations")
    currency = models.CharField(max_length=3)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT, db_index=True)
    valid_until = models.DateField(null=True, blank=True)
    subtotal = models.DecimalField(default=0, **MONEY)
    tax_total = models.DecimalField(default=0, **MONEY)
    total = models.DecimalField(default=0, **MONEY)
    created_by = models.UUIDField()
    version = models.PositiveIntegerField(default=1)


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

"""Procurement & supplier management (module 6). Depends on inventory (products, receipts) and finance
(supplier partner, invoices); neither depends back on it except through the registered finance post-check."""
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


class Supplier(Base):
    class Status(models.TextChoices):
        PROSPECT = "PROSPECT"
        QUALIFIED = "QUALIFIED"
        BLOCKED = "BLOCKED"

    name = models.CharField(max_length=200)
    tax_id = models.CharField(max_length=40, blank=True)
    email = models.CharField(max_length=200, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PROSPECT, db_index=True)
    partner = models.OneToOneField("finance.Partner", null=True, blank=True, on_delete=models.PROTECT, related_name="supplier")
    qualification_notes = models.TextField(blank=True)
    qualified_by = models.UUIDField(null=True, blank=True)
    qualified_at = models.DateTimeField(null=True, blank=True)


class SupplierEvaluation(Base):
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="evaluations")
    period = models.CharField(max_length=20)
    delivery = models.PositiveSmallIntegerField()
    quality = models.PositiveSmallIntegerField()
    price = models.PositiveSmallIntegerField()
    comment = models.CharField(max_length=500, blank=True)
    evaluated_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(delivery__gte=1, delivery__lte=5, quality__gte=1, quality__lte=5, price__gte=1, price__lte=5), name="evaluation_scores_1_5"),
                       models.UniqueConstraint(fields=["supplier", "period"], name="one_evaluation_per_period")]


class Requisition(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        SUBMITTED = "SUBMITTED"
        APPROVED = "APPROVED"
        CONVERTED = "CONVERTED"
        CANCELLED = "CANCELLED"

    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    requester_id = models.UUIDField(db_index=True)
    department_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT, db_index=True)
    needed_by = models.DateField(null=True, blank=True)
    estimated_total = models.DecimalField(default=0, **MONEY)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    approved_by = models.UUIDField(null=True, blank=True)


class RequisitionLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    requisition = models.ForeignKey(Requisition, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    product = models.ForeignKey("inventory.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    description = models.CharField(max_length=300)
    quantity = models.DecimalField(**QTY)
    estimated_unit_price = models.DecimalField(default=0, **MONEY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["requisition", "line_no"], name="req_line_no_uniq"), models.CheckConstraint(condition=Q(quantity__gt=0), name="req_line_qty_positive")]


class Rfq(Base):
    class Status(models.TextChoices):
        OPEN = "OPEN"
        AWARDED = "AWARDED"
        CANCELLED = "CANCELLED"

    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    requisition = models.ForeignKey(Requisition, null=True, blank=True, on_delete=models.PROTECT, related_name="rfqs")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.OPEN, db_index=True)
    due_date = models.DateField(null=True, blank=True)
    created_by = models.UUIDField()
    suppliers = models.ManyToManyField(Supplier, related_name="rfqs")


class RfqLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    rfq = models.ForeignKey(Rfq, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    product = models.ForeignKey("inventory.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    description = models.CharField(max_length=300)
    quantity = models.DecimalField(**QTY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["rfq", "line_no"], name="rfq_line_no_uniq")]


class Quotation(Base):
    rfq = models.ForeignKey(Rfq, on_delete=models.CASCADE, related_name="quotations")
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="quotations")
    currency = models.CharField(max_length=3)
    lead_time_days = models.PositiveSmallIntegerField(default=0)
    valid_until = models.DateField(null=True, blank=True)
    is_awarded = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["rfq", "supplier"], name="one_quotation_per_supplier")]


class QuotationLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    quotation = models.ForeignKey(Quotation, on_delete=models.CASCADE, related_name="lines")
    rfq_line = models.ForeignKey(RfqLine, on_delete=models.PROTECT, related_name="quoted")
    unit_price = models.DecimalField(**MONEY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["quotation", "rfq_line"], name="one_price_per_line"), models.CheckConstraint(condition=Q(unit_price__gte=0), name="quoted_price_non_negative")]


class PurchaseOrder(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        PENDING_APPROVAL = "PENDING_APPROVAL"
        APPROVED = "APPROVED"
        PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"
        RECEIVED = "RECEIVED"
        CANCELLED = "CANCELLED"

    number = models.CharField(max_length=30, unique=True)
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="orders")
    currency = models.CharField(max_length=3)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT, db_index=True)
    order_date = models.DateField()
    expected_date = models.DateField(null=True, blank=True)
    requisition = models.ForeignKey(Requisition, null=True, blank=True, on_delete=models.PROTECT, related_name="orders")
    quotation = models.ForeignKey(Quotation, null=True, blank=True, on_delete=models.PROTECT, related_name="orders")
    total = models.DecimalField(default=0, **MONEY)
    invoiced_value = models.DecimalField(default=0, **MONEY)
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)


class PurchaseOrderLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(PurchaseOrder, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    product = models.ForeignKey("inventory.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    description = models.CharField(max_length=300)
    quantity = models.DecimalField(**QTY)
    unit_price = models.DecimalField(**MONEY)
    received_quantity = models.DecimalField(default=0, **QTY)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["order", "line_no"], name="po_line_no_uniq"),
            models.CheckConstraint(condition=Q(quantity__gt=0, unit_price__gte=0), name="po_line_positive"),
            models.CheckConstraint(condition=Q(received_quantity__gte=0), name="po_received_non_negative"),
        ]


class GoodsReceipt(Base):
    number = models.CharField(max_length=30, unique=True)
    order = models.ForeignKey(PurchaseOrder, on_delete=models.PROTECT, related_name="receipts")
    location = models.ForeignKey("inventory.Location", on_delete=models.PROTECT, related_name="+")
    receipt_date = models.DateField()
    received_by = models.UUIDField()
    delivery_note = models.CharField(max_length=60, blank=True)


class GoodsReceiptLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    receipt = models.ForeignKey(GoodsReceipt, on_delete=models.CASCADE, related_name="lines")
    po_line = models.ForeignKey(PurchaseOrderLine, on_delete=models.PROTECT, related_name="receipt_lines")
    quantity = models.DecimalField(**QTY)
    lot_code = models.CharField(max_length=60, blank=True)
    stock_movement_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="gr_line_positive")]


class InvoiceMatch(Base):
    class Status(models.TextChoices):
        MATCHED = "MATCHED"
        EXCEPTION = "EXCEPTION"

    invoice = models.OneToOneField("finance.Invoice", on_delete=models.PROTECT, related_name="match")
    order = models.ForeignKey(PurchaseOrder, on_delete=models.PROTECT, related_name="matches")
    status = models.CharField(max_length=10, choices=Status.choices)
    goods_value = models.DecimalField(**MONEY)
    detail = models.JSONField(default=dict)
    matched_by = models.UUIDField()

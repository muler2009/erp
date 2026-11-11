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
    legal_name = models.CharField(max_length=200, blank=True)
    registration_no = models.CharField(max_length=60, blank=True)
    category = models.CharField(max_length=60, blank=True, db_index=True)
    phone = models.CharField(max_length=40, blank=True)
    website = models.CharField(max_length=200, blank=True)
    address = models.JSONField(default=dict, blank=True)  # {"street","city","region","country","postal_code"}
    payment_terms_days = models.PositiveSmallIntegerField(default=30)
    early_discount_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)  # e.g. 2 for "2/10 net 30"
    early_discount_days = models.PositiveSmallIntegerField(default=0)
    wht_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)  # withholding tax deducted from payments
    currency = models.CharField(max_length=3, blank=True)
    risk_level = models.CharField(max_length=6, default="LOW")  # LOW / MEDIUM / HIGH
    is_preferred = models.BooleanField(default=False)
    standing = models.CharField(max_length=12, default="GOOD", db_index=True)  # GOOD / SUSPENDED / BLACKLISTED
    standing_reason = models.CharField(max_length=300, blank=True)
    suspended_until = models.DateField(null=True, blank=True)


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
        PARTIALLY_ORDERED = "PARTIALLY_ORDERED"
        CONVERTED = "CONVERTED"
        CANCELLED = "CANCELLED"

    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    requester_id = models.UUIDField(db_index=True)
    department_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=17, choices=Status.choices, default=Status.DRAFT, db_index=True)
    needed_by = models.DateField(null=True, blank=True)
    estimated_total = models.DecimalField(default=0, **MONEY)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    approved_by = models.UUIDField(null=True, blank=True)
    priority = models.CharField(max_length=9, default="NORMAL")  # NORMAL / URGENT / EMERGENCY
    emergency_justification = models.CharField(max_length=500, blank=True)
    project_ref = models.CharField(max_length=60, blank=True)
    cost_center_ref = models.CharField(max_length=60, blank=True)
    procurement_type = models.CharField(max_length=8, default="GOODS")  # GOODS / SERVICES / WORKS
    source = models.CharField(max_length=10, default="MANUAL")  # MANUAL / REORDER / RECURRING
    recurring_every_days = models.PositiveSmallIntegerField(null=True, blank=True)
    next_run_on = models.DateField(null=True, blank=True)
    budget = models.ForeignKey("Budget", null=True, blank=True, on_delete=models.PROTECT, related_name="+")


class RequisitionLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    requisition = models.ForeignKey(Requisition, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    product = models.ForeignKey("inventory.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    description = models.CharField(max_length=300)
    quantity = models.DecimalField(**QTY)
    estimated_unit_price = models.DecimalField(default=0, **MONEY)
    ordered_quantity = models.DecimalField(default=0, **QTY)
    preferred_supplier_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["requisition", "line_no"], name="req_line_no_uniq"), models.CheckConstraint(condition=Q(quantity__gt=0), name="req_line_qty_positive")]


class Rfq(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        OPEN = "OPEN"
        CLOSED = "CLOSED"
        EVALUATING = "EVALUATING"
        AWARDED = "AWARDED"
        CANCELLED = "CANCELLED"

    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    requisition = models.ForeignKey(Requisition, null=True, blank=True, on_delete=models.PROTECT, related_name="rfqs")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.OPEN, db_index=True)
    due_date = models.DateField(null=True, blank=True)
    created_by = models.UUIDField()
    suppliers = models.ManyToManyField(Supplier, related_name="rfqs")
    source_requisition_ids = models.JSONField(default=list, blank=True)
    kind = models.CharField(max_length=6, default="RFQ")  # RFQ / TENDER
    closing_at = models.DateTimeField(null=True, blank=True)
    payment_terms = models.CharField(max_length=120, blank=True)
    delivery_terms = models.CharField(max_length=120, blank=True)
    terms_text = models.TextField(blank=True)
    criteria = models.JSONField(default=list, blank=True)  # [{"name","type": FINANCIAL|TECHNICAL,"weight": 0-100}] weights sum to 100
    min_technical_score = models.PositiveSmallIntegerField(null=True, blank=True)
    open_to_all = models.BooleanField(default=False)  # any qualified supplier in good standing may bid
    committee = models.JSONField(default=list, blank=True)  # user ids who evaluate / open the bids
    opened_at = models.DateTimeField(null=True, blank=True)
    opened_by = models.JSONField(default=list, blank=True)
    estimated_value = models.DecimalField(null=True, blank=True, **MONEY)
    award_justification = models.CharField(max_length=500, blank=True)


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
    submitted_at = models.DateTimeField(default=timezone.now)
    disqualified = models.BooleanField(default=False)
    disqualification_reason = models.CharField(max_length=300, blank=True)
    payment_terms = models.CharField(max_length=120, blank=True)
    delivery_terms = models.CharField(max_length=120, blank=True)

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
        CLOSED = "CLOSED"
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
    budget = models.ForeignKey("Budget", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    single_source = models.BooleanField(default=False)
    single_source_justification = models.CharField(max_length=500, blank=True)
    contract = models.ForeignKey("SupplierContract", null=True, blank=True, on_delete=models.PROTECT, related_name="orders")
    kind = models.CharField(max_length=8, default="STANDARD")  # STANDARD / BLANKET / RELEASE
    blanket = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="releases")
    valid_to = models.DateField(null=True, blank=True)  # blanket orders: last day releases may be raised
    payment_terms = models.CharField(max_length=120, blank=True)
    delivery_terms = models.CharField(max_length=120, blank=True)
    delivery_address = models.CharField(max_length=300, blank=True)
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    acknowledgment_ref = models.CharField(max_length=80, blank=True)
    acknowledgment_note = models.CharField(max_length=300, blank=True)
    promised_date = models.DateField(null=True, blank=True)
    closed_reason = models.CharField(max_length=300, blank=True)


class PurchaseOrderLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(PurchaseOrder, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    product = models.ForeignKey("inventory.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    description = models.CharField(max_length=300)
    quantity = models.DecimalField(**QTY)
    unit_price = models.DecimalField(**MONEY)
    received_quantity = models.DecimalField(default=0, **QTY)
    requisition_line = models.ForeignKey(RequisitionLine, null=True, blank=True, on_delete=models.PROTECT, related_name="po_lines")
    returned_quantity = models.DecimalField(default=0, **QTY)
    released_quantity = models.DecimalField(default=0, **QTY)  # blanket orders: quantity already drawn by releases

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
    kind = models.CharField(max_length=7, default="GOODS")  # GOODS / SERVICE
    notes = models.TextField(blank=True)


class GoodsReceiptLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    receipt = models.ForeignKey(GoodsReceipt, on_delete=models.CASCADE, related_name="lines")
    po_line = models.ForeignKey(PurchaseOrderLine, on_delete=models.PROTECT, related_name="receipt_lines")
    quantity = models.DecimalField(**QTY)
    lot_code = models.CharField(max_length=60, blank=True)
    stock_movement_id = models.UUIDField(null=True, blank=True)
    over_quantity = models.DecimalField(default=0, **QTY)
    inspection_status = models.CharField(max_length=12, default="NOT_REQUIRED")  # NOT_REQUIRED / PENDING / PARTIAL / ACCEPTED / REJECTED
    accepted_quantity = models.DecimalField(default=0, **QTY)
    rejected_quantity = models.DecimalField(default=0, **QTY)
    destination = models.ForeignKey("inventory.Location", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    quarantine_location = models.ForeignKey("inventory.Location", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    inspected_by = models.UUIDField(null=True, blank=True)
    inspected_at = models.DateTimeField(null=True, blank=True)
    inspection_note = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="gr_line_positive"), models.CheckConstraint(condition=Q(accepted_quantity__gte=0, rejected_quantity__gte=0), name="gr_line_inspection_non_negative")]


class InvoiceMatch(Base):
    class Status(models.TextChoices):
        MATCHED = "MATCHED"
        EXCEPTION = "EXCEPTION"
        OVERRIDDEN = "OVERRIDDEN"

    invoice = models.OneToOneField("finance.Invoice", on_delete=models.PROTECT, related_name="match")
    order = models.ForeignKey(PurchaseOrder, on_delete=models.PROTECT, related_name="matches")
    status = models.CharField(max_length=10, choices=Status.choices)
    goods_value = models.DecimalField(**MONEY)
    detail = models.JSONField(default=dict)
    matched_by = models.UUIDField()
    overridden_by = models.UUIDField(null=True, blank=True)
    override_reason = models.CharField(max_length=300, blank=True)


class SupplierContact(Base):
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="contacts")
    name = models.CharField(max_length=120)
    role = models.CharField(max_length=80, blank=True)
    email = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    is_primary = models.BooleanField(default=False)


class SupplierBank(Base):
    """Bank details are payment-fraud sensitive: a second person must verify them before any payment may use them."""
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="bank_accounts")
    bank_name = models.CharField(max_length=120)
    account_name = models.CharField(max_length=120)
    account_number = models.CharField(max_length=40)
    currency = models.CharField(max_length=3, blank=True)
    is_default = models.BooleanField(default=False)
    created_by = models.UUIDField(null=True, blank=True)
    verified_by = models.UUIDField(null=True, blank=True)
    verified_at = models.DateTimeField(null=True, blank=True)


class SupplierDocument(Base):
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="documents")
    doc_type = models.CharField(max_length=40)  # TAX_CERTIFICATE / LICENCE / INSURANCE / ISO_CERTIFICATE / CONTRACT / OTHER
    reference = models.CharField(max_length=80, blank=True)
    expiry_date = models.DateField(null=True, blank=True)
    file_id = models.UUIDField(null=True, blank=True)


class SupplierItem(Base):
    """Supplier catalogue entry and price history: a price change adds a row; the latest valid row is the current price."""
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="catalogue")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    supplier_sku = models.CharField(max_length=60, blank=True)
    unit_price = models.DecimalField(**MONEY)
    currency = models.CharField(max_length=3)
    min_order_quantity = models.DecimalField(default=1, **QTY)
    lead_time_days = models.PositiveSmallIntegerField(default=0)
    valid_from = models.DateField()
    valid_to = models.DateField(null=True, blank=True)
    is_preferred = models.BooleanField(default=False)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(unit_price__gte=0, min_order_quantity__gt=0), name="supplier_item_positive")]
        indexes = [models.Index(fields=["supplier", "product", "valid_from"], name="supitem_lookup")]


class Budget(Base):
    """A spending envelope for one fiscal year (optionally one department / cost centre / category). Requisitions and purchase orders
    commit against it; matched invoices are recorded as consumed."""
    code = models.CharField(max_length=40)
    name = models.CharField(max_length=160)
    fiscal_year = models.PositiveSmallIntegerField(db_index=True)
    department_id = models.UUIDField(null=True, blank=True)
    cost_center_ref = models.CharField(max_length=60, blank=True)
    category = models.CharField(max_length=60, blank=True)
    amount = models.DecimalField(**MONEY)  # base currency
    enforcement = models.CharField(max_length=5, default="BLOCK")  # BLOCK (refuse overspend) / WARN (allow and notify)
    status = models.CharField(max_length=6, default="ACTIVE")  # ACTIVE / CLOSED

    class Meta:
        constraints = [models.UniqueConstraint(fields=["code", "fiscal_year"], name="budget_code_per_year"), models.CheckConstraint(condition=Q(amount__gte=0), name="budget_non_negative")]


class BudgetRevision(Base):
    budget = models.ForeignKey(Budget, on_delete=models.CASCADE, related_name="revisions")
    old_amount = models.DecimalField(**MONEY)
    new_amount = models.DecimalField(**MONEY)
    reason = models.CharField(max_length=300)
    revised_by = models.UUIDField(null=True, blank=True)


class BudgetCommitment(Base):
    budget = models.ForeignKey(Budget, on_delete=models.PROTECT, related_name="commitments")
    ref_type = models.CharField(max_length=20)  # REQUISITION / PO
    ref_id = models.UUIDField(db_index=True)
    amount = models.DecimalField(default=0, **MONEY)  # currently committed (base currency); 0 = released
    consumed = models.DecimalField(default=0, **MONEY)  # part already invoiced

    class Meta:
        constraints = [models.UniqueConstraint(fields=["ref_type", "ref_id"], name="one_commitment_per_document"), models.CheckConstraint(condition=Q(amount__gte=0, consumed__gte=0), name="commitment_non_negative")]


class ProcurementPlan(Base):
    code = models.CharField(max_length=40)
    name = models.CharField(max_length=160)
    fiscal_year = models.PositiveSmallIntegerField()
    status = models.CharField(max_length=8, default="DRAFT")  # DRAFT / APPROVED / CLOSED
    revision = models.PositiveSmallIntegerField(default=1)
    created_by = models.UUIDField(null=True, blank=True)
    approved_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["code", "fiscal_year"], name="plan_code_per_year")]


class PlanLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    plan = models.ForeignKey(ProcurementPlan, on_delete=models.CASCADE, related_name="lines")
    category = models.CharField(max_length=60)
    description = models.CharField(max_length=300)
    department_id = models.UUIDField(null=True, blank=True)
    quarter = models.PositiveSmallIntegerField(default=1)
    planned_amount = models.DecimalField(**MONEY)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(planned_amount__gte=0, quarter__gte=1, quarter__lte=4), name="plan_line_valid")]


class PlanRevision(Base):
    plan = models.ForeignKey(ProcurementPlan, on_delete=models.CASCADE, related_name="revisions")
    revision = models.PositiveSmallIntegerField()
    reason = models.CharField(max_length=300)
    snapshot = models.JSONField(default=list)
    revised_by = models.UUIDField(null=True, blank=True)


class QuotationScore(Base):
    quotation = models.ForeignKey(Quotation, on_delete=models.CASCADE, related_name="scores")
    criterion = models.CharField(max_length=60)
    score = models.PositiveSmallIntegerField()
    scored_by = models.UUIDField()
    comment = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["quotation", "criterion", "scored_by"], name="one_score_per_evaluator"), models.CheckConstraint(condition=Q(score__lte=100), name="score_0_100")]


class RfqClarification(Base):
    rfq = models.ForeignKey(Rfq, on_delete=models.CASCADE, related_name="clarifications")
    supplier = models.ForeignKey(Supplier, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    question = models.CharField(max_length=500)
    answer = models.CharField(max_length=1000, blank=True)  # answers are visible to every invited bidder
    answered_by = models.UUIDField(null=True, blank=True)


class DeliverySchedule(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    po_line = models.ForeignKey(PurchaseOrderLine, on_delete=models.CASCADE, related_name="schedule")
    due_date = models.DateField()
    quantity = models.DecimalField(**QTY)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="schedule_qty_positive")]


class PoAmendment(Base):
    """A change to an approved purchase order: it takes effect only when someone else approves it."""
    order = models.ForeignKey(PurchaseOrder, on_delete=models.CASCADE, related_name="amendments")
    number = models.PositiveSmallIntegerField()
    changes = models.JSONField(default=dict)  # {"expected_date": "...", "lines": [{"line": id, "quantity": "..", "unit_price": ".."}]}
    reason = models.CharField(max_length=300)
    status = models.CharField(max_length=8, default="PENDING")  # PENDING / APPLIED / REJECTED
    old_total = models.DecimalField(**MONEY)
    new_total = models.DecimalField(**MONEY)
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["order", "number"], name="amendment_no_uniq")]


class SupplierContract(Base):
    number = models.CharField(max_length=30, unique=True)
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="contracts")
    title = models.CharField(max_length=200)
    status = models.CharField(max_length=10, default="DRAFT", db_index=True)  # DRAFT / ACTIVE / EXPIRED / TERMINATED
    start_date = models.DateField()
    end_date = models.DateField()
    currency = models.CharField(max_length=3)
    value_limit = models.DecimalField(null=True, blank=True, **MONEY)  # ceiling on the total ordered under the contract (contract currency)
    payment_terms = models.CharField(max_length=120, blank=True)
    terms_text = models.TextField(blank=True)
    auto_renew = models.BooleanField(default=False)
    renewal_notice_days = models.PositiveSmallIntegerField(default=60)
    created_by = models.UUIDField(null=True, blank=True)
    approved_by = models.UUIDField(null=True, blank=True)
    terminated_reason = models.CharField(max_length=300, blank=True)
    last_notice_on = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(end_date__gte=models.F("start_date")), name="supplier_contract_dates")]


class ContractPrice(Base):
    contract = models.ForeignKey(SupplierContract, on_delete=models.CASCADE, related_name="prices")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    unit_price = models.DecimalField(**MONEY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["contract", "product"], name="one_contract_price_per_product"), models.CheckConstraint(condition=Q(unit_price__gte=0), name="contract_price_non_negative")]


class SupplierReturn(Base):
    number = models.CharField(max_length=30, unique=True)
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="returns")
    order = models.ForeignKey(PurchaseOrder, on_delete=models.PROTECT, related_name="returns")
    location = models.ForeignKey("inventory.Location", on_delete=models.PROTECT, related_name="+")
    status = models.CharField(max_length=10, default="DRAFT", db_index=True)  # DRAFT / APPROVED / DISPATCHED / CREDITED / CLOSED / CANCELLED
    reason = models.CharField(max_length=300)
    return_date = models.DateField()
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    dispatched_by = models.UUIDField(null=True, blank=True)
    return_value = models.DecimalField(default=0, **MONEY)  # at PO prices, PO currency
    credit_due = models.DecimalField(default=0, **MONEY)  # part of the value that was already invoiced and must be credited
    credit_note_id = models.UUIDField(null=True, blank=True)


class SupplierReturnLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    supplier_return = models.ForeignKey(SupplierReturn, on_delete=models.CASCADE, related_name="lines")
    po_line = models.ForeignKey(PurchaseOrderLine, on_delete=models.PROTECT, related_name="return_lines")
    quantity = models.DecimalField(**QTY)
    lot_code = models.CharField(max_length=60, blank=True)
    stock_movement_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="supplier_return_line_positive")]


class SupplierClaim(Base):
    number = models.CharField(max_length=30, unique=True)
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="claims")
    order = models.ForeignKey(PurchaseOrder, null=True, blank=True, on_delete=models.PROTECT, related_name="claims")
    supplier_return = models.ForeignKey(SupplierReturn, null=True, blank=True, on_delete=models.PROTECT, related_name="claims")
    kind = models.CharField(max_length=10)  # DAMAGE / SHORTAGE / QUALITY / LATE / PRICE / OTHER
    description = models.TextField()
    currency = models.CharField(max_length=3)
    amount_claimed = models.DecimalField(**MONEY)
    amount_accepted = models.DecimalField(null=True, blank=True, **MONEY)
    status = models.CharField(max_length=10, default="OPEN", db_index=True)  # OPEN / SUBMITTED / ACCEPTED / REJECTED / SETTLED
    decision_note = models.CharField(max_length=300, blank=True)
    created_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    credit_note_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount_claimed__gt=0), name="claim_amount_positive")]


class PaymentAdjustment(Base):
    """A discount taken or tax withheld when a supplier invoice is paid; each one is backed by its own journal entry."""

    invoice = models.ForeignKey("finance.Invoice", on_delete=models.PROTECT, related_name="payment_adjustments")
    kind = models.CharField(max_length=10)  # DISCOUNT / WHT
    percent = models.DecimalField(max_digits=5, decimal_places=2)
    amount = models.DecimalField(**MONEY)  # invoice currency
    amount_base = models.DecimalField(**MONEY)
    journal_entry_id = models.UUIDField()
    adjustment_date = models.DateField()
    idempotency_key = models.CharField(max_length=80, db_index=True)
    created_by = models.UUIDField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["idempotency_key", "kind"], name="one_adjustment_kind_per_payment"), models.CheckConstraint(condition=Q(amount__gt=0), name="payment_adjustment_positive")]

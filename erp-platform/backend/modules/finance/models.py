"""Finance & Accounting (module 2). Tenant schema. All money is Decimal(20,4); journal amounts are in the
company's base currency. Posted journal entries are immutable (enforced by database triggers)."""
import uuid

from django.db import models
from django.db.models import F, Q
from django.utils import timezone

MONEY = dict(max_digits=20, decimal_places=4)


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Account(Base):
    class Type(models.TextChoices):
        ASSET = "ASSET"
        LIABILITY = "LIABILITY"
        EQUITY = "EQUITY"
        REVENUE = "REVENUE"
        EXPENSE = "EXPENSE"

    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=200)
    type = models.CharField(max_length=9, choices=Type.choices)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    is_postable = models.BooleanField(default=True)  # header accounts only group
    is_control = models.BooleanField(default=False)  # AR/AP control: written by subledger postings only
    system_key = models.CharField(max_length=30, null=True, blank=True, unique=True)
    is_active = models.BooleanField(default=True)

    @property
    def debit_normal(self):
        return self.type in (self.Type.ASSET, self.Type.EXPENSE)

    class Meta:
        ordering = ["code"]
        constraints = [models.CheckConstraint(condition=~Q(parent=F("id")), name="account_not_own_parent")]


class TaxRate(Base):
    class Kind(models.TextChoices):
        SALES = "SALES"
        PURCHASE = "PURCHASE"

    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=100)
    kind = models.CharField(max_length=8, choices=Kind.choices)
    rate = models.DecimalField(max_digits=7, decimal_places=4)  # percent, e.g. 15.0000
    account = models.ForeignKey(Account, on_delete=models.PROTECT, related_name="+")
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(rate__gte=0, rate__lte=100), name="tax_rate_percent_range")]


class Partner(Base):
    """Customer/supplier master kept minimal here; CRM (customers) and Procurement (suppliers) will own the
    full records and link by `external_ref`."""

    name = models.CharField(max_length=200)
    is_customer = models.BooleanField(default=False)
    is_supplier = models.BooleanField(default=False)
    tax_id = models.CharField(max_length=40, blank=True)
    external_ref = models.CharField(max_length=64, blank=True)
    is_active = models.BooleanField(default=True)


class BankAccount(Base):
    name = models.CharField(max_length=100)
    account_number = models.CharField(max_length=40, blank=True)
    currency = models.CharField(max_length=3)
    gl_account = models.ForeignKey(Account, on_delete=models.PROTECT, related_name="bank_accounts")
    is_cash = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)


class JournalEntry(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        POSTED = "POSTED"
        REVERSED = "REVERSED"

    number = models.CharField(max_length=30, blank=True)
    entry_date = models.DateField(db_index=True)
    period_id = models.UUIDField(null=True, blank=True)  # FiscalPeriod (same schema, kept loose across modules)
    memo = models.CharField(max_length=500, blank=True)
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.DRAFT, db_index=True)
    source_type = models.CharField(max_length=30, default="manual")  # manual | invoice | payment | reversal
    source_id = models.CharField(max_length=64, blank=True)
    created_by = models.UUIDField(null=True, blank=True)
    posted_by = models.UUIDField(null=True, blank=True)
    posted_at = models.DateTimeField(null=True, blank=True)
    reversed_by = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="reverses")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["number"], condition=~Q(number=""), name="journal_number_uniq")]
        indexes = [models.Index(fields=["status", "entry_date"], name="journal_status_date_idx")]


class JournalLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    entry = models.ForeignKey(JournalEntry, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    account = models.ForeignKey(Account, on_delete=models.PROTECT, related_name="lines")
    debit = models.DecimalField(default=0, **MONEY)
    credit = models.DecimalField(default=0, **MONEY)
    description = models.CharField(max_length=300, blank=True)
    currency = models.CharField(max_length=3, blank=True)  # document currency for reference
    amount_currency = models.DecimalField(null=True, blank=True, **MONEY)  # signed doc-currency amount (debit +)
    partner = models.ForeignKey(Partner, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    cost_center_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["entry", "line_no"], name="journal_line_no_uniq"),
            models.CheckConstraint(condition=Q(debit__gte=0, credit__gte=0), name="journal_line_non_negative"),
            models.CheckConstraint(condition=(Q(debit__gt=0, credit=0) | Q(credit__gt=0, debit=0)), name="journal_line_one_side"),
        ]
        indexes = [models.Index(fields=["account", "entry"], name="journal_line_account_idx")]


class Invoice(Base):
    class Kind(models.TextChoices):
        CUSTOMER_INVOICE = "CUSTOMER_INVOICE"
        SUPPLIER_INVOICE = "SUPPLIER_INVOICE"
        CUSTOMER_CREDIT_NOTE = "CUSTOMER_CREDIT_NOTE"
        SUPPLIER_CREDIT_NOTE = "SUPPLIER_CREDIT_NOTE"

    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        SUBMITTED = "SUBMITTED"
        APPROVED = "APPROVED"
        POSTED = "POSTED"
        PAID = "PAID"
        VOID = "VOID"

    kind = models.CharField(max_length=20, choices=Kind.choices)
    number = models.CharField(max_length=30, blank=True)
    supplier_ref = models.CharField(max_length=60, blank=True)  # the supplier's own invoice number
    partner = models.ForeignKey(Partner, on_delete=models.PROTECT, related_name="invoices")
    invoice_date = models.DateField()
    due_date = models.DateField(null=True, blank=True)
    currency = models.CharField(max_length=3)
    fx_rate = models.DecimalField(max_digits=18, decimal_places=8, null=True, blank=True)  # fixed at posting
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT, db_index=True)
    subtotal = models.DecimalField(default=0, **MONEY)
    tax_total = models.DecimalField(default=0, **MONEY)
    total = models.DecimalField(default=0, **MONEY)
    paid_amount = models.DecimalField(default=0, **MONEY)
    total_base = models.DecimalField(null=True, blank=True, **MONEY)
    credit_for = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="credit_notes")
    journal_entry = models.ForeignKey(JournalEntry, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    posted_by = models.UUIDField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["number"], condition=~Q(number=""), name="invoice_number_uniq"),
            models.CheckConstraint(condition=Q(paid_amount__gte=0, paid_amount__lte=F("total")), name="invoice_paid_within_total"),
            models.CheckConstraint(condition=Q(total__gte=0), name="invoice_total_non_negative"),
        ]
        indexes = [models.Index(fields=["kind", "status"], name="invoice_kind_status_idx")]

    @property
    def outstanding(self):
        return self.total - self.paid_amount


class InvoiceLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    invoice = models.ForeignKey(Invoice, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    description = models.CharField(max_length=300)
    quantity = models.DecimalField(max_digits=18, decimal_places=4)
    unit_price = models.DecimalField(**MONEY)
    account = models.ForeignKey(Account, on_delete=models.PROTECT, related_name="+")
    tax_rate = models.ForeignKey(TaxRate, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    line_total = models.DecimalField(**MONEY)
    tax_amount = models.DecimalField(default=0, **MONEY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["invoice", "line_no"], name="invoice_line_no_uniq"), models.CheckConstraint(condition=Q(quantity__gt=0), name="invoice_line_qty_positive")]


class Payment(Base):
    class Kind(models.TextChoices):
        RECEIPT = "RECEIPT"  # money in from a customer
        DISBURSEMENT = "DISBURSEMENT"  # money out to a supplier

    number = models.CharField(max_length=30, unique=True)
    kind = models.CharField(max_length=12, choices=Kind.choices)
    partner = models.ForeignKey(Partner, on_delete=models.PROTECT, related_name="payments")
    bank_account = models.ForeignKey(BankAccount, on_delete=models.PROTECT, related_name="payments")
    payment_date = models.DateField()
    currency = models.CharField(max_length=3)
    amount = models.DecimalField(**MONEY)
    amount_base = models.DecimalField(**MONEY)
    idempotency_key = models.CharField(max_length=80, unique=True)
    fingerprint = models.CharField(max_length=64)
    journal_entry = models.ForeignKey(JournalEntry, on_delete=models.PROTECT, related_name="+")
    released_by = models.UUIDField()
    memo = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="payment_amount_positive")]


class PaymentAllocation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    payment = models.ForeignKey(Payment, on_delete=models.CASCADE, related_name="allocations")
    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="allocations")
    amount = models.DecimalField(**MONEY)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="allocation_positive")]


class CreditSettlement(models.Model):
    """A posted credit note applied against a posted invoice of the same partner/currency (no new journal:
    both already sit on the same control account)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    credit_note = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="settlements_given")
    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="settlements_received")
    amount = models.DecimalField(**MONEY)
    created_by = models.UUIDField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="settlement_positive")]

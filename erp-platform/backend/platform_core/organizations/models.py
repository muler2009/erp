"""Organization & Administration (module 1): company structure, reference data, fiscal calendar.

Lives in each tenant schema. Users are referenced by UUID value (User is a public-schema record).
"""
import uuid

from django.db import models
from django.db.models import F, Q
from django.utils import timezone


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)
    version = models.PositiveIntegerField(default=1)  # optimistic locking (compared by the service layer)

    class Meta:
        abstract = True


class Currency(Base):
    code = models.CharField(max_length=3, unique=True)  # ISO 4217
    name = models.CharField(max_length=80)
    symbol = models.CharField(max_length=8, blank=True)
    decimals = models.PositiveSmallIntegerField(default=2)
    is_active = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(decimals__lte=4), name="currency_decimals_max_4"),
            models.CheckConstraint(condition=Q(code__regex=r"^[A-Z]{3}$"), name="currency_code_iso_format"),
        ]


class ExchangeRate(Base):
    """Units of the BASE currency per 1 unit of `currency` on `rate_date` (so base_amount = amount * rate)."""

    currency = models.ForeignKey(Currency, on_delete=models.PROTECT, related_name="rates")
    rate_date = models.DateField()
    rate = models.DecimalField(max_digits=18, decimal_places=8)
    source = models.CharField(max_length=60, blank=True)
    created_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["currency", "rate_date"], name="uniq_rate_per_day"),
            models.CheckConstraint(condition=Q(rate__gt=0), name="rate_positive"),
        ]


class Company(Base):
    """Exactly one row per tenant schema (enforced by a unique constraint on a constant)."""

    singleton = models.BooleanField(default=True, editable=False)
    legal_name = models.CharField(max_length=200)
    trade_name = models.CharField(max_length=200, blank=True)
    registration_number = models.CharField(max_length=60, blank=True)
    tax_id = models.CharField(max_length=60, blank=True)
    country = models.CharField(max_length=2, blank=True)
    address = models.TextField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    email = models.EmailField(blank=True)
    base_currency = models.ForeignKey(Currency, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    fiscal_year_start_month = models.PositiveSmallIntegerField(default=1)
    work_days = models.JSONField(default=list)  # ISO weekdays (1=Mon..7=Sun); empty = Mon-Fri applied by the service

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["singleton"], name="company_singleton"),
            models.CheckConstraint(condition=Q(fiscal_year_start_month__gte=1, fiscal_year_start_month__lte=12), name="fy_start_month_valid"),
        ]


class LegalEntity(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=200)
    registration_number = models.CharField(max_length=60, blank=True)
    tax_id = models.CharField(max_length=60, blank=True)
    country = models.CharField(max_length=2, blank=True)
    currency = models.ForeignKey(Currency, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    is_active = models.BooleanField(default=True)


class Branch(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=200)
    legal_entity = models.ForeignKey(LegalEntity, null=True, blank=True, on_delete=models.PROTECT, related_name="branches")
    address = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)


class BusinessUnit(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=200)
    head_user_id = models.UUIDField(null=True, blank=True)
    is_active = models.BooleanField(default=True)


class Department(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=200)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    business_unit = models.ForeignKey(BusinessUnit, null=True, blank=True, on_delete=models.PROTECT, related_name="departments")
    branch = models.ForeignKey(Branch, null=True, blank=True, on_delete=models.PROTECT, related_name="departments")
    head_user_id = models.UUIDField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=~Q(parent=F("id")), name="department_not_own_parent")]


class Team(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=200)
    department = models.ForeignKey(Department, on_delete=models.PROTECT, related_name="teams")
    lead_user_id = models.UUIDField(null=True, blank=True)
    is_active = models.BooleanField(default=True)


class Position(Base):
    code = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    department = models.ForeignKey(Department, null=True, blank=True, on_delete=models.PROTECT, related_name="positions")
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)


class CostCenter(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=200)
    department = models.ForeignKey(Department, null=True, blank=True, on_delete=models.PROTECT, related_name="cost_centers")
    business_unit = models.ForeignKey(BusinessUnit, null=True, blank=True, on_delete=models.PROTECT, related_name="cost_centers")
    manager_user_id = models.UUIDField(null=True, blank=True)
    is_active = models.BooleanField(default=True)


class TenantUserProfile(models.Model):
    """The user's position in THIS tenant's organization (the User itself is global, in the public schema)."""

    user_id = models.UUIDField(primary_key=True)
    department = models.ForeignKey(Department, null=True, blank=True, on_delete=models.PROTECT, related_name="members")
    team = models.ForeignKey(Team, null=True, blank=True, on_delete=models.PROTECT, related_name="members")
    position = models.ForeignKey(Position, null=True, blank=True, on_delete=models.PROTECT, related_name="holders")
    business_unit = models.ForeignKey(BusinessUnit, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    cost_center = models.ForeignKey(CostCenter, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    manager_user_id = models.UUIDField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=~Q(manager_user_id=F("user_id")), name="profile_not_own_manager")]


class FiscalYear(Base):
    name = models.CharField(max_length=40, unique=True)
    start_date = models.DateField()
    end_date = models.DateField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(end_date__gt=F("start_date")), name="fiscal_year_dates_ordered")]


class FiscalPeriod(Base):
    class Status(models.TextChoices):
        OPEN = "OPEN"
        CLOSED = "CLOSED"

    fiscal_year = models.ForeignKey(FiscalYear, on_delete=models.PROTECT, related_name="periods")
    number = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=40)
    start_date = models.DateField()
    end_date = models.DateField()
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.OPEN, db_index=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    closed_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["fiscal_year", "number"], name="uniq_period_number"),
            models.CheckConstraint(condition=Q(end_date__gte=F("start_date")), name="period_dates_ordered"),
        ]
        ordering = ["start_date"]


class Holiday(Base):
    holiday_date = models.DateField()
    name = models.CharField(max_length=120)
    branch = models.ForeignKey(Branch, null=True, blank=True, on_delete=models.CASCADE, related_name="holidays")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["holiday_date", "branch"], name="uniq_holiday_per_branch", nulls_distinct=False),
        ]


class TenantSetting(models.Model):
    key = models.CharField(max_length=80, primary_key=True)
    value = models.JSONField()
    updated_by = models.UUIDField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

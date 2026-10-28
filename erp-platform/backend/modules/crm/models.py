"""CRM (module 4). Records carry an owner; non-managers only see and change what they own."""
import uuid

from django.db import models
from django.db.models import Q
from django.utils import timezone

MONEY = dict(max_digits=20, decimal_places=4)


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class CrmAccount(Base):
    name = models.CharField(max_length=200)
    industry = models.CharField(max_length=80, blank=True)
    segment = models.CharField(max_length=40, blank=True, db_index=True)
    website = models.CharField(max_length=200, blank=True)
    tax_id = models.CharField(max_length=40, blank=True)
    owner_id = models.UUIDField(db_index=True)
    partner = models.OneToOneField("finance.Partner", null=True, blank=True, on_delete=models.PROTECT, related_name="crm_account")
    is_active = models.BooleanField(default=True)


class Contact(Base):
    account = models.ForeignKey(CrmAccount, null=True, blank=True, on_delete=models.PROTECT, related_name="contacts")
    first_name = models.CharField(max_length=80)
    last_name = models.CharField(max_length=80, blank=True)
    email = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    job_title = models.CharField(max_length=100, blank=True)
    owner_id = models.UUIDField(db_index=True)


class PipelineStage(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=80)
    position = models.PositiveSmallIntegerField()
    probability = models.PositiveSmallIntegerField()
    is_won = models.BooleanField(default=False)
    is_lost = models.BooleanField(default=False)

    class Meta:
        ordering = ["position"]
        constraints = [models.CheckConstraint(condition=Q(probability__lte=100), name="stage_probability_max_100"), models.CheckConstraint(condition=~Q(is_won=True, is_lost=True), name="stage_not_won_and_lost")]


class Lead(Base):
    class Status(models.TextChoices):
        NEW = "NEW"
        CONTACTED = "CONTACTED"
        QUALIFIED = "QUALIFIED"
        DISQUALIFIED = "DISQUALIFIED"
        CONVERTED = "CONVERTED"

    name = models.CharField(max_length=200)
    company = models.CharField(max_length=200, blank=True)
    email = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    source = models.CharField(max_length=40, blank=True)
    status = models.CharField(max_length=13, choices=Status.choices, default=Status.NEW, db_index=True)
    owner_id = models.UUIDField(null=True, blank=True, db_index=True)
    disqualify_reason = models.CharField(max_length=300, blank=True)
    converted_account = models.ForeignKey(CrmAccount, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    converted_opportunity = models.ForeignKey("Opportunity", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    converted_at = models.DateTimeField(null=True, blank=True)
    created_by = models.UUIDField(null=True, blank=True)


class Opportunity(Base):
    class Status(models.TextChoices):
        OPEN = "OPEN"
        WON = "WON"
        LOST = "LOST"

    name = models.CharField(max_length=200)
    account = models.ForeignKey(CrmAccount, on_delete=models.PROTECT, related_name="opportunities")
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    stage = models.ForeignKey(PipelineStage, on_delete=models.PROTECT, related_name="opportunities")
    amount = models.DecimalField(default=0, **MONEY)
    currency = models.CharField(max_length=3)
    expected_close = models.DateField(null=True, blank=True)
    owner_id = models.UUIDField(db_index=True)
    status = models.CharField(max_length=4, choices=Status.choices, default=Status.OPEN, db_index=True)
    lost_reason = models.CharField(max_length=300, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gte=0), name="opportunity_amount_non_negative")]


class Activity(Base):
    class Type(models.TextChoices):
        CALL = "CALL"
        MEETING = "MEETING"
        TASK = "TASK"
        NOTE = "NOTE"

    type = models.CharField(max_length=8, choices=Type.choices)
    subject = models.CharField(max_length=200)
    notes = models.TextField(blank=True)
    due_at = models.DateTimeField(null=True, blank=True, db_index=True)
    done_at = models.DateTimeField(null=True, blank=True)
    owner_id = models.UUIDField(db_index=True)
    lead = models.ForeignKey(Lead, null=True, blank=True, on_delete=models.CASCADE, related_name="activities")
    opportunity = models.ForeignKey(Opportunity, null=True, blank=True, on_delete=models.CASCADE, related_name="activities")
    account = models.ForeignKey(CrmAccount, null=True, blank=True, on_delete=models.CASCADE, related_name="activities")

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(lead__isnull=False) | Q(opportunity__isnull=False) | Q(account__isnull=False), name="activity_has_subject_record")]

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
    customer_type = models.CharField(max_length=10, default="BUSINESS")  # INDIVIDUAL / BUSINESS
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    classification = models.CharField(max_length=40, blank=True)  # e.g. A / B / C, strategic, key
    lifecycle_stage = models.CharField(max_length=12, default="PROSPECT")  # PROSPECT / ACTIVE / AT_RISK / CHURNED
    credit_status = models.CharField(max_length=10, default="OK")  # OK / ON_HOLD / BLOCKED
    credit_limit = models.DecimalField(max_digits=20, decimal_places=4, null=True, blank=True)
    restriction_note = models.CharField(max_length=300, blank=True)
    preferred_channel = models.CharField(max_length=10, blank=True)
    language = models.CharField(max_length=10, blank=True)
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
    role = models.CharField(max_length=20, blank=True)  # DECISION_MAKER / INFLUENCER / BILLING / TECHNICAL / USER
    preferred_channel = models.CharField(max_length=10, blank=True)
    consent_email = models.BooleanField(default=False)
    consent_phone = models.BooleanField(default=False)
    consent_sms = models.BooleanField(default=False)
    consent_recorded_at = models.DateTimeField(null=True, blank=True)
    opted_out_at = models.DateTimeField(null=True, blank=True)  # a global stop: nothing marketing-related may be sent


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
        MERGED = "MERGED"

    name = models.CharField(max_length=200)
    company = models.CharField(max_length=200, blank=True)
    email = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    source = models.CharField(max_length=40, blank=True)
    status = models.CharField(max_length=13, choices=Status.choices, default=Status.NEW, db_index=True)
    priority = models.CharField(max_length=6, default="MEDIUM")  # LOW / MEDIUM / HIGH
    qualification = models.CharField(max_length=5, default="COLD")  # COLD / WARM / HOT
    industry = models.CharField(max_length=80, blank=True)
    interests = models.CharField(max_length=300, blank=True)
    budget = models.DecimalField(max_digits=20, decimal_places=4, null=True, blank=True)
    potential_value = models.DecimalField(max_digits=20, decimal_places=4, null=True, blank=True)
    currency = models.CharField(max_length=3, blank=True)
    follow_up_date = models.DateField(null=True, blank=True, db_index=True)
    merged_into = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="merged_from")
    marketing_consent = models.BooleanField(default=False)  # opt-in: leads are not mailed until this is recorded
    opted_out_at = models.DateTimeField(null=True, blank=True)
    campaign = models.ForeignKey("Campaign", null=True, blank=True, on_delete=models.PROTECT, related_name="leads")
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
    competitors = models.CharField(max_length=300, blank=True)
    requirements = models.TextField(blank=True)
    decision_makers = models.CharField(max_length=300, blank=True)
    risks = models.TextField(blank=True)
    next_action = models.CharField(max_length=200, blank=True)
    next_action_date = models.DateField(null=True, blank=True)
    last_activity_at = models.DateTimeField(null=True, blank=True)
    campaign = models.ForeignKey("Campaign", null=True, blank=True, on_delete=models.PROTECT, related_name="opportunities")

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gte=0), name="opportunity_amount_non_negative")]


class Activity(Base):
    class Type(models.TextChoices):
        CALL = "CALL"
        MEETING = "MEETING"
        TASK = "TASK"
        NOTE = "NOTE"
        DEMO = "DEMO"
        EMAIL = "EMAIL"

    type = models.CharField(max_length=8, choices=Type.choices)
    priority = models.CharField(max_length=6, default="MEDIUM")
    assignee_id = models.UUIDField(null=True, blank=True, db_index=True)  # who must do it (the owner created/owns the record)
    outcome = models.CharField(max_length=300, blank=True)
    reminded_at = models.DateTimeField(null=True, blank=True)
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


class AccountAddress(Base):
    class Kind(models.TextChoices):
        BILLING = "BILLING"
        DELIVERY = "DELIVERY"
        BRANCH = "BRANCH"

    account = models.ForeignKey(CrmAccount, on_delete=models.CASCADE, related_name="addresses")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    label = models.CharField(max_length=80, blank=True)
    line1 = models.CharField(max_length=200)
    city = models.CharField(max_length=80, blank=True)
    region = models.CharField(max_length=80, blank=True)
    country = models.CharField(max_length=2, blank=True)
    is_default = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["account", "kind"], condition=Q(is_default=True), name="one_default_address_per_kind")]


class ContactLink(Base):
    """A contact can play a role at several accounts (e.g. a consultant or a group procurement officer)."""

    contact = models.ForeignKey(Contact, on_delete=models.CASCADE, related_name="links")
    account = models.ForeignKey(CrmAccount, on_delete=models.CASCADE, related_name="contact_links")
    role = models.CharField(max_length=40, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["contact", "account"], name="one_link_per_contact_account")]


class ContactDate(Base):
    contact = models.ForeignKey(Contact, on_delete=models.CASCADE, related_name="dates")
    label = models.CharField(max_length=80)
    on_date = models.DateField()
    remind_days_before = models.PositiveSmallIntegerField(default=7)
    yearly = models.BooleanField(default=True)


class AccountHistory(models.Model):
    """Material changes to an account (ownership, credit status, parent, classification) — who, what, when."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    account = models.ForeignKey(CrmAccount, on_delete=models.CASCADE, related_name="history")
    at = models.DateTimeField(default=timezone.now, db_index=True)
    actor_id = models.UUIDField(null=True, blank=True)
    field = models.CharField(max_length=40)
    old = models.CharField(max_length=300, blank=True)
    new = models.CharField(max_length=300, blank=True)


class StageChange(models.Model):
    """Every movement of an opportunity through the pipeline (append-only by convention; never edited)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    opportunity = models.ForeignKey(Opportunity, on_delete=models.CASCADE, related_name="stage_changes")
    from_stage = models.CharField(max_length=30, blank=True)
    to_stage = models.CharField(max_length=30)
    at = models.DateTimeField(default=timezone.now, db_index=True)
    actor_id = models.UUIDField(null=True, blank=True)
    note = models.CharField(max_length=300, blank=True)


class OpportunityLine(Base):
    opportunity = models.ForeignKey(Opportunity, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey("inventory.Product", on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(max_digits=18, decimal_places=4)
    expected_price = models.DecimalField(max_digits=20, decimal_places=4, default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["opportunity", "product"], name="one_line_per_product_per_opportunity"), models.CheckConstraint(condition=Q(quantity__gt=0, expected_price__gte=0), name="opp_line_positive")]


class Campaign(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        ACTIVE = "ACTIVE"
        COMPLETED = "COMPLETED"
        CANCELLED = "CANCELLED"

    number = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=150)
    objective = models.CharField(max_length=300, blank=True)
    channel = models.CharField(max_length=10, default="EMAIL")  # EMAIL / PHONE / SMS / EVENT / SOCIAL / OTHER
    audience = models.JSONField(default=dict, blank=True)  # segment criteria used to build the member list
    budget = models.DecimalField(default=0, **MONEY)
    currency = models.CharField(max_length=3)
    start_date = models.DateField()
    end_date = models.DateField()
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT, db_index=True)
    owner_id = models.UUIDField(db_index=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(end_date__gte=models.F("start_date"), budget__gte=0), name="campaign_dates_and_budget")]


class CampaignMember(Base):
    class Status(models.TextChoices):
        TARGETED = "TARGETED"
        SENT = "SENT"
        RESPONDED = "RESPONDED"
        EXCLUDED = "EXCLUDED"

    campaign = models.ForeignKey(Campaign, on_delete=models.CASCADE, related_name="members")
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.CASCADE, related_name="campaign_memberships")
    lead = models.ForeignKey(Lead, null=True, blank=True, on_delete=models.CASCADE, related_name="campaign_memberships")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.TARGETED, db_index=True)
    excluded_reason = models.CharField(max_length=100, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    responded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(contact__isnull=False) | Q(lead__isnull=False), name="member_has_target"),
            models.UniqueConstraint(fields=["campaign", "contact"], condition=Q(contact__isnull=False), name="one_membership_per_contact"),
            models.UniqueConstraint(fields=["campaign", "lead"], condition=Q(lead__isnull=False), name="one_membership_per_lead"),
        ]


class CampaignExpense(Base):
    campaign = models.ForeignKey(Campaign, on_delete=models.CASCADE, related_name="expenses")
    on_date = models.DateField()
    description = models.CharField(max_length=200)
    amount = models.DecimalField(**MONEY)
    created_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="campaign_expense_positive")]


class SlaPolicy(Base):
    """Service-level targets per case priority (hours, calendar time)."""

    priority = models.CharField(max_length=6, unique=True)
    first_response_hours = models.PositiveIntegerField()
    resolution_hours = models.PositiveIntegerField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(first_response_hours__gt=0, resolution_hours__gte=models.F("first_response_hours")), name="sla_hours_valid")]


class ServiceCase(Base):
    class Kind(models.TextChoices):
        INQUIRY = "INQUIRY"
        COMPLAINT = "COMPLAINT"
        REQUEST = "REQUEST"

    class Status(models.TextChoices):
        NEW = "NEW"
        OPEN = "OPEN"
        PENDING_CUSTOMER = "PENDING_CUSTOMER"
        RESOLVED = "RESOLVED"
        CLOSED = "CLOSED"
        CANCELLED = "CANCELLED"

    number = models.CharField(max_length=30, unique=True)
    subject = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.COMPLAINT)
    category = models.CharField(max_length=60, blank=True)
    priority = models.CharField(max_length=6, default="MEDIUM")  # LOW / MEDIUM / HIGH / URGENT
    severity = models.CharField(max_length=8, default="MINOR")  # MINOR / MAJOR / CRITICAL
    status = models.CharField(max_length=17, choices=Status.choices, default=Status.NEW, db_index=True)
    account = models.ForeignKey(CrmAccount, on_delete=models.PROTECT, related_name="cases")
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    order = models.ForeignKey("sales.SalesOrder", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    delivery = models.ForeignKey("sales.Delivery", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    invoice = models.ForeignKey("finance.Invoice", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    product = models.ForeignKey("inventory.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    owner_id = models.UUIDField(null=True, blank=True, db_index=True)  # the assigned handler
    team = models.CharField(max_length=60, blank=True)
    first_response_due = models.DateTimeField(null=True, blank=True)
    due_at = models.DateTimeField(null=True, blank=True, db_index=True)
    first_responded_at = models.DateTimeField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    resolution = models.TextField(blank=True)
    escalation_level = models.PositiveSmallIntegerField(default=0)
    satisfaction = models.PositiveSmallIntegerField(null=True, blank=True)
    feedback = models.CharField(max_length=500, blank=True)
    created_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(satisfaction__isnull=True) | Q(satisfaction__gte=1, satisfaction__lte=5), name="case_satisfaction_range")]


class CaseComment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    case = models.ForeignKey(ServiceCase, on_delete=models.CASCADE, related_name="comments")
    author_id = models.UUIDField()
    text = models.TextField()
    is_internal = models.BooleanField(default=False)  # internal notes are never shown to the customer
    created_at = models.DateTimeField(default=timezone.now, db_index=True)


# ----------------------------------------------------------------------------- teams, territories, ownership history (slice N)
class SalesTeam(Base):
    name = models.CharField(max_length=100, unique=True)
    manager_id = models.UUIDField(null=True, blank=True, db_index=True)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    is_active = models.BooleanField(default=True)


class TeamMember(models.Model):
    user_id = models.UUIDField(primary_key=True)  # a person belongs to one team
    team = models.ForeignKey(SalesTeam, on_delete=models.CASCADE, related_name="members")
    is_lead = models.BooleanField(default=False)  # leads see the team's portfolio like the manager does
    added_at = models.DateTimeField(default=timezone.now)


class Territory(Base):
    name = models.CharField(max_length=100, unique=True)
    team = models.ForeignKey(SalesTeam, on_delete=models.PROTECT, related_name="territories")
    criteria = models.JSONField(default=dict)  # {"country": ["ET"], "industry": [...], "segment": [...]} - every given key must match
    priority = models.PositiveSmallIntegerField(default=100)  # lower is checked first
    is_active = models.BooleanField(default=True)


class OwnershipChange(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    record_type = models.CharField(max_length=12)  # account / lead / opportunity
    record_id = models.UUIDField(db_index=True)
    from_owner = models.UUIDField(null=True)
    to_owner = models.UUIDField()
    changed_by = models.UUIDField(null=True)
    reason = models.CharField(max_length=200, blank=True)
    changed_at = models.DateTimeField(default=timezone.now, db_index=True)

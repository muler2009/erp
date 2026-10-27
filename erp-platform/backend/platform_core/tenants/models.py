"""Public-schema tenant registry, domains, plans, entitlements and provisioning records."""
import re
import uuid

from django.db import models
from django.utils import timezone
from django_tenants.models import DomainMixin, TenantMixin

SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,38}[a-z0-9]$")
RESERVED_SLUGS = {
    "www", "platform", "admin", "api", "auth", "app", "public", "static", "mail", "keycloak",
    "login", "sso", "status", "support", "root", "system", "default", "test", "erp",
}


class Plan(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.SlugField(unique=True)
    name = models.CharField(max_length=100)
    modules = models.JSONField(default=list)  # module codes entitled by this plan
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now)

    def __str__(self):
        return self.code


class Tenant(TenantMixin):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        PROVISIONING = "PROVISIONING"
        PROVISIONING_FAILED = "PROVISIONING_FAILED"
        ACTIVE = "ACTIVE"
        SUSPENDED = "SUSPENDED"
        MIGRATION_FAILED = "MIGRATION_FAILED"
        DEACTIVATED = "DEACTIVATED"
        PENDING_DELETION = "PENDING_DELETION"

    class SuspensionPolicy(models.TextChoices):
        READ_ONLY = "READ_ONLY"  # reads allowed, writes blocked
        BLOCKED = "BLOCKED"  # only identity endpoints allowed

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    slug = models.SlugField(max_length=40, unique=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.PENDING, db_index=True)
    suspension_policy = models.CharField(max_length=12, choices=SuspensionPolicy.choices, default=SuspensionPolicy.READ_ONLY)
    plan = models.ForeignKey(Plan, null=True, blank=True, on_delete=models.PROTECT, related_name="tenants")
    is_platform = models.BooleanField(default=False, help_text="True only for the public-schema platform tenant")
    created_at = models.DateTimeField(default=timezone.now)
    suspended_at = models.DateTimeField(null=True, blank=True)
    deactivated_at = models.DateTimeField(null=True, blank=True)
    deletion_requested_at = models.DateTimeField(null=True, blank=True)
    retention_until = models.DateTimeField(null=True, blank=True)

    # Schemas are created explicitly by the provisioning saga, never as a side effect of save().
    auto_create_schema = False
    auto_drop_schema = False

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(is_platform=True, schema_name="public") | models.Q(is_platform=False, schema_name__startswith="t_"),
                name="tenant_schema_name_policy",
            )
        ]

    def __str__(self):
        return self.slug


class Domain(DomainMixin):
    pass


class ModuleEntitlement(models.Model):
    """`entitled` is set by the platform; `enabled` by the tenant administrator and only if entitled."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="entitlements")
    module = models.CharField(max_length=40)
    entitled = models.BooleanField(default=False)
    enabled = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["tenant", "module"], name="uniq_entitlement_per_module"),
            models.CheckConstraint(condition=models.Q(enabled=False) | models.Q(entitled=True), name="enabled_requires_entitled"),
        ]


class ProvisioningJob(models.Model):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        RUNNING = "RUNNING"
        SUCCEEDED = "SUCCEEDED"
        SUCCEEDED_WITH_WARNINGS = "SUCCEEDED_WITH_WARNINGS"
        FAILED = "FAILED"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="provisioning_jobs")
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.PENDING, db_index=True)
    idempotency_key = models.CharField(max_length=100, unique=True, null=True, blank=True)
    requested_by_user_id = models.UUIDField(null=True, blank=True)
    admin_email = models.EmailField()
    admin_display_name = models.CharField(max_length=200)
    attempts = models.PositiveIntegerField(default=0)
    last_error = models.TextField(blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    finished_at = models.DateTimeField(null=True, blank=True)


class ProvisioningStep(models.Model):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        SUCCEEDED = "SUCCEEDED"
        FAILED = "FAILED"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    job = models.ForeignKey(ProvisioningJob, on_delete=models.CASCADE, related_name="steps")
    name = models.CharField(max_length=60)
    required = models.BooleanField(default=True)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveIntegerField(default=0)
    error = models.TextField(blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["job", "name"], name="uniq_step_per_job")]

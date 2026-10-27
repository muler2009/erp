"""Public-schema identity records: users, external identities, memberships, platform administration."""
import uuid

from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.db import models
from django.utils import timezone

from platform_core.tenants.models import Tenant


class UserManager(BaseUserManager):
    def create_user(self, email, display_name="", **extra):
        user = self.model(email=email.strip().lower(), display_name=display_name, **extra)
        user.set_unusable_password()  # credentials live in Keycloak, never here
        user.save(using=self._db)
        return user


class User(AbstractBaseUser):
    """Global identity record. Authentication is delegated to Keycloak; the permanent key is
    ExternalIdentity(issuer, subject), not the email address."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(db_index=True)
    display_name = models.CharField(max_length=200, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now)

    USERNAME_FIELD = "id"
    REQUIRED_FIELDS = []
    objects = UserManager()

    # last_login from AbstractBaseUser is kept (updated on login)


class ExternalIdentity(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="identities")
    issuer = models.CharField(max_length=300)
    subject = models.CharField(max_length=200)
    linked_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["issuer", "subject"], name="uniq_external_identity")]


class TenantMembership(models.Model):
    class Status(models.TextChoices):
        INVITED = "INVITED"
        ACTIVE = "ACTIVE"
        DEACTIVATED = "DEACTIVATED"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="memberships")
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="memberships")
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.INVITED, db_index=True)
    invite_token_hash = models.CharField(max_length=64, blank=True, db_index=True)
    invite_expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "tenant"], name="uniq_membership")]


class PlatformRole(models.Model):
    """Explicit set of platform permission codes. No wildcard, no implicit 'is_superuser' bypass."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=80, unique=True)
    permissions = models.JSONField(default=list)


class PlatformAdmin(models.Model):
    class Status(models.TextChoices):
        PENDING_APPROVAL = "PENDING_APPROVAL"
        INVITED = "INVITED"
        ACTIVE = "ACTIVE"
        DEACTIVATED = "DEACTIVATED"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="platform_admin")
    roles = models.ManyToManyField(PlatformRole, related_name="admins")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING_APPROVAL)
    proposed_by = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="proposed_admins")
    approved_by = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="approved_admins")
    invite_token_hash = models.CharField(max_length=64, blank=True, db_index=True)
    invite_expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)


class TenantAccessGrant(models.Model):
    """Break-glass access of a platform administrator to a tenant's business records."""

    class Status(models.TextChoices):
        REQUESTED = "REQUESTED"
        APPROVED = "APPROVED"
        DENIED = "DENIED"
        REVOKED = "REVOKED"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    requested_by = models.ForeignKey(PlatformAdmin, on_delete=models.PROTECT, related_name="access_requests")
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="access_grants")
    reason = models.TextField()
    ticket_ref = models.CharField(max_length=100)
    requested_minutes = models.PositiveIntegerField()
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.REQUESTED, db_index=True)
    approved_by = models.ForeignKey(PlatformAdmin, null=True, blank=True, on_delete=models.PROTECT, related_name="access_approvals")
    approved_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [
            # Four-eyes principle enforced in the database as well as in the service layer.
            models.CheckConstraint(
                condition=models.Q(approved_by__isnull=True) | ~models.Q(approved_by=models.F("requested_by")),
                name="grant_approver_differs_from_requester",
            ),
        ]

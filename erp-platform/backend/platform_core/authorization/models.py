"""Tenant-schema RBAC: roles, role permissions and scoped, time-boxed role assignments.

Users are referenced by UUID value (no FK) because User lives in the public schema; integrity is
enforced by the service layer.
"""
import uuid

from django.db import models
from django.db.models import Q
from django.utils import timezone


class RoleDefinition(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=80, unique=True)  # stable key for system roles
    display_name = models.CharField(max_length=120)
    is_system = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)


class RolePermission(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    role = models.ForeignKey(RoleDefinition, on_delete=models.CASCADE, related_name="permissions")
    permission_code = models.CharField(max_length=100)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["role", "permission_code"], name="uniq_role_permission"),
            # Platform permissions can never exist inside a tenant schema.
            models.CheckConstraint(condition=~Q(permission_code__startswith="platform."), name="no_platform_permissions_in_tenant"),
        ]


class RoleAssignment(models.Model):
    class ScopeType(models.TextChoices):
        TENANT = "TENANT"
        DEPARTMENT = "DEPARTMENT"
        BUSINESS_UNIT = "BUSINESS_UNIT"
        COST_CENTER = "COST_CENTER"
        PROJECT = "PROJECT"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id = models.UUIDField(db_index=True)
    role = models.ForeignKey(RoleDefinition, on_delete=models.PROTECT, related_name="assignments")
    scope_type = models.CharField(max_length=14, choices=ScopeType.choices, default=ScopeType.TENANT)
    scope_id = models.UUIDField(null=True, blank=True)
    valid_from = models.DateTimeField(default=timezone.now)
    valid_to = models.DateTimeField(null=True, blank=True)  # temporary access: checked at query time
    granted_by = models.UUIDField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(Q(scope_type="TENANT", scope_id__isnull=True) | (~Q(scope_type="TENANT") & Q(scope_id__isnull=False))),
                name="scope_id_matches_scope_type",
            ),
            models.CheckConstraint(condition=Q(valid_to__isnull=True) | Q(valid_to__gt=models.F("valid_from")), name="valid_window_ordered"),
            models.UniqueConstraint(
                fields=["user_id", "role", "scope_type", "scope_id"],
                condition=Q(revoked_at__isnull=True),
                nulls_distinct=False,
                name="uniq_active_assignment",
            ),
        ]

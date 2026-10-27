"""Tenant-schema authorization services. All functions operate on the *current* schema; callers on the
platform host must wrap them in schema_context(tenant.schema_name)."""
import logging

from django.db import transaction
from django.utils import timezone

from platform_core.authorization.models import RoleAssignment, RoleDefinition, RolePermission
from platform_core.catalog import DEFAULT_TENANT_ROLES, OWNER_ROLE, PERMISSION_BY_CODE, TENANT_PERMISSION_CODES
from shared.api.errors import DomainError, ValidationFailed

logger = logging.getLogger(__name__)


def seed_roles():
    """Idempotently create/reconcile the system roles from the code-defined catalog."""
    with transaction.atomic():
        for name, (display, codes) in DEFAULT_TENANT_ROLES.items():
            role, _ = RoleDefinition.objects.get_or_create(name=name, defaults={"display_name": display, "is_system": True})
            existing = set(role.permissions.values_list("permission_code", flat=True))
            wanted = set(codes)
            RolePermission.objects.bulk_create([RolePermission(role=role, permission_code=c) for c in wanted - existing])
            if role.is_system:
                role.permissions.filter(permission_code__in=existing - wanted).delete()


def _active_assignments(user_id, now=None):
    now = now or timezone.now()
    return RoleAssignment.objects.filter(user_id=user_id, revoked_at__isnull=True, valid_from__lte=now).filter(
        models_q_valid(now)
    )


def models_q_valid(now):
    from django.db.models import Q

    return Q(valid_to__isnull=True) | Q(valid_to__gt=now)


def tenant_wide_permissions(user_id, now=None):
    """Permission codes the user holds with tenant-wide scope (temporary grants are checked at query time)."""
    rows = RolePermission.objects.filter(
        role__assignments__in=_active_assignments(user_id, now).filter(scope_type=RoleAssignment.ScopeType.TENANT)
    ).values_list("permission_code", flat=True)
    return set(rows)


def has_permission(user_id, code, *, scope_type=None, scope_id=None, now=None):
    if code not in PERMISSION_BY_CODE or PERMISSION_BY_CODE[code].scope != "tenant":
        return False  # unknown or platform permissions never resolve inside a tenant
    assignments = _active_assignments(user_id, now)
    query = RolePermission.objects.filter(permission_code=code)
    if query.filter(role__assignments__in=assignments.filter(scope_type=RoleAssignment.ScopeType.TENANT)).exists():
        return True
    if scope_type and scope_id:
        return query.filter(role__assignments__in=assignments.filter(scope_type=scope_type, scope_id=scope_id)).exists()
    return False


def effective_permissions(user_id, now=None):
    """{code: {"tenant_wide": bool, "scopes": [[scope_type, scope_id], ...]}} for the /me endpoint."""
    result = {}
    for assignment in _active_assignments(user_id, now).select_related("role"):
        for code in assignment.role.permissions.values_list("permission_code", flat=True):
            entry = result.setdefault(code, {"tenant_wide": False, "scopes": []})
            if assignment.scope_type == RoleAssignment.ScopeType.TENANT:
                entry["tenant_wide"] = True
            else:
                entry["scopes"].append([assignment.scope_type, str(assignment.scope_id)])
    return result


def active_owner_ids(exclude_assignment_id=None):
    owners = RoleAssignment.objects.filter(
        role__name=OWNER_ROLE, revoked_at__isnull=True, scope_type=RoleAssignment.ScopeType.TENANT
    ).filter(models_q_valid(timezone.now()))
    if exclude_assignment_id:
        owners = owners.exclude(id=exclude_assignment_id)
    return set(owners.values_list("user_id", flat=True))


def assert_delegation_ceiling(actor_user_id, role):
    """A grantor may only hand out permissions they themselves hold tenant-wide."""
    held = tenant_wide_permissions(actor_user_id)
    wanted = set(role.permissions.values_list("permission_code", flat=True))
    excess = sorted(wanted - held)
    if excess:
        raise DomainError(
            f"Cannot grant a role containing permissions you do not hold: {', '.join(excess)}",
            code="delegation_ceiling_exceeded",
            status_code=403,
        )


def create_custom_role(actor_user_id, name, display_name, permission_codes):
    codes = set(permission_codes)
    unknown = [c for c in codes if c not in PERMISSION_BY_CODE]
    if unknown:
        raise ValidationFailed(f"Unknown permissions: {', '.join(sorted(unknown))}", code="unknown_permission")
    platform = [c for c in codes if PERMISSION_BY_CODE[c].scope != "tenant"]
    if platform:
        raise DomainError("Platform permissions cannot be granted inside a tenant.", code="platform_permission_forbidden", status_code=403)
    excess = sorted(codes - tenant_wide_permissions(actor_user_id))
    if excess:
        raise DomainError(
            f"Cannot create a role with permissions you do not hold: {', '.join(excess)}",
            code="delegation_ceiling_exceeded",
            status_code=403,
        )
    if RoleDefinition.objects.filter(name=name).exists():
        raise DomainError("A role with this name already exists.", code="role_exists")
    with transaction.atomic():
        role = RoleDefinition.objects.create(name=name, display_name=display_name, is_system=False)
        RolePermission.objects.bulk_create([RolePermission(role=role, permission_code=c) for c in sorted(codes)])
    return role


def assign_role(actor_user_id, user_id, role, *, scope_type=RoleAssignment.ScopeType.TENANT, scope_id=None, valid_to=None):
    assert_delegation_ceiling(actor_user_id, role)
    if scope_type == RoleAssignment.ScopeType.TENANT:
        scope_id = None
    elif scope_id is None:
        raise ValidationFailed("scope_id is required for scoped assignments.", code="scope_id_required")
    now = timezone.now()
    if valid_to is not None and valid_to <= now:
        raise ValidationFailed("valid_to must be in the future.", code="invalid_window")
    with transaction.atomic():
        existing = RoleAssignment.objects.select_for_update().filter(
            user_id=user_id, role=role, scope_type=scope_type, scope_id=scope_id, revoked_at__isnull=True
        ).first()
        if existing:
            if existing.valid_to is None or existing.valid_to > now:
                return existing  # already effective: idempotent
            # Expired but never revoked: retire it so a fresh grant can take effect (unique active constraint).
            existing.revoked_at = now
            existing.save(update_fields=["revoked_at"])
    return RoleAssignment.objects.create(
        user_id=user_id, role=role, scope_type=scope_type, scope_id=scope_id, valid_to=valid_to, granted_by=actor_user_id
    )


def revoke_assignment(actor_user_id, assignment):
    if assignment.revoked_at:
        return assignment
    if assignment.role.name == OWNER_ROLE and assignment.scope_type == RoleAssignment.ScopeType.TENANT:
        if not active_owner_ids(exclude_assignment_id=assignment.id):
            raise DomainError("The last Tenant Owner cannot be removed.", code="last_owner_protected")
    # A grantor can only revoke what they could grant.
    assert_delegation_ceiling(actor_user_id, assignment.role)
    assignment.revoked_at = timezone.now()
    assignment.save(update_fields=["revoked_at"])
    return assignment


def all_tenant_permission_codes():
    return list(TENANT_PERMISSION_CODES)

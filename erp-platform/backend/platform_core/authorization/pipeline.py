"""The tenant authorization pipeline, in the order defined by the architecture (Section 6):

 1. authenticated            (DRF authentication + is_authenticated)
 2. active tenant membership
 3. tenant status permits the operation (suspension policy)
 4. module entitlement/enabled
 5. role/permission (+ organizational scope)
 6. object-level rules      -> registry hook, empty until business modules register rules (Phase 2+)
 7. workflow/business state -> same registry, empty until modules exist

Steps 6/7 are intentionally explicit extension points: `OBJECT_RULES` below is evaluated for every call
that passes an object, so modules cannot forget them.
"""
from django.db import connection
from rest_framework import exceptions

from platform_core.authorization import services
from platform_core.catalog import PERMISSION_BY_CODE
from platform_core.tenants.models import ModuleEntitlement, Tenant
from platform_core.users.models import TenantMembership

SAFE_METHODS = ("GET", "HEAD", "OPTIONS")

# callables (user_id, code, obj) -> None or raise AuthzDenied; modules append here when they register.
OBJECT_RULES = []


class AuthzDenied(exceptions.PermissionDenied):
    def __init__(self, reason_code, detail=None):
        super().__init__(detail or reason_code.replace("_", " ").capitalize() + ".")
        self.reason_code = reason_code


def authorize_tenant(request, code=None, *, obj=None, scope_type=None, scope_id=None, allow_when_blocked=False):
    """Run the pipeline for the current tenant. Returns the membership. Raises AuthzDenied."""
    user = request.user
    tenant = connection.tenant
    if not user or not user.is_authenticated or not user.is_active:
        raise AuthzDenied("not_authenticated")
    if tenant is None or getattr(tenant, "is_platform", False):
        raise AuthzDenied("no_tenant_context")

    membership = TenantMembership.objects.filter(user=user, tenant=tenant, status=TenantMembership.Status.ACTIVE).first()
    if membership is None:
        raise AuthzDenied("not_a_tenant_member")

    _check_tenant_status(request, tenant, allow_when_blocked)

    if code is not None:
        definition = PERMISSION_BY_CODE.get(code)
        if definition is None or definition.scope != "tenant":
            raise AuthzDenied("unknown_permission")
        if definition.module and not ModuleEntitlement.objects.filter(
            tenant=tenant, module=definition.module, entitled=True, enabled=True
        ).exists():
            raise AuthzDenied("module_not_enabled")
        if not services.has_permission(user.id, code, scope_type=scope_type, scope_id=scope_id):
            raise AuthzDenied("permission_denied")
        if obj is not None:
            for rule in OBJECT_RULES:
                rule(user.id, code, obj)
    return membership


def _check_tenant_status(request, tenant, allow_when_blocked):
    if tenant.status == Tenant.Status.ACTIVE:
        return
    if tenant.status == Tenant.Status.MIGRATION_FAILED:
        if request.method not in SAFE_METHODS:  # same policy as TenantStatusMiddleware: read-only until repaired
            raise AuthzDenied("tenant_read_only", "Tenant is read-only until its migration is repaired.")
        return
    if tenant.status == Tenant.Status.SUSPENDED:
        if tenant.suspension_policy == Tenant.SuspensionPolicy.READ_ONLY:
            if request.method not in SAFE_METHODS:
                raise AuthzDenied("tenant_suspended", "Tenant is suspended: write operations are blocked.")
            return
        if not allow_when_blocked:
            raise AuthzDenied("tenant_suspended", "Tenant is suspended.")
        return
    raise AuthzDenied("tenant_unavailable")

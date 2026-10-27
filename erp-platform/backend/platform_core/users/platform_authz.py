"""Authorization for the platform host. No wildcard roles: every endpoint names one explicit permission."""
from django.conf import settings
from django.db import connection
from rest_framework.permissions import BasePermission

from platform_core.authorization.pipeline import AuthzDenied
from platform_core.catalog import PLATFORM_PERMISSION_CODES
from platform_core.users.models import PlatformAdmin

MFA_AMR = {"otp", "mfa", "hwk", "webauthn"}


def active_platform_admin(user):
    return PlatformAdmin.objects.filter(user=user, status=PlatformAdmin.Status.ACTIVE).first()


def platform_permissions(admin):
    codes = set()
    for role in admin.roles.all():
        codes.update(c for c in role.permissions if c in PLATFORM_PERMISSION_CODES)
    return codes


def authorize_platform(request, code):
    user = request.user
    tenant = connection.tenant
    if not user or not user.is_authenticated or not user.is_active:
        raise AuthzDenied("not_authenticated")
    if tenant is None or not getattr(tenant, "is_platform", False):
        raise AuthzDenied("not_platform_host")
    admin = active_platform_admin(user)
    if admin is None:
        raise AuthzDenied("not_a_platform_admin")
    if settings.PLATFORM_REQUIRE_MFA:
        claims = request.auth if isinstance(request.auth, dict) else (request._request.session.get("auth_ctx") or {})
        if not MFA_AMR.intersection(claims.get("amr", [])):
            raise AuthzDenied("mfa_required", "Platform administration requires multi-factor authentication.")
    if code is not None and code not in platform_permissions(admin):
        raise AuthzDenied("permission_denied")
    request.platform_admin = admin
    return admin


def require_platform(code):
    if code not in PLATFORM_PERMISSION_CODES:
        raise ValueError(f"{code} is not a platform permission")

    class _RequirePlatform(BasePermission):
        permission_code = code

        def has_permission(self, request, view):
            if not request.user or not request.user.is_authenticated:
                return False
            authorize_platform(request, code)
            return True

    _RequirePlatform.__name__ = f"RequirePlatform[{code}]"
    return _RequirePlatform


class IsActivePlatformAdmin(BasePermission):
    """Identity-level check (active admin + MFA) with no specific permission, e.g. for /me."""

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False
        authorize_platform(request, None)
        return True

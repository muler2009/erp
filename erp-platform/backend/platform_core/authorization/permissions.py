"""DRF permission classes for tenant-host endpoints."""
from rest_framework.permissions import BasePermission

from platform_core.authorization.pipeline import authorize_tenant


class IsTenantMember(BasePermission):
    """Pipeline steps 1-3 only (identity endpoints such as /me)."""

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False  # DRF turns this into 401
        authorize_tenant(request, None, allow_when_blocked=getattr(view, "allow_when_suspended_blocked", False))
        return True


def require(code):
    """Return a permission class that runs the full pipeline for `code`:  permission_classes = [require("users.view")]"""

    class _Require(BasePermission):
        permission_code = code

        def has_permission(self, request, view):
            if not request.user or not request.user.is_authenticated:
                return False
            authorize_tenant(request, code)
            return True

    _Require.__name__ = f"Require[{code}]"
    return _Require

import logging
from decimal import Decimal, InvalidOperation

from django.utils import timezone

from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

log = logging.getLogger(__name__)


def today():
    return timezone.localdate()


def nf(label="Record"):
    return DomainError(f"{label} not found.", code="not_found", status_code=404)


def audit(action, actor, target_type, target_id, **meta):
    record_tenant_event(current_tenant(), action, actor_user_id=actor, target_type=target_type, target_id=target_id, metadata={k: str(v) for k, v in meta.items()})


def need(data, *names):
    missing = [n for n in names if data.get(n) in (None, "", [])]
    if missing:
        raise ValidationFailed(f"Required: {', '.join(missing)}.", code="invalid_fields")


def dec(v, label="value"):
    if v in (None, ""):
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        raise ValidationFailed(f"{label} must be a number.", code="invalid_fields")


class Perms:
    """The caller's tenant-wide permissions, loaded once. Pages that check many permissions (a dashboard
    with a dozen widgets) would otherwise run several queries per check."""

    def __init__(self, user_id):
        self.user_id = user_id
        self._codes = None

    def can(self, code):
        from platform_core.catalog import PERMISSION_BY_CODE

        if code not in PERMISSION_BY_CODE or PERMISSION_BY_CODE[code].scope != "tenant":
            return False
        if self._codes is None:
            self._codes = authz.tenant_wide_permissions(self.user_id)
        return code in self._codes


def can(user_id, code, perms=None):
    return perms.can(code) if perms is not None else authz.has_permission(user_id, code)


def active_members(user_ids):
    from platform_core.users.models import TenantMembership
    return set(TenantMembership.objects.filter(tenant=current_tenant(), user_id__in=[x for x in user_ids], status=TenantMembership.Status.ACTIVE).values_list("user_id", flat=True))


def users_with_permission(code):
    from modules.documents.review import users_with_permission as u
    return u(code)

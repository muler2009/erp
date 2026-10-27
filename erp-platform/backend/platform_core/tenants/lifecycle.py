"""Tenant lifecycle state machine: suspend / reactivate / deactivate / deletion with retention & recovery.

Nothing here destroys business data. Final purge (after retention, with an export and two platform
administrators) is designed in the architecture but not implemented in Phase 1.
"""
from datetime import timedelta

from django.conf import settings
from django.contrib.sessions.models import Session
from django.db import transaction
from django.utils import timezone

from platform_core.audit.services import record_platform_event, record_tenant_event
from platform_core.tenants.models import Tenant
from shared.api.errors import DomainError

S = Tenant.Status
TRANSITIONS = {
    "suspend": ({S.ACTIVE}, S.SUSPENDED),
    "reactivate": ({S.SUSPENDED, S.DEACTIVATED}, S.ACTIVE),
    "deactivate": ({S.ACTIVE, S.SUSPENDED}, S.DEACTIVATED),
    "request_deletion": ({S.DEACTIVATED}, S.PENDING_DELETION),
    "recover": ({S.PENDING_DELETION}, S.DEACTIVATED),
}


def revoke_tenant_sessions(tenant):
    """Delete server-side sessions minted for this tenant. (O(sessions); acceptable until a tenant index is added.)"""
    revoked = 0
    for session in Session.objects.filter(expire_date__gt=timezone.now()).iterator():
        if (session.get_decoded().get("auth_ctx") or {}).get("tenant_id") == str(tenant.id):
            session.delete()
            revoked += 1
    return revoked


def transition(tenant, action, *, actor_user_id, policy=None, request=None):
    if tenant.is_platform:
        raise DomainError("The platform tenant cannot change lifecycle state.", code="platform_tenant_protected")
    allowed_from, target = TRANSITIONS[action]
    with transaction.atomic():
        locked = Tenant.objects.select_for_update().get(pk=tenant.pk)
        if locked.status not in allowed_from:
            raise DomainError(f"Cannot {action} a tenant in status {locked.status}.", code="invalid_state_transition")
        previous = locked.status
        now = timezone.now()
        locked.status = target
        if action == "suspend":
            locked.suspended_at = now
            if policy:
                locked.suspension_policy = policy
        elif action == "reactivate":
            locked.suspended_at = None
            locked.deactivated_at = None
            locked.deletion_requested_at = None
            locked.retention_until = None
        elif action == "deactivate":
            locked.deactivated_at = now
        elif action == "request_deletion":
            locked.deletion_requested_at = now
            locked.retention_until = now + timedelta(days=settings.TENANT_RETENTION_DAYS)
        elif action == "recover":
            if locked.retention_until and locked.retention_until <= now:
                raise DomainError("The retention window has expired.", code="retention_expired")
            locked.deletion_requested_at = None
            locked.retention_until = None
        locked.save()
        meta = {"from": previous, "to": target, "policy": locked.suspension_policy}
        record_platform_event(f"tenant.{action}", actor_user_id=actor_user_id, tenant_id=locked.id, target_type="tenant", target_id=locked.id, metadata=meta, request=request)
        record_tenant_event(locked, f"tenant.{action}", actor_user_id=actor_user_id, target_type="tenant", target_id=locked.id, metadata=meta, request=request)
    hard = target in (S.DEACTIVATED, S.PENDING_DELETION) or (target == S.SUSPENDED and locked.suspension_policy == Tenant.SuspensionPolicy.BLOCKED)
    if hard:
        revoke_tenant_sessions(locked)
    return locked

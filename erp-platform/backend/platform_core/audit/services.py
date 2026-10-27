"""Single entry points for writing audit events (no module writes audit rows directly)."""
from django_tenants.utils import schema_context

from platform_core.audit.models import PlatformAuditEvent
from platform_core.tenant_audit.models import TenantAuditEvent
from shared.logging import correlation_id_var


def _ip(request):
    return request.META.get("REMOTE_ADDR") if request is not None else None


def record_platform_event(action, *, actor_user_id=None, tenant_id=None, target_type="", target_id="", metadata=None, request=None):
    return PlatformAuditEvent.objects.create(
        action=action,
        actor_user_id=actor_user_id,
        tenant_id=tenant_id,
        target_type=target_type,
        target_id=str(target_id or ""),
        metadata=metadata or {},
        correlation_id=correlation_id_var.get(),
        ip_address=_ip(request),
    )


def record_tenant_event(tenant, action, *, actor_user_id=None, target_type="", target_id="", metadata=None, request=None):
    """Write into the given tenant's schema. The tenant is explicit so a wrong ambient schema can never
    receive the event; schema_context restores the previous schema afterwards."""
    with schema_context(tenant.schema_name):
        return TenantAuditEvent.objects.create(
            action=action,
            actor_user_id=actor_user_id,
            target_type=target_type,
            target_id=str(target_id or ""),
            metadata=metadata or {},
            correlation_id=correlation_id_var.get(),
            ip_address=_ip(request),
        )

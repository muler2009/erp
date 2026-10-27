"""Controlled, observable tenant migration fan-out. One tenant's failure never blocks the others and is never
silent: the tenant is marked MIGRATION_FAILED (read-only until repaired) and a platform audit event is written."""
import logging

from django.core.management import call_command
from django.db import connection
from django.utils import timezone

from platform_core.audit.services import record_platform_event
from platform_core.tenants.models import Tenant

logger = logging.getLogger(__name__)
SERVING = (Tenant.Status.ACTIVE, Tenant.Status.SUSPENDED, Tenant.Status.MIGRATION_FAILED)


def migrate_tenants(slugs=None, runner=None):
    """Returns {"ok": [slug...], "failed": {slug: error}}. `runner(schema)` is injectable for tests."""
    runner = runner or (lambda schema: call_command("migrate_schemas", tenant=True, schema_name=schema, interactive=False, verbosity=0))
    qs = Tenant.objects.filter(is_platform=False, status__in=SERVING).order_by("created_at")
    if slugs:
        qs = qs.filter(slug__in=slugs)
    result = {"ok": [], "failed": {}}
    for tenant in list(qs):
        try:
            runner(tenant.schema_name)
        except Exception as exc:  # noqa: BLE001 - recorded, not swallowed
            connection.set_schema_to_public()
            logger.error("tenant migration failed", extra={"tenant": tenant.slug}, exc_info=True)
            result["failed"][tenant.slug] = str(exc)[:500]
            if tenant.status != Tenant.Status.SUSPENDED:  # suspended tenants are already blocked for writes
                Tenant.objects.filter(pk=tenant.pk).update(status=Tenant.Status.MIGRATION_FAILED)
            record_platform_event("tenant.migration.failed", tenant_id=tenant.id, target_type="tenant", target_id=tenant.id, metadata={"error": result["failed"][tenant.slug]})
            continue
        connection.set_schema_to_public()
        if tenant.status == Tenant.Status.MIGRATION_FAILED:
            Tenant.objects.filter(pk=tenant.pk).update(status=Tenant.Status.ACTIVE)
            record_platform_event("tenant.migration.repaired", tenant_id=tenant.id, target_type="tenant", target_id=tenant.id)
        result["ok"].append(tenant.slug)
    return result

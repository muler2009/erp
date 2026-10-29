from celery import shared_task
from django.db import connection
from django_tenants.utils import get_tenant_model, schema_context

from shared.celery import TenantTask


@shared_task(name="hr.daily_tenant", base=TenantTask, bind=True)
def daily_tenant(self):
    """Leave accruals, year-end carry-over and due effective-dated assignment changes for one tenant (all idempotent)."""
    from django.utils import timezone

    from modules.hr import leave_policy, lifecycle, reminders

    today = timezone.now().date()
    return {"accrued": leave_policy.accrue_leave(today), "carried": leave_policy.process_year_end(today.year - 1), "changes_applied": lifecycle.apply_due_changes(today), "reminders": reminders.send_daily(today)}


@shared_task(name="hr.daily_all")
def daily_all():
    """Fan out: one task per serving tenant. The tenant list comes from the registry, never from input."""
    with schema_context("public"):
        schemas = list(get_tenant_model().objects.filter(is_platform=False, status="ACTIVE").values_list("schema_name", flat=True))
    connection.set_schema_to_public()
    for schema in schemas:
        daily_tenant.delay(tenant_schema=schema)
    return len(schemas)

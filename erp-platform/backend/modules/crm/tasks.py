from celery import shared_task
from django.db import connection
from django_tenants.utils import get_tenant_model, schema_context

from shared.celery import TenantTask


@shared_task(name="crm.daily_tenant", base=TenantTask, bind=True)
def daily_tenant(self):
    """Overdue activity reminders and (later slices) service-level escalation for one tenant. All idempotent."""
    from modules.crm import pipeline

    from modules.crm import service_desk

    return {"overdue_reminders": pipeline.send_overdue_reminders(), "escalated": service_desk.escalate_overdue()}


@shared_task(name="crm.daily_all")
def daily_all():
    with schema_context("public"):
        schemas = list(get_tenant_model().objects.filter(is_platform=False, status="ACTIVE").values_list("schema_name", flat=True))
    connection.set_schema_to_public()
    for schema in schemas:
        daily_tenant.delay(tenant_schema=schema)
    return len(schemas)

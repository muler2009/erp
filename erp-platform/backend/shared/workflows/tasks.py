from celery import shared_task
from django.db import connection
from django_tenants.utils import get_tenant_model, schema_context

from shared.celery import TenantTask
from shared.workflows import services


@shared_task(name="workflows.escalate_tenant", base=TenantTask, bind=True)
def escalate_tenant(self):
    return services.escalate_overdue()


@shared_task(name="workflows.escalate_all")
def escalate_all():
    with schema_context("public"):
        schemas = list(get_tenant_model().objects.filter(is_platform=False, status="ACTIVE").values_list("schema_name", flat=True))
    connection.set_schema_to_public()
    for schema in schemas:
        escalate_tenant.delay(tenant_schema=schema)
    return len(schemas)

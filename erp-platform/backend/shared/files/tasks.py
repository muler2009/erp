from celery import shared_task
from django.db import connection
from django_tenants.utils import get_tenant_model, schema_context

from shared.celery import TenantTask
from shared.files import services


@shared_task(name="files.purge_tenant", base=TenantTask, bind=True)
def purge_tenant(self):
    return services.purge_deleted()


@shared_task(name="files.purge_all")
def purge_all():
    with schema_context("public"):
        schemas = list(get_tenant_model().objects.filter(is_platform=False, status__in=["ACTIVE", "SUSPENDED"]).values_list("schema_name", flat=True))
    connection.set_schema_to_public()
    for schema in schemas:
        purge_tenant.delay(tenant_schema=schema)
    return len(schemas)

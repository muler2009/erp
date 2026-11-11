from celery import shared_task
from django.db import connection
from django_tenants.utils import get_tenant_model, schema_context

from shared.celery import TenantTask


@shared_task(name="supply_chain.daily_tenant", base=TenantTask, bind=True)
def daily_tenant(self):
    from modules.supply_chain import jobs

    return jobs.run_daily()


@shared_task(name="supply_chain.daily_all")
def daily_all():
    with schema_context("public"):
        schemas = list(get_tenant_model().objects.filter(is_platform=False, status="ACTIVE").values_list("schema_name", flat=True))
    connection.set_schema_to_public()
    for schema in schemas:
        daily_tenant.delay(tenant_schema=schema)
    return len(schemas)

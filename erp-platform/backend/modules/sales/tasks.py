from celery import shared_task
from django.db import connection
from django_tenants.utils import get_tenant_model, schema_context

from shared.celery import TenantTask


@shared_task(name="sales.daily_tenant", base=TenantTask, bind=True)
def daily_tenant(self):
    """Expire overdue quotations and give newly received stock to backordered lines, for one tenant (idempotent)."""
    from modules.sales import quotes

    from modules.sales import orders_ext

    from modules.sales import billing, contracts, dispatch

    return {"expired_quotations": quotes.expire_overdue(), "backorders_filled": orders_ext.retry_backorders(), "contracts": contracts.run_daily(), "late_deliveries": dispatch.notify_late(), "overdue_reminders": billing.send_overdue_reminders()}


@shared_task(name="sales.daily_all")
def daily_all():
    with schema_context("public"):
        schemas = list(get_tenant_model().objects.filter(is_platform=False, status="ACTIVE").values_list("schema_name", flat=True))
    connection.set_schema_to_public()
    for schema in schemas:
        daily_tenant.delay(tenant_schema=schema)
    return len(schemas)

from celery import shared_task
from django.db import connection
from django_tenants.utils import get_tenant_model, schema_context

from shared.celery import TenantTask
from shared.events.services import relay_outbox


@shared_task(name="events.relay_tenant", base=TenantTask, bind=True)
def relay_tenant_outbox(self):
    return relay_outbox()


@shared_task(name="events.relay_all")
def relay_all():
    """Fan out: one task per serving tenant. The tenant list comes from the registry, never from input."""
    with schema_context("public"):
        schemas = list(get_tenant_model().objects.filter(is_platform=False, status__in=["ACTIVE", "SUSPENDED"]).values_list("schema_name", flat=True))
    connection.set_schema_to_public()
    for schema in schemas:
        relay_tenant_outbox.delay(tenant_schema=schema)
    return len(schemas)

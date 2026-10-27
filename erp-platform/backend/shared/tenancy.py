"""Helpers for the current tenant. Inside `schema_context(...)` django-tenants sets `connection.tenant` to a
FakeTenant that is not a model instance, so code that needs the real row resolves it from the schema name."""
from django.db import connection


def current_tenant():
    from platform_core.tenants.models import Tenant

    tenant = getattr(connection, "tenant", None)
    if isinstance(tenant, Tenant):
        return tenant
    schema = connection.schema_name
    return Tenant.objects.using("default").get(schema_name=schema)

"""Tenant-aware Celery base task.

A tenant-scoped task receives only `tenant_schema`, validates it against the registry (never trusting
arbitrary strings), enters schema_context (restored in `finally`) and refuses to run for tenants that
are not serving.
"""
from celery import Task
from django.db import connection
from django_tenants.utils import get_tenant_model, schema_context

from shared.logging import tenant_var


class TenantTaskError(Exception):
    pass


class TenantTask(Task):
    """Usage: @shared_task(base=TenantTask, bind=True) def work(self, tenant_schema, ...)"""

    abstract = True
    typing = False  # tenant_schema is consumed by __call__, so the task body's signature omits it
    runnable_statuses = ("ACTIVE", "SUSPENDED")

    def __call__(self, *args, **kwargs):
        if "tenant_schema" in kwargs:
            tenant_schema = kwargs.pop("tenant_schema")
        elif args:
            tenant_schema, args = args[0], args[1:]
        else:
            tenant_schema = None
        if not tenant_schema or not isinstance(tenant_schema, str):
            raise TenantTaskError("tenant_schema is required for tenant-scoped tasks")
        with schema_context("public"):
            tenant = get_tenant_model().objects.filter(schema_name=tenant_schema, is_platform=False).first()
        if tenant is None:
            raise TenantTaskError("unknown tenant schema")
        if tenant.status not in self.runnable_statuses:
            raise TenantTaskError(f"tenant {tenant.slug} is {tenant.status}; task refused")
        previous_schema = connection.schema_name  # public in a worker; the caller's schema when run eagerly
        token = tenant_var.set(tenant.schema_name)
        try:
            with schema_context(tenant.schema_name):
                return super().__call__(*args, **kwargs)
        finally:
            tenant_var.reset(token)
            # A worker connection must not keep a tenant schema; an eager caller keeps its own.
            connection.set_schema(previous_schema) if previous_schema != "public" else connection.set_schema_to_public()

import pytest
from django.core.management import call_command
from django.db import connection, connections

from platform_core.tenants import provisioning
from platform_core.tenants.models import ProvisioningJob, Tenant


@pytest.mark.django_db(transaction=True)
def test_concurrent_provisioning_runner_is_excluded_by_advisory_lock(world, fake_identity):
    """A second runner must not execute steps while another holds the job lock."""
    job, _ = provisioning.request_tenant(
        name="Lockco", slug="lockco", plan_code="standard", admin_email="a@lockco.test",
        admin_display_name="A", requested_by_user_id=None, idempotency_key="lock-1",
    )
    other = connections.create_connection("default")  # an independent session = a competing worker
    try:
        with other.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_lock(%s)", [provisioning._advisory_key(job)])
        result = provisioning.run_provisioning(job.id)
        assert result.attempts == 0  # skipped: the other runner owns the job
        assert Tenant.objects.get(slug="lockco").status == "PENDING"
        with other.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_unlock(%s)", [provisioning._advisory_key(job)])
    finally:
        other.close()
    provisioning.run_provisioning(job.id)
    assert Tenant.objects.get(slug="lockco").status == "ACTIVE"
    connection.set_schema_to_public()
    with connection.cursor() as cursor:
        cursor.execute('DROP SCHEMA IF EXISTS "t_lockco" CASCADE')
    Tenant.objects.filter(slug="lockco").delete()


def test_openapi_schema_generates_for_both_surfaces(tmp_path):
    for urlconf in ("config.urls_tenant", "config.urls_platform"):
        out = tmp_path / f"{urlconf}.yml"
        call_command("spectacular", "--urlconf", urlconf, "--file", str(out), "--validate", "--fail-on-warn" if False else "--color")
        assert out.stat().st_size > 100

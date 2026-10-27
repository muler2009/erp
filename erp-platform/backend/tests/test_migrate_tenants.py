import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from platform_core.audit.models import PlatformAuditEvent
from platform_core.tenants.migrations_fanout import migrate_tenants
from platform_core.tenants.models import Tenant


@pytest.mark.django_db
def test_failure_isolated_marked_audited_then_repaired(world):
    calls = []

    def flaky(schema):
        calls.append(schema)
        if schema == world["tenants"]["globex"]["schema"]:
            raise RuntimeError("boom")

    result = migrate_tenants(runner=flaky)
    assert result["ok"] == ["acme"] and list(result["failed"]) == ["globex"] and len(calls) == 2  # acme still ran
    assert Tenant.objects.get(slug="globex").status == "MIGRATION_FAILED" and Tenant.objects.get(slug="acme").status == "ACTIVE"
    assert PlatformAuditEvent.objects.filter(action="tenant.migration.failed").exists()
    repaired = migrate_tenants(runner=lambda schema: None)
    assert sorted(repaired["ok"]) == ["acme", "globex"] and not repaired["failed"]
    assert Tenant.objects.get(slug="globex").status == "ACTIVE"
    assert PlatformAuditEvent.objects.filter(action="tenant.migration.repaired").exists()


@pytest.mark.django_db
def test_command_real_run_is_idempotent_and_exits_nonzero_on_failure(world, monkeypatch):
    call_command("migrate_tenants", "--tenant", "acme")
    from platform_core.tenants import migrations_fanout

    monkeypatch.setattr(migrations_fanout, "call_command", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("bad")))
    with pytest.raises(CommandError):
        call_command("migrate_tenants", "--tenant", "acme")
    assert Tenant.objects.get(slug="acme").status == "MIGRATION_FAILED"

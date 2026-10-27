import pytest
from django.core import mail
from django.db import connection
from django_tenants.utils import schema_context, schema_exists

from platform_core.authorization.models import RoleAssignment, RoleDefinition
from platform_core.catalog import DEFAULT_TENANT_ROLES, MODULES, OWNER_ROLE
from platform_core.tenant_audit.models import TenantAuditEvent
from platform_core.audit.models import PlatformAuditEvent
from platform_core.tenants.models import Domain, ModuleEntitlement, ProvisioningJob, Tenant
from platform_core.tenants.provisioning import request_tenant, run_provisioning
from platform_core.users.models import ExternalIdentity, TenantMembership
from shared.api.errors import DomainError, ValidationFailed


def _request(slug="initech", key=None, email=None):
    return request_tenant(
        name="Initech", slug=slug, plan_code="standard", admin_email=email or f"boss@{slug}.test",
        admin_display_name="Boss", requested_by_user_id=None, idempotency_key=key or f"k-{slug}",
    )


@pytest.mark.django_db
def test_provisioning_creates_a_complete_active_tenant(world, fake_identity):
    job, created = _request()
    assert created
    assert Tenant.objects.get(slug="initech").status == "PENDING"  # registered but not active yet
    run_provisioning(job.id)
    tenant = Tenant.objects.get(slug="initech")
    job.refresh_from_db()
    assert tenant.status == "ACTIVE"
    assert job.status == "SUCCEEDED"
    assert schema_exists("t_initech")
    assert Domain.objects.get(tenant=tenant).domain.startswith("initech.")
    assert ModuleEntitlement.objects.filter(tenant=tenant, entitled=True, enabled=True).count() == len(MODULES)
    with schema_context("t_initech"):
        assert RoleDefinition.objects.filter(is_system=True).count() == len(DEFAULT_TENANT_ROLES)
        owner_assignments = RoleAssignment.objects.filter(role__name=OWNER_ROLE)
        assert owner_assignments.count() == 1
        assert TenantAuditEvent.objects.filter(action="tenant.provisioned").exists()
    assert PlatformAuditEvent.objects.filter(action="tenant.provisioned", tenant_id=tenant.id).exists()
    membership = TenantMembership.objects.get(tenant=tenant)
    assert membership.status == "ACTIVE"
    assert ExternalIdentity.objects.filter(user=membership.user).count() == 1  # fresh Keycloak account linked
    assert f"http://initech.localhost/auth/callback" in fake_identity.redirect_uris
    assert [m.to for m in mail.outbox][-1] == ["boss@initech.test"]
    assert connection.schema_name == "public"


@pytest.mark.django_db
def test_request_is_idempotent_per_key(world, fake_identity):
    job1, created1 = _request("hooli", key="same-key")
    job2, created2 = _request("hooli", key="same-key")
    assert created1 and not created2
    assert job1.id == job2.id
    assert Tenant.objects.filter(slug="hooli").count() == 1
    with pytest.raises(DomainError) as exc:
        _request("piedpiper", key="same-key")
    assert exc.value.detail.code == "idempotency_key_reused"


@pytest.mark.django_db
@pytest.mark.parametrize("slug", ["ab", "-lead", "trail-", "a--b", "has_underscore", "platform", "admin", "x" * 41])
def test_invalid_or_reserved_slugs_are_rejected(world, fake_identity, slug):
    with pytest.raises(ValidationFailed):
        _request(slug, key=f"k-{slug}")
    assert not Tenant.objects.filter(slug=slug, is_platform=False).exists()


@pytest.mark.django_db
def test_slug_is_normalized_to_lowercase(world, fake_identity):
    job, _ = _request("Has-Upper", key="upper")
    assert job.tenant.slug == "has-upper"
    assert job.tenant.schema_name == "t_has_upper"


@pytest.mark.django_db
def test_duplicate_slug_rejected(world, fake_identity):
    with pytest.raises(DomainError) as exc:
        _request("acme", key="dup")
    assert exc.value.detail.code == "slug_taken"


@pytest.mark.django_db
def test_partial_failure_never_activates_and_retry_resumes(world, fake_identity):
    fake_identity.fail_register_redirect = True
    job, _ = _request("umbrella")
    run_provisioning(job.id)
    tenant = Tenant.objects.get(slug="umbrella")
    job.refresh_from_db()
    assert tenant.status == "PROVISIONING_FAILED"  # never silently ACTIVE
    assert job.status == "FAILED"
    steps = {s.name: s for s in job.steps.all()}
    assert steps["create_schema"].status == "SUCCEEDED"
    assert steps["identity_client"].status == "FAILED"
    assert "keycloak unavailable" in steps["identity_client"].error
    assert steps["activate"].status == "PENDING"
    assert PlatformAuditEvent.objects.filter(action="tenant.provisioning.step_failed", tenant_id=tenant.id).exists()

    fake_identity.fail_register_redirect = False
    run_provisioning(job.id)  # retry
    tenant.refresh_from_db()
    job.refresh_from_db()
    steps = {s.name: s for s in job.steps.all()}
    assert tenant.status == "ACTIVE"
    assert job.status == "SUCCEEDED"
    assert steps["create_schema"].attempts == 1  # resumed: completed steps were not re-run
    assert steps["identity_client"].attempts == 2
    assert TenantMembership.objects.filter(tenant=tenant).count() == 1  # no duplicates


@pytest.mark.django_db
def test_rerunning_a_finished_job_is_a_noop(world, fake_identity):
    job, _ = _request("wonka")
    run_provisioning(job.id)
    attempts = ProvisioningJob.objects.get(pk=job.pk).attempts
    run_provisioning(job.id)
    assert ProvisioningJob.objects.get(pk=job.pk).attempts == attempts
    with schema_context("t_wonka"):
        assert RoleAssignment.objects.filter(role__name=OWNER_ROLE).count() == 1


@pytest.mark.django_db
def test_existing_keycloak_account_is_not_linked_by_email(world, fake_identity):
    """If the invited address already has a Keycloak account, provisioning must NOT link it (no email-match
    linking); the person has to prove control with the one-time invite token."""
    fake_identity.users["boss@stark.test"] = "pre-existing-subject"
    job, _ = _request("stark")
    run_provisioning(job.id)
    tenant = Tenant.objects.get(slug="stark")
    membership = TenantMembership.objects.get(tenant=tenant)
    assert tenant.status == "ACTIVE"
    assert membership.status == "INVITED"
    assert not ExternalIdentity.objects.filter(user=membership.user).exists()
    assert "invite=" in mail.outbox[-1].body
    assert membership.invite_token_hash and membership.invite_expires_at


@pytest.mark.django_db
def test_tenant_status_gate_blocks_unprovisioned_tenant_hosts(world, fake_identity):
    from tests.conftest import Api

    job, _ = _request("pending-co")
    response = Api("pending-co.localhost").get("/api/v1/me")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "tenant_unavailable"

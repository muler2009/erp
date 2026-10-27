import pytest
from django.core import mail
from django.db import DatabaseError, IntegrityError, transaction
from django.utils import timezone

from platform_core.audit.models import AppendOnlyError, PlatformAuditEvent
from platform_core.catalog import PLATFORM_PERMISSION_CODES
from platform_core.tenants.models import ModuleEntitlement, Tenant
from platform_core.users.models import ExternalIdentity, PlatformAdmin, PlatformRole, TenantAccessGrant, User
from tests.conftest import ACME_HOST, PLATFORM_HOST, Api, invite_token_from_mail
from tests.fakes import FakeIdentityProvisioner


def code_of(response):
    return response.json()["error"]["code"]


def make_platform_admin(email, sub, roles):
    user = User.objects.create_user(email, email.split("@")[0])
    ExternalIdentity.objects.create(user=user, issuer="https://kc.test/realms/erp", subject=sub)
    admin = PlatformAdmin.objects.create(user=user, status=PlatformAdmin.Status.ACTIVE)
    admin.roles.set(roles)
    return admin


@pytest.fixture
def second_admin(world, idp):
    role = PlatformRole.objects.get(name="platform_superadmin")
    make_platform_admin("second@platform.test", "second-sub", [role])
    api = Api(PLATFORM_HOST)
    assert api.login(idp, "second-sub").status_code == 302
    return api


NEW_TENANT = {"name": "Newco", "slug": "newco", "plan": "standard", "admin_email": "admin@newco.test", "admin_display_name": "New Admin"}


# ------------------------------------------------------------------------- who may enter the platform console
@pytest.mark.django_db
def test_superadmin_is_an_explicit_permission_list_not_a_bypass(world):
    role = PlatformRole.objects.get(name="platform_superadmin")
    assert sorted(role.permissions) == sorted(PLATFORM_PERMISSION_CODES)
    assert "*" not in role.permissions and all(p.startswith("platform.") for p in role.permissions)
    assert not hasattr(User, "is_superuser")


@pytest.mark.django_db
def test_platform_requires_mfa(world, idp):
    api = Api(PLATFORM_HOST)
    assert api.login(idp, "root-sub", invite=world["platform_invite"], amr=("pwd",)).status_code == 302
    response = api.get("/api/v1/platform/me")
    assert response.status_code == 403 and code_of(response) == "mfa_required"
    assert Api(PLATFORM_HOST).get("/api/v1/platform/me").status_code == 401


@pytest.mark.django_db
def test_tenant_users_cannot_enter_the_platform_console(world, idp, acme):
    response = Api(PLATFORM_HOST).login(idp, acme["owner_sub"])  # valid identity, tenant owner, not a platform admin
    assert response.status_code == 403 and code_of(response) == "not_a_platform_admin"


@pytest.mark.django_db
def test_platform_admin_has_no_standing_access_to_tenant_hosts(world, idp, platform_api):
    response = Api(ACME_HOST).login(idp, "root-sub")
    assert response.status_code == 403 and code_of(response) == "not_a_tenant_member"
    replay = Api(ACME_HOST)
    replay.client.cookies = platform_api.client.cookies  # platform session replayed on a tenant host
    assert replay.get("/api/v1/me").status_code in (401, 403)


@pytest.mark.django_db
def test_limited_platform_role_only_gets_its_permissions(world, idp):
    viewer = PlatformRole.objects.create(name="viewer", permissions=["platform.tenants.view"])
    make_platform_admin("viewer@platform.test", "viewer-sub", [viewer])
    api = Api(PLATFORM_HOST)
    assert api.login(idp, "viewer-sub").status_code == 302
    assert api.get("/api/v1/platform/tenants").status_code == 200
    assert api.post("/api/v1/platform/tenants", NEW_TENANT, Idempotency_Key="v-1").status_code == 403
    assert api.get("/api/v1/platform/audit-events").status_code == 403
    assert api.post(f"/api/v1/platform/tenants/{Tenant.objects.get(slug='acme').id}/lifecycle/suspend").status_code == 403


# ------------------------------------------------------------------------- tenant creation through the API
@pytest.mark.django_db
def test_create_tenant_via_api_provisions_and_notifies(platform_api, fake_identity, commit):
    assert platform_api.post("/api/v1/platform/tenants", NEW_TENANT).status_code == 400  # Idempotency-Key required
    mail.outbox = []
    with commit():
        response = platform_api.post("/api/v1/platform/tenants", NEW_TENANT, Idempotency_Key="newco-1")
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["tenant"]["status"] in ("PENDING", "PROVISIONING", "ACTIVE")
    tenant = Tenant.objects.get(slug="newco")
    assert tenant.status == "ACTIVE" and tenant.schema_name == "t_newco"
    assert [m.to for m in mail.outbox] == [["admin@newco.test"]]

    with commit():
        again = platform_api.post("/api/v1/platform/tenants", NEW_TENANT, Idempotency_Key="newco-1")
    assert again.status_code == 200 and again.json()["job"]["id"] == body["job"]["id"]
    assert Tenant.objects.filter(slug="newco").count() == 1

    detail = platform_api.get(f"/api/v1/platform/tenants/{tenant.id}").json()
    assert detail["status"] == "ACTIVE" and {s["name"]: s["status"] for s in detail["provisioning_jobs"][0]["steps"]}["activate"] == "SUCCEEDED"
    assert any(t["slug"] == "newco" for t in platform_api.get("/api/v1/platform/tenants").json()["results"])


@pytest.mark.django_db
def test_failed_provisioning_is_visible_and_retryable_via_api(platform_api, fake_identity, commit):
    fake_identity.fail_register_redirect = True
    with commit():
        platform_api.post("/api/v1/platform/tenants", NEW_TENANT, Idempotency_Key="newco-2")
    tenant = Tenant.objects.get(slug="newco")
    assert tenant.status == "PROVISIONING_FAILED"
    failed = platform_api.get("/api/v1/platform/provisioning-jobs?status=FAILED").json()["results"]
    assert any("identity_client" in j["last_error"] for j in failed)
    fake_identity.fail_register_redirect = False
    with commit():
        retry = platform_api.post(f"/api/v1/platform/tenants/{tenant.id}/provision")
    assert retry.status_code == 202
    tenant.refresh_from_db()
    assert tenant.status == "ACTIVE"
    assert platform_api.post(f"/api/v1/platform/tenants/{tenant.id}/provision").status_code == 409  # not failed anymore


# ------------------------------------------------------------------------- four-eyes: platform admins
@pytest.mark.django_db
def test_platform_admin_creation_needs_a_second_administrator(platform_api, second_admin, idp, commit):
    proposal = platform_api.post("/api/v1/platform/admins", {"email": "third@platform.test", "display_name": "Third", "roles": ["platform_superadmin"]})
    assert proposal.status_code == 201 and proposal.json()["status"] == "PENDING_APPROVAL"
    admin_id = proposal.json()["id"]

    own = platform_api.post(f"/api/v1/platform/admins/{admin_id}/approve")
    assert own.status_code == 403 and code_of(own) == "four_eyes_required"
    assert Api(PLATFORM_HOST).login(idp, "third-sub").status_code == 403  # pending admins cannot sign in

    mail.outbox = []
    with commit():
        approved = second_admin.post(f"/api/v1/platform/admins/{admin_id}/approve")
    assert approved.status_code == 200 and approved.json()["status"] == "INVITED"
    third = Api(PLATFORM_HOST)
    assert third.login(idp, "third-sub", invite=invite_token_from_mail()).status_code == 302
    assert PlatformAdmin.objects.get(id=admin_id).status == "ACTIVE"
    assert third.get("/api/v1/platform/me").status_code == 200
    assert second_admin.post(f"/api/v1/platform/admins/{admin_id}/approve").status_code == 409  # not pending anymore


@pytest.mark.django_db
def test_unknown_platform_role_is_rejected(platform_api):
    response = platform_api.post("/api/v1/platform/admins", {"email": "x@platform.test", "display_name": "X", "roles": ["root"]})
    assert response.status_code == 400 and code_of(response) == "unknown_role"


# ------------------------------------------------------------------------- break-glass access to tenant data
GRANT = {"reason": "Customer reported missing role assignments, ticket investigation.", "ticket_ref": "SUP-1042", "minutes": 30}


@pytest.mark.django_db
def test_cross_tenant_access_is_requested_approved_time_boxed_and_audited(platform_api, second_admin, owner_api, acme):
    path = f"/api/v1/platform/tenants/{acme['id']}/access/role-assignments"
    denied = platform_api.get(path)
    assert denied.status_code == 403 and code_of(denied) == "access_grant_required"  # no implicit access

    grant = platform_api.post("/api/v1/platform/access-grants", {"tenant_id": str(acme["id"]), **GRANT})
    assert grant.status_code == 201
    grant_id = grant.json()["id"]
    assert platform_api.get(path).status_code == 403  # requested != approved

    own = platform_api.post(f"/api/v1/platform/access-grants/{grant_id}/decision", {"approve": True})
    assert own.status_code == 403 and code_of(own) == "four_eyes_required"

    approved = second_admin.post(f"/api/v1/platform/access-grants/{grant_id}/decision", {"approve": True})
    assert approved.status_code == 200 and approved.json()["expires_at"]
    assert second_admin.get(path).status_code == 403  # the grant belongs to the requester only

    allowed = platform_api.get(path)
    assert allowed.status_code == 200 and any(r["role"] == "tenant_owner" for r in allowed.json())

    # Both trails record it, and the tenant can see that the platform accessed its data.
    assert PlatformAuditEvent.objects.filter(action="access.read", tenant_id=acme["id"]).exists()
    tenant_actions = [e["action"] for e in owner_api.get("/api/v1/audit-events").json()["results"]]
    assert "platform_access.granted" in tenant_actions and "platform_access.read" in tenant_actions

    # the grant expires
    TenantAccessGrant.objects.filter(id=grant_id).update(expires_at=timezone.now() - timezone.timedelta(seconds=1))
    assert code_of(platform_api.get(path)) == "access_grant_required"


@pytest.mark.django_db
def test_denied_and_invalid_access_requests(platform_api, second_admin, acme):
    short = platform_api.post("/api/v1/platform/access-grants", {"tenant_id": str(acme["id"]), **{**GRANT, "reason": "because"}})
    assert short.status_code == 400 and code_of(short) == "reason_too_short"
    too_long = platform_api.post("/api/v1/platform/access-grants", {"tenant_id": str(acme["id"]), **{**GRANT, "minutes": 241}})
    assert too_long.status_code == 400 and code_of(too_long) == "invalid_duration"
    grant_id = platform_api.post("/api/v1/platform/access-grants", {"tenant_id": str(acme["id"]), **GRANT}).json()["id"]
    assert second_admin.post(f"/api/v1/platform/access-grants/{grant_id}/decision", {"approve": False}).json()["status"] == "DENIED"
    assert second_admin.post(f"/api/v1/platform/access-grants/{grant_id}/decision", {"approve": True}).status_code == 409


@pytest.mark.django_db
def test_database_rejects_self_approved_grants(world, acme):
    admin = make_platform_admin("solo@platform.test", "solo-sub", [PlatformRole.objects.get(name="platform_superadmin")])
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            TenantAccessGrant.objects.create(requested_by=admin, approved_by=admin, tenant_id=acme["id"], reason="x" * 30, ticket_ref="T-1", requested_minutes=10, status="APPROVED")


# ------------------------------------------------------------------------- lifecycle
@pytest.mark.django_db
def test_suspension_blocks_and_revokes_sessions_then_recovers(platform_api, owner_api, acme, idp):
    assert owner_api.get("/api/v1/users").status_code == 200
    response = platform_api.post(f"/api/v1/platform/tenants/{acme['id']}/lifecycle/suspend", {"policy": "BLOCKED"})
    assert response.status_code == 200 and response.json()["status"] == "SUSPENDED"
    assert owner_api.get("/api/v1/me").status_code == 401  # hard suspension revoked the sessions
    relogin = Api(ACME_HOST)
    assert relogin.login(idp, acme["owner_sub"]).status_code == 302
    assert relogin.get("/api/v1/users").status_code == 403
    assert platform_api.post(f"/api/v1/platform/tenants/{acme['id']}/lifecycle/reactivate").json()["status"] == "ACTIVE"
    assert relogin.get("/api/v1/users").status_code == 200
    assert PlatformAuditEvent.objects.filter(action__in=["tenant.suspend", "tenant.reactivate"], tenant_id=acme["id"]).count() == 2


@pytest.mark.django_db
def test_deletion_requires_deactivation_and_is_recoverable_within_retention(platform_api, owner_api, acme):
    base = f"/api/v1/platform/tenants/{acme['id']}/lifecycle"
    assert platform_api.post(f"{base}/request_deletion").status_code == 409  # cannot jump to deletion from ACTIVE
    assert platform_api.post(f"{base}/deactivate").json()["status"] == "DEACTIVATED"
    assert Api(ACME_HOST).get("/api/v1/me").status_code == 503
    pending = platform_api.post(f"{base}/request_deletion").json()
    assert pending["status"] == "PENDING_DELETION" and pending["retention_until"]
    recovered = platform_api.post(f"{base}/recover").json()
    assert recovered["status"] == "DEACTIVATED" and recovered["retention_until"] is None
    assert platform_api.post(f"{base}/reactivate").json()["status"] == "ACTIVE"
    # data was never destroyed along the way
    from django_tenants.utils import schema_context
    from platform_core.authorization.models import RoleAssignment
    with schema_context(acme["schema"]):
        assert RoleAssignment.objects.filter(role__name="tenant_owner").exists()

    # retention window elapsed -> no recovery
    platform_api.post(f"{base}/deactivate")
    platform_api.post(f"{base}/request_deletion")
    Tenant.objects.filter(id=acme["id"]).update(retention_until=timezone.now() - timezone.timedelta(days=1))
    assert code_of(platform_api.post(f"{base}/recover")) == "retention_expired"
    assert platform_api.post(f"{base}/explode").status_code == 404


@pytest.mark.django_db
def test_platform_tenant_cannot_be_suspended(platform_api):
    platform = Tenant.objects.get(is_platform=True)
    assert platform_api.post(f"/api/v1/platform/tenants/{platform.id}/lifecycle/suspend").status_code == 404


# ------------------------------------------------------------------------- entitlements
@pytest.mark.django_db
def test_platform_controls_module_entitlements(platform_api, owner_api, acme):
    response = platform_api.put(f"/api/v1/platform/tenants/{acme['id']}/entitlements", {"modules": ["finance", "hr"]})
    assert response.status_code == 200
    state = {e["module"]: e for e in response.json()["entitlements"]}
    assert state["finance"]["entitled"] and not state["crm"]["entitled"] and not state["crm"]["enabled"]
    assert sorted(owner_api.get("/api/v1/me").json()["modules"]) == ["finance", "hr"]
    assert owner_api.patch("/api/v1/modules", {"module": "crm", "enabled": True}).status_code == 403
    assert platform_api.put(f"/api/v1/platform/tenants/{acme['id']}/entitlements", {"modules": ["bogus"]}).status_code == 400
    with pytest.raises(IntegrityError):  # a module can never be enabled without being entitled (DB constraint)
        with transaction.atomic():
            ModuleEntitlement.objects.filter(tenant_id=acme["id"], module="crm").update(enabled=True)


# ------------------------------------------------------------------------- audit
@pytest.mark.django_db
def test_platform_audit_log_is_append_only_and_queryable(platform_api, acme):
    platform_api.post(f"/api/v1/platform/tenants/{acme['id']}/lifecycle/suspend", {"policy": "READ_ONLY"})
    events = platform_api.get(f"/api/v1/platform/audit-events?action=tenant.suspend&tenant_id={acme['id']}").json()["results"]
    assert len(events) == 1 and events[0]["metadata"]["to"] == "SUSPENDED" and events[0]["correlation_id"]
    event = PlatformAuditEvent.objects.filter(action="tenant.suspend").first()
    with pytest.raises(AppendOnlyError):
        event.delete()
    with pytest.raises(DatabaseError):
        with transaction.atomic():
            PlatformAuditEvent.objects.filter(pk=event.pk).update(action="tampered")


@pytest.mark.django_db
def test_health_endpoints(world):
    for host in (PLATFORM_HOST, ACME_HOST):
        assert Api(host).get("/healthz").json() == {"status": "ok"}
        assert Api(host).get("/readyz").status_code == 200

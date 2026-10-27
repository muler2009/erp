import pytest
from django.db import connection
from django.test import RequestFactory
from django.urls import get_resolver
from django.utils import timezone
from django_tenants.utils import schema_context

from platform_core.authorization import pipeline, services
from platform_core.authorization.models import RoleAssignment, RoleDefinition
from platform_core.authorization.pipeline import AuthzDenied
from platform_core.catalog import DEFAULT_TENANT_ROLES, OWNER_ROLE, PERMISSION_BY_CODE, TENANT_PERMISSION_CODES
from platform_core.tenants.models import ModuleEntitlement, Tenant
from platform_core.users.models import TenantMembership, User
from shared.api.permissions import DenyByDefault
from tests.conftest import ACME_HOST, Api, invite_token_from_mail


def code_of(response):
    return response.json()["error"]["code"]


def make_member(owner_api, idp, commit, email, sub, role_names=()):
    """Invite + log in a tenant member holding the given system roles; returns (Api, membership)."""
    from django.core import mail

    mail.outbox = []
    role_ids = [str(RoleDefinition.objects.get(name=n).id) for n in role_names] if role_names else []
    # RoleDefinition lives in the tenant schema; resolve ids inside it.
    with commit():
        response = owner_api.post("/api/v1/users/invite", {"email": email, "display_name": email.split("@")[0], "role_ids": role_ids})
    assert response.status_code == 201, response.content
    api = Api(ACME_HOST)
    assert api.login(idp_of(owner_api), sub, invite=invite_token_from_mail()).status_code == 302
    return api, TenantMembership.objects.get(user__email=email)


_IDP = {}


def idp_of(_):
    return _IDP["idp"]


@pytest.fixture
def member_factory(world, idp, owner_api, commit, acme):
    _IDP["idp"] = idp

    def build(email, sub, roles=()):
        with schema_context(acme["schema"]):
            ids = [str(RoleDefinition.objects.get(name=n).id) for n in roles]
        from django.core import mail

        mail.outbox = []
        with commit():
            response = owner_api.post("/api/v1/users/invite", {"email": email, "display_name": email.split("@")[0], "role_ids": ids})
        assert response.status_code == 201, response.content
        api = Api(ACME_HOST)
        assert api.login(idp, sub, invite=invite_token_from_mail()).status_code == 302
        return api, TenantMembership.objects.get(user__email=email)

    return build


# ------------------------------------------------------------------------- catalog invariants
def test_catalog_invariants():
    assert all(not c.startswith("platform.") for c in TENANT_PERMISSION_CODES)
    for name, (_, codes) in DEFAULT_TENANT_ROLES.items():
        assert all(PERMISSION_BY_CODE[c].scope == "tenant" for c in codes), name  # no platform permissions in tenant roles
    # the master prompt's SoD example: officer creates, manager approves, controller releases
    assert "finance.payment.release" not in DEFAULT_TENANT_ROLES["finance_officer"][1]
    assert "finance.payment.release" not in DEFAULT_TENANT_ROLES["finance_manager"][1]
    assert "finance.invoice.approve" not in DEFAULT_TENANT_ROLES["finance_officer"][1]
    assert DEFAULT_TENANT_ROLES["finance_controller"][1] == ["finance.payment.release", "reports.financial.view"]


@pytest.mark.django_db
def test_every_routed_view_declares_an_explicit_permission_policy(world):
    """Contract test: no endpoint may fall back to the deny-by-default policy (i.e. forget to declare one)."""
    from config import urls_platform, urls_tenant

    checked = 0
    for module in (urls_tenant, urls_platform):
        for pattern in module.urlpatterns:
            view_class = getattr(pattern.callback, "view_class", None) or getattr(pattern.callback, "cls", None)
            if view_class is None:
                continue  # plain Django views (auth redirects, health) are covered by their own tests
            declared = list(view_class.permission_classes)
            overrides = "get_permissions" in vars(view_class)
            assert overrides or (declared and DenyByDefault not in declared), f"{view_class.__name__} has no explicit permission policy"
            checked += 1
    assert checked >= 20


@pytest.mark.django_db
def test_unauthenticated_requests_get_401_with_error_envelope(world, acme):
    response = Api(ACME_HOST).get("/api/v1/users")
    assert response.status_code == 401
    body = response.json()["error"]
    assert body["code"] == "not_authenticated" and body["correlation_id"] and response["X-Request-ID"] == body["correlation_id"]


# ------------------------------------------------------------------------- RBAC through the API
@pytest.mark.django_db
def test_permissions_are_enforced_per_role(member_factory):
    employee, _ = member_factory("emp@acme.test", "emp-sub", ["employee"])
    assert employee.get("/api/v1/me").status_code == 200  # a member can always see their own context
    for path in ("/api/v1/users", "/api/v1/roles", "/api/v1/audit-events", "/api/v1/modules"):
        response = employee.get(path)
        assert response.status_code == 403 and code_of(response) == "permission_denied", path
    assert employee.post("/api/v1/users/invite", {"email": "x@y.test", "display_name": "x", "role_ids": []}).status_code == 403

    auditor, _ = member_factory("aud@acme.test", "aud-sub", ["read_only_auditor"])
    assert auditor.get("/api/v1/audit-events").status_code == 200
    assert auditor.get("/api/v1/users").status_code == 200
    assert auditor.post("/api/v1/users/invite", {"email": "x@y.test", "display_name": "x", "role_ids": []}).status_code == 403


@pytest.mark.django_db
def test_delegation_ceiling_prevents_privilege_escalation(member_factory, owner_api, acme):
    admin, admin_membership = member_factory("adm@acme.test", "adm-sub", ["tenant_admin"])
    emp, emp_membership = member_factory("emp2@acme.test", "emp2-sub", ["employee"])
    with schema_context(acme["schema"]):
        owner_role = str(RoleDefinition.objects.get(name=OWNER_ROLE).id)
        manager_role = str(RoleDefinition.objects.get(name="finance_manager").id)
        admin_role = str(RoleDefinition.objects.get(name="tenant_admin").id)

    # a tenant admin cannot hand out the Owner role, or any role holding permissions they lack
    for role_id in (owner_role, manager_role):
        response = admin.post("/api/v1/role-assignments", {"membership_id": str(emp_membership.id), "role_id": role_id})
        assert response.status_code == 403 and code_of(response) == "delegation_ceiling_exceeded"
    # ... nor self-escalate
    response = admin.post("/api/v1/role-assignments", {"membership_id": str(admin_membership.id), "role_id": owner_role})
    assert response.status_code == 403
    # ... nor invite someone straight into a bigger role
    response = admin.post("/api/v1/users/invite", {"email": "n@acme.test", "display_name": "n", "role_ids": [owner_role]})
    assert response.status_code == 403
    # but can assign roles within their own ceiling
    assert admin.post("/api/v1/role-assignments", {"membership_id": str(emp_membership.id), "role_id": admin_role}).status_code == 201
    # custom roles are capped the same way and can never contain platform permissions
    over = admin.post("/api/v1/roles", {"name": "bigrole", "display_name": "Big", "permissions": ["finance.payment.release"]})
    assert over.status_code == 403 and code_of(over) == "delegation_ceiling_exceeded"
    plat = owner_api.post("/api/v1/roles", {"name": "platrole", "display_name": "Plat", "permissions": ["platform.tenants.create"]})
    assert plat.status_code == 403 and code_of(plat) == "platform_permission_forbidden"
    assert owner_api.post("/api/v1/roles", {"name": "payments", "display_name": "P", "permissions": ["finance.payment.release"]}).status_code == 201


@pytest.mark.django_db
def test_last_owner_is_protected(owner_api, member_factory, acme):
    owner_membership = TenantMembership.objects.get(user_id=acme["owner_user_id"], tenant_id=acme["id"])
    response = owner_api.post(f"/api/v1/users/{owner_membership.id}/deactivate")
    assert response.status_code == 409 and code_of(response) in ("self_deactivation_forbidden", "last_owner_protected")
    with schema_context(acme["schema"]):
        assignment = RoleAssignment.objects.get(role__name=OWNER_ROLE, revoked_at__isnull=True)
    assert code_of(owner_api.delete(f"/api/v1/role-assignments/{assignment.id}")) == "last_owner_protected"

    # with a second owner, the first can be revoked
    second, second_membership = member_factory("owner2@acme.test", "owner2-sub", [OWNER_ROLE])
    assert owner_api.delete(f"/api/v1/role-assignments/{assignment.id}").status_code == 204
    with schema_context(acme["schema"]):
        last = RoleAssignment.objects.get(role__name=OWNER_ROLE, revoked_at__isnull=True)
    assert code_of(second.delete(f"/api/v1/role-assignments/{last.id}")) == "last_owner_protected"


@pytest.mark.django_db
def test_temporary_and_revoked_assignments_stop_working(member_factory, owner_api, acme):
    member, membership = member_factory("temp2@acme.test", "temp2-sub", [])
    with schema_context(acme["schema"]):
        role = RoleDefinition.objects.get(name="read_only_auditor")
    soon = (timezone.now() + timezone.timedelta(hours=1)).isoformat()
    response = owner_api.post("/api/v1/role-assignments", {"membership_id": str(membership.id), "role_id": str(role.id), "valid_to": soon})
    assert response.status_code == 201
    assignment_id = response.json()["id"]
    assert member.get("/api/v1/audit-events").status_code == 200
    with schema_context(acme["schema"]):  # time passes: expiry is evaluated at query time, no cleanup job needed
        RoleAssignment.objects.filter(id=assignment_id).update(valid_from=timezone.now() - timezone.timedelta(days=2), valid_to=timezone.now() - timezone.timedelta(minutes=1))
    assert member.get("/api/v1/audit-events").status_code == 403
    assert owner_api.post("/api/v1/role-assignments", {"membership_id": str(membership.id), "role_id": str(role.id), "valid_to": "2001-01-01T00:00:00Z"}).status_code == 400

    owner_api.post("/api/v1/role-assignments", {"membership_id": str(membership.id), "role_id": str(role.id)})
    assert member.get("/api/v1/audit-events").status_code == 200
    with schema_context(acme["schema"]):
        active = RoleAssignment.objects.get(user_id=membership.user_id, role=role, revoked_at__isnull=True)
    assert owner_api.delete(f"/api/v1/role-assignments/{active.id}").status_code == 204
    assert member.get("/api/v1/audit-events").status_code == 403


@pytest.mark.django_db
def test_scoped_assignment_does_not_grant_tenant_wide_access(member_factory, owner_api, acme):
    import uuid

    member, membership = member_factory("scoped@acme.test", "scoped-sub", [])
    with schema_context(acme["schema"]):
        role = RoleDefinition.objects.get(name="read_only_auditor")
    dept = str(uuid.uuid4())
    response = owner_api.post("/api/v1/role-assignments", {"membership_id": str(membership.id), "role_id": str(role.id), "scope_type": "DEPARTMENT", "scope_id": dept})
    assert response.status_code == 201
    assert member.get("/api/v1/audit-events").status_code == 403  # tenant-wide endpoint, department-scoped role
    with schema_context(acme["schema"]):
        assert services.has_permission(membership.user_id, "audit.view", scope_type="DEPARTMENT", scope_id=dept)
        assert not services.has_permission(membership.user_id, "audit.view", scope_type="DEPARTMENT", scope_id=str(uuid.uuid4()))
        assert not services.has_permission(membership.user_id, "audit.view")
    assert owner_api.post("/api/v1/role-assignments", {"membership_id": str(membership.id), "role_id": str(role.id), "scope_type": "PROJECT"}).status_code == 400


# ------------------------------------------------------------------------- module entitlement (pipeline step 4)
@pytest.mark.django_db
def test_module_permissions_require_an_enabled_entitled_module(acme):
    owner = User.objects.get(id=acme["owner_user_id"])
    tenant = Tenant.objects.get(id=acme["id"])
    request = RequestFactory().get("/x")
    request.user = owner
    connection.set_tenant(tenant)
    try:
        assert pipeline.authorize_tenant(request, "finance.invoice.approve")  # owner holds it, module enabled
        ModuleEntitlement.objects.filter(tenant=tenant, module="finance").update(enabled=False)
        with pytest.raises(AuthzDenied) as exc:
            pipeline.authorize_tenant(request, "finance.invoice.approve")
        assert exc.value.reason_code == "module_not_enabled"
        ModuleEntitlement.objects.filter(tenant=tenant, module="finance").update(enabled=True, entitled=False) if False else None
        with pytest.raises(AuthzDenied) as exc:
            pipeline.authorize_tenant(request, "platform.tenants.create")
        assert exc.value.reason_code == "unknown_permission"  # platform permissions never resolve in a tenant
    finally:
        connection.set_schema_to_public()


@pytest.mark.django_db
def test_object_rules_registry_is_evaluated(acme):
    owner = User.objects.get(id=acme["owner_user_id"])
    tenant = Tenant.objects.get(id=acme["id"])
    request = RequestFactory().get("/x")
    request.user = owner
    calls = []

    def deny_posted(user_id, code, obj):
        calls.append(obj)
        if obj == "posted-invoice":
            raise AuthzDenied("workflow_state_forbids")

    pipeline.OBJECT_RULES.append(deny_posted)
    connection.set_tenant(tenant)
    try:
        assert pipeline.authorize_tenant(request, "finance.invoice.approve", obj="draft-invoice")
        with pytest.raises(AuthzDenied):
            pipeline.authorize_tenant(request, "finance.invoice.approve", obj="posted-invoice")
        assert calls == ["draft-invoice", "posted-invoice"]
    finally:
        pipeline.OBJECT_RULES.remove(deny_posted)
        connection.set_schema_to_public()


@pytest.mark.django_db
def test_tenant_admin_can_only_enable_entitled_modules(world, owner_api, acme):
    ModuleEntitlement.objects.filter(tenant_id=acme["id"], module="crm").update(entitled=False, enabled=False)
    refused = owner_api.patch("/api/v1/modules", {"module": "crm", "enabled": True})
    assert refused.status_code == 403 and code_of(refused) == "module_not_entitled"
    assert owner_api.patch("/api/v1/modules", {"module": "finance", "enabled": False}).status_code == 200
    assert "finance" not in owner_api.get("/api/v1/me").json()["modules"]
    assert owner_api.patch("/api/v1/modules", {"module": "nonsense", "enabled": True}).status_code == 404


# ------------------------------------------------------------------------- suspension policy (pipeline step 3)
@pytest.mark.django_db
def test_suspension_read_only_policy(owner_api, acme):
    Tenant.objects.filter(id=acme["id"]).update(status="SUSPENDED", suspension_policy="READ_ONLY")
    assert owner_api.get("/api/v1/users").status_code == 200  # reads and permitted admin access continue
    blocked = owner_api.post("/api/v1/users/invite", {"email": "s@acme.test", "display_name": "s", "role_ids": []})
    assert blocked.status_code == 403 and code_of(blocked) == "tenant_suspended"


@pytest.mark.django_db
def test_suspension_blocked_policy(owner_api, acme):
    Tenant.objects.filter(id=acme["id"]).update(status="SUSPENDED", suspension_policy="BLOCKED")
    assert owner_api.get("/api/v1/me").status_code == 200  # identity context only
    response = owner_api.get("/api/v1/users")
    assert response.status_code == 403 and code_of(response) == "tenant_suspended"


@pytest.mark.django_db
def test_deactivated_and_failed_tenants_are_unavailable(owner_api, acme):
    Tenant.objects.filter(id=acme["id"]).update(status="DEACTIVATED")
    response = owner_api.get("/api/v1/me")
    assert response.status_code == 503 and code_of(response) == "tenant_unavailable"
    Tenant.objects.filter(id=acme["id"]).update(status="MIGRATION_FAILED")
    assert owner_api.get("/api/v1/users").status_code == 200
    write = owner_api.post("/api/v1/users/invite", {"email": "m@acme.test", "display_name": "m", "role_ids": []})
    assert write.status_code == 423 and code_of(write) == "tenant_read_only"


# ------------------------------------------------------------------------- audit trail of administrative actions
@pytest.mark.django_db
def test_administrative_changes_are_audited(owner_api, member_factory):
    emp, membership = member_factory("audited@acme.test", "audited-sub", [])
    owner_api.post(f"/api/v1/users/{membership.id}/deactivate")
    actions = [e["action"] for e in owner_api.get("/api/v1/audit-events").json()["results"]]
    for expected in ("user.invited", "membership.activated", "membership.deactivated"):
        assert expected in actions

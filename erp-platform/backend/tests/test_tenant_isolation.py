"""Tenant isolation at the API, ORM, background-job and database levels."""
import pytest
from celery import shared_task
from django.db import DatabaseError, IntegrityError, connection, transaction
from django_tenants.utils import schema_context

from platform_core.authorization.models import RoleDefinition, RolePermission
from platform_core.tenant_audit.models import TenantAuditEvent
from platform_core.audit.models import AppendOnlyError
from platform_core.tenants.models import Tenant
from shared.celery import TenantTask, TenantTaskError
from tests.conftest import ACME_HOST, GLOBEX_HOST, PLATFORM_HOST, Api


# ------------------------------------------------------------------------- ORM / database level
@pytest.mark.django_db
def test_orm_data_is_schema_isolated(world, acme, globex):
    with schema_context(acme["schema"]):
        RoleDefinition.objects.create(name="acme_only", display_name="Acme only")
    with schema_context(globex["schema"]):
        assert not RoleDefinition.objects.filter(name="acme_only").exists()
    with schema_context(acme["schema"]):
        assert RoleDefinition.objects.filter(name="acme_only").exists()


@pytest.mark.django_db
def test_schema_is_set_and_restored_around_tenant_context(world, acme):
    def current():
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_schema()")
            return cursor.fetchone()[0]

    assert current() == "public"
    with schema_context(acme["schema"]):
        assert current() == acme["schema"]
    assert current() == "public"
    with pytest.raises(RuntimeError):
        with schema_context(acme["schema"]):
            raise RuntimeError("boom")
    assert current() == "public"  # restored even when the block fails


@pytest.mark.django_db
def test_database_forbids_platform_permissions_inside_tenant_schema(world, acme):
    with schema_context(acme["schema"]):
        role = RoleDefinition.objects.create(name="sneaky", display_name="Sneaky")
        with pytest.raises(IntegrityError):
            with transaction.atomic():
                RolePermission.objects.create(role=role, permission_code="platform.tenants.create")


@pytest.mark.django_db
def test_tenant_audit_is_append_only_at_model_and_database_level(world, acme):
    with schema_context(acme["schema"]):
        event = TenantAuditEvent.objects.create(action="test.event")
        event.action = "tampered"
        with pytest.raises(AppendOnlyError):
            event.save()
        with pytest.raises(AppendOnlyError):
            event.delete()
        with pytest.raises(DatabaseError):  # bypass the model: raw UPDATE/DELETE hit the trigger
            with transaction.atomic():
                TenantAuditEvent.objects.filter(pk=event.pk).update(action="tampered")
        with pytest.raises(DatabaseError):
            with transaction.atomic():
                TenantAuditEvent.objects.filter(pk=event.pk).delete()


# ------------------------------------------------------------------------- background jobs
@shared_task(base=TenantTask, bind=True)
def _whoami(self, label="x"):
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_schema()")
        return label, cursor.fetchone()[0]


@shared_task(base=TenantTask, bind=True)
def _explode(self):
    raise RuntimeError("task failed")


@pytest.mark.django_db
def test_celery_tenant_task_runs_in_the_right_schema_and_restores(world, acme, globex):
    assert _whoami.apply(args=[acme["schema"]], kwargs={"label": "a"}).get() == ("a", acme["schema"])
    assert _whoami.apply(kwargs={"tenant_schema": globex["schema"]}).get()[1] == globex["schema"]
    assert connection.schema_name == "public"


@pytest.mark.django_db
def test_celery_tenant_task_requires_a_known_serving_tenant(world, acme):
    with pytest.raises(TenantTaskError):
        _whoami.apply(args=[]).get()  # no schema supplied
    with pytest.raises(TenantTaskError):
        _whoami.apply(args=["t_does_not_exist"]).get()
    with pytest.raises(TenantTaskError):
        _whoami.apply(args=["public"]).get()  # the platform schema is not a tenant
    with pytest.raises(TenantTaskError):
        _whoami.apply(args=["public; DROP SCHEMA t_acme"]).get()  # schemas never come from free-form input
    Tenant.objects.filter(pk=acme["id"]).update(status="DEACTIVATED")
    with pytest.raises(TenantTaskError):
        _whoami.apply(args=[acme["schema"]]).get()


@pytest.mark.django_db
def test_celery_failure_still_restores_schema(world, acme):
    with pytest.raises(RuntimeError):
        _explode.apply(args=[acme["schema"]]).get()
    assert connection.schema_name == "public"


# ------------------------------------------------------------------------- API level
@pytest.mark.django_db
def test_tenant_is_resolved_from_host_only(world, owner_api):
    # The browser claims to be globex via headers; the Host (acme) wins and the claims are ignored.
    response = owner_api.get("/api/v1/me", X_Tenant_ID="globex", X_Tenant="globex", X_Tenant_Schema="t_globex")
    assert response.status_code == 200
    assert response.json()["tenant"]["slug"] == "acme"


@pytest.mark.django_db
def test_unknown_host_is_404_not_public_schema(world):
    for host in ("nope.localhost", "evil.example.com"):
        try:
            response = Api(host).get("/api/v1/me")
        except Exception as exc:  # DisallowedHost for non-allowed hosts is also a rejection
            assert "Invalid HTTP_HOST" in str(exc) or "DisallowedHost" in type(exc).__name__
        else:
            assert response.status_code == 404


@pytest.mark.django_db
def test_owner_of_one_tenant_is_not_a_member_of_another(world, idp, acme):
    globex_api = Api(GLOBEX_HOST)
    response = globex_api.login(idp, acme["owner_sub"])  # valid Keycloak identity, wrong tenant
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "not_a_tenant_member"
    assert globex_api.get("/api/v1/users").status_code in (401, 403)


@pytest.mark.django_db
def test_session_cookie_from_one_tenant_is_rejected_on_another(world, owner_api):
    stolen = owner_api.client.cookies  # replay acme's session cookie against globex's host
    replay = Api(GLOBEX_HOST)
    replay.client.cookies = stolen
    response = replay.get("/api/v1/me")
    assert response.status_code in (401, 403)
    assert response.json()["error"]["code"] in ("session_tenant_mismatch", "not_a_tenant_member")


@pytest.mark.django_db
def test_object_ids_from_another_tenant_do_not_resolve(world, owner_api, idp, globex):
    globex_api = Api(GLOBEX_HOST)
    assert globex_api.login(idp, globex["owner_sub"]).status_code == 302
    foreign = globex_api.get("/api/v1/users").json()["results"][0]["id"]
    for path in (f"/api/v1/users/{foreign}/deactivate",):
        response = owner_api.post(path)
        assert response.status_code == 404  # acme cannot address a globex membership


@pytest.mark.django_db
def test_platform_and_tenant_surfaces_are_not_cross_routable(world, owner_api, platform_api):
    assert owner_api.get("/api/v1/platform/tenants").status_code == 404  # platform API on a tenant host
    assert platform_api.get("/api/v1/users").status_code == 404  # tenant API on the platform host
    assert platform_api.get("/api/v1/me").status_code == 404

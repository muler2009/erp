"""Phase 11 security and operations regression tests.

The sweeps walk every registered route, so a new endpoint added without authorization fails here
even if its author wrote no test for it.
"""
import json
import re
import uuid

import pytest
from django.conf import settings
from django.urls import URLPattern, URLResolver, get_resolver

from platform_core.users.models import ExternalIdentity, TenantMembership, User
from platform_core.tenants.models import Tenant
from tests.conftest import ACME_HOST, GLOBEX_HOST, PLATFORM_HOST, Api

pytestmark = pytest.mark.django_db

ZERO = "00000000-0000-0000-0000-000000000000"


def routes(urlconf):
    """Every concrete URL the conf serves, with converters filled with harmless values."""
    out = []

    def walk(patterns, prefix):
        for p in patterns:
            text = prefix + str(p.pattern)
            if isinstance(p, URLResolver):
                walk(p.url_patterns, text)
            elif isinstance(p, URLPattern):
                path = re.sub(r"<uuid:\w+>", ZERO, text)
                path = re.sub(r"<int:\w+>", "1", path)
                path = re.sub(r"<(?:str|slug|path):\w+>", "x", path)
                path = re.sub(r"<\w+>", "x", path)
                out.append("/" + path.lstrip("/"))

    walk(get_resolver(urlconf).url_patterns, "")
    return sorted(set(out))


TENANT_ROUTES = routes("config.urls_tenant")
PLATFORM_ROUTES = routes("config.urls_platform")
# Routes that are public by design: probes, the OIDC browser flow.
PUBLIC = ("/healthz", "/readyz", "/metrics", "/auth/", "/api/v1/public/")
METHODS = ("get", "post", "patch", "delete")
# Open to any active member because they only ever touch the caller's own data (checked in the views):
# own profile, own notifications, own files, own approval inbox and tasks.
SELF_SERVICE = {
    ("GET", "/api/v1/me"), ("GET", "/api/v1/files"), ("GET", "/api/v1/notification-preferences"), ("GET", "/api/v1/notifications"),
    ("POST", "/api/v1/notifications/read-all"), ("GET", "/api/v1/workflows/inbox"), ("GET", "/api/v1/workflows/instances"),
    ("POST", "/api/v1/workflows/tasks/{id}/decide"), ("POST", "/api/v1/workflows/tasks/{id}/delegate"),
    ("GET", "/api/v1/directory/users"),  # names of active colleagues only; needs a 2+ character query
}


def is_public(path):
    return path.startswith(PUBLIC)


def test_route_inventory_is_not_empty():
    assert len(TENANT_ROUTES) > 300 and len(PLATFORM_ROUTES) > 5


def test_every_api_route_rejects_anonymous_callers(world):
    api = Api(ACME_HOST)
    bad = []
    for path in TENANT_ROUTES:
        if is_public(path):
            continue
        for method in METHODS:
            r = getattr(api, method)(path)
            if r.status_code not in (401, 403, 404, 405):
                bad.append((method.upper(), path, r.status_code))
    assert not bad, bad[:20]


def test_every_platform_route_rejects_anonymous_callers(world):
    api = Api(PLATFORM_HOST)
    bad = []
    for path in PLATFORM_ROUTES:
        if is_public(path):
            continue
        for method in METHODS:
            r = getattr(api, method)(path)
            if r.status_code not in (401, 403, 404, 405):
                bad.append((method.upper(), path, r.status_code))
    assert not bad, bad[:20]


@pytest.fixture
def nobody(world, idp, acme):
    """An active member of the tenant who holds no role at all."""
    tenant = Tenant.objects.get(pk=acme["id"])
    u = User.objects.create_user("nobody@acme.test", "Nobody")
    TenantMembership.objects.create(user=u, tenant=tenant, status="ACTIVE")
    ExternalIdentity.objects.create(user=u, issuer="https://kc.test/realms/erp", subject="nobody-sub")
    api = Api(ACME_HOST)
    assert api.login(idp, "nobody-sub").status_code == 302
    return api


def test_member_without_roles_is_refused_on_every_business_route(nobody):
    """Authenticated is not authorized: with no role, no business endpoint may answer 2xx or 5xx."""
    allowed = []
    errors = []
    for path in TENANT_ROUTES:
        if is_public(path):
            continue
        for method in METHODS:
            r = getattr(nobody, method)(path)
            if r.status_code >= 500:
                errors.append((method.upper(), path, r.status_code))
            elif r.status_code < 300 or r.status_code in (400, 409, 422):
                allowed.append((method.upper(), path, r.status_code))
    assert not errors, errors[:20]
    unexpected = [a for a in allowed if (a[0], re.sub(ZERO, "{id}", a[1])) not in SELF_SERVICE]
    assert not unexpected, unexpected


# ------------------------------------------------------------------ headers, metrics, probes
def test_security_headers_on_api_responses(owner_api):
    r = owner_api.get("/api/v1/me")
    assert r.status_code == 200
    assert r["X-Content-Type-Options"] == "nosniff" and r["X-Frame-Options"] == "DENY"
    assert r["Referrer-Policy"] == "no-referrer"
    assert "frame-ancestors 'none'" in r["Content-Security-Policy"]
    assert r["Cache-Control"] == "no-store"
    assert "camera=()" in r["Permissions-Policy"]
    assert r["X-Request-ID"]


def test_metrics_endpoint_is_closed_unless_token_configured_and_presented(world, settings):
    api = Api(ACME_HOST)
    settings.METRICS_TOKEN = ""
    assert api.get("/metrics").status_code == 404
    settings.METRICS_TOKEN = "s3cret-token-value"
    assert api.get("/metrics").status_code == 401
    assert api.get("/metrics", Authorization="Bearer wrong").status_code == 401
    assert api.get("/metrics", Authorization="Basic s3cret-token-value").status_code == 401
    ok = api.get("/metrics", Authorization="Bearer s3cret-token-value")
    assert ok.status_code == 200 and ok["Content-Type"].startswith("text/plain")
    body = ok.content.decode()
    assert "erp_http_requests_total" in body and "erp_tenants{" in body and "erp_outbox_dead_events" in body
    assert "erp_metrics_scan_ok 1.0" in body
    # on the platform host as well
    assert Api(PLATFORM_HOST).get("/metrics", Authorization="Bearer s3cret-token-value").status_code == 200


def test_metrics_use_route_templates_not_raw_paths(owner_api, settings):
    settings.METRICS_TOKEN = "tok-123456789"
    some_id = str(uuid.uuid4())
    owner_api.get("/api/v1/analytics/kpis/" + some_id)
    body = Api(ACME_HOST).get("/metrics", Authorization="Bearer tok-123456789").content.decode()
    assert "api/v1/analytics/kpis/<uuid:pk>" in body
    assert some_id not in body  # ids never become label values


def test_probes_are_public_and_report_dependencies(world):
    api = Api(ACME_HOST)
    assert api.get("/healthz").status_code == 200
    r = api.get("/readyz")
    assert r.status_code == 200 and r.json()["checks"]["database"] == "ok"


def test_readiness_fails_when_database_is_down(world, monkeypatch):
    from django.db.backends.utils import CursorWrapper

    def boom(self, *a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(CursorWrapper, "execute", boom)
    r = Api(ACME_HOST).get("/readyz")
    assert r.status_code == 503 and r.json()["status"] == "not_ready"


def test_unknown_host_is_404_and_forged_tenant_headers_are_ignored(world, owner_api):
    assert Api("evil.example.com").get("/api/v1/me").status_code == 404
    # A header naming another tenant changes nothing: the host decides.
    r = owner_api.get("/api/v1/me", **{"X-Tenant": "globex", "X-Tenant-ID": "globex", "X-Tenant-Schema": "globex"})
    assert r.status_code == 200 and r.json()["tenant"]["slug"] == "acme" if "tenant" in r.json() else r.status_code == 200


def test_session_from_one_tenant_is_useless_on_another(world, owner_api):
    """Same browser cookies, other tenant's host: no access."""
    other = Api(GLOBEX_HOST)
    other.client.cookies = owner_api.client.cookies
    assert other.get("/api/v1/me").status_code in (401, 403)
    assert other.get("/api/v1/analytics/catalog").status_code in (401, 403)


def test_correlation_id_is_echoed_when_valid_and_replaced_when_not(world):
    api = Api(ACME_HOST)
    assert api.get("/healthz", **{"X-Request-ID": "abc-12345678"})["X-Request-ID"] == "abc-12345678"
    r = api.get("/healthz", **{"X-Request-ID": "bad id\nwith newline"})
    assert re.match(r"^[0-9a-f]{32}$", r["X-Request-ID"])


def test_probes_and_scrapes_answer_on_a_pod_ip_host_but_nothing_else_does(world, settings):
    """Kubelet/Prometheus use the pod IP as Host. Only the operational endpoints may answer there."""
    settings.METRICS_TOKEN = "pod-ip-token-12345"
    api = Api("10.1.2.3:8000")
    assert api.get("/healthz").status_code == 200
    assert api.get("/readyz").status_code == 200
    assert api.get("/metrics").status_code == 401
    assert api.get("/metrics", Authorization="Bearer pod-ip-token-12345").status_code == 200
    assert api.get("/api/v1/me").status_code in (400, 404)
    assert api.post("/healthz").status_code in (400, 404, 405)


def test_openapi_schema_generates_with_every_route(tmp_path):
    from django.core.management import call_command
    out = tmp_path / "o.yaml"
    call_command("spectacular", urlconf="config.urls_tenant", file=str(out), verbosity=0)
    text = out.read_text()
    assert text.startswith("openapi:") and text.count("\n  /api/") > 500


# ------------------------------------------------------------------ browser app bootstrap
def test_public_config_tells_the_app_who_it_is_talking_to(world):
    t = Api(ACME_HOST).get("/api/v1/public/config")
    assert t.status_code == 200
    body = t.json()
    assert body["context"] == "tenant" and body["tenant"]["slug"] == "acme"
    assert body["oidc"]["client_id"] == settings.OIDC["SPA_CLIENT_ID"] and "client_secret" not in json.dumps(body).lower()
    p = Api(PLATFORM_HOST).get("/api/v1/public/config").json()
    assert p["context"] == "platform" and p["tenant"] is None
    assert Api("nope.example.com").get("/api/v1/public/config").status_code == 404
    assert Api(ACME_HOST).post("/api/v1/public/config").status_code == 405

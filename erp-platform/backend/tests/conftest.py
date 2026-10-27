import json
import re
import time
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.conf import settings
from django.core import mail
from django.core.management import call_command
from django.db import connection
from django.test import Client

from platform_core.identity import oidc
from platform_core.tenants.models import Tenant
from platform_core.tenants.provisioning import request_tenant, run_provisioning
from platform_core.users.models import ExternalIdentity
from tests.fakes import FakeIdentityProvisioner

ISSUER = "https://kc.test/realms/erp"
PLATFORM_HOST = settings.PLATFORM_HOST
ACME_HOST = f"acme.{settings.BASE_DOMAIN}"
GLOBEX_HOST = f"globex.{settings.BASE_DOMAIN}"


# ----------------------------------------------------------------------------- fake identity provider
class FakeIdP:
    def __init__(self):
        self.keys = {}
        self.current_kid = None
        self.pending = {}
        self.refresh_ok = True
        self.refresh_calls = 0
        self.redirect_uris = []
        self.add_key("kid-1")

    def add_key(self, kid):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.keys[kid] = key
        self.current_kid = kid
        return key

    def jwks(self):
        keys = []
        for kid, key in self.keys.items():
            jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
            jwk.update({"kid": kid, "use": "sig", "alg": "RS256"})
            keys.append(jwk)
        return {"keys": keys}

    def mint(self, sub, *, aud=None, iss=ISSUER, nonce=None, exp_delta=300, amr=("pwd", "otp"), kid=None, key=None, alg="RS256", extra=None):
        now = int(time.time())
        claims = {"iss": iss, "sub": sub, "aud": aud or settings.OIDC["CLIENT_ID"], "iat": now, "exp": now + exp_delta, "amr": list(amr)}
        if nonce is not None:
            claims["nonce"] = nonce
        claims.update(extra or {})
        use_kid = kid or self.current_kid
        signing_key = key or self.keys.get(use_kid)
        if alg == "HS256":
            return jwt.encode(claims, "secret-secret-secret-secret-secret-1234", algorithm="HS256", headers={"kid": use_kid})
        return jwt.encode(claims, signing_key, algorithm=alg, headers={"kid": use_kid})

    # --- http boundary
    def get_json(self, url):
        if url.endswith("/.well-known/openid-configuration"):
            return {
                "issuer": ISSUER,
                "authorization_endpoint": f"{ISSUER}/protocol/openid-connect/auth",
                "token_endpoint": f"{ISSUER}/protocol/openid-connect/token",
                "jwks_uri": f"{ISSUER}/protocol/openid-connect/certs",
                "end_session_endpoint": f"{ISSUER}/protocol/openid-connect/logout",
            }
        if url.endswith("/certs"):
            return self.jwks()
        raise AssertionError(f"unexpected url {url}")

    def post_form(self, url, data):
        if data["grant_type"] == "authorization_code":
            self.redirect_uris.append(data["redirect_uri"])
            assert data.get("code_verifier"), "PKCE verifier must be sent"
            p = self.pending
            id_token = p.get("id_token_override") or self.mint(p["sub"], nonce=p["nonce"], amr=p.get("amr", ("pwd", "otp")), aud=p.get("aud"))
            return 200, {"access_token": "at-1", "refresh_token": "rt-1", "id_token": id_token, "expires_in": 300, "refresh_expires_in": 1800}
        if data["grant_type"] == "refresh_token":
            self.refresh_calls += 1
            if not self.refresh_ok:
                return 400, {"error": "invalid_grant"}
            return 200, {"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 300, "refresh_expires_in": 1800}
        raise AssertionError(data)


@pytest.fixture
def idp(monkeypatch):
    provider = FakeIdP()
    monkeypatch.setattr(oidc.http, "get_json", provider.get_json)
    monkeypatch.setattr(oidc.http, "post_form", provider.post_form)
    oidc.reset_cache()
    yield provider
    oidc.reset_cache()


@pytest.fixture
def fake_identity():
    FakeIdentityProvisioner.reset()
    yield FakeIdentityProvisioner
    FakeIdentityProvisioner.reset()


# ----------------------------------------------------------------------------- API client helper
class Api:
    def __init__(self, host, enforce_csrf=False):
        self.host = host
        self.client = Client(enforce_csrf_checks=enforce_csrf)

    def _call(self, method, path, data=None, headers=None):
        extra = {f"HTTP_{k.upper().replace('-', '_')}": v for k, v in (headers or {}).items()}
        kwargs = {"HTTP_HOST": self.host, **extra}
        if data is not None:
            kwargs.update(data=json.dumps(data), content_type="application/json")
        elif method != "get":
            kwargs.update(content_type="application/json")
        return getattr(self.client, method)(path, **kwargs)

    def get(self, path, **h):
        return self._call("get", path, headers=h)

    def post(self, path, data=None, **h):
        return self._call("post", path, data if data is not None else {}, headers=h)

    def put(self, path, data=None, **h):
        return self._call("put", path, data if data is not None else {}, headers=h)

    def patch(self, path, data=None, **h):
        return self._call("patch", path, data if data is not None else {}, headers=h)

    def delete(self, path, **h):
        return self._call("delete", path, headers=h)

    def login(self, idp, sub, *, invite=None, amr=("pwd", "otp"), next_path=None, **override):
        """Run the full BFF authorization-code + PKCE flow against the fake IdP."""
        query = ""
        if invite or next_path:
            query = "?" + "&".join(x for x in (f"invite={invite}" if invite else "", f"next={next_path}" if next_path else "") if x)
        response = self.get(f"/auth/login{query}")
        assert response.status_code == 302, response.content
        params = parse_qs(urlparse(response["Location"]).query)
        assert params["code_challenge_method"] == ["S256"]
        idp.pending = {"sub": sub, "nonce": params["nonce"][0], "amr": amr, **override}
        return self.get(f"/auth/callback?code=abc&state={params['state'][0]}")


def invite_token_from_mail(index=-1):
    body = mail.outbox[index].body
    return re.search(r"invite=([\w-]+)", body).group(1)


# ----------------------------------------------------------------------------- session-wide platform + two tenants
@pytest.fixture(scope="session")
def world(django_db_setup, django_db_blocker):
    """Bootstrap the platform and provision two tenants (committed once, shared read-mostly by tests;
    each test still runs in its own rolled-back transaction)."""
    with django_db_blocker.unblock():
        FakeIdentityProvisioner.reset()
        mail.outbox = []
        from io import StringIO

        out = StringIO()
        call_command("bootstrap_platform", admin_email="root@platform.test", admin_name="Root Admin", stdout=out)
        token = re.search(r"invite=([\w-]+)", out.getvalue()).group(1)
        info = {"platform_invite": token, "tenants": {}}
        for slug, name in (("acme", "Acme Ltd"), ("globex", "Globex Corp")):
            job, _ = request_tenant(
                name=name, slug=slug, plan_code="standard", admin_email=f"owner@{slug}.test", admin_display_name=f"{name} Owner",
                requested_by_user_id=None, idempotency_key=f"world-{slug}",
            )
            run_provisioning(job.id)
            tenant = Tenant.objects.get(slug=slug)
            assert tenant.status == "ACTIVE", job.steps.values("name", "status", "error")
            owner = tenant.memberships.select_related("user").get()
            subject = ExternalIdentity.objects.get(user=owner.user).subject
            info["tenants"][slug] = {"id": tenant.id, "schema": tenant.schema_name, "owner_email": owner.user.email, "owner_sub": subject, "owner_user_id": owner.user_id}
        FakeIdentityProvisioner.reset()
        mail.outbox = []
    yield info
    with django_db_blocker.unblock():
        connection.set_schema_to_public()
        for schema in [t["schema"] for t in info["tenants"].values()]:
            with connection.cursor() as cursor:
                cursor.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')


@pytest.fixture
def acme(world):
    return world["tenants"]["acme"]


@pytest.fixture
def globex(world):
    return world["tenants"]["globex"]


@pytest.fixture
def owner_api(world, idp, acme):
    api = Api(ACME_HOST)
    response = api.login(idp, acme["owner_sub"])
    assert response.status_code == 302, response.content
    return api


@pytest.fixture
def platform_api(world, idp):
    api = Api(PLATFORM_HOST)
    response = api.login(idp, "root-sub", invite=world["platform_invite"])
    assert response.status_code == 302, response.content
    return api


@pytest.fixture
def commit(django_capture_on_commit_callbacks):
    """`with commit(): api.post(...)` runs transaction.on_commit callbacks (emails, Celery dispatch)."""
    return lambda: django_capture_on_commit_callbacks(execute=True)


# ----------------------------------------------------------------------------- self-contained tenants (for transactional tests)
@pytest.fixture
def own_tenant(django_db_blocker):
    """Provision a throwaway tenant inside the test (committed data), independent of `world`, which
    transactional tests flush. Cleans up its schema afterwards."""
    from platform_core.catalog import MODULES
    from platform_core.tenants.models import Plan

    created = []

    def make(slug):
        FakeIdentityProvisioner.reset()
        Plan.objects.get_or_create(code="standard", defaults={"name": "Standard", "modules": list(MODULES)})
        job, _ = request_tenant(
            name=slug.title(), slug=slug, plan_code="standard", admin_email=f"owner@{slug}.test", admin_display_name="Owner",
            requested_by_user_id=None, idempotency_key=f"own-{slug}",
        )
        run_provisioning(job.id)
        tenant = Tenant.objects.get(slug=slug)
        assert tenant.status == "ACTIVE", list(job.steps.values("name", "status", "error"))
        created.append(tenant.schema_name)
        return tenant

    yield make
    connection.set_schema_to_public()
    with django_db_blocker.unblock():
        for schema in created:
            with connection.cursor() as cursor:
                cursor.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')

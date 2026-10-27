"""OIDC/BFF authentication: token validation attacks, state/nonce/PKCE, invite linking, sessions, CSRF, refresh."""
import time
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.contrib.sessions.models import Session
from django.test import Client

from platform_core.identity import oidc
from platform_core.identity.authentication import store_tokens
from platform_core.identity.crypto import decrypt_json
from platform_core.users.models import ExternalIdentity, TenantMembership, User
from tests.conftest import ACME_HOST, Api, invite_token_from_mail


def code_of(response):
    return response.json()["error"]["code"]


# ------------------------------------------------------------------------- the happy path
@pytest.mark.django_db
def test_login_uses_pkce_and_a_server_side_session(world, idp, acme):
    api = Api(ACME_HOST)
    response = api.get("/auth/login")
    params = parse_qs(urlparse(response["Location"]).query)
    assert params["response_type"] == ["code"] and params["code_challenge_method"] == ["S256"]
    assert params["redirect_uri"] == [f"http://{ACME_HOST}/auth/callback"]
    assert len(params["state"][0]) >= 32 and len(params["nonce"][0]) >= 32

    idp.pending = {"sub": acme["owner_sub"], "nonce": params["nonce"][0]}
    callback = api.get(f"/auth/callback?code=abc&state={params['state'][0]}")
    assert callback.status_code == 302 and callback["Location"] == "/app/dashboard"
    cookie = api.client.cookies["sessionid"]
    assert cookie["httponly"]
    assert "access_token" not in str(callback.content) and "at-1" not in str(api.client.cookies)  # tokens never reach the browser
    session = Session.objects.get(session_key=cookie.value).get_decoded()
    stored = decrypt_json(session["oidc_tokens"])  # tokens exist only encrypted, server-side
    assert stored["access_token"] == "at-1"
    assert "at-1" not in Session.objects.get(session_key=cookie.value).session_data


@pytest.mark.django_db
def test_open_redirect_is_neutralised(world, idp, acme):
    for evil in ("//evil.example.com", "https://evil.example.com", "/\\evil.example.com"):
        api = Api(ACME_HOST)
        response = api.login(idp, acme["owner_sub"], next_path=evil)
        assert response["Location"] == "/app/dashboard"
    api = Api(ACME_HOST)
    assert api.login(idp, acme["owner_sub"], next_path="/app/finance")["Location"] == "/app/finance"


# ------------------------------------------------------------------------- state / nonce / replay
@pytest.mark.django_db
def test_callback_rejects_bad_state_and_replays(world, idp, acme):
    api = Api(ACME_HOST)
    api.get("/auth/login")
    assert code_of(api.get("/auth/callback?code=abc&state=forged")) == "invalid_login_state"
    assert code_of(api.get("/auth/callback?code=abc&state=forged")) == "no_login_in_progress"  # one-shot

    ok = Api(ACME_HOST)
    response = ok.get("/auth/login")
    state = parse_qs(urlparse(response["Location"]).query)["state"][0]
    idp.pending = {"sub": acme["owner_sub"], "nonce": parse_qs(urlparse(response["Location"]).query)["nonce"][0]}
    assert ok.get(f"/auth/callback?code=abc&state={state}").status_code == 302
    assert code_of(ok.get(f"/auth/callback?code=abc&state={state}")) == "no_login_in_progress"  # replay


@pytest.mark.django_db
def test_callback_without_prior_login_is_rejected(world, idp):
    assert code_of(Api(ACME_HOST).get("/auth/callback?code=abc&state=x")) == "no_login_in_progress"


@pytest.mark.django_db
def test_state_expires(world, idp, acme):
    api = Api(ACME_HOST)
    response = api.get("/auth/login")
    params = parse_qs(urlparse(response["Location"]).query)
    session = api.client.session
    session["oidc"]["created"] = time.time() - 3600
    session.save()
    idp.pending = {"sub": acme["owner_sub"], "nonce": params["nonce"][0]}
    assert code_of(api.get(f"/auth/callback?code=abc&state={params['state'][0]}")) == "invalid_login_state"


@pytest.mark.django_db
def test_id_token_attacks_are_rejected(world, idp, acme):
    sub = acme["owner_sub"]
    attacks = {
        "wrong nonce": dict(id_token_override=None, _mint=dict(nonce="not-the-nonce")),
        "wrong audience": dict(aud="some-other-client"),
        "expired": dict(_mint=dict(exp_delta=-3600)),
        "wrong issuer": dict(_mint=dict(iss="https://evil.test/realms/erp")),
        "foreign signing key": dict(_mint=dict(key=rsa.generate_private_key(public_exponent=65537, key_size=2048))),
        "alg confusion HS256": dict(_mint=dict(alg="HS256")),
        "unknown kid": dict(_mint=dict(kid="kid-unknown", key=idp.keys["kid-1"])),
    }
    for name, spec in attacks.items():
        api = Api(ACME_HOST)
        response = api.get("/auth/login")
        params = parse_qs(urlparse(response["Location"]).query)
        mint = {"nonce": params["nonce"][0], **spec.get("_mint", {})}
        override = idp.mint(sub, aud=spec.get("aud"), **mint)
        idp.pending = {"sub": sub, "nonce": params["nonce"][0], "id_token_override": override}
        result = api.get(f"/auth/callback?code=abc&state={params['state'][0]}")
        assert result.status_code == 401, f"{name}: {result.status_code} {result.content}"
        assert api.get("/api/v1/me").status_code in (401, 403), name  # and no session was created


# ------------------------------------------------------------------------- JWKS rotation
@pytest.mark.django_db
def test_jwks_rotation_is_handled(world, idp, acme, monkeypatch):
    api = Api(ACME_HOST)
    assert api.login(idp, acme["owner_sub"]).status_code == 302  # caches JWKS with kid-1
    monkeypatch.setitem(oidc.settings.OIDC, "JWKS_REFETCH_MIN_INTERVAL", 0)
    idp.add_key("kid-2")  # Keycloak rotated; the cached JWKS does not know kid-2
    api2 = Api(ACME_HOST)
    assert api2.login(idp, acme["owner_sub"]).status_code == 302


# ------------------------------------------------------------------------- identity linking / invites
@pytest.mark.django_db
def test_unknown_identity_without_invite_is_denied(world, idp):
    assert code_of(Api(ACME_HOST).login(idp, "some-stranger")) == "unknown_identity_requires_invite"


@pytest.mark.django_db
def test_valid_keycloak_user_with_same_email_is_not_linked_by_email(world, idp, acme):
    """An attacker registers the owner's email in Keycloak (new subject): must NOT gain the owner's access."""
    assert User.objects.filter(email=acme["owner_email"]).exists()
    response = Api(ACME_HOST).login(idp, "attacker-sub", extra={"email": acme["owner_email"]})
    assert code_of(response) == "unknown_identity_requires_invite"
    assert not ExternalIdentity.objects.filter(subject="attacker-sub").exists()


@pytest.mark.django_db
def test_invite_token_links_identity_once(world, idp, owner_api, acme, commit):
    from django.core import mail

    mail.outbox = []
    with commit():
        response = owner_api.post("/api/v1/users/invite", {"email": "newbie@acme.test", "display_name": "Newbie", "role_ids": []})
    assert response.status_code == 201, response.content
    token = invite_token_from_mail()
    membership = TenantMembership.objects.get(user__email="newbie@acme.test")
    assert membership.status == "INVITED" and membership.invite_token_hash != token  # only a hash is stored

    wrong = Api(ACME_HOST)
    assert code_of(wrong.login(idp, "newbie-sub", invite="not-the-token")) == "unknown_identity_requires_invite"

    newbie = Api(ACME_HOST)
    assert newbie.login(idp, "newbie-sub", invite=token).status_code == 302
    membership.refresh_from_db()
    assert membership.status == "ACTIVE" and membership.invite_token_hash == ""
    assert ExternalIdentity.objects.filter(subject="newbie-sub", user=membership.user).exists()

    replay = Api(ACME_HOST)  # token is single-use; a different identity cannot reuse it
    assert code_of(replay.login(idp, "thief-sub", invite=token)) == "unknown_identity_requires_invite"


@pytest.mark.django_db
def test_expired_invite_is_rejected(world, idp, owner_api, commit):
    from django.core import mail
    from django.utils import timezone

    mail.outbox = []
    with commit():
        owner_api.post("/api/v1/users/invite", {"email": "late@acme.test", "display_name": "Late", "role_ids": []})
    token = invite_token_from_mail()
    TenantMembership.objects.filter(user__email="late@acme.test").update(invite_expires_at=timezone.now() - timezone.timedelta(minutes=1))
    assert code_of(Api(ACME_HOST).login(idp, "late-sub", invite=token)) == "unknown_identity_requires_invite"


@pytest.mark.django_db
def test_deactivated_member_cannot_login_or_keep_session(world, idp, owner_api, acme, commit):
    from django.core import mail

    mail.outbox = []
    with commit():
        owner_api.post("/api/v1/users/invite", {"email": "temp@acme.test", "display_name": "Temp", "role_ids": []})
    temp = Api(ACME_HOST)
    assert temp.login(idp, "temp-sub", invite=invite_token_from_mail()).status_code == 302
    assert temp.get("/api/v1/me").status_code == 200
    membership = TenantMembership.objects.get(user__email="temp@acme.test")
    assert owner_api.post(f"/api/v1/users/{membership.id}/deactivate").status_code == 200
    assert temp.get("/api/v1/me").status_code in (401, 403)  # session was revoked
    assert code_of(Api(ACME_HOST).login(idp, "temp-sub")) == "membership_not_active"


# ------------------------------------------------------------------------- sessions, CSRF, logout
@pytest.mark.django_db
def test_csrf_is_enforced_for_session_authenticated_writes(world, idp, acme):
    api = Api(ACME_HOST, enforce_csrf=True)
    assert api.login(idp, acme["owner_sub"]).status_code == 302
    assert api.get("/auth/csrf").status_code == 204
    csrf = api.client.cookies["csrftoken"].value
    body = {"email": "csrf@acme.test", "display_name": "Csrf", "role_ids": []}
    assert api.post("/api/v1/users/invite", body).status_code == 403  # cookie alone is not enough
    assert api.post("/api/v1/users/invite", body, X_CSRFToken=csrf).status_code == 201


@pytest.mark.django_db
def test_logout_destroys_the_session_and_returns_end_session_url(world, idp, owner_api):
    response = owner_api.post("/auth/logout")
    assert response.status_code == 200
    assert "id_token_hint=" in response.json()["logout_url"]
    assert owner_api.get("/api/v1/me").status_code == 401


@pytest.mark.django_db
def test_session_tokens_refresh_server_side(world, idp, owner_api):
    session = owner_api.client.session
    tokens = decrypt_json(session["oidc_tokens"])
    tokens["access_expires_at"] = int(time.time()) - 10
    store_tokens(session, {"access_token": tokens["access_token"], "refresh_token": "rt-1", "id_token": "x", "expires_in": -10, "refresh_expires_in": 1800})
    session.save()
    assert owner_api.get("/api/v1/me").status_code == 200
    assert idp.refresh_calls == 1
    assert decrypt_json(owner_api.client.session["oidc_tokens"])["access_token"] == "at-2"


@pytest.mark.django_db
def test_failed_refresh_ends_the_session(world, idp, owner_api):
    session = owner_api.client.session
    store_tokens(session, {"access_token": "a", "refresh_token": "rt-1", "id_token": "x", "expires_in": -10, "refresh_expires_in": 1800})
    session.save()
    idp.refresh_ok = False
    response = owner_api.get("/api/v1/me")
    assert response.status_code == 401 and code_of(response) == "session_expired"
    assert owner_api.get("/api/v1/me").status_code == 401


# ------------------------------------------------------------------------- bearer tokens (API clients)
@pytest.mark.django_db
def test_bearer_token_validation(world, idp, acme):
    sub = acme["owner_sub"]
    api = Api(ACME_HOST)
    good = idp.mint(sub, aud="erp-api")
    assert api.get("/api/v1/me", Authorization=f"Bearer {good}").status_code == 200
    bad = {
        "wrong audience": idp.mint(sub, aud="account"),
        "expired": idp.mint(sub, aud="erp-api", exp_delta=-3600),
        "unknown subject": idp.mint("nobody", aud="erp-api"),
        "foreign key": idp.mint(sub, aud="erp-api", key=rsa.generate_private_key(public_exponent=65537, key_size=2048)),
        "alg confusion": idp.mint(sub, aud="erp-api", alg="HS256"),
    }
    for name, token in bad.items():
        assert api.get("/api/v1/me", Authorization=f"Bearer {token}").status_code == 401, name
    assert api.get("/api/v1/me", Authorization="Bearer garbage").status_code == 401
    assert api.get("/api/v1/me").status_code == 401


@pytest.mark.django_db
def test_valid_token_does_not_grant_access_to_another_tenant(world, idp, acme):
    token = idp.mint(acme["owner_sub"], aud="erp-api")
    response = Api("globex.localhost").get("/api/v1/me", Authorization=f"Bearer {token}")
    assert response.status_code == 403 and code_of(response) == "not_a_tenant_member"

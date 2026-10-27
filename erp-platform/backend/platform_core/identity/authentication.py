"""DRF authentication: BFF session (browser) and Bearer JWT (machine/API clients)."""
import time

from django.contrib.auth import logout
from django.db import connection
from rest_framework import authentication, exceptions

from platform_core.identity import oidc
from platform_core.identity.crypto import decrypt_json, encrypt_json
from platform_core.users.models import ExternalIdentity

REFRESH_MARGIN_SECONDS = 30


def store_tokens(session, token_response):
    now = int(time.time())
    session["oidc_tokens"] = encrypt_json(
        {
            "access_token": token_response["access_token"],
            "refresh_token": token_response.get("refresh_token", ""),
            "id_token": token_response.get("id_token", ""),
            "access_expires_at": now + int(token_response.get("expires_in", 300)),
            "refresh_expires_at": now + int(token_response.get("refresh_expires_in", 1800)),
        }
    )


class BFFSessionAuthentication(authentication.SessionAuthentication):
    """Session cookie auth with CSRF enforcement (inherited), tenant binding and server-side token refresh."""

    def authenticate(self, request):
        result = super().authenticate(request)  # CSRF is enforced here for unsafe methods
        if result is None:
            return None
        user, _ = result
        session = request._request.session
        ctx = session.get("auth_ctx") or {}
        tenant = connection.tenant
        # Defence in depth: a session minted on one host is never honoured on another tenant's host.
        if ctx.get("tenant_id") != str(tenant.id):
            raise exceptions.AuthenticationFailed("Session does not belong to this tenant.", code="session_tenant_mismatch")
        self._ensure_fresh(request, session)
        return user, None

    def _ensure_fresh(self, request, session):
        encrypted = session.get("oidc_tokens")
        if not encrypted:
            return
        tokens = decrypt_json(encrypted)
        now = time.time()
        if tokens["access_expires_at"] - REFRESH_MARGIN_SECONDS > now:
            return
        if not tokens.get("refresh_token") or tokens["refresh_expires_at"] <= now:
            logout(request._request)
            raise exceptions.AuthenticationFailed("Session expired.", code="session_expired")
        try:
            refreshed = oidc.refresh(tokens["refresh_token"])
        except oidc.TokenInvalid:
            logout(request._request)
            raise exceptions.AuthenticationFailed("Session expired.", code="session_expired")
        refreshed.setdefault("id_token", tokens.get("id_token", ""))
        store_tokens(session, refreshed)

    def authenticate_header(self, request):
        return 'Session realm="erp"'  # makes DRF answer 401 (not 403) for unauthenticated requests


class BearerJWTAuthentication(authentication.BaseAuthentication):
    """Validates a Keycloak access token (signature, issuer, audience=erp-api, expiry) and maps (iss, sub)
    to a User. A valid token proves *who*, never *which tenant*: tenant comes from the Host and
    membership/permissions are enforced by the pipeline."""

    keyword = "Bearer"

    def authenticate(self, request):
        header = authentication.get_authorization_header(request).split()
        if not header or header[0].decode().lower() != self.keyword.lower():
            return None
        if len(header) != 2:
            raise exceptions.AuthenticationFailed("Invalid Authorization header.")
        try:
            claims = oidc.validate_access_token(header[1].decode())
        except (oidc.TokenInvalid, UnicodeDecodeError) as exc:
            raise exceptions.AuthenticationFailed("Invalid token.", code="invalid_token") from exc
        identity = ExternalIdentity.objects.select_related("user").filter(issuer=claims["iss"], subject=claims["sub"]).first()
        if identity is None or not identity.user.is_active:
            raise exceptions.AuthenticationFailed("Unknown or inactive identity.", code="unknown_identity")
        return identity.user, claims  # request.auth carries the validated claims (incl. amr)

    def authenticate_header(self, request):
        return 'Bearer realm="erp"'

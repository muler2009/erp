"""BFF endpoints (/auth/login, /auth/callback, /auth/logout). The browser never receives tokens."""
import logging
import secrets
import time

from django.conf import settings
from django.contrib.auth import login, logout
from django.db import connection
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from platform_core.audit.services import record_platform_event
from platform_core.identity import oidc
from platform_core.identity.authentication import store_tokens
from platform_core.identity.crypto import decrypt_json
from platform_core.identity.services import LoginDenied, resolve_login
from shared.logging import correlation_id_var

logger = logging.getLogger(__name__)

STATE_TTL_SECONDS = 600


def _error(request, code, status):
    return JsonResponse({"error": {"code": code, "message": code.replace("_", " ").capitalize() + ".", "details": [], "correlation_id": correlation_id_var.get()}}, status=status)


def _redirect_uri(request):
    # request.get_host() is already validated: ALLOWED_HOSTS + TenantMainMiddleware's Domain lookup.
    return f"{settings.PUBLIC_SCHEME}://{request.get_host()}/auth/callback"


def _safe_next(value, default):
    if value and value.startswith("/") and not value.startswith("//") and "\\" not in value:
        return value
    return default


@require_GET
def login_view(request):
    tenant = connection.tenant
    verifier, challenge = oidc.new_pkce()
    state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    default_next = "/platform-admin" if tenant.is_platform else "/app/dashboard"
    request.session["oidc"] = {
        "state": state,
        "nonce": nonce,
        "verifier": verifier,
        "invite": request.GET.get("invite", "")[:200],
        "next": _safe_next(request.GET.get("next"), default_next),
        "host": request.get_host(),
        "tenant_id": str(tenant.id),
        "created": time.time(),
    }
    try:
        url = oidc.authorize_url(redirect_uri=_redirect_uri(request), state=state, nonce=nonce, challenge=challenge)
    except Exception:  # identity provider unreachable
        logger.exception("oidc discovery failed")
        return _error(request, "identity_provider_unavailable", 502)
    return HttpResponseRedirect(url)


@require_GET
def callback_view(request):
    tenant = connection.tenant
    pending = request.session.pop("oidc", None)
    if not pending:
        return _error(request, "no_login_in_progress", 400)
    if request.GET.get("error"):
        return _error(request, "identity_provider_error", 400)
    state = request.GET.get("state", "")
    if (
        not secrets.compare_digest(state, pending["state"])
        or time.time() - pending["created"] > STATE_TTL_SECONDS
        or pending["host"] != request.get_host()
        or pending["tenant_id"] != str(tenant.id)
    ):
        return _error(request, "invalid_login_state", 400)
    code = request.GET.get("code")
    if not code:
        return _error(request, "missing_code", 400)
    try:
        tokens = oidc.exchange_code(code=code, verifier=pending["verifier"], redirect_uri=_redirect_uri(request))
        claims = oidc.validate_id_token(tokens["id_token"], pending["nonce"])
    except oidc.TokenInvalid:
        record_platform_event("auth.login.rejected", tenant_id=tenant.id if not tenant.is_platform else None, metadata={"reason": "token_invalid"}, request=request)
        return _error(request, "invalid_token", 401)
    except Exception:
        logger.exception("oidc callback failed")
        return _error(request, "identity_provider_unavailable", 502)

    try:
        user = resolve_login(claims=claims, tenant=tenant, invite_token=pending["invite"], request=request)
    except LoginDenied as denied:
        record_platform_event(
            "auth.login.denied",
            tenant_id=None if tenant.is_platform else tenant.id,
            metadata={"reason": denied.code, "issuer": claims["iss"]},
            request=request,
        )
        return _error(request, denied.code, 403)

    request.session.cycle_key()
    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    request.session["auth_ctx"] = {
        "tenant_id": str(tenant.id),
        "iss": claims["iss"],
        "sub": claims["sub"],
        "amr": claims.get("amr", []),
    }
    store_tokens(request.session, tokens)
    record_platform_event("auth.login.succeeded", actor_user_id=user.id, tenant_id=None if tenant.is_platform else tenant.id, request=request)
    return HttpResponseRedirect(pending["next"])


@require_POST
@csrf_protect
def logout_view(request):
    id_token = ""
    encrypted = request.session.get("oidc_tokens")
    if encrypted:
        try:
            id_token = decrypt_json(encrypted).get("id_token", "")
        except Exception:
            id_token = ""
    user_id = request.user.id if request.user.is_authenticated else None
    logout(request)  # destroys the server-side session and its tokens
    logout_url = None
    if id_token:
        try:
            logout_url = oidc.end_session_url(
                id_token_hint=id_token, post_logout_redirect_uri=f"{settings.PUBLIC_SCHEME}://{request.get_host()}/"
            )
        except Exception:
            logger.exception("could not build end-session url")
    if user_id:
        record_platform_event("auth.logout", actor_user_id=user_id, request=request)
    return JsonResponse({"logout_url": logout_url})


@require_GET
@ensure_csrf_cookie
def csrf_view(request):
    """The SPA calls this once to receive the CSRF cookie, then echoes it in X-CSRFToken."""
    return HttpResponse(status=204)

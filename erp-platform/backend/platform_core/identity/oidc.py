"""OpenID Connect client: discovery, JWKS (with rotation), authorization-code + PKCE, token validation.

Validation always checks signature (algorithm allow-list), issuer, audience, expiry and required claims.
"""
import base64
import hashlib
import secrets
import threading
import time
from urllib.parse import urlencode

import jwt
from django.conf import settings

from platform_core.identity import http


class TokenInvalid(Exception):
    pass


_lock = threading.Lock()
_cache = {"discovery": (0.0, None), "jwks": (0.0, None), "jwks_fetched": 0.0}


def reset_cache():
    with _lock:
        _cache.update({"discovery": (0.0, None), "jwks": (0.0, None), "jwks_fetched": 0.0})


def conf():
    return settings.OIDC


def discovery():
    now = time.time()
    with _lock:
        fetched, data = _cache["discovery"]
        if data is not None and now - fetched < conf()["DISCOVERY_TTL"]:
            return data
    data = http.get_json(conf()["ISSUER"].rstrip("/") + "/.well-known/openid-configuration")
    if data.get("issuer") != conf()["ISSUER"]:
        raise TokenInvalid("discovery issuer mismatch")
    with _lock:
        _cache["discovery"] = (now, data)
    return data


def _jwks(force=False):
    now = time.time()
    with _lock:
        fetched, data = _cache["jwks"]
        if data is not None and not force:
            return data
        if force and now - _cache["jwks_fetched"] < conf()["JWKS_REFETCH_MIN_INTERVAL"] and data is not None:
            return data  # rate-limit refetches triggered by unknown key ids
    data = http.get_json(discovery()["jwks_uri"])
    with _lock:
        _cache["jwks"] = (now, data)
        _cache["jwks_fetched"] = now
    return data


def _signing_key(kid):
    for attempt in (False, True):  # second pass: key rotation, refetch once
        for jwk in _jwks(force=attempt).get("keys", []):
            if jwk.get("kid") == kid and jwk.get("use", "sig") == "sig":
                return jwt.PyJWK(jwk).key
    raise TokenInvalid("unknown signing key")


def _decode(token, audience):
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise TokenInvalid("malformed token") from exc
    if header.get("alg") not in conf()["ALGORITHMS"] or not header.get("kid"):
        raise TokenInvalid("disallowed algorithm or missing kid")
    key = _signing_key(header["kid"])
    try:
        return jwt.decode(
            token,
            key=key,
            algorithms=conf()["ALGORITHMS"],
            audience=audience,
            issuer=conf()["ISSUER"],
            leeway=conf()["LEEWAY_SECONDS"],
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenInvalid(str(exc)) from exc


def validate_id_token(token, nonce):
    claims = _decode(token, conf()["CLIENT_ID"])
    aud = claims.get("aud")
    if isinstance(aud, list) and len(aud) > 1 and claims.get("azp") != conf()["CLIENT_ID"]:
        raise TokenInvalid("azp mismatch")
    if not nonce or not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
        raise TokenInvalid("nonce mismatch")
    return claims


def validate_access_token(token):
    return _decode(token, conf()["API_AUDIENCE"])


def new_pkce():
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def authorize_url(*, redirect_uri, state, nonce, challenge):
    params = {
        "client_id": conf()["CLIENT_ID"],
        "response_type": "code",
        "scope": conf()["SCOPES"],
        "redirect_uri": redirect_uri,
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return discovery()["authorization_endpoint"] + "?" + urlencode(params)


def exchange_code(*, code, verifier, redirect_uri):
    status, body = http.post_form(
        discovery()["token_endpoint"],
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": conf()["CLIENT_ID"],
            "client_secret": conf()["CLIENT_SECRET"],
            "code_verifier": verifier,
        },
    )
    if status != 200 or "id_token" not in body:
        raise TokenInvalid("code exchange failed")
    return body


def refresh(refresh_token):
    status, body = http.post_form(
        discovery()["token_endpoint"],
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": conf()["CLIENT_ID"],
            "client_secret": conf()["CLIENT_SECRET"],
        },
    )
    if status != 200 or "access_token" not in body:
        raise TokenInvalid("refresh failed")
    return body


def end_session_url(*, id_token_hint, post_logout_redirect_uri):
    endpoint = discovery().get("end_session_endpoint")
    if not endpoint:
        return None
    return endpoint + "?" + urlencode(
        {"id_token_hint": id_token_hint, "post_logout_redirect_uri": post_logout_redirect_uri, "client_id": conf()["CLIENT_ID"]}
    )

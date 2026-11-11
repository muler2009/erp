"""Unauthenticated bootstrap data for the browser app.

The single-page app is served from the tenant's own host, so it asks the host who it is talking to. Only
facts needed to start the sign-in are returned; nothing here is a secret or a business record.
"""
from django.conf import settings
from django.db import connection
from django.http import JsonResponse
from django.views.decorators.http import require_GET


@require_GET
def public_config(request):
    tenant = connection.tenant
    oidc = settings.OIDC
    body = {
        "context": "platform" if tenant.is_platform else "tenant",
        "oidc": {"issuer": oidc["ISSUER"], "client_id": oidc["SPA_CLIENT_ID"], "scope": oidc["SPA_SCOPES"]},
        "tenant": None if tenant.is_platform else {"name": tenant.name, "slug": tenant.slug},
    }
    response = JsonResponse(body)
    response["Cache-Control"] = "public, max-age=60"  # same for every visitor of this host
    return response

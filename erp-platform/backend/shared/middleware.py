"""Request middleware: correlation ids, tenant routing, tenant status gate."""
import logging
import re
import uuid

from django.conf import settings
from django.db import connection
from django.http import JsonResponse
from django_tenants.middleware.main import TenantMainMiddleware

from shared.logging import correlation_id_var, tenant_var, user_var

logger = logging.getLogger(__name__)

_CORRELATION_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
# Headers a browser might send claiming a tenant. They are never an authority; their presence is logged.
_FORBIDDEN_TENANT_HEADERS = ("HTTP_X_TENANT_ID", "HTTP_X_TENANT", "HTTP_X_TENANT_SCHEMA")


class CorrelationIdMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        incoming = request.META.get("HTTP_X_REQUEST_ID", "")
        cid = incoming if _CORRELATION_RE.match(incoming) else uuid.uuid4().hex
        request.correlation_id = cid
        token = correlation_id_var.set(cid)
        try:
            response = self.get_response(request)
        finally:
            # Never leave a tenant schema active on a (possibly reused) connection after a request.
            connection.set_schema_to_public()
            correlation_id_var.reset(token)
            tenant_var.set("-")
            user_var.set("-")
        response["X-Request-ID"] = cid
        return response


class TenantRoutingMiddleware(TenantMainMiddleware):
    """Resolve the tenant strictly from the Host header (validated against the Domain table).

    Unknown hosts get a 404 (SHOW_PUBLIC_IF_NO_TENANT_FOUND is off). Client-supplied tenant headers
    are ignored and logged as security events.
    """

    def process_request(self, request):
        for header in _FORBIDDEN_TENANT_HEADERS:
            if header in request.META:
                logger.warning(
                    "ignored client-supplied tenant header",
                    extra={"extra_fields": {"security_event": "forged_tenant_header", "header": header}},
                )
        response = super().process_request(request)
        tenant = getattr(request, "tenant", None)
        if tenant is not None:
            tenant_var.set(tenant.schema_name)
        return response


class TenantStatusMiddleware:
    """Block requests to tenants that are not in a serving state.

    SUSPENDED is deliberately *not* handled here: it is enforced by the authorization pipeline
    (step 3) so that permitted administrative access can continue per the suspension policy.
    """

    SERVING = {"ACTIVE", "SUSPENDED"}
    READ_ONLY = {"MIGRATION_FAILED"}
    EXEMPT_PREFIXES = ("/healthz", "/readyz")

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        tenant = getattr(request, "tenant", None) or connection.tenant
        if tenant is not None and not getattr(tenant, "is_platform", False) and not request.path.startswith(self.EXEMPT_PREFIXES):
            status = tenant.status
            if status in self.READ_ONLY:
                if request.method not in ("GET", "HEAD", "OPTIONS"):
                    return self._deny(request, "tenant_read_only", "Tenant is in read-only mode.", 423)
            elif status not in self.SERVING:
                return self._deny(request, "tenant_unavailable", "Tenant is not available.", 503)
        return self.get_response(request)

    @staticmethod
    def _deny(request, code, message, http_status):
        return JsonResponse(
            {"error": {"code": code, "message": message, "details": [], "correlation_id": getattr(request, "correlation_id", "")}},
            status=http_status,
        )

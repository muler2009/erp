"""Consistent error envelope: {"error": {"code", "message", "details": [...], "correlation_id"}}."""
from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from shared.logging import correlation_id_var


class DomainError(exceptions.APIException):
    """Business-rule violation raised from application services."""

    status_code = status.HTTP_409_CONFLICT
    default_code = "domain_error"
    default_detail = "The operation violates a business rule."

    def __init__(self, detail=None, code=None, status_code=None):
        super().__init__(detail, code)
        if status_code:
            self.status_code = status_code


class ValidationFailed(DomainError):
    status_code = status.HTTP_400_BAD_REQUEST
    default_code = "validation_error"


def _flatten(detail, prefix=""):
    items = []
    if isinstance(detail, dict):
        for key, value in detail.items():
            items.extend(_flatten(value, f"{prefix}{key}." if prefix or True else key))
    elif isinstance(detail, list):
        for value in detail:
            if isinstance(value, (dict, list)):
                items.extend(_flatten(value, prefix))
            else:
                items.append({"field": prefix.rstrip("."), "code": getattr(value, "code", "invalid"), "message": str(value)})
    else:
        items.append({"field": prefix.rstrip("."), "code": getattr(detail, "code", "invalid"), "message": str(detail)})
    return items


def exception_handler(exc, context):
    response = drf_exception_handler(exc, context)
    if response is None:
        return None
    details = []
    if isinstance(exc, exceptions.ValidationError):
        code, message = "validation_error", "Request validation failed."
        details = _flatten(exc.detail)
    else:
        code = getattr(exc, "default_code", "error")
        if hasattr(exc, "detail") and hasattr(exc.detail, "code"):
            code = exc.detail.code
        message = str(exc.detail) if hasattr(exc, "detail") and not isinstance(exc.detail, (dict, list)) else "Request failed."
        if isinstance(exc, exceptions.NotAuthenticated):
            code = "not_authenticated"
        elif isinstance(exc, exceptions.PermissionDenied):
            code = getattr(exc, "reason_code", None) or "permission_denied"
        elif isinstance(exc, exceptions.Throttled):
            code = "throttled"
    response.data = {"error": {"code": code, "message": message, "details": details, "correlation_id": correlation_id_var.get()}}
    return response

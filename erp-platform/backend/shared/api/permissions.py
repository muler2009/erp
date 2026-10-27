from rest_framework.permissions import BasePermission


class DenyByDefault(BasePermission):
    """Default permission class. A view that does not declare permission_classes is unusable.

    tests/test_authorization_contract.py asserts that no routed view relies on this default.
    """

    message = "This endpoint has no explicit permission policy."

    def has_permission(self, request, view):
        return False

"""Tenant-host API. Every view declares its permission explicitly; services enforce business rules."""
from django.db import connection, transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.authorization.models import RoleAssignment, RoleDefinition
from platform_core.authorization.permissions import IsTenantMember, require
from platform_core.tenant_audit.models import TenantAuditEvent
from platform_core.tenants.models import ModuleEntitlement
from platform_core.users import services as user_services
from platform_core.users.models import TenantMembership
from shared.api.errors import DomainError
from shared.api.pagination import StandardPagination


def _membership_dict(m, roles_by_user):
    return {
        "id": str(m.id), "user_id": str(m.user_id), "email": m.user.email, "display_name": m.user.display_name,
        "status": m.status, "roles": roles_by_user.get(m.user_id, []), "created_at": m.created_at,
    }


def _roles_by_user(user_ids):
    out = {}
    for a in RoleAssignment.objects.filter(user_id__in=user_ids, revoked_at__isnull=True).select_related("role"):
        out.setdefault(a.user_id, []).append({"assignment_id": str(a.id), "role": a.role.name, "scope_type": a.scope_type, "scope_id": a.scope_id and str(a.scope_id), "valid_to": a.valid_to})
    return out


class Me(APIView):
    permission_classes = [IsTenantMember]
    allow_when_suspended_blocked = True

    def get(self, request):
        tenant = connection.tenant
        enabled = list(ModuleEntitlement.objects.filter(tenant=tenant, entitled=True, enabled=True).values_list("module", flat=True))
        return Response({
            "context": "tenant",
            "user": {"id": str(request.user.id), "email": request.user.email, "display_name": request.user.display_name},
            "tenant": {"id": str(tenant.id), "name": tenant.name, "slug": tenant.slug, "status": tenant.status},
            "modules": sorted(enabled),
            "permissions": authz.effective_permissions(request.user.id),  # UI hints only; the backend re-checks every call
        })


class UserList(APIView):
    permission_classes = [require("users.view")]

    def get(self, request):
        qs = TenantMembership.objects.filter(tenant=connection.tenant).select_related("user").order_by("-created_at")
        paginator = StandardPagination()
        page = paginator.paginate_queryset(qs, request)
        roles = _roles_by_user([m.user_id for m in page])
        return paginator.get_paginated_response([_membership_dict(m, roles) for m in page])


class UserInvite(APIView):
    permission_classes = [require("users.create")]

    class In(serializers.Serializer):
        email = serializers.EmailField()
        display_name = serializers.CharField(max_length=200)
        role_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)

    def post(self, request):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        membership = user_services.invite_user(connection.tenant, request.user.id, email=v["email"], display_name=v["display_name"], role_ids=v["role_ids"], request=request)
        return Response(_membership_dict(membership, _roles_by_user([membership.user_id])), status=201)


class UserDeactivate(APIView):
    permission_classes = [require("users.deactivate")]

    def post(self, request, membership_id):
        membership = get_object_or_404(TenantMembership.objects.select_related("user"), id=membership_id, tenant=connection.tenant)
        membership = user_services.set_membership_status(connection.tenant, request.user.id, membership, active=False, request=request)
        return Response(_membership_dict(membership, _roles_by_user([membership.user_id])))


class UserReactivate(APIView):
    permission_classes = [require("users.update")]

    def post(self, request, membership_id):
        membership = get_object_or_404(TenantMembership.objects.select_related("user"), id=membership_id, tenant=connection.tenant)
        membership = user_services.set_membership_status(connection.tenant, request.user.id, membership, active=True, request=request)
        return Response(_membership_dict(membership, _roles_by_user([membership.user_id])))


def _role_dict(role):
    return {"id": str(role.id), "name": role.name, "display_name": role.display_name, "is_system": role.is_system, "permissions": sorted(role.permissions.values_list("permission_code", flat=True))}


class RoleListCreate(APIView):
    def get_permissions(self):
        return [require("roles.manage" if self.request.method == "POST" else "roles.view")()]

    class In(serializers.Serializer):
        name = serializers.RegexField(r"^[a-z][a-z0-9_]{2,60}$", max_length=80)
        display_name = serializers.CharField(max_length=120)
        permissions = serializers.ListField(child=serializers.CharField(), min_length=1)

    def get(self, request):
        return Response([_role_dict(r) for r in RoleDefinition.objects.prefetch_related("permissions").order_by("name")])

    def post(self, request):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        role = authz.create_custom_role(request.user.id, v["name"], v["display_name"], v["permissions"])
        record_tenant_event(connection.tenant, "role.created", actor_user_id=request.user.id, target_type="role", target_id=role.id, metadata={"name": role.name, "permissions": v["permissions"]}, request=request)
        return Response(_role_dict(role), status=201)


class AssignmentCreate(APIView):
    permission_classes = [require("roles.assign")]

    class In(serializers.Serializer):
        membership_id = serializers.UUIDField()
        role_id = serializers.UUIDField()
        scope_type = serializers.ChoiceField(choices=RoleAssignment.ScopeType.values, default="TENANT")
        scope_id = serializers.UUIDField(required=False, allow_null=True)
        valid_to = serializers.DateTimeField(required=False, allow_null=True)

    @transaction.atomic
    def post(self, request):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        membership = get_object_or_404(TenantMembership, id=v["membership_id"], tenant=connection.tenant)
        if membership.status == TenantMembership.Status.DEACTIVATED:
            raise DomainError("Cannot assign roles to a deactivated member.", code="membership_deactivated")
        role = get_object_or_404(RoleDefinition, id=v["role_id"])
        assignment = authz.assign_role(request.user.id, membership.user_id, role, scope_type=v["scope_type"], scope_id=v.get("scope_id"), valid_to=v.get("valid_to"))
        record_tenant_event(connection.tenant, "role.assigned", actor_user_id=request.user.id, target_type="role_assignment", target_id=assignment.id, metadata={"user_id": str(membership.user_id), "role": role.name, "scope_type": assignment.scope_type, "valid_to": str(assignment.valid_to or "")}, request=request)
        return Response({"id": str(assignment.id), "role": role.name, "scope_type": assignment.scope_type}, status=201)


class AssignmentRevoke(APIView):
    permission_classes = [require("roles.assign")]

    @transaction.atomic
    def delete(self, request, assignment_id):
        assignment = get_object_or_404(RoleAssignment.objects.select_related("role"), id=assignment_id)
        authz.revoke_assignment(request.user.id, assignment)
        record_tenant_event(connection.tenant, "role.revoked", actor_user_id=request.user.id, target_type="role_assignment", target_id=assignment.id, metadata={"user_id": str(assignment.user_id), "role": assignment.role.name}, request=request)
        return Response(status=204)


class ModuleList(APIView):
    def get_permissions(self):
        return [require("modules.manage" if self.request.method == "PATCH" else "modules.view")()]

    class In(serializers.Serializer):
        module = serializers.CharField()
        enabled = serializers.BooleanField()

    def get(self, request):
        return Response(list(ModuleEntitlement.objects.filter(tenant=connection.tenant).order_by("module").values("module", "entitled", "enabled")))

    @transaction.atomic
    def patch(self, request):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        row = ModuleEntitlement.objects.select_for_update().filter(tenant=connection.tenant, module=v["module"]).first()
        if row is None:
            raise DomainError("Unknown module.", code="not_found", status_code=404)
        if v["enabled"] and not row.entitled:
            raise DomainError("This module is not part of the tenant's subscription.", code="module_not_entitled", status_code=403)
        row.enabled = v["enabled"]
        row.save(update_fields=["enabled"])
        record_tenant_event(connection.tenant, "module.toggled", actor_user_id=request.user.id, target_type="module", target_id=row.module, metadata={"enabled": row.enabled}, request=request)
        return Response({"module": row.module, "entitled": row.entitled, "enabled": row.enabled})


class AuditList(APIView):
    permission_classes = [require("audit.view")]

    def get(self, request):
        qs = TenantAuditEvent.objects.order_by("-created_at")
        if request.query_params.get("action"):
            qs = qs.filter(action=request.query_params["action"])
        paginator = StandardPagination()
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response([
            {"id": str(e.id), "created_at": e.created_at, "action": e.action, "actor_user_id": e.actor_user_id and str(e.actor_user_id), "target_type": e.target_type, "target_id": e.target_id, "metadata": e.metadata, "correlation_id": e.correlation_id}
            for e in page
        ])

"""Platform-host API (public schema). Views are thin: validation -> application service -> response."""
from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.generics import ListAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from platform_core.audit.models import PlatformAuditEvent
from platform_core.audit.services import record_platform_event
from platform_core.catalog import MODULES
from platform_core.tenants import lifecycle
from platform_core.tenants.models import ModuleEntitlement, ProvisioningJob, Tenant
from platform_core.tenants.provisioning import apply_plan_entitlements, request_tenant
from platform_core.tenants.tasks import provision_tenant_task
from platform_core.users import services
from platform_core.users.models import PlatformAdmin, TenantAccessGrant
from platform_core.users.platform_authz import IsActivePlatformAdmin, platform_permissions, require_platform
from shared.api.errors import DomainError
from shared.api.pagination import StandardPagination


def tenant_dict(t):
    return {
        "id": str(t.id), "name": t.name, "slug": t.slug, "status": t.status, "plan": t.plan.code if t.plan else None,
        "suspension_policy": t.suspension_policy, "created_at": t.created_at, "retention_until": t.retention_until,
    }


def job_dict(job):
    return {
        "id": str(job.id), "tenant_id": str(job.tenant_id), "status": job.status, "attempts": job.attempts,
        "last_error": job.last_error, "created_at": job.created_at, "finished_at": job.finished_at,
        "steps": [{"name": s.name, "status": s.status, "attempts": s.attempts, "error": s.error} for s in job.steps.all()],
    }


def _schedule(job):
    transaction.on_commit(lambda: provision_tenant_task.delay(str(job.id)))


class PlatformMe(APIView):
    permission_classes = [IsActivePlatformAdmin]

    def get(self, request):
        admin = request.platform_admin
        return Response({"user": {"id": str(request.user.id), "email": request.user.email, "display_name": request.user.display_name}, "context": "platform", "permissions": sorted(platform_permissions(admin))})


class TenantListCreate(APIView):
    def get_permissions(self):
        return [require_platform("platform.tenants.create" if self.request.method == "POST" else "platform.tenants.view")()]

    class In(serializers.Serializer):
        name = serializers.CharField(max_length=200)
        slug = serializers.CharField(max_length=40)
        plan = serializers.CharField(default="standard")
        admin_email = serializers.EmailField()
        admin_display_name = serializers.CharField(max_length=200)

    def get(self, request):
        qs = Tenant.objects.filter(is_platform=False).select_related("plan").order_by("-created_at")
        paginator = StandardPagination()
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response([tenant_dict(t) for t in page])

    def post(self, request):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        job, created = request_tenant(
            name=v["name"], slug=v["slug"], plan_code=v["plan"], admin_email=v["admin_email"], admin_display_name=v["admin_display_name"],
            requested_by_user_id=request.user.id, idempotency_key=request.headers.get("Idempotency-Key", ""), request=request,
        )
        if created:
            _schedule(job)
        job.refresh_from_db()
        job = ProvisioningJob.objects.prefetch_related("steps").select_related("tenant").get(pk=job.pk)
        return Response({"tenant": tenant_dict(Tenant.objects.select_related("plan").get(pk=job.tenant_id)), "job": job_dict(job)}, status=201 if created else 200)


class TenantDetail(APIView):
    permission_classes = [require_platform("platform.tenants.view")]

    def get(self, request, tenant_id):
        tenant = get_object_or_404(Tenant.objects.select_related("plan"), id=tenant_id, is_platform=False)
        jobs = ProvisioningJob.objects.filter(tenant=tenant).prefetch_related("steps").order_by("-created_at")[:5]
        ent = list(ModuleEntitlement.objects.filter(tenant=tenant).values("module", "entitled", "enabled"))
        return Response({**tenant_dict(tenant), "entitlements": ent, "provisioning_jobs": [job_dict(j) for j in jobs]})


class TenantRetryProvisioning(APIView):
    permission_classes = [require_platform("platform.tenants.provision")]

    def post(self, request, tenant_id):
        tenant = get_object_or_404(Tenant, id=tenant_id, is_platform=False)
        job = ProvisioningJob.objects.filter(tenant=tenant).order_by("-created_at").first()
        if job is None or tenant.status != Tenant.Status.PROVISIONING_FAILED:
            raise DomainError("Only a tenant in PROVISIONING_FAILED can be retried.", code="invalid_state_transition")
        record_platform_event("tenant.provisioning.retry", actor_user_id=request.user.id, tenant_id=tenant.id, target_type="tenant", target_id=tenant.id, request=request)
        _schedule(job)
        return Response({"job_id": str(job.id), "scheduled": True}, status=202)


class TenantLifecycle(APIView):
    permission_classes = [require_platform("platform.tenants.lifecycle")]

    class In(serializers.Serializer):
        policy = serializers.ChoiceField(choices=Tenant.SuspensionPolicy.values, required=False)

    def post(self, request, tenant_id, action):
        if action not in lifecycle.TRANSITIONS:
            raise DomainError("Unknown lifecycle action.", code="not_found", status_code=404)
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        tenant = get_object_or_404(Tenant, id=tenant_id, is_platform=False)
        tenant = lifecycle.transition(tenant, action, actor_user_id=request.user.id, policy=data.validated_data.get("policy"), request=request)
        return Response(tenant_dict(tenant))


class TenantEntitlements(APIView):
    permission_classes = [require_platform("platform.plans.manage")]

    class In(serializers.Serializer):
        modules = serializers.ListField(child=serializers.ChoiceField(choices=MODULES))

    def put(self, request, tenant_id):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        tenant = get_object_or_404(Tenant, id=tenant_id, is_platform=False)
        wanted = set(data.validated_data["modules"])
        with transaction.atomic():
            apply_plan_entitlements(tenant, enable_new=False)  # ensures one row per module
            for row in ModuleEntitlement.objects.select_for_update().filter(tenant=tenant):
                row.entitled = row.module in wanted
                if not row.entitled:
                    row.enabled = False
                row.save(update_fields=["entitled", "enabled"])
            record_platform_event("tenant.entitlements.changed", actor_user_id=request.user.id, tenant_id=tenant.id, target_type="tenant", target_id=tenant.id, metadata={"modules": sorted(wanted)}, request=request)
        return Response({"entitlements": list(ModuleEntitlement.objects.filter(tenant=tenant).values("module", "entitled", "enabled"))})


class ProvisioningJobList(APIView):
    permission_classes = [require_platform("platform.tenants.view")]

    def get(self, request):
        qs = ProvisioningJob.objects.prefetch_related("steps").order_by("-created_at")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        paginator = StandardPagination()
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response([job_dict(j) for j in page])


class AdminPropose(APIView):
    permission_classes = [require_platform("platform.admins.manage")]

    class In(serializers.Serializer):
        email = serializers.EmailField()
        display_name = serializers.CharField(max_length=200)
        roles = serializers.ListField(child=serializers.CharField(), min_length=1)

    def post(self, request):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        admin = services.propose_platform_admin(request.platform_admin, email=data.validated_data["email"], display_name=data.validated_data["display_name"], role_names=data.validated_data["roles"], request=request)
        return Response({"id": str(admin.id), "status": admin.status}, status=201)


class AdminApprove(APIView):
    permission_classes = [require_platform("platform.admins.approve")]

    def post(self, request, admin_id):
        admin = get_object_or_404(PlatformAdmin, id=admin_id)
        admin = services.approve_platform_admin(request.platform_admin, admin, request=request)
        return Response({"id": str(admin.id), "status": admin.status})


class AccessRequest(APIView):
    permission_classes = [require_platform("platform.access.request")]

    class In(serializers.Serializer):
        tenant_id = serializers.UUIDField()
        reason = serializers.CharField()
        ticket_ref = serializers.CharField(max_length=100)
        minutes = serializers.IntegerField(min_value=1)

    def post(self, request):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        tenant = get_object_or_404(Tenant, id=v["tenant_id"], is_platform=False)
        grant = services.request_access(request.platform_admin, tenant, reason=v["reason"], ticket_ref=v["ticket_ref"], minutes=v["minutes"], request=request)
        return Response({"id": str(grant.id), "status": grant.status}, status=201)


class AccessDecision(APIView):
    permission_classes = [require_platform("platform.access.approve")]

    class In(serializers.Serializer):
        approve = serializers.BooleanField()

    def post(self, request, grant_id):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        grant = get_object_or_404(TenantAccessGrant, id=grant_id)
        grant = services.decide_access(request.platform_admin, grant, approve=data.validated_data["approve"], request=request)
        return Response({"id": str(grant.id), "status": grant.status, "expires_at": grant.expires_at})


class TenantRoleAssignmentsBreakGlass(APIView):
    """Reads tenant-schema data: allowed only with an active, approved, audited grant."""

    permission_classes = [require_platform("platform.access.request")]

    def get(self, request, tenant_id):
        tenant = get_object_or_404(Tenant, id=tenant_id, is_platform=False)
        grant = services.active_grant(request.platform_admin, tenant)
        rows = services.read_tenant_role_assignments(request.platform_admin, tenant, grant, request=request)
        return Response([{"user_id": str(r.user_id), "role": r.role.name, "scope_type": r.scope_type} for r in rows])


class PlatformAuditList(APIView):
    permission_classes = [require_platform("platform.audit.view")]

    def get(self, request):
        qs = PlatformAuditEvent.objects.order_by("-created_at")
        for param, field in (("action", "action"), ("tenant_id", "tenant_id")):
            if request.query_params.get(param):
                qs = qs.filter(**{field: request.query_params[param]})
        paginator = StandardPagination()
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response([
            {"id": str(e.id), "created_at": e.created_at, "action": e.action, "actor_user_id": e.actor_user_id and str(e.actor_user_id), "tenant_id": e.tenant_id and str(e.tenant_id), "target_type": e.target_type, "target_id": e.target_id, "metadata": e.metadata, "correlation_id": e.correlation_id}
            for e in page
        ])

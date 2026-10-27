"""URLs served on the platform host (public schema). Tenant business endpoints are NOT routable here."""
from django.urls import path

from platform_core.identity import views as auth_views
from platform_core.platform_api import views as p
from shared.api.health import healthz, readyz

urlpatterns = [
    path("healthz", healthz),
    path("readyz", readyz),
    path("auth/login", auth_views.login_view),
    path("auth/callback", auth_views.callback_view),
    path("auth/logout", auth_views.logout_view),
    path("auth/csrf", auth_views.csrf_view),
    path("api/v1/platform/me", p.PlatformMe.as_view()),
    path("api/v1/platform/tenants", p.TenantListCreate.as_view()),
    path("api/v1/platform/tenants/<uuid:tenant_id>", p.TenantDetail.as_view()),
    path("api/v1/platform/tenants/<uuid:tenant_id>/provision", p.TenantRetryProvisioning.as_view()),
    path("api/v1/platform/tenants/<uuid:tenant_id>/lifecycle/<str:action>", p.TenantLifecycle.as_view()),
    path("api/v1/platform/tenants/<uuid:tenant_id>/entitlements", p.TenantEntitlements.as_view()),
    path("api/v1/platform/tenants/<uuid:tenant_id>/access/role-assignments", p.TenantRoleAssignmentsBreakGlass.as_view()),
    path("api/v1/platform/provisioning-jobs", p.ProvisioningJobList.as_view()),
    path("api/v1/platform/admins", p.AdminPropose.as_view()),
    path("api/v1/platform/admins/<uuid:admin_id>/approve", p.AdminApprove.as_view()),
    path("api/v1/platform/access-grants", p.AccessRequest.as_view()),
    path("api/v1/platform/access-grants/<uuid:grant_id>/decision", p.AccessDecision.as_view()),
    path("api/v1/platform/audit-events", p.PlatformAuditList.as_view()),
]

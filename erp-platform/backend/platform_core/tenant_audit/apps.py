from django.apps import AppConfig


class TenantAuditConfig(AppConfig):
    name = "platform_core.tenant_audit"
    label = "tenant_audit"
    default_auto_field = "django.db.models.BigAutoField"

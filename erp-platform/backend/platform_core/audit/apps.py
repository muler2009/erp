from django.apps import AppConfig


class AuditConfig(AppConfig):
    name = "platform_core.audit"
    label = "platform_audit"
    default_auto_field = "django.db.models.BigAutoField"

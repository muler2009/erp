from django.apps import AppConfig


class TenantsConfig(AppConfig):
    name = "platform_core.tenants"
    label = "tenants"
    default_auto_field = "django.db.models.BigAutoField"

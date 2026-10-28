from django.apps import AppConfig


class CrmConfig(AppConfig):
    name = "modules.crm"
    label = "crm"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.crm import registration  # noqa: F401

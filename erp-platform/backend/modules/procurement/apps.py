from django.apps import AppConfig


class ProcurementConfig(AppConfig):
    name = "modules.procurement"
    label = "procurement"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.procurement import registration  # noqa: F401

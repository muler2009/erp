from django.apps import AppConfig


class ManufacturingConfig(AppConfig):
    name = "modules.manufacturing"
    label = "manufacturing"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.manufacturing import registration  # noqa: F401

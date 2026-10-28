from django.apps import AppConfig


class InventoryConfig(AppConfig):
    name = "modules.inventory"
    label = "inventory"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.inventory import registration  # noqa: F401

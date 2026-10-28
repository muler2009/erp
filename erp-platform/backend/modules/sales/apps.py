from django.apps import AppConfig


class SalesConfig(AppConfig):
    name = "modules.sales"
    label = "sales"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.sales import registration  # noqa: F401

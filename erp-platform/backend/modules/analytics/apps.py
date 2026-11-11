from django.apps import AppConfig


class AnalyticsConfig(AppConfig):
    name = "modules.analytics"
    label = "analytics"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.analytics import registration  # noqa: F401

from django.apps import AppConfig


class QualityConfig(AppConfig):
    name = "modules.quality"
    label = "quality"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.quality import registration  # noqa: F401

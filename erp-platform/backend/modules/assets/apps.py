from django.apps import AppConfig


class AssetsConfig(AppConfig):
    name = "modules.assets"
    label = "assets"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.assets import registration  # noqa: F401

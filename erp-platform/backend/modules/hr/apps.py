from django.apps import AppConfig


class HrConfig(AppConfig):
    name = "modules.hr"
    label = "hr"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.hr import registration  # noqa: F401

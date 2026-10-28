from django.apps import AppConfig


class FinanceConfig(AppConfig):
    name = "modules.finance"
    label = "finance"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.finance import registration  # noqa: F401 - registers sequences, events, subjects, period checks

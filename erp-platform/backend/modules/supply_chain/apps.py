from django.apps import AppConfig


class SupplyChainConfig(AppConfig):
    name = "modules.supply_chain"
    label = "supply_chain"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.supply_chain import registration  # noqa: F401

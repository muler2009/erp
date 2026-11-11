from django.apps import AppConfig


class DocumentsConfig(AppConfig):
    name = "modules.documents"
    label = "documents"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.documents import registration  # noqa: F401

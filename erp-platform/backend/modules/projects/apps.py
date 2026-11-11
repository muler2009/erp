from django.apps import AppConfig


class ProjectsConfig(AppConfig):
    name = "modules.projects"
    label = "projects"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from modules.projects import registration  # noqa: F401

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("erp")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks(["platform_core.tenants", "shared.events", "shared.notifications", "shared.workflows", "shared.files", "modules.hr"])

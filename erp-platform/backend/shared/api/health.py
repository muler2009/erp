from django.conf import settings
from django.db import connection
from django.http import JsonResponse


def healthz(request):
    """Liveness: the process answers. Never touches dependencies, so a database outage does not restart the pods."""
    return JsonResponse({"status": "ok"})


def _redis_ok(url):
    import redis

    client = redis.Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1)
    try:
        return client.ping()
    finally:
        client.close()


def readyz(request):
    """Readiness: can this instance serve traffic. The database is required; the task broker is reported
    but only degrades (requests do not need it), so a Redis blip does not take every pod out of rotation."""
    checks = {}
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        checks["database"] = "ok"
    except Exception:  # noqa: BLE001
        checks["database"] = "unavailable"
    broker = getattr(settings, "CELERY_BROKER_URL", "")
    if broker.startswith("redis") and not getattr(settings, "CELERY_TASK_ALWAYS_EAGER", False):
        try:
            checks["broker"] = "ok" if _redis_ok(broker) else "degraded"
        except Exception:  # noqa: BLE001
            checks["broker"] = "degraded"
    ready = checks["database"] == "ok"
    status = "ready" if ready and all(v == "ok" for v in checks.values()) else ("degraded" if ready else "not_ready")
    return JsonResponse({"status": status, "checks": checks}, status=200 if ready else 503)

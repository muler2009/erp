from django.db import connection
from django.http import JsonResponse


def healthz(request):
    return JsonResponse({"status": "ok"})


def readyz(request):
    checks = {}
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        checks["database"] = "ok"
    except Exception:  # noqa: BLE001
        checks["database"] = "unavailable"
    ok = all(v == "ok" for v in checks.values())
    return JsonResponse({"status": "ready" if ok else "not_ready", "checks": checks}, status=200 if ok else 503)

"""Prometheus metrics: per-request counters/latency, plus platform gauges computed at scrape time.

/metrics is never public: it needs `Authorization: Bearer <ERP_METRICS_TOKEN>` and answers 404 when no
token is configured. The reverse proxy should also refuse it from outside (see infrastructure/nginx).
Set PROMETHEUS_MULTIPROC_DIR (an empty, writable directory) when running several gunicorn workers.
"""
import hmac
import logging
import os
import time

from django.conf import settings
from django.http import HttpResponse, HttpResponseNotFound
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Histogram, generate_latest, multiprocess
from prometheus_client.core import GaugeMetricFamily

log = logging.getLogger(__name__)

REQUESTS = Counter("erp_http_requests_total", "HTTP requests", ["method", "route", "status"])
LATENCY = Histogram("erp_http_request_seconds", "HTTP request latency", ["method", "route"], buckets=(0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10))
SECURITY_EVENTS = Counter("erp_security_events_total", "Security-relevant events", ["event"])
MAX_TENANTS_SCANNED = 200


def route_of(request):
    """Route template, never the raw path: ids in URLs would explode the label cardinality."""
    match = getattr(request, "resolver_match", None)
    if match is None and request.path in ("/healthz", "/readyz", "/metrics"):
        return request.path
    return (match.route if match and match.route else "unmatched")[:100]


class MetricsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        start = time.perf_counter()
        status = 500
        try:
            response = self.get_response(request)
            status = response.status_code
            return response
        finally:
            route = route_of(request)
            REQUESTS.labels(request.method, route, str(status)).inc()
            LATENCY.labels(request.method, route).observe(time.perf_counter() - start)


class PlatformCollector:
    """Gauges read from the database when Prometheus scrapes. A failure never breaks the scrape."""

    def collect(self):
        from django_tenants.utils import get_tenant_model, schema_context

        tenants = GaugeMetricFamily("erp_tenants", "Tenants by lifecycle status", labels=["status"])
        pending = GaugeMetricFamily("erp_outbox_pending_events", "Domain events waiting for delivery (all scanned tenants)")
        oldest = GaugeMetricFamily("erp_outbox_oldest_pending_age_seconds", "Age of the oldest undelivered event")
        dead = GaugeMetricFamily("erp_outbox_dead_events", "Dead-lettered domain events that need an operator")
        scan_ok = GaugeMetricFamily("erp_metrics_scan_ok", "1 when the tenant scan completed")
        n_pending = n_dead = 0
        oldest_age = 0.0
        ok = 1
        try:
            from django.db.models import Count
            from django.utils import timezone

            from shared.events.models import OutboxEvent

            with schema_context("public"):
                model = get_tenant_model()
                by_status = dict(model.objects.filter(is_platform=False).values_list("status").annotate(n=Count("id")))
                schemas = list(model.objects.filter(is_platform=False, status="ACTIVE").order_by("schema_name").values_list("schema_name", flat=True)[:MAX_TENANTS_SCANNED])
            for status, n in by_status.items():
                tenants.add_metric([status], n)
            now = timezone.now()
            for schema in schemas:
                with schema_context(schema):
                    rows = OutboxEvent.objects.filter(status__in=["PENDING", "DEAD"])
                    for status, n in rows.values_list("status").annotate(n=Count("id")):
                        if status == "PENDING":
                            n_pending += n
                        else:
                            n_dead += n
                    first = OutboxEvent.objects.filter(status="PENDING").order_by("created_at").values_list("created_at", flat=True).first()
                    if first:
                        oldest_age = max(oldest_age, (now - first).total_seconds())
            if len(by_status) and sum(by_status.values()) > MAX_TENANTS_SCANNED:
                ok = 0
        except Exception:  # noqa: BLE001
            log.exception("metrics scrape could not read the database")
            ok = 0
        finally:
            from django.db import connection
            connection.set_schema_to_public()
        pending.add_metric([], n_pending)
        dead.add_metric([], n_dead)
        oldest.add_metric([], oldest_age)
        scan_ok.add_metric([], ok)
        yield from (tenants, pending, oldest, dead, scan_ok)


def _render():
    out = []
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        reg = CollectorRegistry()
        multiprocess.MultiProcessCollector(reg)
        out.append(generate_latest(reg))
    else:
        from prometheus_client import REGISTRY
        out.append(generate_latest(REGISTRY))
    platform = CollectorRegistry()
    platform.register(PlatformCollector())
    out.append(generate_latest(platform))
    return b"".join(out)


def metrics_view(request):
    token = getattr(settings, "METRICS_TOKEN", "")
    if not token:
        return HttpResponseNotFound()
    given = request.META.get("HTTP_AUTHORIZATION", "")
    if not given.startswith("Bearer ") or not hmac.compare_digest(given[7:].encode(), token.encode()):
        SECURITY_EVENTS.labels("metrics_unauthorized").inc()
        resp = HttpResponse(status=401)
        resp["WWW-Authenticate"] = "Bearer"
        return resp
    return HttpResponse(_render(), content_type=CONTENT_TYPE_LATEST)

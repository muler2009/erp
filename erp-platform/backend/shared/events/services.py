"""Domain events: registry, emit (outbox), relay (retry/backoff/dead-letter), idempotent local consumers,
optional external broker (RabbitMQ via kombu).

Delivery is at-least-once. Local consumers are made idempotent by ConsumedEvent; external consumers must
deduplicate on the envelope `id`.
"""
import logging
from datetime import timedelta

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone
from django.utils.module_loading import import_string

from shared.api.errors import DomainError, ValidationFailed
from shared.events.models import ConsumedEvent, OutboxEvent
from shared.logging import correlation_id_var

logger = logging.getLogger(__name__)

# ----------------------------------------------------------------------------- registry
_EVENT_TYPES = {}  # type -> {"version": int, "required": set[str]}
_CONSUMERS = {}  # event_type -> [(consumer_name, handler)]


def register_event(event_type, *, version=1, required=()):
    _EVENT_TYPES[event_type] = {"version": version, "required": set(required)}


def subscribe(event_type, consumer_name):
    """Decorator: register a local consumer. `handler(envelope)` runs at most once per event (per consumer)."""

    def wrap(handler):
        _CONSUMERS.setdefault(event_type, [])
        _CONSUMERS[event_type] = [(n, h) for n, h in _CONSUMERS[event_type] if n != consumer_name] + [(consumer_name, handler)]
        return handler

    return wrap


def unsubscribe(event_type, consumer_name):
    _CONSUMERS[event_type] = [(n, h) for n, h in _CONSUMERS.get(event_type, []) if n != consumer_name]


# Core events (modules register theirs at import time).
register_event("tenant.provisioned", required=["tenant_id", "slug"])
register_event("tenant.user.created", required=["user_id", "email"])
register_event("workflow.approval.completed", required=["instance_id", "subject_type", "subject_id", "outcome"])
register_event("org.department.changed", required=["department_id", "change"])
register_event("org.period.closed", required=["period_id", "fiscal_year", "number"])
register_event("org.period.reopened", required=["period_id", "fiscal_year", "number"])


# ----------------------------------------------------------------------------- emit
def emit(event_type, payload, *, dedup_key=None):
    """Write an event to the current tenant's outbox. Call inside the business transaction."""
    spec = _EVENT_TYPES.get(event_type)
    if spec is None:
        raise ValidationFailed(f"Unregistered event type '{event_type}'.", code="unknown_event_type")
    missing = sorted(spec["required"] - set(payload))
    if missing:
        raise ValidationFailed(f"Event '{event_type}' is missing fields: {', '.join(missing)}", code="invalid_event_payload")
    if dedup_key:
        existing = OutboxEvent.objects.filter(dedup_key=dedup_key).first()
        if existing:
            return existing
    return OutboxEvent.objects.create(
        event_type=event_type, version=spec["version"], payload=payload, dedup_key=dedup_key, correlation_id=correlation_id_var.get() if correlation_id_var.get() != "-" else "",
    )


def envelope_for(event):
    tenant = connection.tenant
    return {
        "id": str(event.id), "type": event.event_type, "version": event.version, "tenant": tenant.schema_name,
        "occurred_at": event.created_at.isoformat(), "correlation_id": event.correlation_id, "payload": event.payload,
    }


# ----------------------------------------------------------------------------- brokers
class Broker:
    def publish(self, envelope):
        raise NotImplementedError


class KombuBroker(Broker):
    """Publishes to a topic exchange (routing key = event type). Works with RabbitMQ (amqp://...) and with
    kombu's in-memory transport (used in tests). Messages are persistent with the event id as message_id."""

    def __init__(self, url=None, exchange=None):
        self.url = url or settings.EVENT_BROKER_URL
        self.exchange_name = exchange or settings.EVENT_EXCHANGE

    def publish(self, envelope):
        from kombu import Connection, Exchange

        exchange = Exchange(self.exchange_name, type="topic", durable=True)
        with Connection(self.url, connect_timeout=5) as conn:
            producer = conn.Producer(serializer="json")
            producer.publish(
                envelope, exchange=exchange, routing_key=envelope["type"], declare=[exchange], delivery_mode=2,
                headers={"message_id": envelope["id"], "tenant": envelope["tenant"], "version": envelope["version"]},
                retry=True, retry_policy={"max_retries": 2, "interval_start": 0, "interval_step": 0.2},
            )


def get_external_broker():
    path = getattr(settings, "EVENT_BROKER_CLASS", "")
    if path:
        return import_string(path)()
    return KombuBroker() if settings.EVENT_BROKER_URL else None


# ----------------------------------------------------------------------------- delivery
def dispatch_local(event):
    envelope = envelope_for(event)
    for name, handler in list(_CONSUMERS.get(event.event_type, [])):
        with transaction.atomic():
            _, created = ConsumedEvent.objects.get_or_create(consumer=name, event_id=event.id)
            if not created:
                continue  # already processed in an earlier delivery attempt
            handler(envelope)  # an exception rolls back the ledger row, so the retry re-runs this consumer


def _backoff(attempts):
    return timedelta(seconds=min(2 ** attempts * 5, 3600))


def relay_outbox(batch_size=100):
    """Deliver due events of the CURRENT tenant schema. Returns (published, failed, dead)."""
    published = failed = dead = 0
    broker = get_external_broker()
    with transaction.atomic():
        due = list(
            OutboxEvent.objects.select_for_update(skip_locked=True)
            .filter(status=OutboxEvent.Status.PENDING, next_attempt_at__lte=timezone.now())
            .order_by("created_at")[:batch_size]
        )
        for event in due:
            try:
                dispatch_local(event)
                if broker is not None:
                    broker.publish(envelope_for(event))
            except Exception as exc:  # noqa: BLE001 - recorded on the event; never swallowed silently
                event.attempts += 1
                event.last_error = f"{type(exc).__name__}: {exc}"[:2000]
                if event.attempts >= settings.EVENT_MAX_ATTEMPTS:
                    event.status = OutboxEvent.Status.DEAD
                    dead += 1
                    logger.error("event dead-lettered", extra={"extra_fields": {"event_id": str(event.id), "type": event.event_type, "error": event.last_error}})
                else:
                    event.next_attempt_at = timezone.now() + _backoff(event.attempts)
                    failed += 1
                    logger.warning("event delivery failed", extra={"extra_fields": {"event_id": str(event.id), "attempts": event.attempts}})
                event.save(update_fields=["attempts", "last_error", "status", "next_attempt_at"])
                continue
            event.status = OutboxEvent.Status.PUBLISHED
            event.published_at = timezone.now()
            event.save(update_fields=["status", "published_at"])
            published += 1
    return published, failed, dead


def retry_dead_event(event_id):
    with transaction.atomic():
        event = OutboxEvent.objects.select_for_update().filter(id=event_id).first()
        if event is None:
            raise DomainError("Event not found.", code="not_found", status_code=404)
        if event.status != OutboxEvent.Status.DEAD:
            raise DomainError("Only dead-lettered events can be retried.", code="invalid_state_transition")
        event.status = OutboxEvent.Status.PENDING
        event.attempts = 0
        event.next_attempt_at = timezone.now()
        event.save(update_fields=["status", "attempts", "next_attempt_at"])
        return event


def outbox_stats():
    qs = OutboxEvent.objects
    oldest = qs.filter(status=OutboxEvent.Status.PENDING).order_by("created_at").first()
    return {
        "pending": qs.filter(status=OutboxEvent.Status.PENDING).count(),
        "dead": qs.filter(status=OutboxEvent.Status.DEAD).count(),
        "oldest_pending_age_seconds": int((timezone.now() - oldest.created_at).total_seconds()) if oldest else 0,
    }

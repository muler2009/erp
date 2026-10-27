import pytest
from django.db import IntegrityError, connection, transaction
from django.test import override_settings
from django_tenants.utils import schema_context
from django.utils import timezone

from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as ev
from shared.events.models import ConsumedEvent, OutboxEvent
from shared.events.tasks import relay_all
from tests.conftest import Api


def code_of(response):
    return response.json()["error"]["code"]


@pytest.fixture
def tenant_schema(acme):
    with schema_context(acme["schema"]):
        yield acme["schema"]


@pytest.fixture
def consumers():
    registered = []

    def add(event_type, name, handler):
        ev.subscribe(event_type, name)(handler)
        registered.append((event_type, name))

    yield add
    for event_type, name in registered:
        ev.unsubscribe(event_type, name)


def make_event(**payload):
    return ev.emit("org.department.changed", {"department_id": "d1", "change": "created", **payload})


@pytest.mark.django_db
def test_emit_validates_type_and_payload(tenant_schema):
    with pytest.raises(ValidationFailed) as exc:
        ev.emit("nope.unknown", {})
    assert exc.value.detail.code == "unknown_event_type"
    with pytest.raises(ValidationFailed) as exc:
        ev.emit("org.department.changed", {"department_id": "x"})
    assert exc.value.detail.code == "invalid_event_payload"
    event = make_event()
    assert event.status == "PENDING" and event.version == 1


@pytest.mark.django_db
def test_dedup_key_makes_emit_idempotent(tenant_schema):
    first = ev.emit("org.department.changed", {"department_id": "d", "change": "x"}, dedup_key="k-1")
    second = ev.emit("org.department.changed", {"department_id": "d", "change": "x"}, dedup_key="k-1")
    assert first.id == second.id and OutboxEvent.objects.filter(dedup_key="k-1").count() == 1
    with pytest.raises(IntegrityError):  # database-level guarantee, too
        with transaction.atomic():
            OutboxEvent.objects.create(event_type="org.department.changed", payload={}, dedup_key="k-1")


@pytest.mark.django_db
def test_outbox_is_transactional(tenant_schema):
    before = OutboxEvent.objects.count()
    with pytest.raises(RuntimeError):
        with transaction.atomic():
            make_event()
            raise RuntimeError("business change failed")
    assert OutboxEvent.objects.count() == before  # no event for a change that never committed


@pytest.mark.django_db
def test_relay_delivers_to_consumers_once_with_envelope(tenant_schema, consumers):
    seen = []
    consumers("org.department.changed", "audit-mirror", lambda envelope: seen.append(envelope))
    event = make_event(code="ENG")
    OutboxEvent.objects.filter(status="PENDING").exclude(pk=event.pk).update(status="PUBLISHED")  # isolate this event
    assert ev.relay_outbox() == (1, 0, 0)
    assert ev.relay_outbox() == (0, 0, 0)  # published events are not delivered again
    assert len(seen) == 1
    envelope = seen[0]
    assert envelope["id"] == str(event.id) and envelope["type"] == "org.department.changed" and envelope["version"] == 1
    assert envelope["tenant"] == connection.tenant.schema_name and envelope["payload"]["code"] == "ENG"
    event.refresh_from_db()
    assert event.status == "PUBLISHED" and event.published_at


@pytest.mark.django_db
def test_failed_delivery_backs_off_then_dead_letters_and_can_be_retried(tenant_schema, consumers, settings):
    settings.EVENT_MAX_ATTEMPTS = 3
    calls = {"n": 0, "fail": True}

    def flaky(envelope):
        calls["n"] += 1
        if calls["fail"]:
            raise RuntimeError("downstream unavailable")

    consumers("org.department.changed", "flaky", flaky)
    OutboxEvent.objects.update(status="PUBLISHED")
    event = make_event()
    assert ev.relay_outbox() == (0, 1, 0)
    event.refresh_from_db()
    assert event.status == "PENDING" and event.attempts == 1 and "downstream unavailable" in event.last_error
    assert event.next_attempt_at > timezone.now()  # backoff: not due yet
    assert ev.relay_outbox() == (0, 0, 0) and calls["n"] == 1

    for expected_dead in (False, True):  # attempts 2 and 3
        OutboxEvent.objects.filter(pk=event.pk).update(next_attempt_at=timezone.now())
        ev.relay_outbox()
        event.refresh_from_db()
        assert (event.status == "DEAD") == expected_dead
    assert event.attempts == 3
    OutboxEvent.objects.filter(pk=event.pk).update(next_attempt_at=timezone.now())
    assert ev.relay_outbox() == (0, 0, 0)  # dead events are not retried automatically
    assert ev.outbox_stats()["dead"] == 1

    calls["fail"] = False
    ev.retry_dead_event(event.pk)
    assert ev.relay_outbox() == (1, 0, 0)
    with pytest.raises(DomainError):
        ev.retry_dead_event(event.pk)  # only DEAD events can be retried


@pytest.mark.django_db
def test_consumers_are_idempotent_across_redelivery(tenant_schema, consumers):
    """One consumer succeeds, another fails: on redelivery the successful one must not run again."""
    runs = {"ok": 0, "bad": 0}
    consumers("org.department.changed", "a-ok", lambda e: runs.__setitem__("ok", runs["ok"] + 1))

    def bad(envelope):
        runs["bad"] += 1
        if runs["bad"] == 1:
            raise RuntimeError("first attempt fails")

    consumers("org.department.changed", "b-bad", bad)
    OutboxEvent.objects.update(status="PUBLISHED")
    event = make_event()
    ev.relay_outbox()
    OutboxEvent.objects.filter(pk=event.pk).update(next_attempt_at=timezone.now())
    ev.relay_outbox()
    assert runs == {"ok": 1, "bad": 2}
    assert ConsumedEvent.objects.filter(event_id=event.id).count() == 2
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            ConsumedEvent.objects.create(consumer="a-ok", event_id=event.id)


@pytest.mark.django_db
def test_external_broker_receives_events_and_failures_are_retried(tenant_schema, settings):
    published = []

    class Recorder(ev.Broker):
        fail = True

        def publish(self, envelope):
            if Recorder.fail:
                raise ConnectionError("rabbitmq down")
            published.append(envelope)

    settings.EVENT_BROKER_CLASS = f"{__name__}.RecorderBroker"
    globals()["RecorderBroker"] = Recorder
    OutboxEvent.objects.update(status="PUBLISHED")
    event = make_event()
    assert ev.relay_outbox() == (0, 1, 0)
    OutboxEvent.objects.filter(pk=event.pk).update(next_attempt_at=timezone.now())
    Recorder.fail = False
    assert ev.relay_outbox() == (1, 0, 0)
    assert [e["id"] for e in published] == [str(event.id)]


@pytest.mark.django_db
def test_kombu_broker_publishes_routable_json_envelopes(tenant_schema, settings):
    """Exercises the real kombu publisher against kombu's in-memory transport. This verifies serialization,
    exchange/routing-key use and message headers; it does NOT verify behaviour against a live RabbitMQ."""
    from kombu import Connection, Exchange, Queue

    url = "memory://erp-test"
    exchange = Exchange("erp.events.test", type="topic", durable=True)
    with Connection(url) as conn:
        queue = Queue("org-events", exchange, routing_key="org.#", channel=conn.default_channel)
        queue.declare()
        settings.EVENT_BROKER_URL, settings.EVENT_EXCHANGE = url, "erp.events.test"
        OutboxEvent.objects.update(status="PUBLISHED")
        event = make_event(code="X")
        assert ev.relay_outbox() == (1, 0, 0)
        message = queue.get(no_ack=True)
        assert message is not None
        assert message.payload["id"] == str(event.id) and message.payload["type"] == "org.department.changed"
        assert message.headers["tenant"] == connection.tenant.schema_name
        assert queue.get(no_ack=True) is None


@pytest.mark.django_db
def test_celery_relay_fans_out_across_tenants(acme, globex):
    with schema_context(acme["schema"]):
        OutboxEvent.objects.update(status="PUBLISHED")
        event = make_event()
    with schema_context(globex["schema"]):
        OutboxEvent.objects.update(status="PUBLISHED")
        other = make_event()
    assert relay_all.apply().get() >= 2
    with schema_context(acme["schema"]):
        assert OutboxEvent.objects.get(pk=event.pk).status == "PUBLISHED"
    with schema_context(globex["schema"]):
        assert OutboxEvent.objects.get(pk=other.pk).status == "PUBLISHED"
        assert not OutboxEvent.objects.filter(pk=event.pk).exists()  # events never cross tenant schemas


@pytest.mark.django_db
def test_core_events_are_emitted_by_provisioning_and_invites(acme, owner_api, commit):
    with schema_context(acme["schema"]):
        assert OutboxEvent.objects.filter(event_type="tenant.provisioned").exists()
    with commit():
        owner_api.post("/api/v1/users/invite", {"email": "ev@acme.test", "display_name": "Ev", "role_ids": []})
    with schema_context(acme["schema"]):
        event = OutboxEvent.objects.filter(event_type="tenant.user.created").latest("created_at")
        assert event.payload["email"] == "ev@acme.test"


@pytest.mark.django_db
def test_dead_letter_api(owner_api, acme):
    with schema_context(acme["schema"]):
        event = make_event()
        OutboxEvent.objects.filter(pk=event.pk).update(status="DEAD", attempts=8, last_error="boom")
    listing = owner_api.get("/api/v1/events?status=dead").json()
    assert any(e["id"] == str(event.id) for e in listing["results"]) and listing["stats"]["dead"] >= 1
    assert owner_api.post(f"/api/v1/events/{event.id}/retry").json()["status"] == "PENDING"
    assert code_of(owner_api.post(f"/api/v1/events/{event.id}/retry")) == "invalid_state_transition"

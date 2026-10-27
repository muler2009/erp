import uuid

from django.db import models
from django.utils import timezone


class OutboxEvent(models.Model):
    """Transactional outbox (one per tenant schema). Rows are inserted in the same transaction as the
    business change; the relay delivers them afterwards, so an event exists iff the change committed."""

    class Status(models.TextChoices):
        PENDING = "PENDING"
        PUBLISHED = "PUBLISHED"
        DEAD = "DEAD"  # exhausted retries: dead-letter, visible and retryable by an operator

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    event_type = models.CharField(max_length=100, db_index=True)
    version = models.PositiveSmallIntegerField(default=1)
    payload = models.JSONField()
    correlation_id = models.CharField(max_length=64, blank=True)
    dedup_key = models.CharField(max_length=200, null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    next_attempt_at = models.DateTimeField(default=timezone.now, db_index=True)
    last_error = models.TextField(blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    published_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["dedup_key"], name="uniq_outbox_dedup_key", condition=models.Q(dedup_key__isnull=False))]
        indexes = [models.Index(fields=["status", "next_attempt_at"], name="outbox_due_idx")]


class ConsumedEvent(models.Model):
    """Idempotent-consumer ledger: (consumer, event) is processed at most once."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    consumer = models.CharField(max_length=100)
    event_id = models.UUIDField()
    consumed_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["consumer", "event_id"], name="uniq_consumed_event")]

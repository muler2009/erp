import uuid

from django.db import models
from django.db.models import Q
from django.utils import timezone


class NumberSequence(models.Model):
    """A numbering scheme such as 'PO-{yyyy}-{seq:05d}'. Counters are advanced under a row lock."""

    class Reset(models.TextChoices):
        NEVER = "NEVER"
        YEARLY = "YEARLY"
        MONTHLY = "MONTHLY"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.SlugField(max_length=60, unique=True)
    name = models.CharField(max_length=120)
    template = models.CharField(max_length=120)
    reset_policy = models.CharField(max_length=8, choices=Reset.choices, default=Reset.NEVER)
    next_value = models.PositiveBigIntegerField(default=1)
    period_key = models.CharField(max_length=8, blank=True)  # e.g. "2026" / "2026-10": last reset period
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(next_value__gte=1), name="sequence_next_value_positive")]


class IssuedNumber(models.Model):
    """Every number ever issued. The unique constraint is a safety net against duplicates; rows are
    written in the caller's transaction, so a rolled-back business action also releases its number."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sequence = models.ForeignKey(NumberSequence, on_delete=models.PROTECT, related_name="issued")
    number = models.CharField(max_length=120)
    issued_at = models.DateTimeField(default=timezone.now)
    issued_for_type = models.CharField(max_length=60, blank=True)
    issued_for_id = models.CharField(max_length=64, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["sequence", "number"], name="uniq_number_per_sequence")]

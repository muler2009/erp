import uuid

from django.db import models
from django.utils import timezone


class Notification(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id = models.UUIDField(db_index=True)
    notification_type = models.CharField(max_length=80)
    title = models.CharField(max_length=200)
    body = models.TextField(blank=True)
    ref_type = models.CharField(max_length=60, blank=True)
    ref_id = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    read_at = models.DateTimeField(null=True, blank=True)
    emailed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["user_id", "read_at"], name="notif_user_unread_idx")]


class NotificationPreference(models.Model):
    """Per-user opt-outs by notification type. Absent row = defaults (in-app on, email per tenant setting)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id = models.UUIDField(db_index=True)
    notification_type = models.CharField(max_length=80)
    in_app = models.BooleanField(default=True)
    email = models.BooleanField(default=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user_id", "notification_type"], name="uniq_pref_per_type")]

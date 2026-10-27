"""Append-only tenant audit trail (lives in each tenant schema)."""
import uuid

from django.db import models
from django.utils import timezone

from platform_core.audit.models import AppendOnlyError


class TenantAuditEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    actor_user_id = models.UUIDField(null=True, blank=True, db_index=True)
    action = models.CharField(max_length=80, db_index=True)
    target_type = models.CharField(max_length=60, blank=True)
    target_id = models.CharField(max_length=64, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    correlation_id = models.CharField(max_length=64, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise AppendOnlyError("audit events are immutable")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise AppendOnlyError("audit events are immutable")

import uuid

from django.db import models
from django.utils import timezone


class StoredFile(models.Model):
    class Status(models.TextChoices):
        ACTIVE = "ACTIVE"
        DELETED = "DELETED"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    original_name = models.CharField(max_length=255)  # display only; never used to build a path
    content_type = models.CharField(max_length=100)  # decided by the server from content, not by the client
    size = models.PositiveBigIntegerField()
    sha256 = models.CharField(max_length=64, db_index=True)
    storage_key = models.CharField(max_length=120, unique=True)
    owner_id = models.UUIDField(db_index=True)
    ref_type = models.CharField(max_length=60, blank=True)  # the business record this belongs to (module-owned)
    ref_id = models.CharField(max_length=64, blank=True)
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.ACTIVE, db_index=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["ref_type", "ref_id"], name="file_ref_idx")]
        constraints = [models.CheckConstraint(condition=models.Q(size__gte=0), name="file_size_nonneg")]

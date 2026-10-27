"""Reusable workflow / approval engine (tenant schema). Modules never implement their own approvals: they
register a subject type and call `submit`. Users are referenced by UUID (User lives in the public schema)."""
import uuid

from django.db import models
from django.db.models import Q
from django.utils import timezone


class WorkflowDefinition(models.Model):
    """One immutable VERSION of a workflow. Editing creates a new version; in-flight instances keep theirs."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.SlugField(max_length=60)
    version = models.PositiveIntegerField(default=1)
    name = models.CharField(max_length=200)
    subject_type = models.CharField(max_length=60, db_index=True)
    is_active = models.BooleanField(default=True)
    separation_of_duties = models.BooleanField(default=True)  # requester can never approve their own request
    distinct_approvers = models.BooleanField(default=False)  # one person cannot approve two stages of one round
    created_by = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["code", "version"], name="workflow_def_code_version_uniq"),
            models.UniqueConstraint(fields=["subject_type"], condition=Q(is_active=True), name="workflow_def_one_active_per_subject"),
        ]


class WorkflowStage(models.Model):
    class Policy(models.TextChoices):
        ANY_OF = "ANY_OF"
        ALL_OF = "ALL_OF"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    definition = models.ForeignKey(WorkflowDefinition, on_delete=models.CASCADE, related_name="stages")
    order = models.PositiveIntegerField()
    name = models.CharField(max_length=120)
    policy = models.CharField(max_length=6, choices=Policy.choices, default=Policy.ANY_OF)
    approvers = models.JSONField(default=list)  # [{"type": "ROLE|USER|DEPARTMENT_HEAD|MANAGER", "ref": "..."}]
    min_amount = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True)  # inclusive
    max_amount = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True)  # exclusive
    due_hours = models.PositiveIntegerField(null=True, blank=True)
    escalate_to_user_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["definition", "order"], name="workflow_stage_order_uniq")]
        ordering = ["order"]


class WorkflowInstance(models.Model):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        CHANGES_REQUESTED = "CHANGES_REQUESTED"
        APPROVED = "APPROVED"
        REJECTED = "REJECTED"
        CANCELLED = "CANCELLED"

    ACTIVE = ("PENDING", "CHANGES_REQUESTED")

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    definition = models.ForeignKey(WorkflowDefinition, on_delete=models.PROTECT, related_name="instances")
    subject_type = models.CharField(max_length=60)
    subject_id = models.CharField(max_length=64)
    title = models.CharField(max_length=200, blank=True)
    amount = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True)
    requester_id = models.UUIDField(db_index=True)
    department_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=18, choices=Status.choices, default=Status.PENDING, db_index=True)
    round = models.PositiveIntegerField(default=1)  # incremented on every resubmission
    stage_orders = models.JSONField(default=list)  # applicable stage orders for this round
    stage_index = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["subject_type", "subject_id"], condition=Q(status__in=["PENDING", "CHANGES_REQUESTED"]), name="workflow_one_active_per_subject"),
        ]


class ApprovalTask(models.Model):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        APPROVED = "APPROVED"
        REJECTED = "REJECTED"
        CHANGES_REQUESTED = "CHANGES_REQUESTED"
        SKIPPED = "SKIPPED"  # ANY_OF stage already satisfied by someone else
        DELEGATED = "DELEGATED"
        ESCALATED = "ESCALATED"
        CANCELLED = "CANCELLED"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    instance = models.ForeignKey(WorkflowInstance, on_delete=models.CASCADE, related_name="tasks")
    round = models.PositiveIntegerField()
    stage_order = models.PositiveIntegerField()
    assignee_id = models.UUIDField(db_index=True)
    status = models.CharField(max_length=18, choices=Status.choices, default=Status.PENDING, db_index=True)
    due_at = models.DateTimeField(null=True, blank=True)
    escalated_at = models.DateTimeField(null=True, blank=True)
    handed_over_from = models.UUIDField(null=True, blank=True)  # delegator / escalated-from user
    decided_at = models.DateTimeField(null=True, blank=True)
    comment = models.TextField(blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["instance", "round", "stage_order", "assignee_id"], name="approval_task_unique_assignee")]
        indexes = [models.Index(fields=["assignee_id", "status"], name="approval_task_inbox_idx")]


class WorkflowAction(models.Model):
    """Append-only history (database trigger forbids UPDATE/DELETE)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    instance = models.ForeignKey(WorkflowInstance, on_delete=models.PROTECT, related_name="actions")
    actor_id = models.UUIDField(null=True, blank=True)
    action = models.CharField(max_length=24)
    round = models.PositiveIntegerField(default=1)
    stage_order = models.PositiveIntegerField(null=True, blank=True)
    task_id = models.UUIDField(null=True, blank=True)
    comment = models.TextField(blank=True)
    metadata = models.JSONField(default=dict)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["created_at", "id"]

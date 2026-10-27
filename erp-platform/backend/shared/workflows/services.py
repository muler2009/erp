"""Workflow engine application services. All state changes happen inside a transaction holding a row lock on
the instance, so concurrent decisions, delegations and cancellations serialize and can never double-apply."""
from datetime import timedelta
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.utils import timezone

from platform_core.authorization import services as authz
from platform_core.authorization.models import RoleAssignment, RoleDefinition
from platform_core.organizations.models import Department, TenantUserProfile
from platform_core.users.models import TenantMembership
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.notifications import services as notifications
from shared.tenancy import current_tenant
from shared.workflows.models import ApprovalTask, WorkflowAction, WorkflowDefinition, WorkflowInstance, WorkflowStage

APPROVER_TYPES = ("ROLE", "USER", "DEPARTMENT_HEAD", "MANAGER")
TERMINAL_TASK = {"APPROVED", "REJECTED", "CHANGES_REQUESTED", "SKIPPED", "DELEGATED", "ESCALATED", "CANCELLED"}

# ----------------------------------------------------------------------------- subject registry
_SUBJECTS = {}  # subject_type -> {"on_outcome": callable|None}


def register_subject(subject_type, *, on_outcome=None):
    """A module declares which records it routes through approvals. `on_outcome(instance)` runs inside the
    transaction that completes the workflow (APPROVED / REJECTED / CANCELLED)."""
    _SUBJECTS[subject_type] = {"on_outcome": on_outcome}


def registered_subjects():
    return sorted(_SUBJECTS)


register_subject("generic")


# ----------------------------------------------------------------------------- helpers
def _log(instance, action, actor_id=None, *, stage_order=None, task=None, comment="", **metadata):
    return WorkflowAction.objects.create(
        instance=instance, actor_id=actor_id, action=action, round=instance.round, stage_order=stage_order,
        task_id=task.id if task else None, comment=comment or "", metadata={k: str(v) for k, v in metadata.items()},
    )


def _active_members(user_ids):
    return set(TenantMembership.objects.filter(tenant=current_tenant(), user_id__in=set(user_ids), status=TenantMembership.Status.ACTIVE).values_list("user_id", flat=True))


def _money(value):
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise ValidationFailed("amount must be a decimal number.", code="invalid_amount")


def _stage_applies(stage, amount):
    value = amount if amount is not None else Decimal("0")
    if stage.min_amount is not None and value < stage.min_amount:
        return False
    if stage.max_amount is not None and value >= stage.max_amount:
        return False
    return True


def resolve_approvers(stage, instance):
    """Concrete, currently eligible approver ids for a stage (ordered, de-duplicated)."""
    found = []
    for rule in stage.approvers:
        kind, ref = rule.get("type"), str(rule.get("ref") or "")
        if kind == "USER" and ref:
            found.append(_uuid(ref))
        elif kind == "ROLE":
            ids = RoleAssignment.objects.filter(role__name=ref, scope_type="TENANT", revoked_at__isnull=True, valid_from__lte=timezone.now()).filter(authz.models_q_valid(timezone.now())).order_by("created_at").values_list("user_id", flat=True)
            found.extend(ids)
        elif kind == "DEPARTMENT_HEAD":
            dept_id = _uuid(ref) if ref else instance.department_id
            dept = Department.objects.filter(pk=dept_id).first() if dept_id else None
            if dept and dept.head_user_id:
                found.append(dept.head_user_id)
        elif kind == "MANAGER":
            profile = TenantUserProfile.objects.filter(user_id=instance.requester_id).first()
            if profile and profile.manager_user_id:
                found.append(profile.manager_user_id)
    unique = list(dict.fromkeys(u for u in found if u))
    eligible = _active_members(unique)
    unique = [u for u in unique if u in eligible]
    if instance.definition.separation_of_duties:
        unique = [u for u in unique if u != instance.requester_id]
    return unique


def _uuid(value):
    import uuid

    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise ValidationFailed("Invalid identifier in approver rule.", code="invalid_approver_rule")


def _prior_approvers(instance):
    return set(instance.tasks.filter(round=instance.round, status="APPROVED").values_list("assignee_id", flat=True))


def _eligible_for_stage(instance, stage):
    ids = resolve_approvers(stage, instance)
    if instance.definition.distinct_approvers:
        prior = _prior_approvers(instance)
        ids = [u for u in ids if u not in prior]
    if not ids and stage.escalate_to_user_id and stage.escalate_to_user_id in _active_members([stage.escalate_to_user_id]):
        if not (instance.definition.separation_of_duties and stage.escalate_to_user_id == instance.requester_id):
            ids = [stage.escalate_to_user_id]  # documented fallback when nobody is eligible
    return ids


def _open_stage(instance):
    order = instance.stage_orders[instance.stage_index]
    stage = instance.definition.stages.get(order=order)
    ids = _eligible_for_stage(instance, stage)
    if not ids:
        raise DomainError(f"Stage '{stage.name}' has no eligible approvers.", code="no_eligible_approvers")
    due = timezone.now() + timedelta(hours=stage.due_hours) if stage.due_hours else None
    for user_id in ids:
        ApprovalTask.objects.create(instance=instance, round=instance.round, stage_order=order, assignee_id=user_id, due_at=due)
    _log(instance, "STAGE_OPENED", stage_order=order, approvers=",".join(map(str, ids)), policy=stage.policy)
    notifications.notify(ids, "workflow.approval_requested", f"Approval requested: {instance.title or instance.subject_type}", f"{instance.subject_type} {instance.subject_id} awaits your decision.", ref_type="workflow_instance", ref_id=instance.id, email=True)


def _lock(instance_id):
    instance = WorkflowInstance.objects.select_for_update().select_related("definition").filter(pk=instance_id).first()
    if instance is None:
        raise DomainError("Workflow instance not found.", code="not_found", status_code=404)
    return instance


def _finish(instance, outcome, actor_id, *, action):
    instance.status = outcome
    instance.completed_at = timezone.now()
    instance.save(update_fields=["status", "completed_at"])
    instance.tasks.filter(status="PENDING").update(status="CANCELLED", decided_at=timezone.now())
    _log(instance, action, actor_id)
    events.emit(
        "workflow.approval.completed",
        {"instance_id": str(instance.id), "subject_type": instance.subject_type, "subject_id": instance.subject_id, "outcome": outcome},
        dedup_key=f"workflow-completed-{instance.id}-{instance.round}-{outcome}",
    )
    hook = _SUBJECTS.get(instance.subject_type, {}).get("on_outcome")
    if hook:
        hook(instance)
    notifications.notify([instance.requester_id], "workflow.completed", f"{instance.title or instance.subject_type}: {outcome.lower()}", ref_type="workflow_instance", ref_id=instance.id, email=True)


def _plan_stages(definition, amount):
    orders = [s.order for s in definition.stages.all() if _stage_applies(s, amount)]
    if not orders:
        raise DomainError("No approval stage applies to this request.", code="no_applicable_stage")
    return orders


# ----------------------------------------------------------------------------- definitions
@transaction.atomic
def create_definition(actor_id, *, code, name, subject_type, stages, separation_of_duties=True, distinct_approvers=False):
    """Create a new version of workflow `code` (the previous active version is retired, never edited)."""
    if subject_type not in _SUBJECTS:
        raise ValidationFailed(f"Unknown subject type '{subject_type}'.", code="unknown_subject_type")
    if not stages:
        raise ValidationFailed("At least one stage is required.", code="no_stages")
    previous = WorkflowDefinition.objects.select_for_update().filter(code=code).order_by("-version").first()
    if previous and previous.subject_type != subject_type:
        raise ValidationFailed("subject_type cannot change between versions.", code="subject_type_immutable")
    seen = set()
    cleaned = []
    for i, raw in enumerate(stages, start=1):
        order = int(raw.get("order", i))
        if order in seen:
            raise ValidationFailed("Stage orders must be unique.", code="duplicate_stage_order")
        seen.add(order)
        policy = raw.get("policy", "ANY_OF")
        if policy not in ("ANY_OF", "ALL_OF"):
            raise ValidationFailed("policy must be ANY_OF or ALL_OF.", code="invalid_policy")
        approvers = raw.get("approvers") or []
        if not approvers or any(a.get("type") not in APPROVER_TYPES for a in approvers):
            raise ValidationFailed(f"Stage {order}: approvers must use types {APPROVER_TYPES}.", code="invalid_approvers")
        for a in approvers:
            if a["type"] == "ROLE" and not RoleDefinition.objects.filter(name=a.get("ref")).exists():
                raise ValidationFailed(f"Unknown role '{a.get('ref')}'.", code="unknown_role")
            if a["type"] in ("USER",) and not a.get("ref"):
                raise ValidationFailed("USER approver needs a ref.", code="invalid_approvers")
        lo, hi = _money(raw.get("min_amount")), _money(raw.get("max_amount"))
        if lo is not None and hi is not None and lo >= hi:
            raise ValidationFailed("min_amount must be below max_amount.", code="invalid_threshold")
        cleaned.append(dict(order=order, name=raw.get("name") or f"Stage {order}", policy=policy, approvers=approvers, min_amount=lo, max_amount=hi, due_hours=raw.get("due_hours") or None, escalate_to_user_id=raw.get("escalate_to_user_id") or None))
    WorkflowDefinition.objects.filter(subject_type=subject_type, is_active=True).update(is_active=False)
    definition = WorkflowDefinition.objects.create(code=code, version=(previous.version + 1) if previous else 1, name=name, subject_type=subject_type, separation_of_duties=separation_of_duties, distinct_approvers=distinct_approvers, created_by=actor_id)
    for c in sorted(cleaned, key=lambda s: s["order"]):
        WorkflowStage.objects.create(definition=definition, **c)
    from platform_core.audit.services import record_tenant_event

    record_tenant_event(current_tenant(), "workflow.definition.created", actor_user_id=actor_id, target_type="WorkflowDefinition", target_id=definition.id, metadata={"code": code, "version": definition.version})
    return definition


# ----------------------------------------------------------------------------- lifecycle
@transaction.atomic
def submit(requester_id, subject_type, subject_id, *, amount=None, department_id=None, title="", comment=""):
    """Start approval for a record. Called by the owning module's service, never trusted from a client."""
    if requester_id not in _active_members([requester_id]):
        raise DomainError("Requester is not an active member.", code="not_a_member", status_code=403)
    definition = WorkflowDefinition.objects.filter(subject_type=subject_type, is_active=True).first()
    if definition is None:
        raise DomainError(f"No active workflow for '{subject_type}'.", code="no_workflow", status_code=409)
    amount = _money(amount)
    try:
        with transaction.atomic():
            instance = WorkflowInstance.objects.create(definition=definition, subject_type=subject_type, subject_id=str(subject_id), title=title[:200], amount=amount, requester_id=requester_id, department_id=department_id, stage_orders=_plan_stages(definition, amount))
    except IntegrityError:
        raise DomainError("An approval for this record is already in progress.", code="already_in_flight")
    _log(instance, "SUBMITTED", requester_id, comment=comment, amount=amount, definition_version=definition.version)
    _validate_all_stages(instance)
    _open_stage(instance)
    return instance


def _validate_all_stages(instance):
    """Fail at submission (not mid-way) if an applicable stage can never be satisfied."""
    for order in instance.stage_orders:
        stage = instance.definition.stages.get(order=order)
        if not _eligible_for_stage(instance, stage) and not instance.definition.distinct_approvers:
            raise DomainError(f"Stage '{stage.name}' has no eligible approvers.", code="no_eligible_approvers")


@transaction.atomic
def decide(actor_id, task_id, decision, comment=""):
    if decision not in ("APPROVE", "REJECT", "REQUEST_CHANGES"):
        raise ValidationFailed("decision must be APPROVE, REJECT or REQUEST_CHANGES.", code="invalid_decision")
    probe = ApprovalTask.objects.filter(pk=task_id).values("instance_id").first()
    if probe is None:
        raise DomainError("Task not found.", code="not_found", status_code=404)
    instance = _lock(probe["instance_id"])
    task = ApprovalTask.objects.select_for_update().get(pk=task_id)
    if task.assignee_id != actor_id:
        raise DomainError("This task is not assigned to you.", code="not_found", status_code=404)  # no existence leak
    if task.status != "PENDING":
        raise DomainError("This task was already handled.", code="already_decided")
    if instance.status != "PENDING" or task.round != instance.round:
        raise DomainError("This request is no longer awaiting approval.", code="invalid_state_transition")
    if instance.definition.separation_of_duties and actor_id == instance.requester_id:
        raise DomainError("Separation of duties: you cannot decide your own request.", code="separation_of_duties", status_code=403)
    if actor_id not in _active_members([actor_id]):
        raise DomainError("You are no longer an active member.", code="not_a_member", status_code=403)
    if decision != "APPROVE" and not (comment or "").strip():
        raise ValidationFailed("A comment is required to reject or request changes.", code="comment_required")
    now = timezone.now()
    stage = instance.definition.stages.get(order=task.stage_order)
    task.decided_at, task.comment = now, comment or ""
    if decision == "REJECT":
        task.status = "REJECTED"
        task.save(update_fields=["status", "decided_at", "comment"])
        _log(instance, "REJECTED", actor_id, stage_order=task.stage_order, task=task, comment=comment)
        _finish(instance, "REJECTED", actor_id, action="COMPLETED")
        return instance
    if decision == "REQUEST_CHANGES":
        task.status = "CHANGES_REQUESTED"
        task.save(update_fields=["status", "decided_at", "comment"])
        instance.tasks.filter(status="PENDING").update(status="CANCELLED", decided_at=now)
        instance.status = "CHANGES_REQUESTED"
        instance.save(update_fields=["status"])
        _log(instance, "CHANGES_REQUESTED", actor_id, stage_order=task.stage_order, task=task, comment=comment)
        notifications.notify([instance.requester_id], "workflow.changes_requested", f"Changes requested: {instance.title or instance.subject_type}", comment, ref_type="workflow_instance", ref_id=instance.id, email=True)
        return instance
    task.status = "APPROVED"
    task.save(update_fields=["status", "decided_at", "comment"])
    _log(instance, "APPROVED", actor_id, stage_order=task.stage_order, task=task, comment=comment)
    stage_tasks = instance.tasks.filter(round=instance.round, stage_order=task.stage_order)
    if stage.policy == "ANY_OF":
        satisfied = True
        stage_tasks.filter(status="PENDING").update(status="SKIPPED", decided_at=now)
    else:
        satisfied = not stage_tasks.filter(status="PENDING").exists()
    if satisfied:
        _advance(instance, actor_id)
    return instance


def _advance(instance, actor_id):
    if instance.stage_index + 1 >= len(instance.stage_orders):
        _finish(instance, "APPROVED", actor_id, action="COMPLETED")
        return
    instance.stage_index += 1
    instance.save(update_fields=["stage_index"])
    _open_stage(instance)


@transaction.atomic
def delegate(actor_id, task_id, to_user_id, comment=""):
    probe = ApprovalTask.objects.filter(pk=task_id).values("instance_id").first()
    if probe is None:
        raise DomainError("Task not found.", code="not_found", status_code=404)
    instance = _lock(probe["instance_id"])
    task = ApprovalTask.objects.select_for_update().get(pk=task_id)
    if task.assignee_id != actor_id:
        raise DomainError("This task is not assigned to you.", code="not_found", status_code=404)
    if task.status != "PENDING" or instance.status != "PENDING" or task.round != instance.round:
        raise DomainError("Only a pending task can be delegated.", code="invalid_state_transition")
    if to_user_id == actor_id:
        raise ValidationFailed("You cannot delegate to yourself.", code="invalid_delegate")
    if to_user_id not in _active_members([to_user_id]):
        raise ValidationFailed("Delegate must be an active member of this tenant.", code="invalid_delegate")
    if instance.definition.separation_of_duties and to_user_id == instance.requester_id:
        raise DomainError("Separation of duties: the requester cannot be a delegate.", code="separation_of_duties", status_code=403)
    if ApprovalTask.objects.filter(instance=instance, round=instance.round, stage_order=task.stage_order, assignee_id=to_user_id).exists():
        raise DomainError("That user already has a task in this stage.", code="duplicate_approver")
    if instance.definition.distinct_approvers and to_user_id in _prior_approvers(instance):
        raise DomainError("That user already approved an earlier stage.", code="distinct_approvers_required")
    task.status, task.decided_at, task.comment = "DELEGATED", timezone.now(), comment or ""
    task.save(update_fields=["status", "decided_at", "comment"])
    new = ApprovalTask.objects.create(instance=instance, round=task.round, stage_order=task.stage_order, assignee_id=to_user_id, due_at=task.due_at, handed_over_from=actor_id)
    _log(instance, "DELEGATED", actor_id, stage_order=task.stage_order, task=new, comment=comment, to=to_user_id)
    notifications.notify([to_user_id], "workflow.approval_requested", f"Approval delegated to you: {instance.title or instance.subject_type}", comment, ref_type="workflow_instance", ref_id=instance.id, email=True)
    return new


@transaction.atomic
def resubmit(actor_id, instance_id, *, comment="", amount=None):
    instance = _lock(instance_id)
    if instance.requester_id != actor_id:
        raise DomainError("Workflow instance not found.", code="not_found", status_code=404)
    if instance.status != "CHANGES_REQUESTED":
        raise DomainError("Only a request with requested changes can be resubmitted.", code="invalid_state_transition")
    if amount is not None:
        instance.amount = _money(amount)
    instance.round += 1
    instance.stage_index = 0
    instance.stage_orders = _plan_stages(instance.definition, instance.amount)
    instance.status = "PENDING"
    instance.save(update_fields=["amount", "round", "stage_index", "stage_orders", "status"])
    _log(instance, "RESUBMITTED", actor_id, comment=comment, amount=instance.amount)
    _validate_all_stages(instance)
    _open_stage(instance)
    return instance


@transaction.atomic
def cancel(actor_id, instance_id, *, comment=""):
    instance = _lock(instance_id)
    allowed = instance.requester_id == actor_id or authz.has_permission(actor_id, "workflow.cancel_any")
    if not allowed:
        raise DomainError("Workflow instance not found.", code="not_found", status_code=404)
    if instance.status not in WorkflowInstance.ACTIVE:
        raise DomainError("This request is already finished.", code="invalid_state_transition")
    _log(instance, "CANCEL_REQUESTED", actor_id, comment=comment)
    _finish(instance, "CANCELLED", actor_id, action="CANCELLED")
    return instance


# ----------------------------------------------------------------------------- escalation (periodic)
def escalate_overdue(now=None):
    """Hand overdue tasks to the stage's escalation user (once per task); returns the number escalated."""
    now = now or timezone.now()
    count = 0
    overdue = list(ApprovalTask.objects.filter(status="PENDING", due_at__lt=now, escalated_at__isnull=True).values_list("id", "instance_id"))
    for task_id, instance_id in overdue:
        with transaction.atomic():
            instance = _lock(instance_id)
            task = ApprovalTask.objects.select_for_update().get(pk=task_id)
            if task.status != "PENDING" or task.escalated_at or instance.status != "PENDING" or task.round != instance.round:
                continue
            stage = instance.definition.stages.get(order=task.stage_order)
            target = stage.escalate_to_user_id
            ok = (
                target
                and target in _active_members([target])
                and not (instance.definition.separation_of_duties and target == instance.requester_id)
                and not ApprovalTask.objects.filter(instance=instance, round=instance.round, stage_order=task.stage_order, assignee_id=target).exists()
            )
            if ok:
                task.status, task.escalated_at, task.decided_at = "ESCALATED", now, now
                task.save(update_fields=["status", "escalated_at", "decided_at"])
                new = ApprovalTask.objects.create(instance=instance, round=task.round, stage_order=task.stage_order, assignee_id=target, due_at=None, handed_over_from=task.assignee_id, escalated_at=now)
                _log(instance, "ESCALATED", None, stage_order=task.stage_order, task=new, from_user=task.assignee_id, to=target)
                notifications.notify([target], "workflow.escalated", f"Escalated approval: {instance.title or instance.subject_type}", ref_type="workflow_instance", ref_id=instance.id, email=True)
            else:  # nobody to escalate to: remind once and record that it happened
                task.escalated_at = now
                task.save(update_fields=["escalated_at"])
                _log(instance, "OVERDUE_REMINDER", None, stage_order=task.stage_order, task=task)
                notifications.notify([task.assignee_id], "workflow.overdue", f"Overdue approval: {instance.title or instance.subject_type}", ref_type="workflow_instance", ref_id=instance.id, email=True)
            count += 1
    return count


# ----------------------------------------------------------------------------- reads
def inbox(user_id):
    return ApprovalTask.objects.filter(assignee_id=user_id, status="PENDING", instance__status="PENDING").select_related("instance").order_by("due_at", "created_at")


def can_view(user_id, instance):
    if instance.requester_id == user_id or authz.has_permission(user_id, "workflow.view_all"):
        return True
    return instance.tasks.filter(assignee_id=user_id).exists()

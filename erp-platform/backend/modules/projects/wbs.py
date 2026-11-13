"""Work breakdown structure: tasks, milestones, dependencies, progress rollup and critical-path (Gantt) data."""
from collections import defaultdict, deque
from datetime import timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone

from modules.projects import models as m
from modules.projects import services as svc
from shared.api.errors import DomainError, ValidationFailed

ZERO = Decimal("0")
MAX_DEPTH = 6


def _task(pk, lock=False):
    qs = m.Task.objects.select_for_update(of=("self",)) if lock else m.Task.objects
    t = qs.select_related("project").filter(pk=pk).first()
    if t is None:
        raise DomainError("Task not found.", code="not_found", status_code=404)
    return t


def is_summary(t):
    return m.Task.objects.filter(parent=t).exists()


def _depth(t):
    n = 1
    while t.parent_id:
        t = m.Task.objects.get(pk=t.parent_id)
        n += 1
    return n


def _next_wbs(project, parent):
    siblings = m.Task.objects.filter(project=project, parent=parent).values_list("wbs_code", flat=True)
    last = max((int(c.rsplit(".", 1)[-1]) for c in siblings), default=0)
    return f"{parent.wbs_code}.{last + 1}" if parent else str(last + 1)


def _check_member(project, user_id):
    if user_id and not m.ProjectMember.objects.filter(project=project, user_id=user_id, is_active=True, role__in=("MANAGER", "MEMBER")).exists():
        raise ValidationFailed("Assign tasks only to team members (not observers).", code="invalid_assignee")


def _check_dates(project, start, end, milestone):
    if end < start:
        raise ValidationFailed("A task cannot end before it starts.", code="invalid_dates")
    if start < project.start_on or end > project.end_on:
        raise ValidationFailed("The task must fall within the project dates.", code="outside_project_dates")
    if milestone and start != end:
        raise ValidationFailed("A milestone is a single date.", code="invalid_dates")


def _violations(t, start=None, end=None):
    """Dependencies broken if `t` ran from start to end (defaults to its own dates)."""
    start, end = start or t.planned_start, end or t.planned_end
    out = []
    for d in m.TaskDependency.objects.filter(successor=t).select_related("predecessor"):
        p = d.predecessor
        need = p.planned_end + timedelta(days=d.lag_days + 1) if d.kind == "FS" else p.planned_start + timedelta(days=d.lag_days)
        if start < need:
            out.append(f"{p.wbs_code} must {'finish' if d.kind == 'FS' else 'start'} first (earliest start {need})")
    for d in m.TaskDependency.objects.filter(predecessor=t).select_related("successor"):
        s = d.successor
        need = end + timedelta(days=d.lag_days + 1) if d.kind == "FS" else start + timedelta(days=d.lag_days)
        if s.planned_start < need:
            out.append(f"{s.wbs_code} would start before this task allows (earliest {need})")
    return out


def _recompute(task):
    """Roll a summary task up from its children, then continue up the tree."""
    while task is not None:
        kids = list(m.Task.objects.filter(parent=task).exclude(status="CANCELLED"))
        all_kids = list(m.Task.objects.filter(parent=task))
        if all_kids:
            if kids:
                task.planned_start, task.planned_end = min(k.planned_start for k in kids), max(k.planned_end for k in kids)
                hours = sum((k.planned_hours for k in kids), ZERO)
                task.planned_hours = hours
                task.percent_complete = (sum((k.percent_complete * k.planned_hours for k in kids), ZERO) / hours).quantize(Decimal("0.01")) if hours else (sum((k.percent_complete for k in kids), ZERO) / len(kids)).quantize(Decimal("0.01"))
                if all(k.status == "DONE" for k in kids):
                    task.status = "DONE"
                    task.actual_end = max((k.actual_end for k in kids if k.actual_end), default=task.actual_end)
                elif any(k.status in ("IN_PROGRESS", "DONE") or k.percent_complete > 0 for k in kids):
                    task.status = "IN_PROGRESS"
                    task.actual_start = task.actual_start or min((k.actual_start for k in kids if k.actual_start), default=None)
                else:
                    task.status = "BLOCKED" if any(k.status == "BLOCKED" for k in kids) else "TODO"
            else:
                task.status = "CANCELLED"
            task.save()
        task = m.Task.objects.filter(pk=task.parent_id).first() if task.parent_id else None


@transaction.atomic
def create_task(actor_id, project_id, *, name, planned_start, planned_end, parent_id=None, is_milestone=False, assignee_id=None, planned_hours=0, description=""):
    p = svc.require_manage(actor_id, project_id, lock=True)
    if not (name or "").strip():
        raise ValidationFailed("Name the task.", code="name_required")
    parent = None
    if parent_id:
        parent = _task(parent_id, lock=True)
        if parent.project_id != p.id:
            raise ValidationFailed("The parent belongs to another project.", code="invalid_parent")
        if parent.is_milestone:
            raise ValidationFailed("A milestone cannot have sub-tasks.", code="invalid_parent")
        if _depth(parent) >= MAX_DEPTH:
            raise ValidationFailed(f"The breakdown can be at most {MAX_DEPTH} levels deep.", code="too_deep")
        if parent.status == "DONE" or m.TaskDependency.objects.filter(Q_both(parent)).exists():
            raise DomainError("A completed task or one with dependencies cannot be broken down further.", code="invalid_parent")
    _check_dates(p, planned_start, planned_end, is_milestone)
    _check_member(p, assignee_id)
    hrs = svc._dec(planned_hours, "planned_hours")
    if hrs < 0 or (is_milestone and hrs > 0):
        raise ValidationFailed("Hours cannot be negative, and a milestone has none.", code="invalid_amount")
    t = m.Task.objects.create(project=p, parent=parent, wbs_code=_next_wbs(p, parent), sort_order=m.Task.objects.filter(project=p).count(), name=name[:200], description=description, is_milestone=bool(is_milestone), assignee_id=assignee_id, planned_start=planned_start, planned_end=planned_end, planned_hours=hrs)
    if parent:
        parent.percent_complete = ZERO
        _recompute(parent)
    return t


def Q_both(t):
    from django.db.models import Q

    return Q(predecessor=t) | Q(successor=t)


@transaction.atomic
def update_task(actor_id, task_id, **attrs):
    t = _task(task_id, lock=True)
    p = svc.require_manage(actor_id, t.project_id, lock=True)
    if t.status in ("DONE", "CANCELLED"):
        raise DomainError("A finished task cannot be edited; reopen it first.", code="invalid_state")
    summary = is_summary(t)
    start, end = attrs.get("planned_start") or t.planned_start, attrs.get("planned_end") or t.planned_end
    if summary and (attrs.get("planned_start") or attrs.get("planned_end") or attrs.get("planned_hours") is not None):
        raise DomainError("A summary task takes its dates and hours from its sub-tasks.", code="summary_derived")
    if not summary:
        _check_dates(p, start, end, t.is_milestone)
        bad = _violations(t, start, end)
        if bad:
            raise DomainError("This would break a dependency: " + "; ".join(bad), code="dependency_violated")
        t.planned_start, t.planned_end = start, end
        if attrs.get("planned_hours") is not None:
            h = svc._dec(attrs["planned_hours"], "planned_hours")
            if h < 0 or (t.is_milestone and h > 0):
                raise ValidationFailed("Hours cannot be negative, and a milestone has none.", code="invalid_amount")
            t.planned_hours = h
    if "assignee_id" in attrs:
        _check_member(p, attrs["assignee_id"])
        t.assignee_id = attrs["assignee_id"]
    if attrs.get("name"):
        t.name = attrs["name"][:200]
    if attrs.get("description") is not None:
        t.description = attrs["description"]
    t.save()
    if t.parent_id:
        _recompute(m.Task.objects.get(pk=t.parent_id))
    return t


@transaction.atomic
def shift_task(actor_id, task_id, days, *, cascade=True):
    """Move a task (and, optionally, everything that depends on it) by whole days; the Gantt drag-and-drop operation."""
    t = _task(task_id, lock=True)
    p = svc.require_manage(actor_id, t.project_id, lock=True)
    if is_summary(t):
        raise DomainError("Move the sub-tasks of a summary task instead.", code="summary_derived")
    days = int(days)
    seen, queue, moved = set(), deque([(t, days)]), []
    while queue:
        cur, d = queue.popleft()
        if cur.id in seen:
            continue
        seen.add(cur.id)
        if cur.status in ("DONE", "CANCELLED") and cur.id != t.id:
            continue
        cur.planned_start += timedelta(days=d)
        cur.planned_end += timedelta(days=d)
        _check_dates(p, cur.planned_start, cur.planned_end, cur.is_milestone)
        moved.append(cur)
        if cascade:
            for dep in m.TaskDependency.objects.filter(predecessor=cur).select_related("successor"):
                s = dep.successor
                need = cur.planned_end + timedelta(days=dep.lag_days + 1) if dep.kind == "FS" else cur.planned_start + timedelta(days=dep.lag_days)
                if s.planned_start < need:
                    queue.append((s, (need - s.planned_start).days))
    for c in moved:
        c.save()
    parents = {c.parent_id for c in moved if c.parent_id}
    for pid in parents:
        _recompute(m.Task.objects.get(pk=pid))
    if not cascade:
        bad = _violations(t)
        if bad:
            raise DomainError("This would break a dependency: " + "; ".join(bad), code="dependency_violated")
    return moved


@transaction.atomic
def delete_task(actor_id, task_id):
    t = _task(task_id, lock=True)
    svc.require_manage(actor_id, t.project_id, lock=True)
    if is_summary(t):
        raise DomainError("Delete the sub-tasks first.", code="has_children")
    if t.status != "TODO" or t.percent_complete > 0:
        raise DomainError("A task that has started cannot be deleted; cancel it instead.", code="task_started")
    parent = m.Task.objects.filter(pk=t.parent_id).first()
    try:
        t.delete()
    except Exception:
        raise DomainError("Records (time, expenses) refer to this task; cancel it instead.", code="task_in_use")
    if parent:
        _recompute(parent)


# ----------------------------------------------------------------------------- dependencies
def _reaches(start_id, target_id):
    seen, stack = set(), [start_id]
    while stack:
        cur = stack.pop()
        if cur == target_id:
            return True
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(m.TaskDependency.objects.filter(predecessor_id=cur).values_list("successor_id", flat=True))
    return False


@transaction.atomic
def add_dependency(actor_id, predecessor_id, successor_id, *, kind="FS", lag_days=0):
    a, b = _task(predecessor_id, lock=True), _task(successor_id, lock=True)
    p = svc.require_manage(actor_id, a.project_id, lock=True)
    if a.project_id != b.project_id:
        raise ValidationFailed("Both tasks must be in the same project.", code="invalid_dependency")
    if a.id == b.id:
        raise ValidationFailed("A task cannot depend on itself.", code="invalid_dependency")
    if kind not in m.DEP_TYPES:
        raise ValidationFailed("Dependency kind must be FS or SS.", code="invalid_dependency")
    if is_summary(a) or is_summary(b):
        raise ValidationFailed("Link the detailed tasks, not summary tasks.", code="invalid_dependency")
    if b.status in ("DONE", "CANCELLED") or a.status == "CANCELLED":
        raise DomainError("A finished or cancelled task cannot be linked.", code="invalid_state")
    if _reaches(b.id, a.id):
        raise DomainError("This link would create a circular dependency.", code="circular_dependency")
    need = a.planned_end + timedelta(days=int(lag_days) + 1) if kind == "FS" else a.planned_start + timedelta(days=int(lag_days))
    if b.planned_start < need:
        raise DomainError(f"{b.wbs_code} starts {b.planned_start}, before the {need} this link requires; move it first.", code="dependency_violated")
    try:
        with transaction.atomic():
            return m.TaskDependency.objects.create(predecessor=a, successor=b, kind=kind, lag_days=int(lag_days))
    except IntegrityError:
        raise DomainError("These tasks are already linked.", code="already_pending")


@transaction.atomic
def remove_dependency(actor_id, dependency_id):
    d = m.TaskDependency.objects.select_related("predecessor").filter(pk=dependency_id).first()
    if d is None:
        raise DomainError("Dependency not found.", code="not_found", status_code=404)
    svc.require_manage(actor_id, d.predecessor.project_id, lock=True)
    d.delete()


# ----------------------------------------------------------------------------- progress
_TASK_GUARDS = []


def register_task_guard(fn):
    """Another module (quality hold points) can veto a task starting or finishing: fn(task, new_status) raises DomainError."""
    _TASK_GUARDS.append(fn)


def _blocked_by_predecessors(t, starting_only):
    out = []
    for d in m.TaskDependency.objects.filter(successor=t).select_related("predecessor"):
        p = d.predecessor
        if p.status == "CANCELLED":
            continue
        if d.kind == "FS" and p.status != "DONE":
            out.append(p.wbs_code)
        elif d.kind == "SS" and p.status == "TODO" and not starting_only:
            out.append(p.wbs_code)
        elif d.kind == "SS" and p.status == "TODO" and starting_only:
            out.append(p.wbs_code)
    return out


@transaction.atomic
def update_progress(actor_id, task_id, *, status=None, percent=None, note=""):
    """Leaf-task progress by the assignee or the project manager. Status and percentage always agree."""
    t = _task(task_id, lock=True)
    p = svc.get_project(t.project_id, lock=True)
    if not svc.can_view(actor_id, p):
        raise DomainError("Task not found.", code="not_found", status_code=404)
    if not (svc.can_manage(actor_id, p) or t.assignee_id == actor_id):
        raise DomainError("Only the assignee or the project manager can update this task.", code="forbidden", status_code=403)
    if p.status != "ACTIVE":
        raise DomainError("Progress is recorded while the project is active.", code="project_not_active")
    if is_summary(t):
        raise DomainError("A summary task's progress comes from its sub-tasks.", code="summary_derived")
    if status is not None and status not in m.TASK_STATUSES:
        raise ValidationFailed("Unknown task status.", code="invalid_status")
    if t.status == "CANCELLED":
        raise DomainError("This task is cancelled.", code="invalid_state")
    today = timezone.now().date()
    new_status = status or t.status
    pct = svc._dec(percent, "percent") if percent is not None else t.percent_complete
    if not (0 <= pct <= 100):
        raise ValidationFailed("Percent complete must be between 0 and 100.", code="invalid_percent")
    if t.is_milestone and pct not in (ZERO, Decimal("100")):
        raise ValidationFailed("A milestone is either not reached (0) or reached (100).", code="invalid_percent")
    if status is None and percent is not None:
        new_status = "DONE" if pct == 100 else ("IN_PROGRESS" if pct > 0 or t.status == "IN_PROGRESS" else t.status)
    if t.status == "DONE" and new_status != "DONE" and percent is None:
        raise ValidationFailed("Say how much is done when reopening a finished task.", code="invalid_percent")
    if new_status == "DONE":
        pct = Decimal("100")
    elif new_status == "TODO" and percent is None:
        pct = ZERO
    elif new_status == "TODO" and pct > 0:
        raise ValidationFailed("A task that has progress is in progress, not to-do.", code="invalid_percent")
    elif pct == 100:
        raise ValidationFailed("A task at 100 percent is done.", code="invalid_percent")
    if new_status == "CANCELLED" and not svc.can_manage(actor_id, p):
        raise DomainError("Only the project manager can cancel a task.", code="forbidden", status_code=403)
    if new_status == "BLOCKED" and not (note or "").strip():
        raise ValidationFailed("Say what is blocking the task.", code="reason_required")
    if new_status in ("IN_PROGRESS", "DONE") and t.status in ("TODO", "BLOCKED"):
        waiting = _blocked_by_predecessors(t, starting_only=True)
        if waiting:
            raise DomainError("Waiting for " + ", ".join(waiting) + ".", code="predecessor_open")
        for guard in _TASK_GUARDS:
            guard(t, new_status)
    if new_status == "DONE":
        fs_open = [d.predecessor.wbs_code for d in m.TaskDependency.objects.filter(successor=t, kind="FS").select_related("predecessor") if d.predecessor.status not in ("DONE", "CANCELLED")]
        if fs_open:
            raise DomainError("Waiting for " + ", ".join(fs_open) + ".", code="predecessor_open")
    if new_status in ("IN_PROGRESS", "DONE") and not t.actual_start:
        t.actual_start = today
    if new_status == "DONE":
        t.actual_end = today
    elif t.status == "DONE":
        t.actual_end = None  # reopened
    t.status, t.percent_complete = new_status, pct
    t.save()
    if t.parent_id:
        _recompute(m.Task.objects.get(pk=t.parent_id))
    return t


# ----------------------------------------------------------------------------- Gantt and critical path
def schedule(project_id):
    """Tasks with dependencies, float and the critical path (calendar days, planned dates)."""
    p = svc.get_project(project_id)
    tasks = list(m.Task.objects.filter(project=p).exclude(status="CANCELLED").order_by("sort_order", "created_at"))
    parents = {t.parent_id for t in tasks if t.parent_id}
    leaves = [t for t in tasks if t.id not in parents]
    deps = list(m.TaskDependency.objects.filter(predecessor__project=p, predecessor__in=[t.id for t in leaves], successor__in=[t.id for t in leaves]))
    by_id = {t.id: t for t in leaves}
    succ = defaultdict(list)
    indeg = {t.id: 0 for t in leaves}
    for d in deps:
        succ[d.predecessor_id].append(d)
        indeg[d.successor_id] += 1
    order, q = [], deque(i for i, n in indeg.items() if n == 0)
    while q:
        cur = q.popleft()
        order.append(cur)
        for d in succ[cur]:
            indeg[d.successor_id] -= 1
            if indeg[d.successor_id] == 0:
                q.append(d.successor_id)
    end = max((t.planned_end.toordinal() for t in leaves), default=p.end_on.toordinal())
    dur = {t.id: t.planned_end.toordinal() - t.planned_start.toordinal() + 1 for t in leaves}
    late_finish = {t.id: end for t in leaves}
    for tid in reversed(order):
        for d in succ[tid]:
            s_ls = late_finish[d.successor_id] - dur[d.successor_id] + 1
            cand = s_ls - d.lag_days - 1 if d.kind == "FS" else s_ls - d.lag_days + dur[tid] - 1
            late_finish[tid] = min(late_finish[tid], cand)
    rows, critical = [], []
    for t in tasks:
        row = {"id": str(t.id), "wbs": t.wbs_code, "name": t.name, "parent": None if not t.parent_id else str(t.parent_id), "milestone": t.is_milestone, "status": t.status, "start": str(t.planned_start), "end": str(t.planned_end), "percent": str(t.percent_complete), "assignee": None if not t.assignee_id else str(t.assignee_id), "summary": t.id in parents,
               "hours": str(t.planned_hours), "predecessors": [{"id": str(d.id), "task": str(d.predecessor_id), "kind": d.kind, "lag_days": d.lag_days} for d in deps if d.successor_id == t.id]}
        if t.id in by_id:
            slack = late_finish[t.id] - t.planned_end.toordinal()
            row["slack_days"], row["critical"] = slack, slack == 0 and t.status != "DONE"
            if row["critical"]:
                critical.append(t.wbs_code)
        rows.append(row)
    return {"project": p.code, "start": str(p.start_on), "end": str(p.end_on), "tasks": rows, "critical_path": critical}

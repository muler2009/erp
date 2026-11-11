"""Risk and issue registers. Any team member can raise; the owner/assignee or manager works them; the manager closes."""
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from modules.projects import models as m
from modules.projects import services as svc
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify

SEVERITIES = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
OPEN_ISSUE = ("OPEN", "IN_PROGRESS")


def _team(actor_id, project_id, lock=False):
    p = svc.get_project(project_id, lock=lock)
    mem = svc._member(p, actor_id)
    if not svc.can_view(actor_id, p) or not (mem or svc.can_manage(actor_id, p)):
        raise DomainError("Project not found.", code="not_found", status_code=404)
    if mem is not None and mem.role == "OBSERVER" and not svc.can_manage(actor_id, p):
        raise DomainError("Observers cannot change the registers.", code="forbidden", status_code=403)
    if p.status in ("COMPLETED", "CANCELLED"):
        raise DomainError("The project is closed.", code="project_closed")
    return p


def _check_user(project, user_id):
    if user_id and not m.ProjectMember.objects.filter(project=project, user_id=user_id, is_active=True).exists():
        raise ValidationFailed("Assign only team members.", code="invalid_assignee")


@transaction.atomic
def raise_risk(actor_id, project_id, *, title, probability, impact, description="", category="", owner_id=None, mitigation="", review_on=None):
    p = _team(actor_id, project_id)
    pr, im = int(probability or 0), int(impact or 0)
    if not (title or "").strip() or not (1 <= pr <= 5 and 1 <= im <= 5):
        raise ValidationFailed("A risk needs a title and probability and impact between 1 and 5.", code="invalid_risk")
    _check_user(p, owner_id)
    return m.Risk.objects.create(project=p, title=title[:200], description=description, category=category[:60], probability=pr, impact=im, owner_id=owner_id or svc.get_project(project_id).manager_id, mitigation=mitigation, review_on=review_on, raised_by=actor_id)


@transaction.atomic
def update_risk(actor_id, risk_id, *, status=None, probability=None, impact=None, mitigation=None, owner_id=None, review_on=None, note=""):
    r = m.Risk.objects.select_for_update(of=("self",)).filter(pk=risk_id).first()
    if r is None:
        raise DomainError("Risk not found.", code="not_found", status_code=404)
    p = _team(actor_id, r.project_id)
    if not (svc.can_manage(actor_id, p) or r.owner_id == actor_id):
        raise DomainError("Only the risk owner or the project manager can change this risk.", code="forbidden", status_code=403)
    if r.status == "CLOSED":
        raise DomainError("A closed risk cannot be changed.", code="invalid_state")
    if probability is not None or impact is not None:
        pr, im = int(probability or r.probability), int(impact or r.impact)
        if not (1 <= pr <= 5 and 1 <= im <= 5):
            raise ValidationFailed("Probability and impact are between 1 and 5.", code="invalid_risk")
        r.probability, r.impact = pr, im
    if mitigation is not None:
        r.mitigation = mitigation
    if owner_id:
        _check_user(p, owner_id)
        r.owner_id = owner_id
    if review_on:
        r.review_on = review_on
    if status:
        if status not in ("OPEN", "MITIGATING", "OCCURRED", "CLOSED"):
            raise ValidationFailed("Unknown status.", code="invalid_status")
        if status == "MITIGATING" and not (r.mitigation or "").strip():
            raise ValidationFailed("Record the mitigation plan first.", code="reason_required")
        if status == "CLOSED":
            if not svc.can_manage(actor_id, p):
                raise DomainError("Only the project manager can close a risk.", code="forbidden", status_code=403)
            if not (note or "").strip():
                raise ValidationFailed("Say why the risk is closed.", code="reason_required")
            r.closed_note = note[:300]
        r.status = status
    r.save()
    return r


@transaction.atomic
def raise_issue(actor_id, project_id, *, title, severity="MEDIUM", description="", task_id=None, risk_id=None, assigned_to=None, due_on=None):
    p = _team(actor_id, project_id)
    if not (title or "").strip() or severity not in SEVERITIES:
        raise ValidationFailed("An issue needs a title and a severity of LOW, MEDIUM, HIGH or CRITICAL.", code="invalid_issue")
    if task_id and not m.Task.objects.filter(pk=task_id, project=p).exists():
        raise ValidationFailed("The task belongs to another project.", code="invalid_task")
    risk = None
    if risk_id:
        risk = m.Risk.objects.filter(pk=risk_id, project=p).first()
        if risk is None:
            raise ValidationFailed("The risk belongs to another project.", code="invalid_risk")
    _check_user(p, assigned_to)
    i = m.Issue.objects.create(project=p, task_id=task_id, risk=risk, title=title[:200], description=description, severity=severity, assigned_to=assigned_to or p.manager_id, due_on=due_on, raised_by=actor_id)
    if risk and risk.status != "CLOSED":
        risk.status = "OCCURRED"
        risk.save(update_fields=["status", "updated_at"])
    if severity in ("HIGH", "CRITICAL") and p.manager_id != actor_id:
        notify([p.manager_id], "projects.issue", f"{severity} issue on {p.code}: {title[:80]}", description[:200], ref_type="projects.issue", ref_id=str(i.id))
    return i


@transaction.atomic
def update_issue(actor_id, issue_id, *, status=None, severity=None, assigned_to=None, due_on=None, resolution=""):
    i = m.Issue.objects.select_for_update(of=("self",)).filter(pk=issue_id).first()
    if i is None:
        raise DomainError("Issue not found.", code="not_found", status_code=404)
    p = _team(actor_id, i.project_id)
    manager = svc.can_manage(actor_id, p)
    if not (manager or i.assigned_to == actor_id):
        raise DomainError("Only the assignee or the project manager can change this issue.", code="forbidden", status_code=403)
    if i.status == "CLOSED":
        raise DomainError("A closed issue cannot be changed.", code="invalid_state")
    if severity:
        if severity not in SEVERITIES:
            raise ValidationFailed("Unknown severity.", code="invalid_severity")
        if not manager:
            raise DomainError("Only the project manager changes severity.", code="forbidden", status_code=403)
        i.severity = severity
    if assigned_to:
        if not manager:
            raise DomainError("Only the project manager reassigns issues.", code="forbidden", status_code=403)
        _check_user(p, assigned_to)
        i.assigned_to = assigned_to
    if due_on:
        i.due_on = due_on
    if status:
        allowed = {"OPEN": ("IN_PROGRESS", "RESOLVED"), "IN_PROGRESS": ("OPEN", "RESOLVED"), "RESOLVED": ("IN_PROGRESS", "CLOSED")}
        if status not in allowed.get(i.status, ()):
            raise DomainError(f"An issue cannot move from {i.status} to {status}.", code="invalid_state_transition")
        if status == "RESOLVED":
            if not (resolution or "").strip():
                raise ValidationFailed("Describe the resolution.", code="reason_required")
            i.resolution, i.resolved_by = resolution, actor_id
        if status == "CLOSED":
            if not manager:
                raise DomainError("Only the project manager closes an issue.", code="forbidden", status_code=403)
            if i.resolved_by == actor_id:
                raise DomainError("Separation of duties: someone other than the resolver confirms and closes the issue.", code="separation_of_duties", status_code=403)
        i.status = status
    i.save()
    return i


def view_risks(project_id):
    return m.Risk.objects.filter(project_id=project_id).order_by("-created_at")


def register_summary(project_id):
    risks = m.Risk.objects.filter(project_id=project_id).exclude(status="CLOSED")
    issues = m.Issue.objects.filter(project_id=project_id, status__in=OPEN_ISSUE)
    return {"open_risks": risks.count(), "high_risks": sum(1 for r in risks if r.score >= 15), "open_issues": issues.count(), "critical_issues": issues.filter(severity="CRITICAL").count(), "high_issues": issues.filter(severity__in=("HIGH", "CRITICAL")).count()}


def no_blocking_issues(project):
    n = m.Issue.objects.filter(project=project, status__in=OPEN_ISSUE + ("RESOLVED",), severity__in=("HIGH", "CRITICAL")).count()
    if n:
        raise DomainError(f"{n} high or critical issue(s) are still open or awaiting confirmation.", code="issues_open")


@transaction.atomic
def run_reminders(today=None):
    """Remind owners of risks due for review and assignees of overdue issues; each at most weekly."""
    today = today or timezone.now().date()
    sent = 0
    for r in m.Risk.objects.select_for_update(of=("self",)).filter(review_on__lte=today).exclude(status="CLOSED").select_related("project"):
        if r.project.status in ("COMPLETED", "CANCELLED") or (r.last_reminder_on and (today - r.last_reminder_on).days < 7):
            continue
        notify([r.owner_id], "projects.risk_review", f"Risk review due on {r.project.code}: {r.title[:80]}", "", ref_type="projects.risk", ref_id=str(r.id))
        r.last_reminder_on = today
        r.save(update_fields=["last_reminder_on", "updated_at"])
        sent += 1
    for i in m.Issue.objects.select_for_update(of=("self",)).filter(due_on__lt=today, status__in=OPEN_ISSUE).select_related("project"):
        if i.project.status in ("COMPLETED", "CANCELLED") or (i.last_reminder_on and (today - i.last_reminder_on).days < 7):
            continue
        notify([x for x in {i.assigned_to, i.project.manager_id} if x], "projects.issue_overdue", f"Overdue issue on {i.project.code}: {i.title[:80]}", "", ref_type="projects.issue", ref_id=str(i.id))
        i.last_reminder_on = today
        i.save(update_fields=["last_reminder_on", "updated_at"])
        sent += 1
    return sent

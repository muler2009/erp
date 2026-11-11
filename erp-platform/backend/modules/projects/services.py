"""Projects: creation, team, status lifecycle and the object-level access rules every other projects service uses."""
from decimal import Decimal

from django.db import IntegrityError, transaction

from modules.projects import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.users.models import TenantMembership
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")
TRANSITIONS = {"PLANNING": {"ACTIVE", "CANCELLED"}, "ACTIVE": {"ON_HOLD", "COMPLETED", "CANCELLED"}, "ON_HOLD": {"ACTIVE", "CANCELLED"}, "COMPLETED": set(), "CANCELLED": set()}
EDITABLE = ("PLANNING", "ACTIVE", "ON_HOLD")


def _dec(v, name="amount"):
    try:
        d = Decimal(str(v if v is not None else 0))
    except Exception:
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")
    if not d.is_finite():
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")
    return d


def get_project(pk, lock=False):
    qs = m.Project.objects.select_for_update(of=("self",)) if lock else m.Project.objects
    p = qs.filter(pk=pk).first()
    if p is None:
        raise DomainError("Project not found.", code="not_found", status_code=404)
    return p


def _member(project, user_id):
    return m.ProjectMember.objects.filter(project=project, user_id=user_id, is_active=True).first()


def can_view(user_id, project):
    if authz.has_permission(user_id, "projects.view_all") or authz.has_permission(user_id, "projects.manage"):
        return True
    return project.manager_id == user_id or (authz.has_permission(user_id, "projects.view") and _member(project, user_id) is not None)


def can_manage(user_id, project):
    if authz.has_permission(user_id, "projects.manage"):
        return True
    mem = _member(project, user_id)
    return project.manager_id == user_id or (mem is not None and mem.role == "MANAGER")


def can_see_costs(user_id, project):
    return can_manage(user_id, project) or authz.has_permission(user_id, "projects.view_all")


def require_view(user_id, project_id):
    p = get_project(project_id)
    if not can_view(user_id, p):
        raise DomainError("Project not found.", code="not_found", status_code=404)  # do not reveal projects you cannot see
    return p


def require_manage(user_id, project_id, lock=False, editable=True):
    p = get_project(project_id, lock=lock)
    if not can_view(user_id, p):
        raise DomainError("Project not found.", code="not_found", status_code=404)
    if not can_manage(user_id, p):
        raise DomainError("Only the project manager can do this.", code="forbidden", status_code=403)
    if editable and p.status not in EDITABLE:
        raise DomainError(f"The project is {p.status.lower()} and can no longer be changed.", code="project_closed")
    return p


def visible_projects(user_id):
    qs = m.Project.objects.all()
    if authz.has_permission(user_id, "projects.view_all") or authz.has_permission(user_id, "projects.manage"):
        return qs
    ids = m.ProjectMember.objects.filter(user_id=user_id, is_active=True).values_list("project_id", flat=True)
    return qs.filter(pk__in=list(ids)) | qs.filter(manager_id=user_id)


def _active_user(user_id):
    return TenantMembership.objects.filter(tenant=current_tenant(), user_id=user_id, status="ACTIVE").exists()


@transaction.atomic
def create_project(actor_id, *, name, start_on, end_on, manager_id=None, description="", billing_type="FIXED", contract_value=0, customer_id=None, department_id=None, cost_center_id=None, priority="MEDIUM"):
    if not (name or "").strip():
        raise ValidationFailed("Name the project.", code="name_required")
    if end_on < start_on:
        raise ValidationFailed("The project cannot end before it starts.", code="invalid_dates")
    if billing_type not in m.BILLING:
        raise ValidationFailed("Billing type must be FIXED, TIME_MATERIAL or NON_BILLABLE.", code="invalid_billing")
    value = _dec(contract_value, "contract_value")
    if value < 0 or (billing_type == "NON_BILLABLE" and value > 0):
        raise ValidationFailed("A non-billable project has no contract value and the value cannot be negative.", code="invalid_amount")
    manager = manager_id or actor_id
    if not _active_user(manager):
        raise ValidationFailed("The project manager must be an active user of this company.", code="invalid_manager")
    if customer_id:
        from modules.finance.models import Partner

        if not Partner.objects.filter(pk=customer_id, is_customer=True).exists():
            raise ValidationFailed("Unknown customer.", code="invalid_customer")
    p = m.Project.objects.create(code=sequences.next_number("projects.project", on_date=start_on, for_type="Project"), name=name[:200], description=description, billing_type=billing_type, contract_value=value, customer_id=customer_id, manager_id=manager, department_id=department_id, cost_center_id=cost_center_id, priority=priority, start_on=start_on, end_on=end_on, created_by=actor_id)
    m.ProjectMember.objects.create(project=p, user_id=manager, role="MANAGER")
    record_tenant_event(current_tenant(), "projects.project.created", actor_user_id=actor_id, target_type="Project", target_id=p.id, metadata={"code": p.code})
    return p


@transaction.atomic
def update_project(actor_id, project_id, *, expected_version=None, **attrs):
    p = require_manage(actor_id, project_id, lock=True)
    if expected_version is not None and expected_version != p.version:
        raise DomainError("The project was changed by someone else.", code="version_conflict")
    allowed = ("name", "description", "priority", "start_on", "end_on", "department_id", "cost_center_id", "contract_value", "billing_type", "customer_id", "manager_id")
    changed = False
    for k, v in attrs.items():
        if k not in allowed or v is None:
            continue
        if k == "contract_value":
            v = _dec(v, k)
            if v < 0:
                raise ValidationFailed("The contract value cannot be negative.", code="invalid_amount")
        if k == "billing_type" and v not in m.BILLING:
            raise ValidationFailed("Unknown billing type.", code="invalid_billing")
        if k == "manager_id":
            if not _active_user(v):
                raise ValidationFailed("The project manager must be an active user of this company.", code="invalid_manager")
            if v != p.manager_id and not authz.has_permission(actor_id, "projects.manage"):
                raise DomainError("Only a project administrator can hand the project to another manager.", code="forbidden", status_code=403)
        if getattr(p, k) != v:
            setattr(p, k, v)
            changed = True
    if p.end_on < p.start_on:
        raise ValidationFailed("The project cannot end before it starts.", code="invalid_dates")
    if p.billing_type == "NON_BILLABLE" and p.contract_value > 0:
        raise ValidationFailed("A non-billable project has no contract value.", code="invalid_amount")
    if changed:
        p.version += 1
        p.save()
        if not _member(p, p.manager_id):
            m.ProjectMember.objects.create(project=p, user_id=p.manager_id, role="MANAGER")
    return p


@transaction.atomic
def set_status(actor_id, project_id, new, *, reason=""):
    p = require_manage(actor_id, project_id, lock=True, editable=False)
    if new not in m.STATUSES:
        raise ValidationFailed("Unknown status.", code="invalid_status")
    if new not in TRANSITIONS[p.status]:
        raise DomainError(f"A project cannot move from {p.status} to {new}.", code="invalid_state_transition")
    if new in ("COMPLETED", "CANCELLED", "ON_HOLD") and not (reason or "").strip() and new != "COMPLETED":
        raise ValidationFailed("A reason is required.", code="reason_required")
    if new == "COMPLETED":
        open_tasks = m.Task.objects.filter(project=p).exclude(status__in=("DONE", "CANCELLED")).count()
        if open_tasks:
            raise DomainError(f"{open_tasks} task(s) are still open.", code="tasks_open")
        from modules.projects import closure

        closure.check_can_complete(p)
    old = p.status
    from django.utils import timezone

    today = timezone.now().date()
    if new == "ACTIVE" and not p.actual_start:
        p.actual_start = today
    if new in ("COMPLETED", "CANCELLED"):
        p.actual_end, p.closed_reason = today, reason[:300]
    p.status = new
    p.version += 1
    p.save()
    record_tenant_event(current_tenant(), "projects.project.status_changed", actor_user_id=actor_id, target_type="Project", target_id=p.id, metadata={"old": old, "new": new})
    events.emit("projects.project.status_changed", {"project": p.code, "old": old, "new": new}, dedup_key=f"project:{p.id}:{new}")
    return p


# ----------------------------------------------------------------------------- team
@transaction.atomic
def add_member(actor_id, project_id, user_id, *, role="MEMBER", cost_rate=0, bill_rate=0, allocation_percent=100, employee_id=None):
    p = require_manage(actor_id, project_id, lock=True)
    if role not in m.MEMBER_ROLES:
        raise ValidationFailed("Role must be MANAGER, MEMBER or OBSERVER.", code="invalid_role")
    if role == "MANAGER" and not authz.has_permission(actor_id, "projects.manage") and p.manager_id != actor_id:
        raise DomainError("Only the project manager can appoint another manager.", code="forbidden", status_code=403)
    if not _active_user(user_id):
        raise ValidationFailed("The member must be an active user of this company.", code="invalid_user")
    cr, br, al = _dec(cost_rate, "cost_rate"), _dec(bill_rate, "bill_rate"), _dec(allocation_percent, "allocation_percent")
    if cr < 0 or br < 0 or not (0 < al <= 100):
        raise ValidationFailed("Rates cannot be negative and allocation must be between 0 and 100 percent.", code="invalid_amount")
    if employee_id:
        from modules.hr.models import Employee

        if not Employee.objects.filter(pk=employee_id).exists():
            raise ValidationFailed("Unknown employee.", code="invalid_employee")
    from modules.projects import resources

    if role != "OBSERVER" and resources.committed_allocation(user_id, p.start_on, p.end_on, exclude_project=p.id) + al > 100:
        raise DomainError("This person would be allocated more than 100 percent across overlapping projects.", code="over_allocated")
    try:
        with transaction.atomic():
            return m.ProjectMember.objects.create(project=p, user_id=user_id, role=role, cost_rate=cr, bill_rate=br, allocation_percent=al, employee_id=employee_id)
    except IntegrityError:
        raise DomainError("This person is already on the team.", code="already_pending")


@transaction.atomic
def remove_member(actor_id, project_id, user_id):
    p = require_manage(actor_id, project_id, lock=True)
    if user_id == p.manager_id:
        raise DomainError("The project manager cannot be removed; hand the project over first.", code="manager_required")
    mem = _member(p, user_id)
    if mem is None:
        raise DomainError("This person is not on the team.", code="not_found", status_code=404)
    open_tasks = m.Task.objects.filter(project=p, assignee_id=user_id).exclude(status__in=("DONE", "CANCELLED")).count()
    if open_tasks:
        raise DomainError(f"{open_tasks} open task(s) are still assigned to this person; reassign them first.", code="tasks_assigned")
    mem.is_active = False
    mem.save(update_fields=["is_active", "updated_at"])
    return mem


@transaction.atomic
def update_member(actor_id, project_id, user_id, **attrs):
    p = require_manage(actor_id, project_id, lock=True)
    mem = _member(p, user_id)
    if mem is None:
        raise DomainError("This person is not on the team.", code="not_found", status_code=404)
    for k in ("cost_rate", "bill_rate", "allocation_percent"):
        if attrs.get(k) is not None:
            v = _dec(attrs[k], k)
            if v < 0 or (k == "allocation_percent" and not (0 < v <= 100)):
                raise ValidationFailed(f"{k} is out of range.", code="invalid_amount")
            if k == "allocation_percent":
                from modules.projects import resources

                if mem.role != "OBSERVER" and resources.committed_allocation(user_id, p.start_on, p.end_on, exclude_project=p.id) + v > 100:
                    raise DomainError("This person would be allocated more than 100 percent across overlapping projects.", code="over_allocated")
            setattr(mem, k, v)
    mem.save()
    return mem

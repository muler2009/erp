"""HR and payroll services. Object-level rules live here: employees see themselves, managers their direct
reports, HR (`hr.view` / `hr.employee.manage`) everyone. Payroll rules (tax table, pension rates, components)
are tenant configuration; payslips are frozen once the run is approved."""
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone

from modules.finance import services as finance
from modules.hr import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.organizations import models as om
from platform_core.organizations import services as org
from platform_core.organizations.models import Currency
from platform_core.users.models import TenantMembership
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.sequences import services as sequences
from shared.tenancy import current_tenant
from shared.workflows import services as workflows

ZERO = Decimal("0")
LEAVE_SUBJECT, PAYROLL_SUBJECT = "hr.leave", "hr.payroll"
DEFAULT_LEAVE_TYPES = [  # code, name, paid, annual days, grant mode, extras
    ("ANNUAL", "Annual leave", True, 16, "ACCRUAL", dict(max_carryover_days=5, carryover_expiry_months=3, allow_half_day=True, min_notice_days=0)),
    ("SICK", "Sick leave", True, 10, "UPFRONT", dict(allow_half_day=True)),
    ("MATERNITY", "Maternity leave", True, 0, "MANUAL", dict(eligibility_months=0)),
    ("PATERNITY", "Paternity leave", True, 0, "MANUAL", dict()),
    ("COMPASSIONATE", "Compassionate leave", True, 0, "MANUAL", dict()),
    ("UNPAID", "Unpaid leave", False, 0, "MANUAL", dict()),
]
ONBOARDING_ITEMS = [("Sign employment contract", "HR"), ("Submit identity and tax documents", "EMPLOYEE"), ("Acknowledge HR policies", "EMPLOYEE"), ("Set up workstation and accounts", "IT"), ("Orientation and team introduction", "MANAGER")]
OFFBOARDING_ITEMS = [("Return company equipment", "IT"), ("Hand over work and responsibilities", "MANAGER"), ("Financial clearance (advances, loans, claims)", "FINANCE"), ("Exit interview", "HR")]  # system access is revoked automatically at termination


def add_months(d, months):
    y, mth = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, mth + 1
    last = (date(year + (month == 12), (month % 12) + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(d.day, last))


def seed_defaults():
    for code, name, paid, days, mode, extra in DEFAULT_LEAVE_TYPES:
        m.LeaveType.objects.get_or_create(code=code, defaults=dict(name=name, is_paid=paid, annual_days=days, grant_mode=mode, **extra))


# ----------------------------------------------------------------------------- helpers
def _dec(value, field="amount"):
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValidationFailed(f"{field} must be a decimal number.", code="invalid_amount")


def _q(value, decimals):
    return Decimal(value).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def _404(label):
    return DomainError(f"{label} not found.", code="not_found", status_code=404)


def _get(model, pk, label, lock=False):
    qs = model.objects.select_for_update() if lock else model.objects
    try:
        obj = qs.filter(pk=pk).first()
    except Exception:
        obj = None
    if obj is None:
        raise _404(label)
    return obj


def is_hr(user_id):
    return authz.has_permission(user_id, "hr.view") or authz.has_permission(user_id, "hr.employee.manage")


def is_manager_of(user_id, employee):
    return employee.manager_id is not None and employee.manager.user_id == user_id


def can_see(user_id, employee):
    return is_hr(user_id) or employee.user_id == user_id or is_manager_of(user_id, employee)


def visible_employees(user_id):
    qs = m.Employee.objects.select_related("department", "position", "manager")
    if is_hr(user_id):
        return qs
    return qs.filter(Q(user_id=user_id) | Q(manager__user_id=user_id))


def employee_for(user_id):
    e = m.Employee.objects.filter(user_id=user_id).first()
    if e is None:
        raise DomainError("You have no employee record.", code="no_employee_record", status_code=404)
    return e


def employee_visible(user_id, pk, lock=False):
    e = _get(m.Employee, pk, "Employee", lock)
    if not can_see(user_id, e):
        raise _404("Employee")  # same answer for missing and not yours
    return e


def _require_hr_manage(actor_id):
    if not authz.has_permission(actor_id, "hr.employee.manage"):
        raise DomainError("You cannot manage employee records.", code="permission_denied", status_code=403)


def _active_member(user_id):
    return TenantMembership.objects.filter(tenant=current_tenant(), user_id=user_id, status="ACTIVE").exists()


def _business_days(start, end):
    d, n = start, 0
    while d <= end:
        n += org.is_business_day(d)
        d += timedelta(days=1)
    return n


# ----------------------------------------------------------------------------- employees
def _norm(text):
    return " ".join((text or "").lower().split())


def find_duplicates(*, first_name, last_name, email="", tax_id="", hire_date=None, exclude_id=None):
    """Existing employees that look like the same person: same e-mail, same tax id, or same name + hire date."""
    q = Q()
    if email.strip():
        q |= Q(email__iexact=email.strip())
    if tax_id.strip():
        q |= Q(tax_id=tax_id.strip())
    hits = list(m.Employee.objects.filter(q)) if q else []
    for e in m.Employee.objects.filter(first_name__iexact=first_name.strip(), last_name__iexact=last_name.strip()):
        if hire_date and e.hire_date == hire_date and e not in hits:
            hits.append(e)
    return [e for e in hits if e.id != exclude_id]


def _headcount_check(position, exclude_employee_id=None):
    plan = m.PositionPlan.objects.filter(position=position).first()
    if plan is None or not org.get_setting("hr.enforce_headcount", False):
        return
    occupied = m.Employee.objects.filter(position=position).exclude(status="TERMINATED").exclude(pk=exclude_employee_id).count()
    if occupied >= plan.approved_headcount:
        raise DomainError(f"The approved headcount of {plan.approved_headcount} for this position is full.", code="headcount_full")


def log_event(employee, kind, effective_date, actor_id, **details):
    return m.EmployeeEvent.objects.create(employee=employee, kind=kind, effective_date=effective_date, actor_id=actor_id, details={k: (str(v) if v is not None else None) for k, v in details.items()})


@transaction.atomic
def create_employee(actor_id, *, first_name, last_name, hire_date, email="", phone="", department_id=None, position_id=None, manager_id=None, user_id=None, bank_account="", tax_id="", employment_type="FULL_TIME", grade_id=None, probation_months=None, date_of_birth=None, address="", allow_duplicate=False):
    if not first_name.strip() or not last_name.strip():
        raise ValidationFailed("first_name and last_name are required.", code="invalid_name")
    if employment_type not in m.Employee.EmploymentType.values:
        raise ValidationFailed("Invalid employment type.", code="invalid_employment_type")
    if user_id:
        if not _active_member(user_id):
            raise ValidationFailed("The linked user must be an active member.", code="invalid_user")
        if m.Employee.objects.filter(user_id=user_id).exists():
            raise DomainError("This user is already linked to an employee.", code="user_already_linked")
    dups = find_duplicates(first_name=first_name, last_name=last_name, email=email, tax_id=tax_id, hire_date=hire_date)
    if dups and not allow_duplicate:
        raise DomainError(f"Possible duplicate of {dups[0].employee_no} ({dups[0].name}).", code="duplicate_employee")
    dept = _get(om.Department, department_id, "Department") if department_id else None
    pos = _get(om.Position, position_id, "Position") if position_id else None
    if pos:
        _headcount_check(pos)
    mgr = _get(m.Employee, manager_id, "Manager") if manager_id else None
    grade = _get(m.JobGrade, grade_id, "Grade") if grade_id else None
    months = int(org.get_setting("hr.probation_months", 3)) if probation_months is None else int(probation_months)
    e = m.Employee.objects.create(employee_no=sequences.next_number("hr.employee", for_type="Employee"), first_name=first_name.strip(), last_name=last_name.strip(), email=email, phone=phone, hire_date=hire_date, department=dept, position=pos, manager=mgr, user_id=user_id, bank_account=bank_account, tax_id=tax_id, employment_type=employment_type, grade=grade, date_of_birth=date_of_birth, address=address[:300],
                                  probation_end=add_months(hire_date, months) if months else None, probation_status="IN_PROGRESS" if months else "NONE")
    m.ChecklistItem.objects.bulk_create([m.ChecklistItem(employee=e, kind="ONBOARDING", title=t, assignee_role=r, due_date=hire_date + timedelta(days=14)) for t, r in ONBOARDING_ITEMS])
    log_event(e, "HIRED", hire_date, actor_id, department=dept.name if dept else None, position=pos.title if pos else None, manager=mgr.employee_no if mgr else None, employment_type=employment_type)
    events.emit("hr.employee.created", {"employee_id": str(e.id), "employee_no": e.employee_no}, dedup_key=f"employee-created-{e.id}")
    record_tenant_event(current_tenant(), "hr.employee.created", actor_user_id=actor_id, target_type="Employee", target_id=e.id, metadata={"employee_no": e.employee_no})
    return e


@transaction.atomic
def update_employee(actor_id, employee_id, **fields):
    """Personal and contact details. Department, position, manager and grade change through
    `change_assignment` so that the history is kept and effective-dated."""
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if e.status == "TERMINATED":
        raise DomainError("A terminated employee cannot be edited.", code="invalid_state_transition")
    if any(k in fields and fields[k] is not None for k in ("department_id", "position_id", "manager_id", "grade_id")):
        raise ValidationFailed("Use an assignment change for department, position, manager or grade.", code="use_assignment_change")
    if fields.get("employment_type") is not None and fields["employment_type"] not in m.Employee.EmploymentType.values:
        raise ValidationFailed("Invalid employment type.", code="invalid_employment_type")
    for key in ("first_name", "last_name", "email", "phone", "bank_account", "tax_id", "address", "employment_type", "date_of_birth"):
        if fields.get(key) is not None:
            setattr(e, key, fields[key])
    if find_duplicates(first_name=e.first_name, last_name=e.last_name, email=e.email, tax_id=e.tax_id, exclude_id=e.id) and not fields.get("allow_duplicate"):
        raise DomainError("These details match another employee.", code="duplicate_employee")
    e.save()
    record_tenant_event(current_tenant(), "hr.employee.updated", actor_user_id=actor_id, target_type="Employee", target_id=e.id, metadata={"fields": sorted(k for k, v in fields.items() if v is not None)})
    return e


@transaction.atomic
def complete_checklist_item(actor_id, item_id):
    """HR can complete any task; the employee their own tasks; the line manager the manager tasks."""
    item = m.ChecklistItem.objects.select_for_update(of=("self",)).select_related("employee", "employee__manager").filter(pk=item_id).first()
    if item is None:
        raise _404("Checklist item")
    e = item.employee
    allowed = authz.has_permission(actor_id, "hr.employee.manage") or (item.assignee_role == "EMPLOYEE" and e.user_id == actor_id) or (item.assignee_role == "MANAGER" and is_manager_of(actor_id, e))
    if not allowed:
        raise _404("Checklist item")
    if item.done_at:
        raise DomainError("This item is already done.", code="invalid_state_transition")
    item.done_at, item.done_by = timezone.now(), actor_id
    item.save(update_fields=["done_at", "done_by", "updated_at"])
    return item


def _open_items(e, kind):
    return e.checklist.filter(kind=kind, done_at__isnull=True).count()


@transaction.atomic
def activate_employee(actor_id, employee_id):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if e.status != "ONBOARDING":
        raise DomainError("Only employees being onboarded can be activated.", code="invalid_state_transition")
    if n := _open_items(e, "ONBOARDING"):
        raise DomainError(f"{n} onboarding task(s) are still open.", code="onboarding_incomplete")
    e.status = "ACTIVE"
    e.save(update_fields=["status", "updated_at"])
    return e


SEPARATION_KINDS = ("RESIGNATION", "TERMINATION", "RETIREMENT", "END_OF_CONTRACT", "OTHER")


@transaction.atomic
def start_offboarding(actor_id, employee_id, *, termination_date, reason, separation_type="TERMINATION", requested_by=None):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if e.status != "ACTIVE":
        raise DomainError("Only active employees can be offboarded.", code="invalid_state_transition")
    if separation_type not in SEPARATION_KINDS:
        raise ValidationFailed("Invalid separation type.", code="invalid_separation_type")
    if not (reason or "").strip() or termination_date < e.hire_date:
        raise ValidationFailed("A reason and a termination date on or after the hire date are required.", code="invalid_termination")
    e.status, e.termination_date, e.termination_reason, e.separation_type = "OFFBOARDING", termination_date, reason[:300], separation_type
    e.save()
    sep = m.Separation.objects.filter(employee=e, status="REQUESTED").first()
    if sep:
        sep.status, sep.kind, sep.last_working_date, sep.decided_by = "ACCEPTED", separation_type, termination_date, actor_id
        sep.save()
    else:
        sep = m.Separation.objects.create(employee=e, kind=separation_type, last_working_date=termination_date, reason=reason[:300], status="ACCEPTED", requested_by=requested_by or actor_id, decided_by=actor_id)
    m.ChecklistItem.objects.bulk_create([m.ChecklistItem(employee=e, kind="OFFBOARDING", title=t, assignee_role=r, due_date=termination_date) for t, r in OFFBOARDING_ITEMS])
    log_event(e, "SEPARATION", termination_date, actor_id, type=separation_type, reason=reason[:100], stage="started")
    return e


@transaction.atomic
def submit_resignation(user_id, *, last_working_date, reason):
    """Employee self-service: request to resign. HR accepts it (starting offboarding) or rejects it."""
    e = employee_for(user_id)
    if e.status != "ACTIVE":
        raise DomainError("Only active employees can resign.", code="invalid_state_transition")
    if not (reason or "").strip() or last_working_date < timezone.now().date():
        raise ValidationFailed("A reason and a last working day that is not in the past are required.", code="invalid_termination")
    if m.Separation.objects.filter(employee=e, status="REQUESTED").exists():
        raise DomainError("A resignation request is already open.", code="request_open")
    return m.Separation.objects.create(employee=e, kind="RESIGNATION", last_working_date=last_working_date, reason=reason[:300], requested_by=user_id)


@transaction.atomic
def decide_resignation(actor_id, separation_id, *, accept, note=""):
    sep = m.Separation.objects.select_for_update().filter(pk=separation_id).first()
    if sep is None:
        raise _404("Request")
    if sep.status != "REQUESTED":
        raise DomainError("This request was already decided.", code="invalid_state_transition")
    if accept:
        start_offboarding(actor_id, sep.employee_id, termination_date=sep.last_working_date, reason=sep.reason, separation_type="RESIGNATION")
        return m.Separation.objects.get(pk=sep.pk)
    if not note.strip():
        raise ValidationFailed("A note is required when rejecting.", code="reason_required")
    sep.status, sep.decided_by, sep.settlement_notes = "REJECTED", actor_id, note[:500]
    sep.save()
    return sep


@transaction.atomic
def withdraw_resignation(user_id, separation_id):
    sep = m.Separation.objects.select_for_update().filter(pk=separation_id, employee__user_id=user_id).first()
    if sep is None:
        raise _404("Request")
    if sep.status != "REQUESTED":
        raise DomainError("Only open requests can be withdrawn.", code="invalid_state_transition")
    sep.status = "WITHDRAWN"
    sep.save(update_fields=["status", "updated_at"])
    return sep


@transaction.atomic
def record_settlement(actor_id, employee_id, *, amount, notes=""):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    sep = m.Separation.objects.select_for_update().filter(employee=e, status="ACCEPTED").first()
    if sep is None:
        raise DomainError("The employee is not being offboarded.", code="invalid_state_transition")
    amount = _dec(amount, "amount")
    sep.settlement_amount, sep.settlement_notes, sep.settlement_recorded = amount, notes[:500], True
    sep.save()
    return sep


@transaction.atomic
def complete_offboarding(actor_id, employee_id):
    """Close the employment: every clearance task done and the final settlement recorded. Ends contracts,
    cancels pending leave and revokes the person's access to the ERP."""
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if e.status != "OFFBOARDING":
        raise DomainError("The employee is not being offboarded.", code="invalid_state_transition")
    if n := _open_items(e, "OFFBOARDING"):
        raise DomainError(f"{n} offboarding task(s) are still open.", code="offboarding_incomplete")
    sep = m.Separation.objects.select_for_update().filter(employee=e, status="ACCEPTED").first()
    if sep is None or not sep.settlement_recorded:
        raise DomainError("The final settlement must be recorded first.", code="settlement_missing")
    e.contracts.filter(Q(end_date__isnull=True) | Q(end_date__gt=e.termination_date)).update(end_date=e.termination_date)
    e.leave_requests.filter(status="PENDING").update(status="CANCELLED")
    e.status = "TERMINATED"
    e.save(update_fields=["status", "updated_at"])
    sep.status = "COMPLETED"
    sep.save(update_fields=["status", "updated_at"])
    if e.user_id:
        ms = TenantMembership.objects.filter(tenant=current_tenant(), user_id=e.user_id, status="ACTIVE").first()
        if ms:
            from platform_core.users import services as user_services

            user_services.set_membership_status(current_tenant(), actor_id, ms, active=False)  # IAM lifecycle: access is revoked
    log_event(e, "SEPARATION", e.termination_date, actor_id, type=e.separation_type, stage="completed", settlement=sep.settlement_amount)
    events.emit("hr.employee.terminated", {"employee_id": str(e.id), "termination_date": str(e.termination_date)}, dedup_key=f"employee-terminated-{e.id}")
    record_tenant_event(current_tenant(), "hr.employee.terminated", actor_user_id=actor_id, target_type="Employee", target_id=e.id)
    return e


# ----------------------------------------------------------------------------- contracts
@transaction.atomic
def add_contract(actor_id, employee_id, *, start_date, monthly_salary, currency, kind="PERMANENT", end_date=None):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if e.status == "TERMINATED":
        raise DomainError("A terminated employee cannot get a contract.", code="invalid_state_transition")
    if kind not in m.Contract.Kind.values:
        raise ValidationFailed("Invalid contract kind.", code="invalid_kind")
    salary = _dec(monthly_salary, "monthly_salary")
    if salary < 0 or (end_date and end_date < start_date):
        raise ValidationFailed("Salary must be non-negative and the end date not before the start date.", code="invalid_contract")
    if kind == "FIXED_TERM" and not end_date:
        raise ValidationFailed("A fixed-term contract needs an end date.", code="invalid_contract")
    if not Currency.objects.filter(code=currency, is_active=True).exists():
        raise ValidationFailed(f"Currency {currency} is not active.", code="invalid_currency")
    far = date.max
    for c in e.contracts.all():
        if start_date <= (c.end_date or far) and (end_date or far) >= c.start_date:
            raise DomainError("The contract overlaps an existing contract.", code="contract_overlap")
    c = m.Contract.objects.create(employee=e, kind=kind, start_date=start_date, end_date=end_date, monthly_salary=salary, currency=currency, created_by=actor_id)
    record_tenant_event(current_tenant(), "hr.contract.created", actor_user_id=actor_id, target_type="Contract", target_id=c.id, metadata={"employee": e.employee_no})
    return c


@transaction.atomic
def end_contract(actor_id, contract_id, end_date):
    c = m.Contract.objects.select_for_update().filter(pk=contract_id).first()
    if c is None:
        raise _404("Contract")
    if end_date < c.start_date or (c.end_date and end_date > c.end_date):
        raise ValidationFailed("Invalid end date.", code="invalid_contract")
    c.end_date = end_date
    c.save(update_fields=["end_date", "updated_at"])
    return c


# ----------------------------------------------------------------------------- attendance
WORK_MODES = ("OFFICE", "REMOTE", "FIELD", "TRAVEL")


@transaction.atomic
def check_in(user_id, now=None, work_mode="OFFICE"):
    e = employee_for(user_id)
    now = now or timezone.now()
    if work_mode not in WORK_MODES:
        raise ValidationFailed("Invalid work mode.", code="invalid_work_mode")
    if e.status != "ACTIVE":
        raise DomainError("Only active employees can clock in.", code="invalid_state_transition")
    try:
        with transaction.atomic():
            return m.Attendance.objects.create(employee=e, work_date=now.date(), check_in=now, work_mode=work_mode, source="CLOCK")
    except IntegrityError:
        raise DomainError("You already clocked in today.", code="already_checked_in")


@transaction.atomic
def check_out(user_id, now=None):
    e = employee_for(user_id)
    now = now or timezone.now()
    a = m.Attendance.objects.select_for_update().filter(employee=e, check_out__isnull=True).order_by("-check_in").first()
    if a is None:
        raise DomainError("You are not clocked in.", code="not_checked_in")
    if now <= a.check_in:
        raise ValidationFailed("Check-out must be after check-in.", code="invalid_time")
    a.check_out = now
    a.save(update_fields=["check_out", "updated_at"])
    return a


@transaction.atomic
def record_attendance(actor_id, employee_id, *, work_date, check_in, check_out=None, work_mode="OFFICE", source="MANUAL"):
    e = _get(m.Employee, employee_id, "Employee")
    if check_out and check_out <= check_in:
        raise ValidationFailed("Check-out must be after check-in.", code="invalid_time")
    if work_mode not in WORK_MODES:
        raise ValidationFailed("Invalid work mode.", code="invalid_work_mode")
    a, created = m.Attendance.objects.update_or_create(employee=e, work_date=work_date, defaults=dict(check_in=check_in, check_out=check_out, work_mode=work_mode, source=source))
    record_tenant_event(current_tenant(), "hr.attendance.recorded", actor_user_id=actor_id, target_type="Attendance", target_id=a.id, metadata={"employee": e.employee_no, "corrected": not created, "source": source})
    return a


# ----------------------------------------------------------------------------- leave
def acts_as_manager(user_id, employee, on_date=None):
    """The employee's line manager, or someone the manager has delegated approvals to for today."""
    if is_manager_of(user_id, employee):
        return True
    if employee.manager_id is None or employee.manager.user_id is None:
        return False
    on_date = on_date or timezone.now().date()
    return m.LeaveDelegation.objects.filter(delegator_id=employee.manager.user_id, delegate_id=user_id, revoked_at__isnull=True, start_date__lte=on_date, end_date__gte=on_date).exists()


def leave_balance(employee, leave_type, year, *, as_of=None, request_end=None):
    """Entitlement vs usage for one leave year. Carried-over days are used first (earliest expiry first) and are
    usable only until they expire; `request_end` limits usable days to those valid on that date."""
    entries = list(m.LeaveAllocation.objects.filter(employee=employee, leave_type=leave_type, year=year).order_by("expires_on", "created_at"))
    buckets = sorted(([e.days, e.expires_on] for e in entries), key=lambda b: (b[1] is None, b[1] or date.max))
    reqs = m.LeaveRequest.objects.filter(employee=employee, leave_type=leave_type, start_date__year=year, status__in=["PENDING", "APPROVED"]).order_by("start_date")
    used = ZERO
    for r in reqs:
        need = r.days
        used += r.days
        for b in buckets:  # take from buckets that are still valid on the leave's last day, earliest expiry first
            if need <= 0:
                break
            if b[1] is not None and b[1] < r.end_date:
                continue
            take = min(b[0], need)
            b[0] -= take
            need -= take
        if need > 0:  # overdrawn (e.g. an allocation was reduced after approval): take from anything left
            for b in buckets:
                take = min(b[0], need)
                b[0] -= take
                need -= take
    ref = request_end or as_of or timezone.now().date()
    usable = sum((b[0] for b in buckets if b[1] is None or b[1] >= ref), ZERO)
    expired = sum((b[0] for b in buckets if b[1] is not None and b[1] < ref), ZERO)
    allocated = sum((e.days for e in entries), ZERO)
    return {"allocated": allocated, "used": used, "expired": expired, "remaining": usable}


@transaction.atomic
def allocate_leave(actor_id, employee_id, *, leave_type, year, days):
    """HR sets the manual grant for a year (replaces the earlier manual grant for that year)."""
    e = _get(m.Employee, employee_id, "Employee")
    lt = _get(m.LeaveType, leave_type, "Leave type")
    days = _dec(days, "days")
    if days < 0:
        raise ValidationFailed("days must be non-negative.", code="invalid_amount")
    a, _ = m.LeaveAllocation.objects.update_or_create(employee=e, leave_type=lt, year=year, kind="MANUAL", period="", defaults={"days": days})
    record_tenant_event(current_tenant(), "hr.leave.allocated", actor_user_id=actor_id, target_type="LeaveAllocation", target_id=a.id, metadata={"employee": e.employee_no, "type": lt.code, "year": year, "days": str(days)})
    return a


def check_eligibility(employee, lt, on_date):
    if lt.eligible_employment_types and employee.employment_type not in lt.eligible_employment_types:
        raise DomainError(f"{lt.name} is not available for {employee.employment_type} employees.", code="not_eligible")
    served = (on_date.year - employee.hire_date.year) * 12 + on_date.month - employee.hire_date.month - (on_date.day < employee.hire_date.day)
    if served < lt.eligibility_months:
        raise DomainError(f"{lt.name} needs {lt.eligibility_months} months of service.", code="not_eligible")


@transaction.atomic
def request_leave(actor_id, employee_id, *, leave_type, start_date, end_date, reason="", half_day=""):
    e = _get(m.Employee, employee_id, "Employee", lock=True)  # serialises balance checks per employee
    on_behalf = e.user_id != actor_id
    if on_behalf and not authz.has_permission(actor_id, "hr.employee.manage"):
        raise _404("Employee")
    if e.status not in ("ACTIVE", "ONBOARDING"):
        raise DomainError("This employee cannot take leave.", code="invalid_state_transition")
    lt = m.LeaveType.objects.filter(pk=leave_type, is_active=True).first()
    if lt is None:
        raise ValidationFailed("Unknown leave type.", code="invalid_leave_type")
    if end_date < start_date or start_date.year != end_date.year:
        raise ValidationFailed("The leave must end on or after it starts and stay within one calendar year.", code="invalid_dates")
    check_eligibility(e, lt, start_date)
    if half_day:
        if half_day not in ("AM", "PM") or not lt.allow_half_day or start_date != end_date:
            raise ValidationFailed("Half days are allowed for single-day requests of types that permit them.", code="invalid_half_day")
        days = Decimal("0.5") if org.is_business_day(start_date) else ZERO
    else:
        days = Decimal(_business_days(start_date, end_date))
    if days <= 0:
        raise ValidationFailed("The period contains no working days.", code="no_working_days")
    if lt.max_consecutive_days and (end_date - start_date).days + 1 > lt.max_consecutive_days:
        raise ValidationFailed(f"At most {lt.max_consecutive_days} consecutive days for {lt.name}.", code="too_long")
    if lt.min_notice_days and not on_behalf and (start_date - timezone.now().date()).days < lt.min_notice_days:
        raise ValidationFailed(f"{lt.name} needs {lt.min_notice_days} days notice.", code="insufficient_notice")
    for other in m.LeaveRequest.objects.filter(employee=e, status__in=["PENDING", "APPROVED"], start_date__lte=end_date, end_date__gte=start_date):
        opposite_halves = half_day and other.half_day and start_date == end_date == other.start_date == other.end_date and half_day != other.half_day
        if not opposite_halves:  # two requests clash unless they are the AM and PM of the same single day
            raise DomainError("This overlaps another leave request.", code="leave_overlap")
    if lt.is_paid and (bal := leave_balance(e, lt, start_date.year, request_end=end_date))["remaining"] < days:
        raise DomainError(f"Insufficient leave balance ({bal['remaining']} days left).", code="insufficient_leave_balance")
    req = m.LeaveRequest.objects.create(employee=e, leave_type=lt, start_date=start_date, end_date=end_date, days=days, half_day=half_day, reason=reason[:300])
    if workflows.WorkflowDefinition.objects.filter(subject_type=LEAVE_SUBJECT, is_active=True).exists():
        inst = workflows.submit(actor_id, LEAVE_SUBJECT, str(req.id), title=f"Leave {e.name} {start_date}–{end_date}")
        req.workflow_instance_id = inst.id
        req.save(update_fields=["workflow_instance_id"])
    else:
        from modules.hr import reminders

        reminders.leave_requested(req)
    return req


@transaction.atomic
def decide_leave(actor_id, request_id, *, approve, note=""):
    req = m.LeaveRequest.objects.select_for_update(of=("self",)).select_related("employee", "employee__manager").filter(pk=request_id).first()
    if req is None:
        raise _404("Leave request")
    e = req.employee
    can = authz.has_permission(actor_id, "hr.leave.approve") and (acts_as_manager(actor_id, e) or authz.has_permission(actor_id, "hr.employee.manage"))
    if not can:
        raise _404("Leave request")
    if req.status != "PENDING":
        raise DomainError("This request was already decided.", code="invalid_state_transition")
    if req.workflow_instance_id:
        raise DomainError("This request is governed by an approval workflow; decide it in the approval inbox.", code="workflow_governed")
    if e.user_id == actor_id:
        raise DomainError("Separation of duties: you cannot decide your own leave.", code="separation_of_duties", status_code=403)
    if not approve and not note.strip():
        raise ValidationFailed("A note is required when rejecting.", code="reason_required")
    req.status, req.decided_by, req.decision_note = ("APPROVED" if approve else "REJECTED"), actor_id, note[:300]
    req.save()
    from modules.hr import reminders

    reminders.leave_decided(req)
    return req


@transaction.atomic
def cancel_leave(actor_id, request_id):
    req = m.LeaveRequest.objects.select_for_update(of=("self",)).select_related("employee").filter(pk=request_id).first()
    if req is None or not (req.employee.user_id == actor_id or authz.has_permission(actor_id, "hr.employee.manage")):
        raise _404("Leave request")
    if req.status == "PENDING" or (req.status == "APPROVED" and req.start_date > timezone.now().date()):
        if req.workflow_instance_id:
            inst = workflows.WorkflowInstance.objects.filter(pk=req.workflow_instance_id, status__in=workflows.WorkflowInstance.ACTIVE).first()
            req.workflow_instance_id = None
            req.save(update_fields=["workflow_instance_id"])
            if inst:
                workflows.cancel(actor_id, inst.id, comment="Leave cancelled")
                req = m.LeaveRequest.objects.select_for_update(of=("self",)).get(pk=request_id)
        req.status = "CANCELLED"
        req.save(update_fields=["status", "updated_at"])
        return req
    raise DomainError("This request can no longer be cancelled.", code="invalid_state_transition")


def _on_leave_outcome(instance):
    req = m.LeaveRequest.objects.select_for_update().filter(pk=instance.subject_id).first()
    if req is None or req.workflow_instance_id != instance.id or req.status != "PENDING":
        return
    last = instance.actions.filter(action__in=["APPROVED", "REJECTED"]).order_by("-created_at").first()
    req.status = {"APPROVED": "APPROVED", "REJECTED": "REJECTED"}.get(instance.status, "CANCELLED")
    req.decided_by = last.actor_id if last else None
    req.save()
    from modules.hr import reminders

    reminders.leave_decided(req)


# ----------------------------------------------------------------------------- timesheets
def _entries_valid(week_start, entries):
    perday = {}
    out = []
    for r in entries:
        d = r["work_date"]
        h = _dec(r["hours"], "hours")
        if not (week_start <= d <= week_start + timedelta(days=6)) or not (ZERO < h <= 24):
            raise ValidationFailed("Entries must fall in the week and have 0 < hours <= 24.", code="invalid_entry")
        perday[d] = perday.get(d, ZERO) + h
        if perday[d] > 24:
            raise ValidationFailed("More than 24 hours on one day.", code="invalid_entry")
        out.append((d, h, (r.get("project_ref") or "")[:60], (r.get("description") or "")[:200]))
    return out


@transaction.atomic
def save_timesheet(actor_id, employee_id, week_start, entries):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if e.user_id != actor_id and not authz.has_permission(actor_id, "hr.employee.manage"):
        raise _404("Employee")
    if week_start.isoweekday() != 1:
        raise ValidationFailed("week_start must be a Monday.", code="invalid_week")
    rows = _entries_valid(week_start, entries)
    ts, _ = m.Timesheet.objects.select_for_update().get_or_create(employee=e, week_start=week_start)
    if ts.status not in ("DRAFT", "REJECTED"):
        raise DomainError("Only draft or rejected timesheets can be edited.", code="invalid_state_transition")
    ts.entries.all().delete()
    m.TimesheetEntry.objects.bulk_create([m.TimesheetEntry(timesheet=ts, work_date=d, hours=h, project_ref=p, description=t) for d, h, p, t in rows])
    ts.status = "DRAFT"
    ts.save(update_fields=["status", "updated_at"])
    return ts


@transaction.atomic
def submit_timesheet(actor_id, timesheet_id):
    ts = m.Timesheet.objects.select_for_update().filter(pk=timesheet_id).first()
    if ts is None or not (ts.employee.user_id == actor_id or authz.has_permission(actor_id, "hr.employee.manage")):
        raise _404("Timesheet")
    if ts.status != "DRAFT" or not ts.entries.exists():
        raise DomainError("Only a non-empty draft timesheet can be submitted.", code="invalid_state_transition")
    ts.status = "SUBMITTED"
    ts.save(update_fields=["status", "updated_at"])
    return ts


@transaction.atomic
def decide_timesheet(actor_id, timesheet_id, *, approve, note=""):
    ts = m.Timesheet.objects.select_for_update().filter(pk=timesheet_id).first()
    if ts is None or not authz.has_permission(actor_id, "hr.timesheet.approve") or not (acts_as_manager(actor_id, ts.employee) or authz.has_permission(actor_id, "hr.employee.manage")):
        raise _404("Timesheet")
    if ts.status != "SUBMITTED":
        raise DomainError("Only submitted timesheets can be decided.", code="invalid_state_transition")
    if ts.employee.user_id == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own timesheet.", code="separation_of_duties", status_code=403)
    if not approve and not note.strip():
        raise ValidationFailed("A note is required when rejecting.", code="reason_required")
    ts.status, ts.decided_by, ts.decision_note = ("APPROVED" if approve else "REJECTED"), actor_id, note[:300]
    ts.save()
    return ts


# ----------------------------------------------------------------------------- payroll configuration
@transaction.atomic
def set_tax_brackets(actor_id, brackets):
    rows = [(_dec(b["lower_bound"], "lower_bound"), _dec(b["rate"], "rate")) for b in brackets]
    if rows and (rows[0][0] != 0 or any(rows[i][0] >= rows[i + 1][0] for i in range(len(rows) - 1)) or any(not (0 <= r <= 100) for _, r in rows)):
        raise ValidationFailed("Brackets must start at 0, ascend strictly and have rates between 0 and 100.", code="invalid_brackets")
    m.TaxBracket.objects.all().delete()
    m.TaxBracket.objects.bulk_create([m.TaxBracket(lower_bound=lo, rate=r) for lo, r in rows])
    record_tenant_event(current_tenant(), "hr.tax_table.updated", actor_user_id=actor_id, target_type="TaxBracket", metadata={"brackets": len(rows)})
    return list(m.TaxBracket.objects.all())


@transaction.atomic
def create_component(actor_id, *, code, name, kind, calc, value, taxable=True):
    if kind not in m.PayComponent.Kind.values or calc not in m.PayComponent.Calc.values:
        raise ValidationFailed("Invalid kind or calculation.", code="invalid_component")
    value = _dec(value, "value")
    if value < 0 or (calc == "PERCENT_OF_BASIC" and value > 100):
        raise ValidationFailed("Invalid value.", code="invalid_component")
    if m.PayComponent.objects.filter(code=code).exists():
        raise DomainError("A component with this code exists.", code="code_taken")
    return m.PayComponent.objects.create(code=code, name=name, kind=kind, calc=calc, value=value, taxable=taxable)


@transaction.atomic
def assign_component(actor_id, employee_id, *, component, start_date, end_date=None, override_value=None):
    e = _get(m.Employee, employee_id, "Employee")
    comp = _get(m.PayComponent, component, "Component")
    if not comp.is_active or (end_date and end_date < start_date):
        raise ValidationFailed("Inactive component or invalid dates.", code="invalid_component")
    ov = _dec(override_value, "override_value") if override_value is not None else None
    if ov is not None and ov < 0:
        raise ValidationFailed("Override must be non-negative.", code="invalid_amount")
    return m.EmployeeComponent.objects.create(employee=e, component=comp, override_value=ov, start_date=start_date, end_date=end_date)


def _income_tax(taxable, brackets):
    """Progressive: each bracket taxes the slice of income between its lower bound and the next one's."""
    tax = ZERO
    for i, (lo, rate) in enumerate(brackets):
        hi = brackets[i + 1][0] if i + 1 < len(brackets) else None
        if taxable <= lo:
            break
        top = taxable if hi is None else min(taxable, hi)
        tax += (top - lo) * rate / 100
    return tax


# ----------------------------------------------------------------------------- payroll run
def _month_bounds(start, end):
    nxt = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    if start.day != 1 or end != nxt - timedelta(days=1):
        raise ValidationFailed("The payroll period must be one full calendar month.", code="invalid_period")


def _calculate(run, actor_id):
    base = org.get_company().base_currency
    dec = base.decimals
    start, end = run.period_start, run.period_end
    bdays = [d for d in (start + timedelta(days=i) for i in range((end - start).days + 1)) if org.is_business_day(d)]
    if not bdays:
        raise DomainError("The period has no working days.", code="no_working_days")
    working = Decimal(len(bdays))
    pe_pct = Decimal(str(org.get_setting("hr.pension_employee_percent", 7)))
    pr_pct = Decimal(str(org.get_setting("hr.pension_employer_percent", 11)))
    brackets = [(b.lower_bound, b.rate) for b in m.TaxBracket.objects.all()]
    run.rules_snapshot = {"base_currency": base.code, "pension_employee_percent": str(pe_pct), "pension_employer_percent": str(pr_pct), "tax_brackets": [[str(lo), str(r)] for lo, r in brackets]}
    from modules.hr import payroll_ext as px

    px.release(run)
    run.payslips.all().delete()
    totals = dict(gross=ZERO, tax=ZERO, pe=ZERO, pr=ZERO, ded=ZERO, net=ZERO)
    count = 0
    employees = m.Employee.objects.filter(hire_date__lte=end).exclude(status="ONBOARDING").filter(Q(termination_date__isnull=True) | Q(termination_date__gte=start)).order_by("employee_no")
    for e in employees:
        contracts = list(e.contracts.filter(start_date__lte=end).filter(Q(end_date__isnull=True) | Q(end_date__gte=start)))
        if not contracts:
            continue
        unpaid = list(e.leave_requests.filter(status="APPROVED", leave_type__is_paid=False, start_date__lte=end, end_date__gte=start))
        basic, payable, unpaid_days = ZERO, ZERO, ZERO
        for d in bdays:
            if d < e.hire_date or (e.termination_date and d > e.termination_date):
                continue
            c = next((c for c in contracts if c.start_date <= d and (c.end_date is None or d <= c.end_date)), None)
            if c is None:
                continue
            if any(l.start_date <= d <= l.end_date for l in unpaid):
                unpaid_days += 1
                continue
            payable += 1
            basic += c.monthly_salary * org.get_rate(c.currency, end) / working
        if payable == 0 and unpaid_days == 0:
            continue
        basic = _q(basic, dec)
        lines = [("BASIC", "Basic salary", "BASIC", basic)]
        allowances, taxable_allow, deductions = ZERO, ZERO, ZERO
        for ec in e.components.select_related("component").filter(start_date__lte=end).filter(Q(end_date__isnull=True) | Q(end_date__gte=start), component__is_active=True):
            comp = ec.component
            v = ec.override_value if ec.override_value is not None else comp.value
            amount = _q(basic * v / 100 if comp.calc == "PERCENT_OF_BASIC" else v, dec)
            if comp.kind == "ALLOWANCE":
                allowances += amount
                taxable_allow += amount if comp.taxable else 0
                lines.append((comp.code, comp.name, "ALLOWANCE", amount))
            else:
                deductions += amount
                lines.append((comp.code, comp.name, "DEDUCTION", -amount))
        overtime, earnings, taxable_extra, extra_ded, extra_lines = px.additions(run, e, contracts, end, dec)
        lines += extra_lines
        deductions += extra_ded
        gross = basic + allowances + overtime + earnings
        pen_e, pen_r = _q(basic * pe_pct / 100, dec), _q(basic * pr_pct / 100, dec)
        taxable = max(basic + taxable_allow + taxable_extra - pen_e, ZERO)
        tax = _q(_income_tax(taxable, brackets), dec)
        net = gross - tax - pen_e - deductions
        if net < 0:
            raise DomainError(f"Net pay for {e.employee_no} would be negative; review their deductions.", code="negative_net_pay")
        if pen_e:
            lines.append(("PENSION", "Employee pension", "PENSION", -pen_e))
        if tax:
            lines.append(("INCOME_TAX", "Income tax", "TAX", -tax))
        slip = m.Payslip.objects.create(run=run, employee=e, working_days=working, payable_days=payable, unpaid_leave_days=unpaid_days, basic=basic, allowances=allowances, overtime_pay=overtime, other_earnings=earnings, gross=gross, taxable_income=taxable, income_tax=tax, pension_employee=pen_e, other_deductions=deductions, net=net, pension_employer=pen_r)
        m.PayslipLine.objects.bulk_create([m.PayslipLine(payslip=slip, code=c, name=n, kind=k, amount=a) for c, n, k, a in lines])
        for key, val in (("gross", gross), ("tax", tax), ("pe", pen_e), ("pr", pen_r), ("ded", deductions), ("net", net)):
            totals[key] += val
        count += 1
    if not count:
        raise DomainError("No employee with a contract is payable in this period.", code="nothing_to_pay")
    run.gross_total, run.tax_total, run.pension_employee_total, run.pension_employer_total, run.deduction_total, run.net_total = (totals[k] for k in ("gross", "tax", "pe", "pr", "ded", "net"))
    run.version += 1
    run.save()
    return run


@transaction.atomic
def create_payroll_run(actor_id, period_start, period_end):
    _month_bounds(period_start, period_end)
    if m.PayrollRun.objects.exclude(status="CANCELLED").filter(period_start=period_start, period_end=period_end).exists():
        raise DomainError("A payroll run already exists for this period.", code="run_exists")
    try:
        with transaction.atomic():
            run = m.PayrollRun.objects.create(number=sequences.next_number("hr.payroll", on_date=period_end, for_type="PayrollRun"), period_start=period_start, period_end=period_end, created_by=actor_id)
    except IntegrityError:
        raise DomainError("A payroll run already exists for this period.", code="run_exists")
    return _calculate(run, actor_id)


@transaction.atomic
def recalculate_payroll(actor_id, run_id):
    run = _get(m.PayrollRun, run_id, "Payroll run", lock=True)
    if run.status != "DRAFT":
        raise DomainError("Only draft runs can be recalculated.", code="invalid_state_transition")
    return _calculate(run, actor_id)


@transaction.atomic
def submit_payroll(actor_id, run_id):
    run = _get(m.PayrollRun, run_id, "Payroll run", lock=True)
    if run.status != "DRAFT":
        raise DomainError("Only draft runs can be submitted.", code="invalid_state_transition")
    run.status = "PENDING_APPROVAL"
    if workflows.WorkflowDefinition.objects.filter(subject_type=PAYROLL_SUBJECT, is_active=True).exists():
        inst = workflows.submit(actor_id, PAYROLL_SUBJECT, str(run.id), amount=run.gross_total, title=f"Payroll {run.number} gross {run.gross_total}")
        run.workflow_instance_id = inst.id
    run.save()
    return run


@transaction.atomic
def approve_payroll(actor_id, run_id):
    run = _get(m.PayrollRun, run_id, "Payroll run", lock=True)
    if run.status != "PENDING_APPROVAL":
        raise DomainError("Only runs awaiting approval can be approved.", code="invalid_state_transition")
    if run.workflow_instance_id:
        raise DomainError("This run is governed by an approval workflow; decide it in the approval inbox.", code="workflow_governed")
    if run.created_by == actor_id:
        raise DomainError("Separation of duties: you cannot approve a run you prepared.", code="separation_of_duties", status_code=403)
    run.status, run.approved_by = "APPROVED", actor_id
    run.save(update_fields=["status", "approved_by", "updated_at"])
    record_tenant_event(current_tenant(), "hr.payroll.approved", actor_user_id=actor_id, target_type="PayrollRun", target_id=run.id)
    return run


@transaction.atomic
def reject_payroll(actor_id, run_id, note):
    run = _get(m.PayrollRun, run_id, "Payroll run", lock=True)
    if run.status != "PENDING_APPROVAL" or run.workflow_instance_id:
        raise DomainError("Only runs awaiting direct approval can be sent back.", code="invalid_state_transition")
    if not (note or "").strip():
        raise ValidationFailed("A note is required.", code="reason_required")
    run.status = "DRAFT"
    run.save(update_fields=["status", "updated_at"])
    return run


def _on_payroll_outcome(instance):
    run = m.PayrollRun.objects.select_for_update().filter(pk=instance.subject_id).first()
    if run is None or run.workflow_instance_id != instance.id or run.status != "PENDING_APPROVAL":
        return
    if instance.status == "APPROVED":
        last = instance.actions.filter(action="APPROVED").order_by("-created_at").first()
        run.status, run.approved_by = "APPROVED", last.actor_id if last else None
    else:
        run.status, run.workflow_instance_id = "DRAFT", None
    run.save()


@transaction.atomic
def cancel_payroll(actor_id, run_id):
    run = _get(m.PayrollRun, run_id, "Payroll run", lock=True)
    if run.status not in ("DRAFT", "PENDING_APPROVAL"):
        raise DomainError("Approved or posted runs cannot be cancelled.", code="invalid_state_transition")
    if run.workflow_instance_id:
        inst = workflows.WorkflowInstance.objects.filter(pk=run.workflow_instance_id, status__in=workflows.WorkflowInstance.ACTIVE).first()
        run.workflow_instance_id = None
        run.save(update_fields=["workflow_instance_id"])
        if inst:
            workflows.cancel(actor_id, inst.id, comment="Run cancelled")
            run = _get(m.PayrollRun, run_id, "Payroll run", lock=True)
    from modules.hr import payroll_ext as px

    px.release(run)
    run.status = "CANCELLED"
    run.save(update_fields=["status", "updated_at"])
    return run


@transaction.atomic
def post_payroll(actor_id, run_id):
    """Accrue the payroll in the ledger: Dr salaries (gross + employer pension); Cr payroll payable (net),
    tax/deductions payable, pension payable."""
    run = _get(m.PayrollRun, run_id, "Payroll run", lock=True)
    if run.status != "APPROVED":
        raise DomainError("Only approved runs can be posted.", code="invalid_state_transition")
    if run.approved_by == actor_id:
        raise DomainError("Separation of duties: the approver cannot also post the run.", code="separation_of_duties", status_code=403)
    org.assert_period_open(run.period_end)
    legs = [("salary_expense", "debit", run.gross_total + run.pension_employer_total), ("payroll_payable", "credit", run.net_total), ("payroll_tax_payable", "credit", run.tax_total + run.deduction_total), ("pension_payable", "credit", run.pension_employee_total + run.pension_employer_total)]
    entry = finance.post_system_journal(actor_id, run.period_end, f"Payroll {run.number}", "payroll", run.id, legs)
    run.status, run.posted_by, run.journal_id = "POSTED", actor_id, entry.id if entry else None
    run.save()
    from modules.hr import payroll_ext as px

    px.mark_repaid(run)
    events.emit("hr.payroll.posted", {"run_id": str(run.id), "number": run.number, "net_total": str(run.net_total)}, dedup_key=f"payroll-posted-{run.id}")
    return run


@transaction.atomic
def pay_payroll(actor_id, run_id, *, payment_date=None):
    """Record the salary payment (Dr payroll payable / Cr bank). A second call finds the run PAID and is refused."""
    run = _get(m.PayrollRun, run_id, "Payroll run", lock=True)
    if run.status != "POSTED":
        raise DomainError("Only posted runs can be paid (and only once).", code="invalid_state_transition")
    if actor_id in (run.approved_by, run.created_by, run.posted_by):
        raise DomainError("Separation of duties: the payment must be released by someone who did not prepare, approve or post the run.", code="separation_of_duties", status_code=403)
    payment_date = payment_date or timezone.now().date()
    org.assert_period_open(payment_date)
    entry = finance.post_system_journal(actor_id, payment_date, f"Salary payment {run.number}", "payroll_payment", run.id, [("payroll_payable", "debit", run.net_total), ("bank_default", "credit", run.net_total)])
    run.status, run.paid_by, run.payment_journal_id = "PAID", actor_id, entry.id if entry else None
    run.save()
    events.emit("hr.payroll.paid", {"run_id": str(run.id), "number": run.number, "net_total": str(run.net_total)}, dedup_key=f"payroll-paid-{run.id}")
    return run


# ----------------------------------------------------------------------------- reports
def headcount_report():
    rows = m.Employee.objects.exclude(status="TERMINATED").values("department__name", "status").annotate(n=Count("id")).order_by("department__name")
    return [{"department": r["department__name"] or "-", "status": r["status"], "count": r["n"]} for r in rows]


def payslips_visible_to(user_id, employee=None):
    qs = m.Payslip.objects.select_related("run", "employee").prefetch_related("lines")
    if authz.has_permission(user_id, "hr.payroll.view"):
        return qs.filter(employee=employee) if employee else qs
    mine = m.Employee.objects.filter(user_id=user_id).first()
    if mine is None or (employee and employee.id != mine.id):
        return qs.none()
    return qs.filter(employee=mine, run__status__in=["APPROVED", "POSTED", "PAID"])  # own slips only after approval

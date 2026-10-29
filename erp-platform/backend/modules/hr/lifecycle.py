"""Employee record, organisation and lifecycle services: grades, headcount plans, personal records, effective-dated
assignment changes with history, probation, documents, bulk import, org chart and monitoring lists."""
import csv
import io
from datetime import timedelta

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone

from modules.hr import models as m
from modules.hr import services as core
from modules.hr.services import _404, _dec, _get, add_months, authz, is_hr, is_manager_of, log_event, org
from platform_core.audit.services import record_tenant_event
from platform_core.organizations import models as om
from shared.api.errors import DomainError, ValidationFailed
from shared.files import services as files
from shared.tenancy import current_tenant

ZERO = core.ZERO


# ----------------------------------------------------------------------------- grades and headcount plans
@transaction.atomic
def create_grade(actor_id, *, code, name, min_salary=0, max_salary=0):
    lo, hi = _dec(min_salary, "min_salary"), _dec(max_salary, "max_salary")
    if lo < 0 or hi < lo:
        raise ValidationFailed("The salary band must be non-negative and ordered.", code="invalid_band")
    if m.JobGrade.objects.filter(code=code).exists():
        raise DomainError("A grade with this code exists.", code="code_taken")
    return m.JobGrade.objects.create(code=code, name=name, min_salary=lo, max_salary=hi)


@transaction.atomic
def set_position_plan(actor_id, position_id, *, approved_headcount, grade_id=None, job_description="", requirements=""):
    pos = _get(om.Position, position_id, "Position")
    if int(approved_headcount) < 0:
        raise ValidationFailed("approved_headcount must be non-negative.", code="invalid_headcount")
    grade = _get(m.JobGrade, grade_id, "Grade") if grade_id else None
    plan, _ = m.PositionPlan.objects.update_or_create(position=pos, defaults=dict(approved_headcount=int(approved_headcount), grade=grade, job_description=job_description, requirements=requirements))
    return plan


def headcount_plan():
    """Approved vs occupied vs vacant for every planned position."""
    occupied = {r["position_id"]: r["n"] for r in m.Employee.objects.exclude(status="TERMINATED").exclude(position__isnull=True).values("position_id").annotate(n=Count("id"))}
    out = []
    for plan in m.PositionPlan.objects.select_related("position", "position__department", "grade"):
        occ = occupied.get(plan.position_id, 0)
        out.append({"position": plan.position.title, "position_id": str(plan.position_id), "department": plan.position.department.name if plan.position.department_id else None, "grade": plan.grade.code if plan.grade_id else None, "approved": plan.approved_headcount, "occupied": occ, "vacant": max(plan.approved_headcount - occ, 0), "over_headcount": max(occ - plan.approved_headcount, 0)})
    return sorted(out, key=lambda r: r["position"])


def org_chart(user_id):
    """Reporting-line tree. HR sees the whole company, anyone else the tree under their own record."""
    emps = list(m.Employee.objects.exclude(status="TERMINATED").select_related("department", "position"))
    kids = {}
    for e in emps:
        kids.setdefault(e.manager_id, []).append(e)

    def node(e, depth=0):
        if depth > 25:
            return None
        return {"id": str(e.id), "employee_no": e.employee_no, "name": e.name, "position": e.position.title if e.position_id else None, "department": e.department.name if e.department_id else None, "reports": [n for n in (node(c, depth + 1) for c in sorted(kids.get(e.id, []), key=lambda x: x.employee_no)) if n]}

    if is_hr(user_id):
        ids = {e.id for e in emps}
        return [node(e) for e in sorted(emps, key=lambda x: x.employee_no) if e.manager_id is None or e.manager_id not in ids]
    mine = next((e for e in emps if e.user_id == user_id), None)
    return [node(mine)] if mine else []


# ----------------------------------------------------------------------------- personal records
def _own_or_hr(actor_id, employee_id, lock=False):
    e = _get(m.Employee, employee_id, "Employee", lock)
    if e.user_id != actor_id and not authz.has_permission(actor_id, "hr.employee.manage"):
        raise _404("Employee")
    return e


@transaction.atomic
def add_emergency_contact(actor_id, employee_id, *, name, relationship, phone):
    e = _own_or_hr(actor_id, employee_id)
    if not (name or "").strip() or not (phone or "").strip():
        raise ValidationFailed("name and phone are required.", code="invalid_contact")
    if e.emergency_contacts.count() >= 5:
        raise DomainError("At most 5 emergency contacts.", code="too_many")
    return m.EmergencyContact.objects.create(employee=e, name=name[:120], relationship=relationship[:40], phone=phone[:40])


@transaction.atomic
def add_qualification(actor_id, employee_id, *, kind, title, institution="", awarded_on=None, expires_on=None):
    e = _own_or_hr(actor_id, employee_id)
    if not (title or "").strip() or (awarded_on and expires_on and expires_on < awarded_on):
        raise ValidationFailed("A title and consistent dates are required.", code="invalid_qualification")
    return m.Qualification.objects.create(employee=e, kind=(kind or "OTHER")[:12], title=title[:200], institution=institution[:200], awarded_on=awarded_on, expires_on=expires_on)


@transaction.atomic
def set_skill(actor_id, employee_id, *, name, level):
    e = _own_or_hr(actor_id, employee_id)
    if not (name or "").strip() or not (1 <= int(level) <= 5):
        raise ValidationFailed("A name and a level between 1 and 5 are required.", code="invalid_skill")
    sk, _ = m.Skill.objects.update_or_create(employee=e, name=name.strip()[:80], defaults={"level": int(level)})
    return sk


@transaction.atomic
def remove_record(actor_id, model, pk):
    row = model.objects.select_related("employee").filter(pk=pk).first()
    if row is None or not (row.employee.user_id == actor_id or authz.has_permission(actor_id, "hr.employee.manage")):
        raise _404("Record")
    row.delete()


# ----------------------------------------------------------------------------- assignment changes (effective-dated, with history)
CHANGE_KINDS = ("PROMOTION", "TRANSFER", "REPORTING_LINE")


@transaction.atomic
def change_assignment(actor_id, employee_id, *, kind, effective_date, department_id=None, position_id=None, manager_id=None, clear_manager=False, grade_id=None, reason=""):
    """HR schedules the change directly; a line manager can only request it, and HR then approves.
    Nobody can request or approve a change to their own record."""
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    hr_user = authz.has_permission(actor_id, "hr.employee.manage")
    if not (hr_user or (is_manager_of(actor_id, e) and authz.has_permission(actor_id, "hr.leave.approve"))):
        raise _404("Employee")
    if e.user_id == actor_id:
        raise DomainError("Separation of duties: you cannot change your own assignment.", code="separation_of_duties", status_code=403)
    if e.status not in ("ACTIVE", "ONBOARDING"):
        raise DomainError("Only current employees can change assignment.", code="invalid_state_transition")
    if kind not in CHANGE_KINDS:
        raise ValidationFailed("Invalid change kind.", code="invalid_kind")
    if not (department_id or position_id or manager_id or clear_manager or grade_id):
        raise ValidationFailed("Nothing to change.", code="empty_change")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    dept = _get(om.Department, department_id, "Department") if department_id else None
    pos = _get(om.Position, position_id, "Position") if position_id else None
    mgr = _get(m.Employee, manager_id, "Manager") if manager_id else None
    grade = _get(m.JobGrade, grade_id, "Grade") if grade_id else None
    if mgr:
        _no_cycle(e, mgr)
    ch = m.AssignmentChange.objects.create(employee=e, kind=kind, effective_date=effective_date, department=dept, position=pos, manager=mgr, grade=grade, clear_manager=clear_manager, reason=reason[:300], requested_by=actor_id, status="SCHEDULED" if hr_user else "PENDING", approved_by=actor_id if hr_user else None)
    if ch.status == "SCHEDULED" and effective_date <= timezone.now().date():
        _apply(ch, actor_id)
    return ch


def _no_cycle(e, mgr):
    node = mgr
    while node is not None:
        if node.id == e.id:
            raise ValidationFailed("That would create a management cycle.", code="management_cycle")
        node = node.manager


@transaction.atomic
def decide_assignment_change(actor_id, change_id, *, approve, note=""):
    ch = m.AssignmentChange.objects.select_for_update(of=("self",)).select_related("employee").filter(pk=change_id).first()
    if ch is None:
        raise _404("Change")
    if ch.status != "PENDING":
        raise DomainError("This change was already decided.", code="invalid_state_transition")
    if ch.requested_by == actor_id or ch.employee.user_id == actor_id:
        raise DomainError("Separation of duties: you cannot decide this change.", code="separation_of_duties", status_code=403)
    if not approve:
        if not note.strip():
            raise ValidationFailed("A note is required when rejecting.", code="reason_required")
        ch.status, ch.approved_by = "CANCELLED", actor_id
        ch.save()
        return ch
    ch.status, ch.approved_by = "SCHEDULED", actor_id
    ch.save()
    if ch.effective_date <= timezone.now().date():
        _apply(ch, actor_id)
    return ch


@transaction.atomic
def cancel_assignment_change(actor_id, change_id):
    ch = m.AssignmentChange.objects.select_for_update().filter(pk=change_id).first()
    if ch is None or not (ch.requested_by == actor_id or authz.has_permission(actor_id, "hr.employee.manage")):
        raise _404("Change")
    if ch.status not in ("PENDING", "SCHEDULED"):
        raise DomainError("Applied or cancelled changes cannot be cancelled.", code="invalid_state_transition")
    ch.status = "CANCELLED"
    ch.save(update_fields=["status", "updated_at"])
    return ch


def _apply(ch, actor_id):
    e = m.Employee.objects.select_for_update(of=("self",)).select_related("department", "position", "manager", "grade").get(pk=ch.employee_id)
    if e.status == "TERMINATED":
        ch.status = "CANCELLED"
        ch.save(update_fields=["status", "updated_at"])
        return
    before = dict(department=e.department.name if e.department_id else None, position=e.position.title if e.position_id else None, manager=e.manager.employee_no if e.manager_id else None, grade=e.grade.code if e.grade_id else None)
    if ch.position_id and ch.position_id != e.position_id:
        core._headcount_check(ch.position, exclude_employee_id=e.id)
    if ch.manager_id:
        _no_cycle(e, ch.manager)
    if ch.department_id:
        e.department = ch.department
    if ch.position_id:
        e.position = ch.position
    if ch.grade_id:
        e.grade = ch.grade
    if ch.manager_id:
        e.manager = ch.manager
    elif ch.clear_manager:
        e.manager = None
    e.save()
    ch.status = "APPLIED"
    ch.save(update_fields=["status", "updated_at"])
    after = dict(department=e.department.name if e.department_id else None, position=e.position.title if e.position_id else None, manager=e.manager.employee_no if e.manager_id else None, grade=e.grade.code if e.grade_id else None)
    log_event(e, {"PROMOTION": "PROMOTION", "TRANSFER": "TRANSFER", "REPORTING_LINE": "REPORTING_LINE"}[ch.kind], ch.effective_date, actor_id, reason=ch.reason, **{f"from_{k}": v for k, v in before.items() if v != after[k]}, **{f"to_{k}": v for k, v in after.items() if v != before[k]})
    record_tenant_event(current_tenant(), "hr.assignment.changed", actor_user_id=actor_id, target_type="Employee", target_id=e.id, metadata={"kind": ch.kind, "effective": str(ch.effective_date)})


def apply_due_changes(on_date=None):
    """Apply every approved change whose effective date has come (run daily by the scheduler)."""
    on_date = on_date or timezone.now().date()
    done = 0
    for ch in m.AssignmentChange.objects.filter(status="SCHEDULED", effective_date__lte=on_date).order_by("effective_date", "created_at"):
        with transaction.atomic():
            locked = m.AssignmentChange.objects.select_for_update().get(pk=ch.pk)
            if locked.status == "SCHEDULED":
                _apply(locked, locked.approved_by or locked.requested_by)
                done += locked.status == "APPLIED"
    return done


def history(user_id, employee_id):
    e = core.employee_visible(user_id, employee_id)
    return [{"kind": ev.kind, "effective_date": str(ev.effective_date), "details": ev.details, "actor_id": str(ev.actor_id) if ev.actor_id else None, "recorded_at": ev.created_at} for ev in e.events.all()]


# ----------------------------------------------------------------------------- probation
@transaction.atomic
def evaluate_probation(actor_id, employee_id, *, outcome, notes="", new_probation_end=None):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if not (authz.has_permission(actor_id, "hr.employee.manage") or (is_manager_of(actor_id, e) and authz.has_permission(actor_id, "hr.leave.approve"))):
        raise _404("Employee")
    if e.user_id == actor_id:
        raise DomainError("Separation of duties: you cannot evaluate your own probation.", code="separation_of_duties", status_code=403)
    if e.probation_status not in ("IN_PROGRESS", "EXTENDED"):
        raise DomainError("The employee is not on probation.", code="invalid_state_transition")
    if outcome not in ("CONFIRM", "EXTEND", "FAIL"):
        raise ValidationFailed("outcome must be CONFIRM, EXTEND or FAIL.", code="invalid_outcome")
    if outcome == "EXTEND" and (not new_probation_end or new_probation_end <= (e.probation_end or e.hire_date)):
        raise ValidationFailed("An extension needs a new end date after the current one.", code="invalid_dates")
    if outcome in ("FAIL", "EXTEND") and not (notes or "").strip():
        raise ValidationFailed("Notes are required for this outcome.", code="reason_required")
    ev = m.ProbationEvaluation.objects.create(employee=e, evaluator_id=actor_id, outcome=outcome, notes=notes, new_probation_end=new_probation_end)
    e.probation_status = {"CONFIRM": "CONFIRMED", "EXTEND": "EXTENDED", "FAIL": "FAILED"}[outcome]
    if outcome == "EXTEND":
        e.probation_end = new_probation_end
    e.save()
    log_event(e, "PROBATION", timezone.now().date(), actor_id, outcome=outcome, notes=notes[:100])
    return ev


# ----------------------------------------------------------------------------- documents
def _can_see_document(user_id, doc_id):
    d = m.EmployeeDocument.objects.select_related("employee").filter(pk=doc_id).first()
    return d is not None and (d.employee.user_id == user_id or authz.has_permission(user_id, "hr.employee.manage"))


files.register_access_check("hr.employee_document", _can_see_document)


@transaction.atomic
def add_document(actor_id, employee_id, *, doc_type, title, filename, data, expires_on=None):
    """Store a new version of an employee document; older versions remain available."""
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if e.user_id != actor_id and not authz.has_permission(actor_id, "hr.employee.manage"):
        raise _404("Employee")
    if not (title or "").strip() or not (doc_type or "").strip():
        raise ValidationFailed("doc_type and title are required.", code="invalid_document")
    prev = m.EmployeeDocument.objects.select_for_update().filter(employee=e, doc_type=doc_type, title=title, is_current=True).first()
    doc = m.EmployeeDocument.objects.create(employee=e, doc_type=doc_type[:20], title=title[:200], version=(prev.version + 1) if prev else 1, expires_on=expires_on, uploaded_by=actor_id)
    stored = files.upload(actor_id, filename, data, ref_type="hr.employee_document", ref_id=str(doc.id))
    doc.file_id = stored.id
    doc.save(update_fields=["file_id", "updated_at"])
    if prev:
        prev.is_current = False
        prev.save(update_fields=["is_current", "updated_at"])
    return doc


@transaction.atomic
def set_document_requirement(actor_id, *, doc_type, title, employment_type=""):
    if employment_type and employment_type not in m.Employee.EmploymentType.values:
        raise ValidationFailed("Invalid employment type.", code="invalid_employment_type")
    r, _ = m.DocumentRequirement.objects.update_or_create(doc_type=doc_type, employment_type=employment_type, defaults={"title": title})
    return r


def missing_documents(employee):
    have = set(employee.documents.filter(is_current=True).values_list("doc_type", flat=True))
    reqs = m.DocumentRequirement.objects.filter(Q(employment_type="") | Q(employment_type=employee.employment_type))
    return [{"doc_type": r.doc_type, "title": r.title} for r in reqs if r.doc_type not in have]


# ----------------------------------------------------------------------------- bulk import
IMPORT_FIELDS = ("first_name", "last_name", "hire_date", "email", "phone", "tax_id", "bank_account", "employment_type", "date_of_birth", "address")
MAX_IMPORT_ROWS = 500


def parse_csv(text):
    if len(text) > 1_000_000:
        raise ValidationFailed("The file is too large.", code="file_too_large")
    reader = csv.DictReader(io.StringIO(text))
    return [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in reader]


def import_employees(actor_id, rows, *, commit=False):
    """Validate (and with commit=True create) employees in bulk. All-or-nothing: nothing is created when any row
    has an error. Duplicates against existing employees and within the file are reported per row."""
    from django.utils.dateparse import parse_date

    if len(rows) > MAX_IMPORT_ROWS:
        raise ValidationFailed(f"At most {MAX_IMPORT_ROWS} rows per import.", code="too_many_rows")
    report, seen, valid = [], {}, []
    for i, row in enumerate(rows, start=1):
        errors = []
        first, last = (row.get("first_name") or "").strip(), (row.get("last_name") or "").strip()
        hire = parse_date(str(row.get("hire_date") or "")) if row.get("hire_date") else None
        dob = parse_date(str(row["date_of_birth"])) if row.get("date_of_birth") else None
        if not first or not last:
            errors.append("first_name and last_name are required")
        if hire is None:
            errors.append("hire_date must be YYYY-MM-DD")
        if row.get("date_of_birth") and dob is None:
            errors.append("date_of_birth must be YYYY-MM-DD")
        et = (row.get("employment_type") or "FULL_TIME").strip().upper()
        if et not in m.Employee.EmploymentType.values:
            errors.append("invalid employment_type")
        email, tax = (row.get("email") or "").strip(), (row.get("tax_id") or "").strip()
        dup = core.find_duplicates(first_name=first, last_name=last, email=email, tax_id=tax, hire_date=hire) if first and last else []
        if dup:
            errors.append(f"duplicate of existing employee {dup[0].employee_no}")
        for key in ((email.lower(),) if email else ()) + ((f"tax:{tax}",) if tax else ()):
            if key in seen:
                errors.append(f"duplicate of row {seen[key]} in this file")
            else:
                seen[key] = i
        report.append({"row": i, "ok": not errors, "errors": errors})
        if not errors:
            valid.append((first, last, hire, email, row, dob, et))
    ok = all(r["ok"] for r in report)
    created = []
    if commit and ok:
        with transaction.atomic():
            for first, last, hire, email, row, dob, et in valid:
                e = core.create_employee(actor_id, first_name=first, last_name=last, hire_date=hire, email=email, phone=row.get("phone", ""), tax_id=row.get("tax_id", ""), bank_account=row.get("bank_account", ""), employment_type=et, date_of_birth=dob, address=row.get("address", ""))
                created.append(e.employee_no)
    return {"committed": bool(commit and ok), "rows": report, "created": created, "valid_rows": sum(r["ok"] for r in report), "error_rows": sum(not r["ok"] for r in report)}


# ----------------------------------------------------------------------------- monitoring lists (HR and line managers)
def _scope(user_id, qs):
    return qs if is_hr(user_id) else qs.filter(Q(user_id=user_id) | Q(manager__user_id=user_id))


def monitoring(user_id, within_days=60, today=None):
    today = today or timezone.now().date()
    horizon = today + timedelta(days=within_days)
    emps = _scope(user_id, m.Employee.objects.exclude(status="TERMINATED"))
    retire_age = int(org.get_setting("hr.retirement_age", 60))
    retiring = []
    for e in emps.filter(date_of_birth__isnull=False):
        at = e.date_of_birth.replace(year=e.date_of_birth.year + retire_age) if not (e.date_of_birth.month == 2 and e.date_of_birth.day == 29) else e.date_of_birth.replace(year=e.date_of_birth.year + retire_age, day=28)
        if today <= at <= horizon:
            retiring.append({"employee": e.employee_no, "name": e.name, "retirement_date": str(at)})
    return {
        "probation_ending": [{"employee": e.employee_no, "name": e.name, "probation_end": str(e.probation_end)} for e in emps.filter(probation_status__in=["IN_PROGRESS", "EXTENDED"], probation_end__lte=horizon).order_by("probation_end")],
        "contracts_expiring": [{"employee": c.employee.employee_no, "name": c.employee.name, "end_date": str(c.end_date)} for c in m.Contract.objects.filter(employee__in=emps, end_date__gte=today, end_date__lte=horizon).select_related("employee").order_by("end_date")],
        "documents_expiring": [{"employee": d.employee.employee_no, "title": d.title, "expires_on": str(d.expires_on)} for d in m.EmployeeDocument.objects.filter(employee__in=emps, is_current=True, expires_on__lte=horizon).select_related("employee").order_by("expires_on")],
        "qualifications_expiring": [{"employee": q.employee.employee_no, "title": q.title, "expires_on": str(q.expires_on)} for q in m.Qualification.objects.filter(employee__in=emps, expires_on__gte=today, expires_on__lte=horizon).select_related("employee")],
        "retirements": sorted(retiring, key=lambda r: r["retirement_date"]),
    }

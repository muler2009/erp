"""Project budgets (with approved revisions), expenses, time cost and the planned-versus-actual / earned-value report."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.projects import models as m
from modules.projects import services as svc
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

ZERO = Decimal("0")
Q4 = Decimal("0.0001")


def _org():
    from platform_core.organizations import services as org

    return org


# ----------------------------------------------------------------------------- budgets
def approved_budget(project_id):
    return m.ProjectBudget.objects.filter(project_id=project_id, status="APPROVED").first()


def _lines(lines):
    out = []
    for ln in lines or []:
        cat = ln.get("category")
        amt = svc._dec(ln.get("amount"), "amount")
        if cat not in m.COST_CATEGORIES:
            raise ValidationFailed("Category must be one of " + ", ".join(m.COST_CATEGORIES) + ".", code="invalid_category")
        if amt <= 0:
            raise ValidationFailed("Each budget line needs a positive amount.", code="invalid_amount")
        out.append((cat, (ln.get("description") or "")[:200], amt))
    if not out:
        raise ValidationFailed("A budget needs at least one line.", code="lines_required")
    if len({c for c, _, _ in out}) != len(out):
        raise ValidationFailed("Use one line per category.", code="duplicate_category")
    return out


@transaction.atomic
def create_budget(actor_id, project_id, lines, reason=""):
    p = svc.require_manage(actor_id, project_id, lock=True)
    if m.ProjectBudget.objects.filter(project=p, status__in=("DRAFT", "SUBMITTED")).exists():
        raise DomainError("A budget is already being prepared for this project.", code="already_pending")
    rev = (m.ProjectBudget.objects.filter(project=p).order_by("-revision").values_list("revision", flat=True).first() or 0) + 1
    if rev > 1 and not (reason or "").strip():
        raise ValidationFailed("Explain why the budget is being revised.", code="reason_required")
    b = m.ProjectBudget.objects.create(project=p, revision=rev, reason=reason[:300])
    m.BudgetLine.objects.bulk_create([m.BudgetLine(budget=b, category=c, description=d, amount=a) for c, d, a in _lines(lines)])
    return b


@transaction.atomic
def replace_lines(actor_id, budget_id, lines):
    b = m.ProjectBudget.objects.select_for_update(of=("self",)).filter(pk=budget_id).first()
    if b is None:
        raise DomainError("Budget not found.", code="not_found", status_code=404)
    svc.require_manage(actor_id, b.project_id)
    if b.status != "DRAFT":
        raise DomainError("Only a draft budget can be edited.", code="invalid_state")
    new = _lines(lines)
    b.lines.all().delete()
    m.BudgetLine.objects.bulk_create([m.BudgetLine(budget=b, category=c, description=d, amount=a) for c, d, a in new])
    return b


@transaction.atomic
def submit_budget(actor_id, budget_id):
    b = m.ProjectBudget.objects.select_for_update(of=("self",)).filter(pk=budget_id).first()
    if b is None:
        raise DomainError("Budget not found.", code="not_found", status_code=404)
    svc.require_manage(actor_id, b.project_id)
    if b.status != "DRAFT" or not b.lines.exists():
        raise DomainError("Only a draft budget with lines can be submitted.", code="invalid_state")
    b.status, b.submitted_by = "SUBMITTED", actor_id
    b.save()
    return b


@transaction.atomic
def decide_budget(actor_id, budget_id, *, approve, note=""):
    b = m.ProjectBudget.objects.select_for_update(of=("self",)).filter(pk=budget_id).first()
    if b is None or not svc.can_view(actor_id, svc.get_project(b.project_id)):
        raise DomainError("Budget not found.", code="not_found", status_code=404)
    if not authz.has_permission(actor_id, "projects.budget.approve"):
        raise DomainError("You are not allowed to approve budgets.", code="forbidden", status_code=403)
    if b.status != "SUBMITTED":
        raise DomainError("Only a submitted budget can be decided.", code="invalid_state")
    if b.submitted_by == actor_id:
        raise DomainError("Separation of duties: someone else must approve this budget.", code="separation_of_duties", status_code=403)
    if not approve and not (note or "").strip():
        raise ValidationFailed("A reason is required to reject.", code="reason_required")
    if approve:
        m.ProjectBudget.objects.filter(project_id=b.project_id, status="APPROVED").update(status="SUPERSEDED")
    b.status, b.decided_by, b.decision_note = ("APPROVED" if approve else "REJECTED"), actor_id, note[:300]
    b.save()
    record_tenant_event(current_tenant(), "projects.budget.decided", actor_user_id=actor_id, target_type="ProjectBudget", target_id=b.id, metadata={"status": b.status, "revision": str(b.revision)})
    return b


def budget_view(budget):
    return {"id": str(budget.id), "project": str(budget.project_id), "revision": budget.revision, "status": budget.status, "reason": budget.reason, "total": str(sum((l.amount for l in budget.lines.all()), ZERO)), "lines": [{"category": l.category, "description": l.description, "amount": str(l.amount)} for l in budget.lines.all()]}


# ----------------------------------------------------------------------------- expenses
def _invoice_headroom(invoice_id, exclude=None):
    from modules.finance import models as fm

    inv = fm.Invoice.objects.filter(pk=invoice_id, kind="SUPPLIER_INVOICE").first()
    if inv is None or inv.status == "VOID":
        raise ValidationFailed("Supplier invoice not found.", code="invalid_invoice")
    used = m.ProjectExpense.objects.filter(invoice_id=invoice_id).exclude(status="REJECTED")
    if exclude:
        used = used.exclude(pk=exclude)
    return (inv.total_base if inv.total_base is not None else inv.total) - (used.aggregate(s=Sum("amount"))["s"] or ZERO)


@transaction.atomic
def submit_expense(actor_id, project_id, *, category, description, amount, incurred_on, task_id=None, invoice_id=None):
    p = svc.get_project(project_id, lock=True)
    mem = svc._member(p, actor_id)
    if not svc.can_view(actor_id, p) or not (mem or svc.can_manage(actor_id, p)):
        raise DomainError("Project not found.", code="not_found", status_code=404)
    if mem is not None and mem.role == "OBSERVER":
        raise DomainError("Observers cannot submit expenses.", code="forbidden", status_code=403)
    if p.status != "ACTIVE":
        raise DomainError("Expenses are recorded while the project is active.", code="project_not_active")
    if category not in m.COST_CATEGORIES or category == "LABOR":
        raise ValidationFailed("Category must be MATERIAL, EQUIPMENT, SUBCONTRACT, TRAVEL or OTHER (labour comes from timesheets).", code="invalid_category")
    amt = svc._dec(amount, "amount")
    if amt <= 0 or not (description or "").strip():
        raise ValidationFailed("An expense needs a description and a positive amount.", code="invalid_amount")
    if incurred_on > timezone.now().date() or incurred_on < p.start_on:
        raise ValidationFailed("The expense date must be between the project start and today.", code="invalid_dates")
    if task_id and not m.Task.objects.filter(pk=task_id, project=p).exists():
        raise ValidationFailed("The task belongs to another project.", code="invalid_task")
    if invoice_id and _invoice_headroom(invoice_id) < amt:
        raise DomainError("The invoice does not have that much left to allocate.", code="invoice_over_allocated")
    return m.ProjectExpense.objects.create(project=p, task_id=task_id, category=category, description=description[:300], amount=amt, incurred_on=incurred_on, claimant_id=actor_id, invoice_id=invoice_id, status="SUBMITTED")


def _approved_actual(project_id, category):
    return m.ProjectExpense.objects.filter(project_id=project_id, category=category, status="APPROVED").aggregate(s=Sum("amount"))["s"] or ZERO


@transaction.atomic
def decide_expense(actor_id, expense_id, *, approve, note=""):
    e = m.ProjectExpense.objects.select_for_update(of=("self",)).filter(pk=expense_id).first()
    if e is None or not svc.can_view(actor_id, svc.get_project(e.project_id)):
        raise DomainError("Expense not found.", code="not_found", status_code=404)
    p = svc.get_project(e.project_id, lock=True)
    can_big = authz.has_permission(actor_id, "projects.budget.approve")
    if not (svc.can_manage(actor_id, p) or can_big):
        raise DomainError("Only the project manager can decide expenses.", code="forbidden", status_code=403)
    if e.status != "SUBMITTED":
        raise DomainError("Only a submitted expense can be decided.", code="invalid_state")
    if e.claimant_id == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own expense.", code="separation_of_duties", status_code=403)
    if not approve:
        if not (note or "").strip():
            raise ValidationFailed("A reason is required to reject.", code="reason_required")
        e.status, e.decided_by, e.decision_note = "REJECTED", actor_id, note[:300]
        e.save()
        return e
    limit = Decimal(str(_org().get_setting("projects.expense_approval_limit", 1000)))
    if e.amount > limit and not can_big:
        raise DomainError(f"Expenses above {limit} need a budget approver.", code="approval_limit_exceeded", status_code=403)
    if e.invoice_id and _invoice_headroom(e.invoice_id, exclude=e.id) < e.amount:
        raise DomainError("The invoice does not have that much left to allocate.", code="invoice_over_allocated")
    b = approved_budget(p.id)
    if b is not None:
        cap = b.lines.filter(category=e.category).aggregate(s=Sum("amount"))["s"] or ZERO
        if _approved_actual(p.id, e.category) + e.amount > cap:
            raise DomainError(f"This would exceed the approved {e.category.lower()} budget of {cap}; request a budget revision.", code="budget_exceeded")
    if not e.invoice_id:  # out-of-pocket cost: book it now; an invoice-backed cost is already in the ledger
        from modules.finance import services as fin

        entry = fin.post_system_journal(actor_id, e.incurred_on, f"Project cost {p.code}: {e.description}", "project_expense", e.id, [("project_cost", "debit", e.amount), ("claims_payable", "credit", e.amount)])
        e.journal_entry_id = entry.id if entry else None
    e.status, e.decided_by = "APPROVED", actor_id
    e.save()
    record_tenant_event(current_tenant(), "projects.expense.approved", actor_user_id=actor_id, target_type="ProjectExpense", target_id=e.id, metadata={"project": p.code, "amount": str(e.amount)})
    return e


@transaction.atomic
def add_receipt(actor_id, expense_id, *, filename, data):
    from shared.files import services as files

    e = m.ProjectExpense.objects.filter(pk=expense_id).first()
    if e is None or (e.claimant_id != actor_id and not svc.can_manage(actor_id, svc.get_project(e.project_id))):
        raise DomainError("Expense not found.", code="not_found", status_code=404)
    if e.status != "SUBMITTED":
        raise DomainError("Receipts can be added only while the expense awaits a decision.", code="invalid_state")
    return files.upload(actor_id, filename, data, ref_type="projects.expense", ref_id=str(e.id))


def can_read_receipt(user_id, ref_id):
    e = m.ProjectExpense.objects.filter(pk=ref_id).first()
    return bool(e and (e.claimant_id == user_id or svc.can_manage(user_id, svc.get_project(e.project_id)) or authz.has_permission(user_id, "projects.view_all")))


# ----------------------------------------------------------------------------- time and cost
def time_cost(project_id, date_from=None, date_to=None):
    """Approved timesheet hours booked to the project's code, priced at each member's cost rate."""
    from modules.hr import models as hm

    p = svc.get_project(project_id)
    entries = hm.TimesheetEntry.objects.filter(project_ref=p.code, timesheet__status="APPROVED").select_related("timesheet__employee")
    if date_from:
        entries = entries.filter(work_date__gte=date_from)
    if date_to:
        entries = entries.filter(work_date__lte=date_to)
    members = {}
    for mem in m.ProjectMember.objects.filter(project=p).order_by("is_active", "created_at"):
        members[mem.user_id] = mem
        if mem.employee_id:
            members[mem.employee_id] = mem
    rows, unmatched = {}, ZERO
    for en in entries:
        emp = en.timesheet.employee
        mem = members.get(emp.user_id) or members.get(emp.id)
        if mem is None:
            unmatched += en.hours
            continue
        r = rows.setdefault(str(mem.user_id), {"user_id": str(mem.user_id), "hours": ZERO, "cost": ZERO, "rate": mem.cost_rate})
        r["hours"] += en.hours
        r["cost"] += en.hours * mem.cost_rate
    total_h, total_c = sum((r["hours"] for r in rows.values()), ZERO), sum((r["cost"] for r in rows.values()), ZERO)
    return {"rows": [{**r, "hours": str(r["hours"]), "cost": str(r["cost"].quantize(Q4)), "rate": str(r["rate"])} for r in rows.values()], "hours": total_h, "cost": total_c.quantize(Q4), "unmatched_hours": unmatched}


def planned_labor_cost(project_id):
    members = {x.user_id: x.cost_rate for x in m.ProjectMember.objects.filter(project_id=project_id)}
    parents = set(m.Task.objects.filter(project_id=project_id, parent__isnull=False).values_list("parent_id", flat=True))
    return sum((t.planned_hours * members.get(t.assignee_id, ZERO) for t in m.Task.objects.filter(project_id=project_id).exclude(status="CANCELLED") if t.id not in parents), ZERO)


def progress_percent(project_id):
    parents = set(m.Task.objects.filter(project_id=project_id, parent__isnull=False).values_list("parent_id", flat=True))
    leaves = [t for t in m.Task.objects.filter(project_id=project_id).exclude(status="CANCELLED") if t.id not in parents and not t.is_milestone]
    if not leaves:
        return ZERO
    hours = sum((t.planned_hours for t in leaves), ZERO)
    if hours:
        return (sum((t.percent_complete * t.planned_hours for t in leaves), ZERO) / hours).quantize(Decimal("0.01"))
    return (sum((t.percent_complete for t in leaves), ZERO) / len(leaves)).quantize(Decimal("0.01"))


def cost_report(project_id, today=None):
    p = svc.get_project(project_id)
    today = today or timezone.now().date()
    b = approved_budget(p.id)
    budget = {l.category: l.amount for l in b.lines.all()} if b else {}
    tc = time_cost(p.id)
    actual = {c: ZERO for c in m.COST_CATEGORIES}
    actual["LABOR"] = tc["cost"]
    for r in m.ProjectExpense.objects.filter(project=p, status="APPROVED").values("category").annotate(s=Sum("amount")):
        actual[r["category"]] += r["s"]
    pending = m.ProjectExpense.objects.filter(project=p, status="SUBMITTED").aggregate(s=Sum("amount"))["s"] or ZERO
    planned_labor = planned_labor_cost(p.id)
    rows = [{"category": c, "budget": str(budget.get(c, ZERO)), "actual": str(actual[c]), "variance": str(budget.get(c, ZERO) - actual[c]), "over_budget": bool(c in budget and actual[c] > budget[c]), "planned": str(planned_labor) if c == "LABOR" else None} for c in m.COST_CATEGORIES if c in budget or actual[c] > 0]
    bac, ac = sum(budget.values(), ZERO), sum(actual.values(), ZERO)
    pct = progress_percent(p.id)
    span = max((p.end_on - p.start_on).days, 1)
    planned_pct = Decimal(min(max((today - p.start_on).days, 0), span)) / Decimal(span) * 100
    ev, pv = bac * pct / 100, bac * planned_pct / 100
    cpi = (ev / ac).quantize(Decimal("0.01")) if ac > 0 else None
    spi = (ev / pv).quantize(Decimal("0.01")) if pv > 0 else None
    eac = (bac / cpi).quantize(Q4) if cpi else None
    return {"project": p.code, "has_approved_budget": b is not None, "budget_revision": None if not b else b.revision, "rows": rows, "pending_expenses": str(pending), "unmatched_hours": str(tc["unmatched_hours"]), "hours": str(tc["hours"]),
            "totals": {"budget": str(bac), "actual": str(ac), "variance": str(bac - ac)},
            "earned_value": {"percent_complete": str(pct), "planned_percent": str(planned_pct.quantize(Decimal("0.01"))), "bac": str(bac), "pv": str(pv.quantize(Q4)), "ev": str(ev.quantize(Q4)), "ac": str(ac), "cpi": None if cpi is None else str(cpi), "spi": None if spi is None else str(spi), "eac": None if eac is None else str(eac), "vac": None if eac is None else str((bac - eac).quantize(Q4))}}

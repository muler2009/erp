"""Procurement planning and budget control: commitments on requisitions and POs, consumption by matched invoices, revisions, execution report."""
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum

from modules.procurement import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.tenancy import current_tenant

ZERO = Decimal("0")
Q4 = Decimal("0.0001")
OPEN_PO = ("DRAFT", "PENDING_APPROVAL", "APPROVED", "PARTIALLY_RECEIVED", "RECEIVED")
OPEN_REQ = ("APPROVED", "PARTIALLY_ORDERED")


def _dec(v, name="amount"):
    try:
        return Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")


# ------------------------------------------------------------------ budgets
@transaction.atomic
def create_budget(actor_id, *, code, name, fiscal_year, amount, department_id=None, cost_center_ref="", category="", enforcement="BLOCK"):
    amt = _dec(amount)
    if amt < 0:
        raise ValidationFailed("The budget cannot be negative.", code="invalid_amount")
    if enforcement not in ("BLOCK", "WARN"):
        raise ValidationFailed("enforcement must be BLOCK or WARN.", code="invalid_enforcement")
    if m.Budget.objects.filter(code=code, fiscal_year=fiscal_year).exists():
        raise DomainError("A budget with this code already exists for that year.", code="code_taken")
    b = m.Budget.objects.create(code=code, name=name, fiscal_year=int(fiscal_year), amount=amt, department_id=department_id, cost_center_ref=cost_center_ref, category=category, enforcement=enforcement)
    record_tenant_event(current_tenant(), "procurement.budget.created", actor_user_id=actor_id, target_type="Budget", target_id=b.id, metadata={"code": code, "amount": str(amt)})
    return b


def committed(budget, exclude=None):
    qs = m.BudgetCommitment.objects.filter(budget=budget)
    if exclude:
        qs = qs.exclude(ref_type=exclude[0], ref_id=exclude[1])
    return qs.aggregate(t=Sum("amount"))["t"] or ZERO


@transaction.atomic
def revise_budget(actor_id, budget_id, *, new_amount, reason):
    b = m.Budget.objects.select_for_update().filter(pk=budget_id).first()
    if not b:
        raise DomainError("Budget not found.", code="not_found", status_code=404)
    new = _dec(new_amount, "new_amount")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required for a budget revision.", code="reason_required")
    if new < committed(b):
        raise DomainError(f"The new amount is below what is already committed ({committed(b)}).", code="below_committed")
    m.BudgetRevision.objects.create(budget=b, old_amount=b.amount, new_amount=new, reason=reason[:300], revised_by=actor_id)
    b.amount = new
    b.save(update_fields=["amount", "updated_at"])
    return b


@transaction.atomic
def close_budget(actor_id, budget_id):
    b = m.Budget.objects.select_for_update().filter(pk=budget_id).first()
    if not b:
        raise DomainError("Budget not found.", code="not_found", status_code=404)
    if committed(b) > 0:
        raise DomainError("Release or complete the open commitments first.", code="open_commitments")
    b.status = "CLOSED"
    b.save(update_fields=["status", "updated_at"])
    return b


# ------------------------------------------------------------------ commitments
def _apply(budget_id, ref_type, ref_id, amount):
    """Set the commitment of one document to `amount` (0 releases it), refusing an overspend on BLOCK budgets."""
    b = m.Budget.objects.select_for_update().get(pk=budget_id)
    amount = Decimal(amount).quantize(Q4)
    row = m.BudgetCommitment.objects.select_for_update().filter(ref_type=ref_type, ref_id=ref_id).first()
    if amount > 0:
        if b.status != "ACTIVE":
            raise DomainError("This budget is closed.", code="budget_closed")
        others = committed(b, exclude=(ref_type, ref_id))
        if others + amount > b.amount:
            msg = f"Budget {b.code} would be exceeded: available {b.amount - others}, needed {amount}."
            if b.enforcement == "BLOCK":
                raise DomainError(msg, code="budget_exceeded")
            from platform_core.authorization.models import RoleAssignment

            ids = list(RoleAssignment.objects.filter(role__name="procurement_manager").values_list("user_id", flat=True).distinct())
            if ids:
                notify(ids, "procurement.budget.overspend", f"Budget {b.code} overspent", msg, ref_type="procurement.budget", ref_id=str(b.id))
    if row is None:
        if amount > 0:
            m.BudgetCommitment.objects.create(budget=b, ref_type=ref_type, ref_id=ref_id, amount=amount)
    else:
        row.amount = amount
        row.save(update_fields=["amount", "updated_at"])


def sync_requisition(req):
    """Open requisitions hold their still-unordered estimate; anything else holds nothing."""
    if not req.budget_id:
        return
    amount = ZERO
    if req.status in OPEN_REQ:
        amount = sum(((l.quantity - l.ordered_quantity) * l.estimated_unit_price for l in req.lines.all() if l.quantity > l.ordered_quantity), ZERO)
    _apply(req.budget_id, "REQUISITION", req.id, amount)


def po_base_total(order):
    return order.total * org.get_rate(order.currency, order.order_date)


def sync_po(order):
    if not order.budget_id:
        return
    if order.kind == "BLANKET":
        return  # a blanket order commits nothing itself: each release does
    if order.status == "CLOSED":  # short-closed: only what was actually received stays committed
        rate = org.get_rate(order.currency, order.order_date)
        amount = sum((l.received_quantity * l.unit_price for l in order.lines.all()), ZERO) * rate
    else:
        amount = po_base_total(order) if order.status in OPEN_PO else ZERO
    _apply(order.budget_id, "PO", order.id, amount)


def sync_po_consumed(order):
    if not order.budget_id:
        return
    row = m.BudgetCommitment.objects.select_for_update().filter(ref_type="PO", ref_id=order.id).first()
    if row:
        row.consumed = min(row.amount, (order.invoiced_value * org.get_rate(order.currency, order.order_date)).quantize(Q4))
        row.save(update_fields=["consumed", "updated_at"])


def check_po_year(budget_id, order_date):
    b = m.Budget.objects.filter(pk=budget_id).first()
    if not b:
        raise DomainError("Budget not found.", code="not_found", status_code=404)
    if b.fiscal_year != order_date.year:
        raise ValidationFailed(f"Budget {b.code} is for {b.fiscal_year}, not {order_date.year}.", code="budget_year_mismatch")


def budget_status(b):
    com = m.BudgetCommitment.objects.filter(budget=b).aggregate(c=Sum("amount"), u=Sum("consumed"))
    c, u = (com["c"] or ZERO).quantize(Q4), (com["u"] or ZERO).quantize(Q4)
    return {"id": str(b.id), "code": b.code, "name": b.name, "fiscal_year": b.fiscal_year, "category": b.category, "department_id": None if not b.department_id else str(b.department_id), "cost_center_ref": b.cost_center_ref, "enforcement": b.enforcement, "status": b.status,
            "budget": str(Decimal(b.amount).quantize(Q4)), "committed": str(c), "actual": str(u), "open_commitment": str(c - u), "available": str(Decimal(b.amount - c).quantize(Q4)), "utilisation_pct": None if not b.amount else str((c * 100 / b.amount).quantize(Decimal("0.1")))}


def execution_report(fiscal_year):
    rows = [budget_status(b) for b in m.Budget.objects.filter(fiscal_year=fiscal_year).order_by("code")]
    tot = lambda k: str(sum((Decimal(r[k]) for r in rows), ZERO).quantize(Q4))  # noqa: E731
    return {"fiscal_year": fiscal_year, "rows": rows, "totals": {"budget": tot("budget"), "committed": tot("committed"), "actual": tot("actual"), "available": tot("available")}}


# ------------------------------------------------------------------ plans
@transaction.atomic
def create_plan(actor_id, *, code, name, fiscal_year, lines):
    if not lines:
        raise ValidationFailed("A plan needs at least one line.", code="no_lines")
    if m.ProcurementPlan.objects.filter(code=code, fiscal_year=fiscal_year).exists():
        raise DomainError("A plan with this code already exists for that year.", code="code_taken")
    plan = m.ProcurementPlan.objects.create(code=code, name=name, fiscal_year=int(fiscal_year), created_by=actor_id)
    _set_lines(plan, lines)
    return plan


def _set_lines(plan, lines):
    plan.lines.all().delete()
    for l in lines:
        amt = _dec(l.get("planned_amount"), "planned_amount")
        q = int(l.get("quarter", 1))
        if amt < 0 or not 1 <= q <= 4 or not (l.get("category") or "").strip():
            raise ValidationFailed("Each plan line needs a category, a non-negative amount and a quarter 1-4.", code="invalid_line")
        m.PlanLine.objects.create(plan=plan, category=l["category"].strip(), description=(l.get("description") or "")[:300], department_id=l.get("department"), quarter=q, planned_amount=amt)


@transaction.atomic
def approve_plan(actor_id, plan_id):
    p = m.ProcurementPlan.objects.select_for_update().filter(pk=plan_id).first()
    if not p:
        raise DomainError("Plan not found.", code="not_found", status_code=404)
    if p.status != "DRAFT":
        raise DomainError("Only a draft plan can be approved.", code="invalid_state")
    if p.created_by == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own plan.", code="separation_of_duties", status_code=403)
    p.status, p.approved_by = "APPROVED", actor_id
    p.save(update_fields=["status", "approved_by", "updated_at"])
    return p


def _snapshot(plan):
    return [{"category": l.category, "description": l.description, "quarter": l.quarter, "planned_amount": str(l.planned_amount)} for l in plan.lines.all()]


@transaction.atomic
def revise_plan(actor_id, plan_id, *, lines, reason):
    """An approved plan is revised, not overwritten: the previous lines are kept as a snapshot and approval is required again."""
    p = m.ProcurementPlan.objects.select_for_update().filter(pk=plan_id).first()
    if not p:
        raise DomainError("Plan not found.", code="not_found", status_code=404)
    if p.status == "CLOSED":
        raise DomainError("A closed plan cannot be revised.", code="invalid_state")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    m.PlanRevision.objects.create(plan=p, revision=p.revision, reason=reason[:300], snapshot=_snapshot(p), revised_by=actor_id)
    _set_lines(p, lines)
    p.revision += 1
    p.status, p.approved_by, p.created_by = "DRAFT", None, actor_id
    p.save()
    return p


def plan_vs_actual(plan_id):
    p = m.ProcurementPlan.objects.filter(pk=plan_id).first()
    if not p:
        raise DomainError("Plan not found.", code="not_found", status_code=404)
    planned = {}
    for l in p.lines.all():
        planned[l.category] = planned.get(l.category, ZERO) + l.planned_amount
    rows = []
    for cat, amt in sorted(planned.items()):
        agg = m.BudgetCommitment.objects.filter(budget__fiscal_year=p.fiscal_year, budget__category=cat).aggregate(c=Sum("amount"), u=Sum("consumed"))
        c, u = agg["c"] or ZERO, agg["u"] or ZERO
        rows.append({"category": cat, "planned": str(amt), "committed": str(c), "actual": str(u), "variance": str(amt - c)})
    return {"plan": p.code, "revision": p.revision, "status": p.status, "rows": rows}

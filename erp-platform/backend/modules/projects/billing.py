"""Billing a project to its customer: milestone, time-and-material and advance invoices drafted in Finance."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum

from modules.projects import costs
from modules.projects import models as m
from modules.projects import services as svc
from shared.api.errors import DomainError, ValidationFailed

ZERO = Decimal("0")
KINDS = ("MILESTONE", "TIME", "ADVANCE")


def _fin():
    from modules.finance import models as fm
    from modules.finance import services as fin

    return fm, fin


def _live_billings(project_id):
    fm, _ = _fin()
    rows = list(m.ProjectBilling.objects.filter(project_id=project_id))
    status = dict(fm.Invoice.objects.filter(pk__in=[r.invoice_id for r in rows]).values_list("id", "status"))
    return [(r, status.get(r.invoice_id)) for r in rows if status.get(r.invoice_id) not in (None, "VOID")]


def billed_total(project_id):
    return sum((r.amount for r, _ in _live_billings(project_id)), ZERO)


def time_billing_preview(project_id, start, end):
    """Approved hours in the period priced at each member's bill rate (what a time-and-material invoice would charge)."""
    from modules.hr import models as hm

    p = svc.get_project(project_id)
    if end < start:
        raise ValidationFailed("The period is back to front.", code="invalid_dates")
    members = {}
    for mem in m.ProjectMember.objects.filter(project=p):
        members[mem.user_id] = mem
        if mem.employee_id:
            members[mem.employee_id] = mem
    rows = {}
    for en in hm.TimesheetEntry.objects.filter(project_ref=p.code, timesheet__status="APPROVED", work_date__range=(start, end)).select_related("timesheet__employee"):
        emp = en.timesheet.employee
        mem = members.get(emp.user_id) or members.get(emp.id)
        if mem is None:
            continue
        r = rows.setdefault(str(mem.user_id), {"user_id": str(mem.user_id), "hours": ZERO, "rate": mem.bill_rate, "amount": ZERO})
        r["hours"] += en.hours
        r["amount"] += en.hours * mem.bill_rate
    total = sum((r["amount"] for r in rows.values()), ZERO)
    return {"rows": [{**r, "hours": str(r["hours"]), "rate": str(r["rate"]), "amount": str(r["amount"])} for r in rows.values()], "amount": total}


@transaction.atomic
def invoice_project(actor_id, project_id, *, kind, invoice_date, amount=None, description="", task_id=None, period_start=None, period_end=None, tax_rate_id=None):
    p = svc.require_manage(actor_id, project_id, lock=True, editable=False)
    fm, fin = _fin()
    if kind not in KINDS:
        raise ValidationFailed("Kind must be MILESTONE, TIME or ADVANCE.", code="invalid_kind")
    if p.billing_type == "NON_BILLABLE" or not p.customer_id:
        raise DomainError("This project is not billable or has no customer.", code="not_billable")
    if p.status == "CANCELLED" or (p.status == "PLANNING" and kind != "ADVANCE"):
        raise DomainError("The project is not in a state that can be invoiced.", code="project_not_active")
    task = None
    if kind == "MILESTONE":
        if p.billing_type != "FIXED":
            raise DomainError("Milestone billing applies to fixed-price projects.", code="not_billable")
        task = m.Task.objects.filter(pk=task_id, project=p, is_milestone=True).first()
        if task is None or task.status != "DONE":
            raise DomainError("Bill a milestone only once it is reached.", code="milestone_not_reached")
        if m.ProjectBilling.objects.filter(task=task).exists() and any(True for r, _ in _live_billings(p.id) if r.task_id == task.id):
            raise DomainError("This milestone has already been billed.", code="already_pending")
        amt = costs.svc._dec(amount, "amount")
    elif kind == "TIME":
        if p.billing_type != "TIME_MATERIAL":
            raise DomainError("Time billing applies to time-and-material projects.", code="not_billable")
        if not (period_start and period_end):
            raise ValidationFailed("A period is required.", code="period_required")
        for r, _ in _live_billings(p.id):
            if r.kind == "TIME" and r.period_start <= period_end and r.period_end >= period_start:
                raise DomainError("Part of this period has already been billed.", code="already_pending")
        amt = time_billing_preview(p.id, period_start, period_end)["amount"]
        if amt <= 0:
            raise DomainError("There is no approved billable time in this period.", code="nothing_to_bill")
    else:
        amt = costs.svc._dec(amount, "amount")
    if amt <= 0:
        raise ValidationFailed("The amount must be positive.", code="invalid_amount")
    if p.billing_type == "FIXED" and billed_total(p.id) + amt > p.contract_value:
        raise DomainError(f"This would bill more than the contract value of {p.contract_value}.", code="over_billing")
    desc = description or {"MILESTONE": f"Milestone: {task.name}" if task else "", "TIME": f"Time and materials {period_start} to {period_end}", "ADVANCE": "Advance payment"}[kind]
    inv = fin.create_invoice(actor_id, kind="CUSTOMER_INVOICE", partner_id=p.customer_id, invoice_date=invoice_date, lines=[{"description": f"{p.code} {desc}"[:200], "quantity": "1", "unit_price": str(amt), "account": str(fin.system_account("sales_revenue").id), "tax_rate": str(tax_rate_id) if tax_rate_id else None}])
    return m.ProjectBilling.objects.create(project=p, invoice_id=inv.id, kind=kind, amount=amt, description=desc[:300], task=task, period_start=period_start, period_end=period_end, created_by=actor_id)


def billing_summary(project_id):
    fm, _ = _fin()
    p = svc.get_project(project_id)
    live = _live_billings(p.id)
    rows = [{"invoice_id": str(r.invoice_id), "kind": r.kind, "amount": str(r.amount), "description": r.description, "invoice_status": st} for r, st in live]
    recognized = sum((r.amount for r, st in live if st in ("POSTED", "PAID")), ZERO)
    paid = sum((r.amount for r, st in live if st == "PAID"), ZERO)
    total = sum((r.amount for r, _ in live), ZERO)
    return {"project": p.code, "rows": rows, "billed": str(total), "recognized": str(recognized), "paid": str(paid), "contract_value": str(p.contract_value), "remaining": str(p.contract_value - total) if p.billing_type == "FIXED" else None}

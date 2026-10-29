"""Payroll completion: salary revisions with approval, one-off inputs (bonus/commission/arrears/adjustments),
overtime pay, loans and advances with repayment schedules, run reversal, payroll register and payment instructions."""
import csv
import io
from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from modules.finance import services as finance
from modules.hr import attendance as att
from modules.hr import models as m
from modules.hr import services as core
from modules.hr.services import _404, _dec, _get, _q, add_months, authz, log_event
from platform_core.audit.services import record_tenant_event
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.tenancy import current_tenant

ZERO = Decimal("0")


def _need(actor_id, code):
    if not authz.has_permission(actor_id, code):
        raise DomainError("You do not have permission for this action.", code="permission_denied", status_code=403)


def _first(d):
    return d.replace(day=1)


# ----------------------------------------------------------------------------- salary revisions
@transaction.atomic
def request_revision(actor_id, employee_id, *, effective_date, new_salary, reason):
    _need(actor_id, "hr.compensation.manage")
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    salary = _dec(new_salary, "new_salary")
    if salary < 0 or not (reason or "").strip():
        raise ValidationFailed("A non-negative salary and a reason are required.", code="invalid_revision")
    c = e.contracts.filter(start_date__lte=effective_date).filter(Q(end_date__isnull=True) | Q(end_date__gte=effective_date)).first()
    if c is None:
        raise DomainError("The employee has no contract in force on the effective date.", code="no_contract")
    if effective_date <= c.start_date:
        raise ValidationFailed("The revision must take effect after the current contract segment starts.", code="invalid_revision")
    if salary == c.monthly_salary:
        raise ValidationFailed("The new salary equals the current salary.", code="invalid_revision")
    if m.SalaryRevision.objects.filter(employee=e, status="PENDING").exists():
        raise DomainError("A revision is already awaiting a decision for this employee.", code="revision_pending")
    return m.SalaryRevision.objects.create(employee=e, effective_date=effective_date, old_salary=c.monthly_salary, new_salary=salary, reason=reason.strip()[:300], requested_by=actor_id)


@transaction.atomic
def decide_revision(actor_id, revision_id, *, approve, note=""):
    _need(actor_id, "hr.compensation.manage")
    r = _get(m.SalaryRevision, revision_id, "Revision", lock=True)
    if r.status != "PENDING":
        raise DomainError("This revision was already decided.", code="invalid_state_transition")
    if r.requested_by == actor_id:
        raise DomainError("Separation of duties: you cannot decide your own revision request.", code="separation_of_duties", status_code=403)
    if not approve:
        if not (note or "").strip():
            raise ValidationFailed("A note is required to reject.", code="reason_required")
        r.status, r.decided_by, r.decision_note = "REJECTED", actor_id, note[:300]
        r.save()
        return r
    e = _get(m.Employee, r.employee_id, "Employee", lock=True)
    if e.status == "TERMINATED":
        raise DomainError("The employee has left.", code="invalid_state_transition")
    locked = m.PayrollRun.objects.exclude(status__in=["DRAFT", "CANCELLED"]).order_by("-period_end").first()
    if locked and r.effective_date <= locked.period_end:
        raise DomainError(f"Payroll {locked.number} already covers {locked.period_end}; record the difference as an ARREARS input instead of a retroactive change.", code="retroactive_revision_blocked")
    cur = e.contracts.select_for_update().filter(start_date__lte=r.effective_date).filter(Q(end_date__isnull=True) | Q(end_date__gte=r.effective_date)).first()
    if cur is None or r.effective_date <= cur.start_date:
        raise DomainError("The contract situation changed; request the revision again.", code="no_contract")
    new = m.Contract.objects.create(employee=e, kind=cur.kind, start_date=r.effective_date, end_date=cur.end_date, monthly_salary=r.new_salary, currency=cur.currency, created_by=actor_id)
    cur.end_date = r.effective_date - timedelta(days=1)
    cur.save(update_fields=["end_date", "updated_at"])
    r.status, r.decided_by, r.decision_note, r.contract = "APPROVED", actor_id, (note or "")[:300], new
    r.save()
    log_event(e, "SALARY_REVISION", r.effective_date, actor_id, old=r.old_salary, new=r.new_salary, reason=r.reason)
    record_tenant_event(current_tenant(), "hr.salary.revised", actor_user_id=actor_id, target_type="SalaryRevision", target_id=r.id, metadata={"employee": e.employee_no})
    return r


def salary_history(user_id, employee):
    _need(user_id, "hr.compensation.view")
    return [{"effective_date": str(c.start_date), "end_date": str(c.end_date) if c.end_date else None, "monthly_salary": str(c.monthly_salary), "currency": c.currency, "kind": c.kind} for c in employee.contracts.order_by("start_date")]


# ----------------------------------------------------------------------------- one-off inputs
@transaction.atomic
def add_input(actor_id, employee_id, *, kind, month, amount, description, taxable=True):
    _need(actor_id, "hr.compensation.manage")
    e = _get(m.Employee, employee_id, "Employee")
    if kind not in m.PayrollInput.Kind.values:
        raise ValidationFailed("Invalid input kind.", code="invalid_input")
    amt = _dec(amount, "amount")
    if amt == 0 or (amt < 0 and kind != "ADJUSTMENT") or not (description or "").strip():
        raise ValidationFailed("A non-zero amount (negative only for adjustments) and a description are required.", code="invalid_input")
    month = _first(month)
    if m.PayrollRun.objects.exclude(status__in=["DRAFT", "CANCELLED"]).filter(period_start=month).exists():
        raise DomainError("That month's payroll is already approved; use the next month.", code="period_locked")
    return m.PayrollInput.objects.create(employee=e, kind=kind, month=month, amount=amt, taxable=taxable, description=description.strip()[:200], created_by=actor_id)


@transaction.atomic
def decide_input(actor_id, input_id, *, approve):
    _need(actor_id, "hr.payroll.approve")
    i = _get(m.PayrollInput, input_id, "Payroll input", lock=True)
    if i.status != "PENDING":
        raise DomainError("Already decided.", code="invalid_state_transition")
    if i.created_by == actor_id:
        raise DomainError("Separation of duties: someone else must approve this input.", code="separation_of_duties", status_code=403)
    i.status, i.decided_by = ("APPROVED" if approve else "REJECTED"), actor_id
    i.save()
    return i


# ----------------------------------------------------------------------------- loans
@transaction.atomic
def request_loan(actor_id, employee_id, *, principal, installments, start_month, kind="LOAN", reason=""):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    own = e.user_id == actor_id
    if not own:
        _need(actor_id, "hr.compensation.manage")
    if e.status != "ACTIVE":
        raise DomainError("Only active employees can borrow.", code="invalid_state_transition")
    amt = _dec(principal, "principal")
    if amt <= 0 or not (1 <= int(installments) <= 60) or kind not in m.Loan.Kind.values:
        raise ValidationFailed("Principal must be positive and installments between 1 and 60.", code="invalid_loan")
    if m.Loan.objects.filter(employee=e, status__in=["PENDING", "ACTIVE"]).exists():
        raise DomainError("The employee already has a loan open or awaiting approval.", code="loan_open")
    return m.Loan.objects.create(employee=e, kind=kind, principal=amt, installments=int(installments), start_month=_first(start_month), reason=reason[:300], requested_by=actor_id)


@transaction.atomic
def decide_loan(actor_id, loan_id, *, approve, note=""):
    _need(actor_id, "hr.compensation.manage")
    loan = _get(m.Loan, loan_id, "Loan", lock=True)
    if loan.status != "PENDING":
        raise DomainError("Already decided.", code="invalid_state_transition")
    if loan.requested_by == actor_id or loan.employee.user_id == actor_id:
        raise DomainError("Separation of duties: you cannot approve this loan.", code="separation_of_duties", status_code=403)
    loan.decided_by, loan.decision_note = actor_id, (note or "")[:300]
    if not approve:
        if not (note or "").strip():
            raise ValidationFailed("A note is required to reject.", code="reason_required")
        loan.status = "REJECTED"
        loan.save()
        return loan
    dec = org.get_company().base_currency.decimals
    each = _q(loan.principal / loan.installments, dec)
    rows, left = [], loan.principal
    for n in range(loan.installments):
        amt = left if n == loan.installments - 1 else each  # the last instalment absorbs rounding
        rows.append(m.LoanInstallment(loan=loan, due_month=add_months(loan.start_month, n), amount=amt))
        left -= amt
    m.LoanInstallment.objects.bulk_create(rows)
    loan.status = "ACTIVE"
    loan.save()
    return loan


@transaction.atomic
def cancel_loan(actor_id, loan_id):
    _need(actor_id, "hr.compensation.manage")
    loan = _get(m.Loan, loan_id, "Loan", lock=True)
    if loan.status not in ("PENDING", "ACTIVE") or loan.schedule.filter(payroll_run__isnull=False).exists():
        raise DomainError("A loan with deductions already taken cannot be cancelled.", code="invalid_state_transition")
    loan.schedule.all().delete()
    loan.status = "CANCELLED"
    loan.save()
    return loan


def outstanding_loan(employee):
    return sum((i.amount for i in m.LoanInstallment.objects.filter(loan__employee=employee, loan__status="ACTIVE", repaid=False)), ZERO)


# ----------------------------------------------------------------------------- hooks used by the payroll calculation
def release(run):
    """Free everything this run consumed so it can be taken again (recalculation) or by another run (cancellation)."""
    m.OvertimeRequest.objects.filter(payroll_run=run).update(payroll_run=None)
    m.PayrollInput.objects.filter(payroll_run=run).update(payroll_run=None)
    m.LoanInstallment.objects.filter(payroll_run=run).update(payroll_run=None, repaid=False)


def additions(run, e, contracts, end, dec):
    """Overtime pay, approved one-off inputs and loan instalments for one employee in the run's month.
    Returns (overtime_pay, other_earnings, taxable_extra, deductions, lines)."""
    lines, overtime, earnings, taxable, deductions = [], ZERO, ZERO, ZERO, ZERO
    pol, _ = m.OvertimePolicy.objects.get_or_create(code="DEFAULT")
    ref = next((c for c in sorted(contracts, key=lambda c: c.start_date, reverse=True)), None)
    if ref is not None:
        hourly = ref.monthly_salary * org.get_rate(ref.currency, end) / pol.monthly_hours_divisor
        for o, hours, mult in att.payable_overtime(e, run.period_start, run.period_end):
            amount = _q(hours * hourly * mult, dec)
            overtime += amount
            lines.append(("OVERTIME", f"Overtime {o.work_date} ({hours}h x {mult})", "OVERTIME", amount))
            o.payroll_run = run
            o.save(update_fields=["payroll_run", "updated_at"])
    for i in m.PayrollInput.objects.filter(employee=e, status="APPROVED", month=run.period_start).filter(Q(payroll_run__isnull=True) | Q(payroll_run=run)):
        amount = _q(i.amount, dec)
        i.payroll_run = run
        i.save(update_fields=["payroll_run", "updated_at"])
        if amount >= 0:
            earnings += amount
            taxable += amount if i.taxable else 0
            lines.append((i.kind, i.description, "EARNING", amount))
        else:
            deductions += -amount
            lines.append((i.kind, i.description, "DEDUCTION", amount))
    for inst in m.LoanInstallment.objects.select_related("loan").filter(loan__employee=e, loan__status="ACTIVE", due_month=run.period_start).filter(Q(payroll_run__isnull=True) | Q(payroll_run=run)):
        deductions += inst.amount
        lines.append(("LOAN", f"{inst.loan.get_kind_display()} repayment", "DEDUCTION", -inst.amount))
        inst.payroll_run = run
        inst.save(update_fields=["payroll_run", "updated_at"])
    return overtime, earnings, overtime + taxable, deductions, lines


def mark_repaid(run):
    for inst in m.LoanInstallment.objects.select_related("loan").filter(payroll_run=run):
        inst.repaid = True
        inst.save(update_fields=["repaid", "updated_at"])
        loan = inst.loan
        if not loan.schedule.filter(repaid=False).exists():
            loan.status = "COMPLETED"
            loan.save(update_fields=["status", "updated_at"])


# ----------------------------------------------------------------------------- reversal
@transaction.atomic
def reverse_payroll(actor_id, run_id, *, reason, reversal_date=None):
    """Undo a posted (not yet paid) run: post the mirror journal, cancel the run and release its inputs, overtime
    and loan instalments so a corrected run can be created for the same month."""
    _need(actor_id, "hr.payroll.pay")
    run = _get(m.PayrollRun, run_id, "Payroll run", lock=True)
    if run.status != "POSTED":
        raise DomainError("Only posted, unpaid runs can be reversed; a paid run is corrected with an adjustment next month.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    reversal_date = reversal_date or timezone.now().date()
    org.assert_period_open(reversal_date)
    legs = [("salary_expense", "credit", run.gross_total + run.pension_employer_total), ("payroll_payable", "debit", run.net_total), ("payroll_tax_payable", "debit", run.tax_total + run.deduction_total), ("pension_payable", "debit", run.pension_employee_total + run.pension_employer_total)]
    entry = finance.post_system_journal(actor_id, reversal_date, f"Reversal of payroll {run.number}: {reason.strip()}"[:500], "payroll_reversal", run.id, legs)
    release(run)
    for loan in m.Loan.objects.filter(status="COMPLETED"):
        if loan.schedule.filter(repaid=False).exists():
            loan.status = "ACTIVE"
            loan.save(update_fields=["status", "updated_at"])
    run.status, run.reversal_journal_id = "CANCELLED", entry.id if entry else None
    run.save()
    record_tenant_event(current_tenant(), "hr.payroll.reversed", actor_user_id=actor_id, target_type="PayrollRun", target_id=run.id, metadata={"reason": reason[:200]})
    events.emit("hr.payroll.reversed", {"run_id": str(run.id), "number": run.number}, dedup_key=f"payroll-reversed-{run.id}")
    return run


# ----------------------------------------------------------------------------- register and payment instructions
def payroll_register(user_id, run_id):
    _need(user_id, "hr.payroll.view")
    run = _get(m.PayrollRun, run_id, "Payroll run")
    rows = []
    for s in run.payslips.select_related("employee__department").prefetch_related("lines").order_by("employee__employee_no"):
        rows.append({"employee_no": s.employee.employee_no, "name": s.employee.name, "department": s.employee.department.name if s.employee.department_id else None, "basic": str(s.basic), "allowances": str(s.allowances), "overtime": str(s.overtime_pay), "other_earnings": str(s.other_earnings), "gross": str(s.gross), "income_tax": str(s.income_tax), "pension_employee": str(s.pension_employee), "other_deductions": str(s.other_deductions), "net": str(s.net), "pension_employer": str(s.pension_employer)})
    return {"number": run.number, "period_start": str(run.period_start), "period_end": str(run.period_end), "status": run.status, "rows": rows, "totals": {"gross": str(run.gross_total), "tax": str(run.tax_total), "pension_employee": str(run.pension_employee_total), "pension_employer": str(run.pension_employer_total), "deductions": str(run.deduction_total), "net": str(run.net_total)}}


def cost_allocation(user_id, run_id):
    """Employer cost (gross + employer pension) per department for a run."""
    _need(user_id, "hr.payroll.view")
    run = _get(m.PayrollRun, run_id, "Payroll run")
    out = {}
    for s in run.payslips.select_related("employee__department"):
        key = s.employee.department.name if s.employee.department_id else "(none)"
        out[key] = out.get(key, ZERO) + s.gross + s.pension_employer
    return [{"department": k, "employer_cost": str(v)} for k, v in sorted(out.items())]


def payment_instructions(user_id, run_id, *, as_csv=False):
    """The bank transfer list for an approved run. Employees without a bank account are listed as exceptions."""
    _need(user_id, "hr.payroll.pay")
    run = _get(m.PayrollRun, run_id, "Payroll run")
    if run.status not in ("APPROVED", "POSTED", "PAID"):
        raise DomainError("Payment instructions exist only for approved runs.", code="invalid_state_transition")
    rows, missing = [], []
    for s in run.payslips.select_related("employee").order_by("employee__employee_no"):
        if s.net <= 0:
            continue
        if not s.employee.bank_account:
            missing.append(s.employee.employee_no)
            continue
        rows.append({"employee_no": s.employee.employee_no, "name": s.employee.name, "bank_account": s.employee.bank_account, "amount": str(s.net), "reference": f"{run.number}"})
    if as_csv:
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=["employee_no", "name", "bank_account", "amount", "reference"])
        w.writeheader()
        for r in rows:
            w.writerow({k: (("'" + v) if isinstance(v, str) and v[:1] in "=+-@" else v) for k, v in r.items()})  # no spreadsheet formula injection
        return buf.getvalue()
    return {"number": run.number, "total": str(sum((Decimal(r["amount"]) for r in rows), ZERO)), "payments": rows, "missing_bank_account": missing}

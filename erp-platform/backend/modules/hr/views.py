from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm.views import _date
from modules.hr import models as m
from modules.hr import services
from platform_core.authorization.permissions import require
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate


def perm(code):
    return [require(code)()]


def _s(v):
    return None if v is None else str(v)


def _req_date(v, field):
    d = _date(v, field)
    if d is None:
        raise ValidationFailed(f"{field} is required.", code="invalid_date")
    return d


def _emp(e, viewer):
    d = {"id": str(e.id), "employee_no": e.employee_no, "name": e.name, "first_name": e.first_name, "last_name": e.last_name, "email": e.email, "status": e.status, "hire_date": str(e.hire_date), "termination_date": _s(e.termination_date), "department": e.department.name if e.department_id else None, "position": e.position.title if e.position_id else None, "manager": _s(e.manager_id), "user_id": _s(e.user_id)}
    if services.is_hr(viewer) or e.user_id == viewer:
        d.update(bank_account=e.bank_account, tax_id=e.tax_id, phone=e.phone)
    return d


def _contract(c):
    return {"id": str(c.id), "employee": str(c.employee_id), "kind": c.kind, "start_date": str(c.start_date), "end_date": _s(c.end_date), "monthly_salary": str(c.monthly_salary), "currency": c.currency}


def _item(i):
    return {"id": str(i.id), "kind": i.kind, "title": i.title, "done_at": i.done_at}


def _att(a):
    return {"id": str(a.id), "employee": str(a.employee_id), "work_date": str(a.work_date), "check_in": a.check_in, "check_out": a.check_out, "hours": _s(a.hours)}


def _leave(r):
    return {"id": str(r.id), "employee": str(r.employee_id), "leave_type": r.leave_type.code, "start_date": str(r.start_date), "end_date": str(r.end_date), "days": str(r.days), "status": r.status, "reason": r.reason, "decision_note": r.decision_note, "half_day": r.half_day, "workflow_instance_id": _s(r.workflow_instance_id)}


def _ts(t):
    return {"id": str(t.id), "employee": str(t.employee_id), "week_start": str(t.week_start), "status": t.status, "decision_note": t.decision_note, "entries": [{"work_date": str(e.work_date), "hours": str(e.hours), "project_ref": e.project_ref, "description": e.description} for e in t.entries.all()], "total_hours": str(sum((e.hours for e in t.entries.all()), 0))}


def _run(r):
    return {"id": str(r.id), "number": r.number, "period_start": str(r.period_start), "period_end": str(r.period_end), "status": r.status, "gross_total": str(r.gross_total), "tax_total": str(r.tax_total), "pension_employee_total": str(r.pension_employee_total), "pension_employer_total": str(r.pension_employer_total), "deduction_total": str(r.deduction_total), "net_total": str(r.net_total), "created_by": str(r.created_by), "approved_by": _s(r.approved_by), "workflow_instance_id": _s(r.workflow_instance_id), "version": r.version}


def _slip(p, lines=True):
    d = {"id": str(p.id), "run": p.run.number, "period_start": str(p.run.period_start), "period_end": str(p.run.period_end), "employee": str(p.employee_id), "employee_no": p.employee.employee_no, "working_days": str(p.working_days), "payable_days": str(p.payable_days), "unpaid_leave_days": str(p.unpaid_leave_days), "basic": str(p.basic), "allowances": str(p.allowances), "overtime_pay": str(p.overtime_pay), "other_earnings": str(p.other_earnings), "gross": str(p.gross), "taxable_income": str(p.taxable_income), "income_tax": str(p.income_tax), "pension_employee": str(p.pension_employee), "other_deductions": str(p.other_deductions), "net": str(p.net)}
    if lines:
        d["lines"] = [{"code": l.code, "name": l.name, "kind": l.kind, "amount": str(l.amount)} for l in p.lines.all()]
    return d


def _scoped(qs, user_id, field="employee"):
    """Rows of employees the user may see: HR all; others their own and their direct reports'."""
    if services.is_hr(user_id):
        return qs
    from django.db.models import Q

    return qs.filter(Q(**{f"{field}__user_id": user_id}) | Q(**{f"{field}__manager__user_id": user_id}))


# ----------------------------------------------------------------------------- employees
class Employees(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage" if self.request.method == "POST" else "hr.self")

    def get(self, request):
        qs = services.visible_employees(request.user.id)
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, lambda e: _emp(e, request.user.id))

    def post(self, request):
        b = request.data
        e = services.create_employee(request.user.id, first_name=b.get("first_name", ""), last_name=b.get("last_name", ""), hire_date=_req_date(b.get("hire_date"), "hire_date"), email=b.get("email", ""), phone=b.get("phone", ""), department_id=b.get("department"), position_id=b.get("position"), manager_id=b.get("manager"), user_id=b.get("user_id"), bank_account=b.get("bank_account", ""), tax_id=b.get("tax_id", ""), employment_type=b.get("employment_type", "FULL_TIME"), grade_id=b.get("grade"), probation_months=b.get("probation_months"), date_of_birth=_date(b.get("date_of_birth"), "date_of_birth"), address=b.get("address", ""), allow_duplicate=bool(b.get("allow_duplicate")))
        return Response(_emp(e, request.user.id), status=201)


class EmployeeDetail(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage" if self.request.method == "PATCH" else "hr.self")

    def get(self, request, pk):
        e = services.employee_visible(request.user.id, pk)
        return Response({**_emp(e, request.user.id), "checklist": [_item(i) for i in e.checklist.all()] if services.is_hr(request.user.id) else []})

    def patch(self, request, pk):
        b = request.data
        mapping = {"department": "department_id", "position": "position_id", "manager": "manager_id", "grade": "grade_id"}
        fields = {mapping.get(k, k): v for k, v in b.items() if k in ("first_name", "last_name", "email", "phone", "bank_account", "tax_id", "address", "employment_type", "allow_duplicate", *mapping)}
        if b.get("date_of_birth"):
            fields["date_of_birth"] = _date(b["date_of_birth"], "date_of_birth")
        return Response(_emp(services.update_employee(request.user.id, pk, **fields), request.user.id))


def _emp_action(fn, permission="hr.employee.manage", **fixed):
    class View(APIView):
        def get_permissions(self):
            return perm(permission)

        def post(self, request, pk):
            kwargs = {k: (request.data.get(v) if v in ("reason",) else _req_date(request.data.get(v), v)) for k, v in fixed.items()}
            return Response(_emp(fn(request.user.id, pk, **kwargs), request.user.id))

    return View


EmployeeActivate = _emp_action(services.activate_employee)
EmployeeTerminate = _emp_action(services.complete_offboarding)


class ChecklistDone(APIView):
    def get_permissions(self):
        return perm("hr.self")  # the service lets HR, the employee (own tasks) or the manager (manager tasks) complete it

    def post(self, request, pk):
        return Response(_item(services.complete_checklist_item(request.user.id, pk)))


class Contracts(APIView):
    def get_permissions(self):
        return perm("hr.compensation.manage" if self.request.method == "POST" else "hr.compensation.view")

    def get(self, request, pk):
        return Response([_contract(c) for c in m.Contract.objects.filter(employee_id=pk).order_by("-start_date")])

    def post(self, request, pk):
        b = request.data
        c = services.add_contract(request.user.id, pk, start_date=_req_date(b.get("start_date"), "start_date"), end_date=_date(b.get("end_date"), "end_date"), monthly_salary=b.get("monthly_salary"), currency=b.get("currency", ""), kind=b.get("kind", "PERMANENT"))
        return Response(_contract(c), status=201)


class ContractEnd(APIView):
    def get_permissions(self):
        return perm("hr.compensation.manage")

    def post(self, request, pk):
        return Response(_contract(services.end_contract(request.user.id, pk, _req_date(request.data.get("end_date"), "end_date"))))


# ----------------------------------------------------------------------------- self-service
class Me(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        e = services.employee_for(request.user.id)
        year = timezone.now().year
        balances = [{"leave_type": t.code, "year": year, **{k: str(v) for k, v in services.leave_balance(e, t, year).items()}} for t in m.LeaveType.objects.filter(is_active=True)]
        return Response({**_emp(e, request.user.id), "leave_balances": balances})


class CheckIn(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request):
        return Response(_att(services.check_in(request.user.id)), status=201)


class CheckOut(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request):
        return Response(_att(services.check_out(request.user.id)))


class AttendanceList(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage" if self.request.method == "POST" else "hr.self")

    def get(self, request):
        qs = _scoped(m.Attendance.objects.all(), request.user.id)
        if request.query_params.get("employee"):
            qs = qs.filter(employee_id=request.query_params["employee"])
        return paginate(request, qs, _att, ordering="-work_date")

    def post(self, request):
        b = request.data
        cin, cout = parse_datetime(b.get("check_in") or ""), parse_datetime(b["check_out"]) if b.get("check_out") else None
        if cin is None:
            raise ValidationFailed("check_in must be an ISO datetime.", code="invalid_time")
        return Response(_att(services.record_attendance(request.user.id, b.get("employee"), work_date=cin.date(), check_in=cin, check_out=cout)), status=201)


# ----------------------------------------------------------------------------- leave
class LeaveTypes(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        return Response([{"code": t.code, "name": t.name, "is_paid": t.is_paid, "annual_days": str(t.annual_days)} for t in m.LeaveType.objects.filter(is_active=True)])


class LeaveAllocations(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage")

    def post(self, request):
        b = request.data
        a = services.allocate_leave(request.user.id, b.get("employee"), leave_type=b.get("leave_type"), year=int(b.get("year", timezone.now().year)), days=b.get("days"))
        return Response({"id": str(a.id), "days": str(a.days)}, status=201)


class LeaveRequests(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        qs = _scoped(m.LeaveRequest.objects.select_related("leave_type"), request.user.id)
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _leave)

    def post(self, request):
        b = request.data
        emp = b.get("employee") or str(services.employee_for(request.user.id).id)
        lt = m.LeaveType.objects.filter(code=b.get("leave_type")).first()
        r = services.request_leave(request.user.id, emp, leave_type=lt.id if lt else None, start_date=_req_date(b.get("start_date"), "start_date"), end_date=_req_date(b.get("end_date"), "end_date"), reason=b.get("reason", ""), half_day=b.get("half_day", ""))
        return Response(_leave(m.LeaveRequest.objects.select_related("leave_type").get(pk=r.pk)), status=201)


class LeaveDecide(APIView):
    def get_permissions(self):
        return perm("hr.leave.approve")

    def post(self, request, pk, decision):
        r = services.decide_leave(request.user.id, pk, approve=(decision == "approve"), note=request.data.get("note", ""))
        return Response(_leave(r))


class LeaveCancel(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request, pk):
        return Response(_leave(services.cancel_leave(request.user.id, pk)))


# ----------------------------------------------------------------------------- timesheets
class Timesheets(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        return paginate(request, _scoped(m.Timesheet.objects.prefetch_related("entries"), request.user.id), _ts, ordering="-week_start")

    def put(self, request):
        b = request.data
        emp = b.get("employee") or str(services.employee_for(request.user.id).id)
        entries = [{**e, "work_date": _req_date(e.get("work_date"), "work_date")} for e in (b.get("entries") or [])]
        return Response(_ts(services.save_timesheet(request.user.id, emp, _req_date(b.get("week_start"), "week_start"), entries)))


class TimesheetSubmit(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request, pk):
        return Response(_ts(services.submit_timesheet(request.user.id, pk)))


class TimesheetDecide(APIView):
    def get_permissions(self):
        return perm("hr.timesheet.approve")

    def post(self, request, pk, decision):
        return Response(_ts(services.decide_timesheet(request.user.id, pk, approve=(decision == "approve"), note=request.data.get("note", ""))))


# ----------------------------------------------------------------------------- payroll rules
class TaxBrackets(APIView):
    def get_permissions(self):
        return perm("hr.compensation.manage" if self.request.method == "PUT" else "hr.compensation.view")

    def get(self, request):
        return Response([{"lower_bound": str(b.lower_bound), "rate": str(b.rate)} for b in m.TaxBracket.objects.all()])

    def put(self, request):
        rows = services.set_tax_brackets(request.user.id, request.data.get("brackets") or [])
        return Response([{"lower_bound": str(b.lower_bound), "rate": str(b.rate)} for b in rows])


def _comp(c):
    return {"id": str(c.id), "code": c.code, "name": c.name, "kind": c.kind, "calc": c.calc, "value": str(c.value), "taxable": c.taxable, "is_active": c.is_active}


class Components(APIView):
    def get_permissions(self):
        return perm("hr.compensation.manage" if self.request.method == "POST" else "hr.compensation.view")

    def get(self, request):
        return Response([_comp(c) for c in m.PayComponent.objects.all()])

    def post(self, request):
        b = request.data
        return Response(_comp(services.create_component(request.user.id, code=b.get("code", ""), name=b.get("name", ""), kind=b.get("kind", ""), calc=b.get("calc", ""), value=b.get("value", 0), taxable=b.get("taxable", True))), status=201)


class ComponentAssign(APIView):
    def get_permissions(self):
        return perm("hr.compensation.manage")

    def post(self, request, pk):
        b = request.data
        ec = services.assign_component(request.user.id, pk, component=b.get("component"), start_date=_req_date(b.get("start_date"), "start_date"), end_date=_date(b.get("end_date"), "end_date"), override_value=b.get("override_value"))
        return Response({"id": str(ec.id)}, status=201)


# ----------------------------------------------------------------------------- payroll runs
class PayrollRuns(APIView):
    def get_permissions(self):
        return perm("hr.payroll.process" if self.request.method == "POST" else "hr.payroll.view")

    def get(self, request):
        return paginate(request, m.PayrollRun.objects.all(), _run)

    def post(self, request):
        b = request.data
        return Response(_run(services.create_payroll_run(request.user.id, _req_date(b.get("period_start"), "period_start"), _req_date(b.get("period_end"), "period_end"))), status=201)


class PayrollRunDetail(APIView):
    def get_permissions(self):
        return perm("hr.payroll.view")

    def get(self, request, pk):
        run = services._get(m.PayrollRun, pk, "Payroll run")
        slips = m.Payslip.objects.filter(run=run).select_related("run", "employee").prefetch_related("lines")
        return Response({**_run(run), "rules": run.rules_snapshot, "payslips": [_slip(p) for p in slips]})


def _run_action(fn, permission, **extra):
    class View(APIView):
        def get_permissions(self):
            return perm(permission)

        def post(self, request, pk):
            kwargs = {k: request.data.get(v) for k, v in extra.items()}
            return Response(_run(fn(request.user.id, pk, **kwargs)))

    return View


PayrollRecalculate = _run_action(services.recalculate_payroll, "hr.payroll.process")
PayrollSubmit = _run_action(services.submit_payroll, "hr.payroll.process")
PayrollCancel = _run_action(services.cancel_payroll, "hr.payroll.process")
PayrollApprove = _run_action(services.approve_payroll, "hr.payroll.approve")
PayrollReject = _run_action(services.reject_payroll, "hr.payroll.approve", note="note")
PayrollPost = _run_action(services.post_payroll, "hr.payroll.process")


class PayrollPay(APIView):
    def get_permissions(self):
        return perm("hr.payroll.pay")

    def post(self, request, pk):
        return Response(_run(services.pay_payroll(request.user.id, pk, payment_date=_date(request.data.get("payment_date"), "payment_date"))))


class MyPayslips(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        e = services.employee_for(request.user.id)
        qs = m.Payslip.objects.filter(employee=e, run__status__in=["APPROVED", "POSTED", "PAID"]).select_related("run", "employee").prefetch_related("lines")
        return paginate(request, qs, _slip)


class Payslips(APIView):
    def get_permissions(self):
        return perm("hr.payroll.view")

    def get(self, request):
        qs = m.Payslip.objects.select_related("run", "employee").prefetch_related("lines")
        if request.query_params.get("employee"):
            qs = qs.filter(employee_id=request.query_params["employee"])
        return paginate(request, qs, _slip)


class Headcount(APIView):
    def get_permissions(self):
        return perm("hr.view")

    def get(self, request):
        return Response(services.headcount_report())

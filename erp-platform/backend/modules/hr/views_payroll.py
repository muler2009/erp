from django.http import HttpResponse
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm.views import _date
from modules.hr import models as m
from modules.hr import payroll_ext as px
from modules.hr import services
from modules.hr.views import _req_date, _run, _s, perm
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate


def _rev(r):
    return {"id": str(r.id), "employee": str(r.employee_id), "employee_no": r.employee.employee_no, "effective_date": str(r.effective_date), "old_salary": str(r.old_salary), "new_salary": str(r.new_salary), "reason": r.reason, "status": r.status, "requested_by": str(r.requested_by), "decided_by": _s(r.decided_by), "decision_note": r.decision_note}


def _inp(i):
    return {"id": str(i.id), "employee": str(i.employee_id), "employee_no": i.employee.employee_no, "kind": i.kind, "month": str(i.month), "amount": str(i.amount), "taxable": i.taxable, "description": i.description, "status": i.status, "consumed_by_run": _s(i.payroll_run_id)}


def _loan(l):
    return {"id": str(l.id), "employee": str(l.employee_id), "employee_no": l.employee.employee_no, "kind": l.kind, "principal": str(l.principal), "installments": l.installments, "start_month": str(l.start_month), "status": l.status, "reason": l.reason, "decision_note": l.decision_note, "schedule": [{"due_month": str(i.due_month), "amount": str(i.amount), "repaid": i.repaid, "deducted_in_run": _s(i.payroll_run_id)} for i in l.schedule.order_by("due_month")]}


def _emp(pk):
    return services._get(m.Employee, pk, "Employee")


class SalaryRevisions(APIView):
    def get_permissions(self):
        return perm("hr.compensation.manage" if self.request.method == "POST" else "hr.compensation.view")

    def get(self, request):
        return paginate(request, m.SalaryRevision.objects.select_related("employee").order_by("-created_at"), _rev)

    def post(self, request):
        b = request.data
        r = px.request_revision(request.user.id, b.get("employee"), effective_date=_req_date(b.get("effective_date"), "effective_date"), new_salary=b.get("new_salary"), reason=b.get("reason", ""))
        return Response(_rev(r), status=201)


class SalaryRevisionDecision(APIView):
    def get_permissions(self):
        return perm("hr.compensation.manage")

    def post(self, request, pk, action):
        if action not in ("approve", "reject"):
            raise ValidationFailed("Unknown action.", code="invalid_action")
        return Response(_rev(px.decide_revision(request.user.id, pk, approve=action == "approve", note=request.data.get("note", ""))))


class SalaryHistory(APIView):
    def get_permissions(self):
        return perm("hr.compensation.view")

    def get(self, request, pk):
        return Response(px.salary_history(request.user.id, _emp(pk)))


class PayrollInputs(APIView):
    def get_permissions(self):
        return perm("hr.compensation.manage" if self.request.method == "POST" else "hr.payroll.view")

    def get(self, request):
        qs = m.PayrollInput.objects.select_related("employee").order_by("-created_at")
        if request.query_params.get("month"):
            qs = qs.filter(month=_req_date(request.query_params["month"], "month"))
        return paginate(request, qs, _inp)

    def post(self, request):
        b = request.data
        i = px.add_input(request.user.id, b.get("employee"), kind=b.get("kind"), month=_req_date(b.get("month"), "month"), amount=b.get("amount"), description=b.get("description", ""), taxable=bool(b.get("taxable", True)))
        return Response(_inp(i), status=201)


class PayrollInputDecision(APIView):
    def get_permissions(self):
        return perm("hr.payroll.approve")

    def post(self, request, pk, action):
        if action not in ("approve", "reject"):
            raise ValidationFailed("Unknown action.", code="invalid_action")
        return Response(_inp(px.decide_input(request.user.id, pk, approve=action == "approve")))


class Loans(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        qs = m.Loan.objects.select_related("employee").prefetch_related("schedule").order_by("-created_at")
        if not services.is_hr(request.user.id):
            mine = services.employee_for(request.user.id)
            qs = qs.filter(employee=mine) if mine else qs.none()
        return paginate(request, qs, _loan)

    def post(self, request):
        b = request.data
        emp = b.get("employee") or (services.employee_for(request.user.id).id if services.employee_for(request.user.id) else None)
        loan = px.request_loan(request.user.id, emp, principal=b.get("principal"), installments=b.get("installments", 0), start_month=_req_date(b.get("start_month"), "start_month"), kind=b.get("kind", "LOAN"), reason=b.get("reason", ""))
        return Response(_loan(loan), status=201)


class LoanDecision(APIView):
    def get_permissions(self):
        return perm("hr.compensation.manage")

    def post(self, request, pk, action):
        if action == "cancel":
            return Response(_loan(px.cancel_loan(request.user.id, pk)))
        if action not in ("approve", "reject"):
            raise ValidationFailed("Unknown action.", code="invalid_action")
        return Response(_loan(px.decide_loan(request.user.id, pk, approve=action == "approve", note=request.data.get("note", ""))))


class PayrollReverse(APIView):
    def get_permissions(self):
        return perm("hr.payroll.pay")

    def post(self, request, pk):
        return Response(_run(px.reverse_payroll(request.user.id, pk, reason=request.data.get("reason", ""))))


class PayrollRegister(APIView):
    def get_permissions(self):
        return perm("hr.payroll.view")

    def get(self, request, pk):
        return Response(px.payroll_register(request.user.id, pk))


class PayrollCostAllocation(APIView):
    def get_permissions(self):
        return perm("hr.payroll.view")

    def get(self, request, pk):
        return Response(px.cost_allocation(request.user.id, pk))


class PaymentInstructions(APIView):
    def get_permissions(self):
        return perm("hr.payroll.pay")

    def get(self, request, pk):
        if request.query_params.get("format") == "csv":
            resp = HttpResponse(px.payment_instructions(request.user.id, pk, as_csv=True), content_type="text/csv")
            resp["Content-Disposition"] = 'attachment; filename="payment-instructions.csv"'
            return resp
        return Response(px.payment_instructions(request.user.id, pk))

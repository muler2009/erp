from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import budgets
from modules.procurement import models as m
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError


def perm(code):
    return [require(code)()]


class Budgets(APIView):
    def get_permissions(self):
        return perm("procurement.budget.manage" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        qs = m.Budget.objects.all().order_by("fiscal_year", "code")
        if request.query_params.get("fiscal_year"):
            qs = qs.filter(fiscal_year=request.query_params["fiscal_year"])
        return Response({"results": [budgets.budget_status(b) for b in qs]})

    def post(self, request):
        b = request.data
        r = budgets.create_budget(request.user.id, code=b.get("code", ""), name=b.get("name", ""), fiscal_year=b.get("fiscal_year"), amount=b.get("amount"), department_id=b.get("department"), cost_center_ref=b.get("cost_center_ref", ""), category=b.get("category", ""), enforcement=b.get("enforcement", "BLOCK"))
        return Response(budgets.budget_status(r), status=201)


class BudgetAction(APIView):
    def get_permissions(self):
        return perm("procurement.budget.manage")

    def post(self, request, pk, action):
        if action == "revise":
            b = budgets.revise_budget(request.user.id, pk, new_amount=request.data.get("amount"), reason=request.data.get("reason", ""))
        elif action == "close":
            b = budgets.close_budget(request.user.id, pk)
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(budgets.budget_status(b))


class BudgetExecution(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response(budgets.execution_report(int(request.query_params.get("fiscal_year", date.today().year))))


class Plans(APIView):
    def get_permissions(self):
        return perm("procurement.plan.manage" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        return Response({"results": [{"id": str(p.id), "code": p.code, "name": p.name, "fiscal_year": p.fiscal_year, "status": p.status, "revision": p.revision} for p in m.ProcurementPlan.objects.order_by("-fiscal_year", "code")]})

    def post(self, request):
        b = request.data
        p = budgets.create_plan(request.user.id, code=b.get("code", ""), name=b.get("name", ""), fiscal_year=b.get("fiscal_year"), lines=b.get("lines") or [])
        return Response({"id": str(p.id), "status": p.status}, status=201)


class PlanAction(APIView):
    PERMS = {"approve": "procurement.plan.approve", "revise": "procurement.plan.manage"}

    def get_permissions(self):
        return perm(self.PERMS.get(self.kwargs.get("action"), "procurement.plan.approve"))

    def post(self, request, pk, action):
        if action == "approve":
            p = budgets.approve_plan(request.user.id, pk)
        elif action == "revise":
            p = budgets.revise_plan(request.user.id, pk, lines=request.data.get("lines") or [], reason=request.data.get("reason", ""))
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response({"id": str(p.id), "status": p.status, "revision": p.revision})


class PlanReport(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, pk):
        return Response(budgets.plan_vs_actual(pk))

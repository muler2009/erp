from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.assets import models as m
from modules.assets import planning as pl
from modules.assets.views import _s, perm
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def _item(r):
    return {"id": str(r.id), "asset": {"id": str(r.asset_id), "number": r.asset.number}, "planned_year": r.planned_year, "estimated_cost": str(r.estimated_cost), "reason": r.reason, "status": r.status}


def _bud(b):
    return {"id": str(b.id), "year": b.year, "category": _s(b.category_id), "amount": str(b.amount), "status": b.status, "notes": b.notes}


class Dashboard(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        return Response(pl.dashboard())


class ReplacementCandidates(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        return Response(pl.replacement_candidates())


class ReplacementItems(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.valuation.manage")

    def get(self, request):
        return paginate(request, m.ReplacementItem.objects.select_related("asset"), _item)

    def post(self, request):
        b = request.data
        r = pl.plan_replacement(request.user.id, b.get("asset"), planned_year=int(b.get("planned_year") or date.today().year + 1), estimated_cost=b.get("estimated_cost"), reason=b.get("reason", ""))
        return Response(_item(m.ReplacementItem.objects.select_related("asset").get(pk=r.pk)), status=201)


class ReplacementDecision(APIView):
    def get_permissions(self):
        return perm("assets.valuation.approve")

    def post(self, request, pk, action):
        if action not in ("approve", "reject"):
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        r = pl.decide_replacement(request.user.id, pk, approve=action == "approve", note=request.data.get("note", ""))
        return Response(_item(m.ReplacementItem.objects.select_related("asset").get(pk=r.pk)))


class Budgets(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.valuation.manage")

    def get(self, request):
        return paginate(request, m.CapexBudget.objects.all(), _bud)

    def post(self, request):
        b = request.data
        r = pl.propose_budget(request.user.id, year=int(b.get("year") or 0), amount=b.get("amount"), category_id=b.get("category"), notes=b.get("notes", ""))
        return Response(_bud(r), status=201)


class BudgetDecision(APIView):
    def get_permissions(self):
        return perm("assets.valuation.approve")

    def post(self, request, pk, action):
        if action not in ("approve", "reject"):
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_bud(pl.decide_budget(request.user.id, pk, approve=action == "approve", note=request.data.get("note", ""))))


class BudgetReport(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        y = request.query_params.get("year")
        if not (y or "").isdigit():
            raise ValidationFailed("year is required.", code="period_required")
        return Response(pl.budget_report(int(y)))

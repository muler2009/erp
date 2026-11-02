from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm import insights as ins
from modules.crm.views import _date, perm


class AccountSummary(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request, pk):
        return Response(ins.account_summary(request.user.id, pk, request.query_params.get("currency")))


class CrossSell(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request, pk):
        return Response(ins.cross_sell(request.user.id, pk, request.query_params.get("currency")))


class Segmentation(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response(ins.segmentation(request.user.id, request.query_params.get("currency")))


class Retention(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response(ins.retention(request.user.id, currency=request.query_params.get("currency")))


class Satisfaction(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        q = request.query_params
        return Response(ins.satisfaction(request.user.id, _date(q.get("from"), "from"), _date(q.get("to"), "to")))


class Profitability(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response(ins.profitability(request.user.id, request.query_params.get("currency")))


class Dashboard(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response(ins.dashboard(request.user.id, currency=request.query_params.get("currency")))


class RefreshLifecycle(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def post(self, request):
        return Response({"changed": ins.refresh_lifecycle(request.user.id, currency=request.data.get("currency"))})


# ----------------------------------------------------------------------------- teams, territories, portfolios
from modules.crm import teams as tm  # noqa: E402
from modules.crm.views import _s  # noqa: E402


class Teams(APIView):
    def get_permissions(self):
        return perm("crm.assign" if self.request.method == "POST" else "crm.view")

    def get(self, request):
        return Response(tm.tree())

    def post(self, request):
        b = request.data
        t = tm.create_team(request.user.id, b.get("name", ""), b.get("manager_id"), b.get("parent"))
        return Response({"id": str(t.id), "name": t.name}, status=201)


class TeamDetail(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def patch(self, request, pk):
        b = request.data
        kw = {}
        if "manager_id" in b:
            kw["manager_id"] = b["manager_id"]
        if "parent" in b:
            kw["parent_id"] = b["parent"]
        t = tm.update_team(request.user.id, pk, is_active=b.get("is_active"), **kw)
        return Response({"id": str(t.id), "name": t.name, "is_active": t.is_active})


class TeamMembers(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def put(self, request, pk):
        x = tm.set_member(request.user.id, pk, request.data.get("user_id"), bool(request.data.get("is_lead")))
        return Response({"user_id": str(x.user_id), "team": str(x.team_id), "is_lead": x.is_lead})

    def delete(self, request, pk):
        tm.remove_member(request.user.id, request.query_params.get("user_id"))
        return Response(status=204)


class Territories(APIView):
    def get_permissions(self):
        return perm("crm.assign" if self.request.method == "PUT" else "crm.view")

    def get(self, request):
        from modules.crm import models as cmod

        return Response([{"id": str(t.id), "name": t.name, "team": str(t.team_id), "criteria": t.criteria, "priority": t.priority, "is_active": t.is_active} for t in cmod.Territory.objects.order_by("priority", "name")])

    def put(self, request):
        b = request.data
        t = tm.set_territory(request.user.id, b.get("name", ""), b.get("team"), b.get("criteria") or {}, b.get("priority", 100), b.get("is_active", True))
        return Response({"id": str(t.id), "name": t.name, "criteria": t.criteria})


class AssignByTerritory(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def post(self, request, pk):
        a, t = tm.assign_by_territory(request.user.id, pk)
        return Response({"account": str(a.id), "owner_id": str(a.owner_id), "territory": t.name})


class OwnershipHistory(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request, kind, pk):
        return Response([{"from": _s(c.from_owner), "to": str(c.to_owner), "by": _s(c.changed_by), "reason": c.reason, "at": c.changed_at.isoformat()} for c in tm.ownership_history(request.user.id, kind, pk)])


class TransferPortfolio(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def post(self, request):
        b = request.data
        return Response(tm.transfer_portfolio(request.user.id, b.get("from_user"), b.get("to_user"), b.get("reason", "")))


class Portfolio(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response(tm.portfolio(request.user.id))

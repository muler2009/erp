from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.assets import disposal as dp
from modules.assets import models as m
from modules.assets import verification as vf
from modules.assets.views import _d, _s, perm
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def _disp(d):
    return {"id": str(d.id), "number": d.number, "asset": {"id": str(d.asset_id), "number": d.asset.number}, "method": d.method, "status": d.status, "reason": d.reason, "proposed_on": str(d.proposed_on), "expected_proceeds": str(d.expected_proceeds), "buyer": d.buyer, "executed_on": _s(d.executed_on),
            "proceeds": str(d.proceeds), "nbv_at_disposal": _s(d.nbv_at_disposal), "gain_loss": _s(d.gain_loss), "requested_by": str(d.requested_by), "decided_by": _s(d.decided_by)}


def _count(c):
    return {"id": str(c.id), "number": c.number, "name": c.name, "status": c.status, "started_on": str(c.started_on), "lines": c.lines.count()}


def _line(l):
    return {"id": str(l.id), "asset": l.asset.number, "expected": l.expected, "found": l.found, "discrepancy": l.discrepancy, "resolution": l.resolution}


class Disposals(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.disposal.manage")

    def get(self, request):
        qs = m.AssetDisposal.objects.select_related("asset")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _disp)

    def post(self, request):
        b = request.data
        d = dp.request_disposal(request.user.id, b.get("asset"), method=b.get("method", ""), reason=b.get("reason", ""), proposed_on=_d(b.get("proposed_on")), expected_proceeds=b.get("expected_proceeds", 0), buyer=b.get("buyer", ""), buyer_reference=b.get("buyer_reference", ""))
        return Response(_disp(m.AssetDisposal.objects.select_related("asset").get(pk=d.pk)), status=201)


class DisposalAction(APIView):
    def get_permissions(self):
        return perm("assets.disposal.approve" if self.kwargs.get("action") in ("approve", "reject") else "assets.disposal.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "approve":
            dp.decide(uid, pk, approve=True)
        elif action == "reject":
            dp.decide(uid, pk, approve=False, note=b.get("note", ""))
        elif action == "execute":
            dp.execute(uid, pk, executed_on=_d(b.get("executed_on")) or date.today(), proceeds=b.get("proceeds", 0))
        elif action == "cancel":
            dp.cancel(uid, pk)
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_disp(m.AssetDisposal.objects.select_related("asset").get(pk=pk)))


class DisposalCertificate(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request, pk):
        return Response(dp.certificate(pk))


class DisposalReport(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        f, t = _d(request.query_params.get("from")), _d(request.query_params.get("to"))
        if not (f and t):
            raise ValidationFailed("from and to are required (YYYY-MM-DD).", code="period_required")
        return Response(dp.disposal_report(f, t))


class Counts(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.verification.manage")

    def get(self, request):
        return paginate(request, m.VerificationCount.objects.all(), _count)

    def post(self, request):
        b = request.data
        c = vf.start_count(request.user.id, name=b.get("name", ""), location_id=b.get("location"), category_id=b.get("category"), started_on=_d(b.get("started_on")))
        return Response(_count(c), status=201)


class CountAction(APIView):
    def get_permissions(self):
        return perm("assets.verification.approve" if self.kwargs.get("action") == "close" else "assets.verification.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "scan":
            return Response(_line(vf.scan(uid, pk, b.get("code", ""), location_id=b.get("location"), condition=b.get("condition"))), status=201)
        if action == "complete":
            return Response(vf.complete_count(uid, pk))
        if action == "close":
            return Response(_count(vf.close_count(uid, pk)))
        if action == "cancel":
            return Response(_count(vf.cancel_count(uid, pk)))
        raise DomainError("Unknown action.", code="not_found", status_code=404)


class CountReport(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request, pk):
        return Response(vf.count_report(pk))


class CountLineResolve(APIView):
    def get_permissions(self):
        return perm("assets.verification.approve")

    def post(self, request, pk):
        l = vf.resolve(request.user.id, pk, resolution=request.data.get("resolution", ""), notes=request.data.get("notes", ""))
        return Response({"id": str(l.id), "resolution": l.resolution})

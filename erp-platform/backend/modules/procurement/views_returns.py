from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import models as m
from modules.procurement import returns as rt
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError


def perm(code):
    return [require(code)()]


def _ret(r):
    return {"id": str(r.id), "number": r.number, "po": r.order.number, "supplier": r.supplier.name, "status": r.status, "reason": r.reason, "return_date": str(r.return_date), "return_value": str(r.return_value), "credit_due": str(r.credit_due), "credit_note_id": None if not r.credit_note_id else str(r.credit_note_id),
            "lines": [{"po_line": str(l.po_line_id), "quantity": str(l.quantity), "lot_code": l.lot_code} for l in r.lines.all()]}


def _claim(c):
    return {"id": str(c.id), "number": c.number, "supplier": c.supplier.name, "kind": c.kind, "status": c.status, "currency": c.currency, "amount_claimed": str(c.amount_claimed), "amount_accepted": None if c.amount_accepted is None else str(c.amount_accepted), "description": c.description, "decision_note": c.decision_note}


class Returns(APIView):
    def get_permissions(self):
        return perm("procurement.return.manage" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        qs = m.SupplierReturn.objects.select_related("order", "supplier").prefetch_related("lines").order_by("-created_at")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return Response({"results": [_ret(r) for r in qs[:200]]})

    def post(self, request):
        b = request.data
        r = rt.create_return(request.user.id, b.get("order"), location_id=b.get("location"), return_date=date.fromisoformat(b["return_date"]) if b.get("return_date") else date.today(), reason=b.get("reason", ""), lines=b.get("lines") or [])
        return Response(_ret(r), status=201)


class ReturnAction(APIView):
    def get_permissions(self):
        return perm("procurement.return.approve" if self.kwargs.get("action") == "approve" else "procurement.return.manage")

    def post(self, request, pk, action):
        uid, b = request.user.id, request.data
        if action == "approve":
            r = rt.approve_return(uid, pk)
        elif action == "cancel":
            r = rt.cancel_return(uid, pk)
        elif action == "dispatch":
            r = rt.dispatch_return(uid, pk, serials=b.get("serials"))
        elif action == "credit":
            r = rt.link_credit(uid, pk, b.get("credit_note"))
        elif action == "close":
            r = rt.close_return(uid, pk)
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_ret(m.SupplierReturn.objects.select_related("order", "supplier").get(pk=r.pk)))


class Claims(APIView):
    def get_permissions(self):
        return perm("procurement.return.manage" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        qs = m.SupplierClaim.objects.select_related("supplier").order_by("-created_at")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return Response({"results": [_claim(c) for c in qs[:200]]})

    def post(self, request):
        b = request.data
        c = rt.create_claim(request.user.id, supplier_id=b.get("supplier"), kind=b.get("kind", ""), description=b.get("description", ""), amount=b.get("amount"), order_id=b.get("order"), return_id=b.get("return"))
        return Response(_claim(c), status=201)


class ClaimAction(APIView):
    def get_permissions(self):
        return perm("procurement.return.approve" if self.kwargs.get("action") in ("accept", "reject") else "procurement.return.manage")

    def post(self, request, pk, action):
        uid, b = request.user.id, request.data
        if action == "submit":
            c = rt.submit_claim(uid, pk)
        elif action == "accept":
            c = rt.decide_claim(uid, pk, accept=True, amount=b.get("amount"), note=b.get("note", ""))
        elif action == "reject":
            c = rt.decide_claim(uid, pk, accept=False, note=b.get("note", ""))
        elif action == "settle":
            c = rt.settle_claim(uid, pk, b.get("credit_note"))
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_claim(m.SupplierClaim.objects.select_related("supplier").get(pk=c.pk)))


class ReturnsSummary(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response({"results": rt.summary()})

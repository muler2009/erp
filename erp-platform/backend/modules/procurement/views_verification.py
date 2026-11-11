from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import models as m
from modules.procurement import services
from modules.procurement import verification as vf
from platform_core.authorization.permissions import require


def perm(code):
    return [require(code)()]


class MatchExceptions(APIView):
    def get_permissions(self):
        return perm("procurement.invoice.match")

    def get(self, request):
        return Response({"results": vf.exceptions()})


class MatchOverride(APIView):
    def get_permissions(self):
        return perm("procurement.invoice.override")

    def post(self, request, pk):
        x = vf.override(request.user.id, pk, reason=request.data.get("reason", ""))
        return Response({"status": x.status, "override_reason": x.override_reason})


class DebitNotes(APIView):
    def get_permissions(self):
        return perm("procurement.debit_note.create")

    def post(self, request, pk):
        b = request.data
        cn = vf.debit_note(request.user.id, pk, lines=b.get("lines") or [], reason=b.get("reason", ""), invoice_date=date.fromisoformat(b["invoice_date"]) if b.get("invoice_date") else date.today(), supplier_ref=b.get("supplier_ref", ""))
        return Response({"id": str(cn.id), "total": str(cn.total), "status": cn.status}, status=201)

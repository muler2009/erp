from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import models as m
from modules.procurement import requisitions_ext as rx
from platform_core.authorization.permissions import require
from shared.api.errors import ValidationFailed


def perm(code):
    return [require(code)()]


class RequisitionStockCheck(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, pk):
        return Response({"results": rx.stock_check(pk)})


class RequisitionGenerate(APIView):
    def get_permissions(self):
        return perm("procurement.requisition.create")

    def post(self, request):
        r = rx.generate_from_reorder(request.user.id, title=request.data.get("title", "Automatic replenishment"))
        return Response({"id": None if r is None else str(r.id), "number": None if r is None else r.number}, status=201 if r else 200)


class RequisitionConsolidate(APIView):
    def get_permissions(self):
        return perm("procurement.rfq.manage")

    def post(self, request):
        b = request.data
        if b.get("suppliers"):
            rfq = rx.create_consolidated_rfq(request.user.id, b.get("requisitions") or [], title=b.get("title", "Consolidated sourcing"), supplier_ids=b["suppliers"], due_date=date.fromisoformat(b["due_date"]) if b.get("due_date") else None)
            return Response({"rfq": str(rfq.id), "number": rfq.number}, status=201)
        return Response({"lines": [{**l, "product": None if not l["product"] else str(l["product"]), "quantity": str(l["quantity"])} for l in rx.consolidate(b.get("requisitions") or [])]})


class RequisitionRecurring(APIView):
    def get_permissions(self):
        return perm("procurement.requisition.create")

    def delete(self, request, pk):
        rx.stop_recurring(request.user.id, pk)
        return Response(status=204)


class RequisitionAttachment(APIView):
    def get_permissions(self):
        return perm("procurement.requisition.create")

    def post(self, request, pk):
        up = request.FILES.get("file")
        if up is None:
            raise ValidationFailed("A file is required.", code="file_required")
        f = rx.attach_file(request.user.id, pk, up.name, up.read())
        return Response({"file_id": str(f.id), "name": f.original_name}, status=201)

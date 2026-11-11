from datetime import date

from django.http import HttpResponse
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import models as m
from modules.procurement import orders_ext as ox
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError


def perm(code):
    return [require(code)()]


def _d(v):
    return date.fromisoformat(v) if v else None


class PoTerms(APIView):
    def get_permissions(self):
        return perm("procurement.purchase_order.create")

    def patch(self, request, pk):
        b = request.data
        o = ox.set_terms(request.user.id, pk, payment_terms=b.get("payment_terms"), delivery_terms=b.get("delivery_terms"), delivery_address=b.get("delivery_address"))
        return Response({"payment_terms": o.payment_terms, "delivery_terms": o.delivery_terms, "delivery_address": o.delivery_address})


class PoLineSchedule(APIView):
    def get_permissions(self):
        return perm("procurement.purchase_order.create")

    def put(self, request, pk):
        l = ox.set_schedule(request.user.id, pk, [{"due_date": _d(r.get("due_date")), "quantity": r.get("quantity")} for r in request.data.get("rows") or []])
        return Response({"rows": l.schedule.count()})


class PoAcknowledge(APIView):
    def get_permissions(self):
        return perm("procurement.purchase_order.create")

    def post(self, request, pk):
        b = request.data
        o = ox.acknowledge(request.user.id, pk, reference=b.get("reference", ""), promised_date=_d(b.get("promised_date")), note=b.get("note", ""))
        return Response({"acknowledged_at": o.acknowledged_at, "promised_date": None if not o.promised_date else str(o.promised_date)})


class PoAmendments(APIView):
    def get_permissions(self):
        return perm("procurement.purchase_order.create" if self.request.method == "POST" else "procurement.view")

    def get(self, request, pk):
        return Response({"results": [{"id": str(a.id), "number": a.number, "status": a.status, "reason": a.reason, "old_total": str(a.old_total), "new_total": str(a.new_total), "changes": a.changes} for a in m.PoAmendment.objects.filter(order_id=pk).order_by("number")]})

    def post(self, request, pk):
        b = request.data
        a = ox.request_amendment(request.user.id, pk, reason=b.get("reason", ""), lines=b.get("lines"), expected_date=_d(b.get("expected_date")))
        return Response({"id": str(a.id), "number": a.number, "status": a.status}, status=201)


class PoAmendmentDecision(APIView):
    def get_permissions(self):
        return perm("procurement.purchase_order.approve")

    def post(self, request, pk, decision):
        if decision not in ("approve", "reject"):
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        a = ox.decide_amendment(request.user.id, pk, approve=decision == "approve", note=request.data.get("note", ""))
        return Response({"status": a.status})


class PoClose(APIView):
    def get_permissions(self):
        return perm("procurement.purchase_order.approve")

    def post(self, request, pk):
        return Response({"status": ox.close_po(request.user.id, pk, reason=request.data.get("reason", "")).status})


class Blankets(APIView):
    def get_permissions(self):
        return perm("procurement.purchase_order.create")

    def post(self, request):
        b = request.data
        o = ox.create_blanket(request.user.id, supplier_id=b.get("supplier"), currency=b.get("currency", ""), order_date=_d(b.get("order_date")) or date.today(), valid_to=_d(b.get("valid_to")), lines=b.get("lines") or [], budget_id=b.get("budget"))
        return Response({"id": str(o.id), "number": o.number, "status": o.status}, status=201)


class BlanketRelease(APIView):
    def get_permissions(self):
        return perm("procurement.purchase_order.create")

    def post(self, request, pk):
        b = request.data
        o = ox.release_blanket(request.user.id, pk, b.get("lines") or [], order_date=_d(b.get("order_date")), expected_date=_d(b.get("expected_date")))
        return Response({"id": str(o.id), "number": o.number}, status=201)


class PoDocument(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, pk):
        if request.query_params.get("as") == "html":
            return HttpResponse(ox.document_html(pk), content_type="text/html; charset=utf-8")
        return Response(ox.document(pk))


class OverdueDeliveries(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response({"results": ox.overdue_lines()})


# ----------------------------------------------------------------------------- receiving (P-H)
from modules.procurement import receiving as rc  # noqa: E402
from shared.api.errors import ValidationFailed  # noqa: E402


class ReceiptsList(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        qs = m.GoodsReceipt.objects.select_related("order").prefetch_related("lines").order_by("-receipt_date", "-created_at")
        if request.query_params.get("order"):
            qs = qs.filter(order_id=request.query_params["order"])
        return Response({"results": [rc.receipt_view(r) for r in qs[:200]]})


class ReceiptDetail(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, pk):
        r = m.GoodsReceipt.objects.select_related("order").filter(pk=pk).first()
        if r is None:
            raise DomainError("Receipt not found.", code="not_found", status_code=404)
        return Response(rc.receipt_view(r))


class ReceiptEvidence(APIView):
    def get_permissions(self):
        return perm("inventory.goods.receive")

    def post(self, request, pk):
        up = request.FILES.get("file")
        if up is None:
            raise ValidationFailed("A file is required.", code="file_required")
        f = rc.attach_evidence(request.user.id, pk, up.name, up.read())
        return Response({"file_id": str(f.id), "name": f.original_name}, status=201)


class PendingInspections(APIView):
    def get_permissions(self):
        return perm("procurement.receipt.inspect")

    def get(self, request):
        return Response({"results": rc.pending_inspections()})


class InspectLine(APIView):
    def get_permissions(self):
        return perm("procurement.receipt.inspect")

    def post(self, request, pk):
        b = request.data
        l = rc.inspect_line(request.user.id, pk, accept=b.get("accept", "0"), reject=b.get("reject", "0"), note=b.get("note", ""), serials=b.get("serials"))
        return Response({"inspection_status": l.inspection_status, "accepted": str(l.accepted_quantity), "rejected": str(l.rejected_quantity)})

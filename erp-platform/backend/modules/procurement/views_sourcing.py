from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import models as m
from modules.procurement import services, sourcing
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError


def perm(code):
    return [require(code)()]


def _rfq(r):
    return {"id": str(r.id), "number": r.number, "title": r.title, "kind": r.kind, "status": r.status, "closing_at": r.closing_at, "criteria": r.criteria, "committee": r.committee, "opened_at": r.opened_at, "open_to_all": r.open_to_all, "bids_visible": sourcing.bids_visible(r)}


class Tenders(APIView):
    def get_permissions(self):
        return perm("procurement.rfq.manage" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        return Response({"results": [_rfq(r) for r in m.Rfq.objects.filter(kind="TENDER").order_by("-created_at")]})

    def post(self, request):
        b = request.data
        r = sourcing.create_tender(request.user.id, title=b.get("title", ""), lines=b.get("lines") or [], committee=b.get("committee") or [], closing_at=b.get("closing_at"), criteria=b.get("criteria") or [], supplier_ids=b.get("suppliers"), open_to_all=bool(b.get("open_to_all")), requisition_id=b.get("requisition"), payment_terms=b.get("payment_terms"), delivery_terms=b.get("delivery_terms"), terms_text=b.get("terms_text"), min_technical_score=b.get("min_technical_score"), estimated_value=b.get("estimated_value"))
        return Response(_rfq(r), status=201)


class TenderAction(APIView):
    PERMS = {"publish": "procurement.rfq.manage", "close": "procurement.rfq.manage", "open": "procurement.tender.evaluate", "evaluation": "procurement.tender.evaluate", "results": "procurement.view"}

    def get_permissions(self):
        return perm(self.PERMS.get(self.kwargs.get("action"), "procurement.rfq.manage"))

    def get(self, request, pk, action):
        if action == "evaluation":
            return Response(sourcing.evaluation(pk))
        if action == "results":
            return Response({"results": sourcing.bidder_results(pk)})
        raise DomainError("Unknown action.", code="not_found", status_code=404)

    def post(self, request, pk, action):
        u = request.user.id
        if action == "publish":
            return Response(_rfq(sourcing.publish_tender(u, pk)))
        if action == "close":
            return Response(_rfq(sourcing.close_bidding(u, pk)))
        if action == "open":
            return Response(_rfq(sourcing.open_bids(u, pk)))
        raise DomainError("Unknown action.", code="not_found", status_code=404)


class QuotationScoreView(APIView):
    def get_permissions(self):
        return perm("procurement.tender.evaluate")

    def post(self, request, pk):
        sourcing.score_quotation(request.user.id, pk, request.data.get("scores") or {}, request.data.get("comment", ""))
        return Response({"scored": True})


class QuotationDisqualify(APIView):
    def get_permissions(self):
        return perm("procurement.tender.evaluate")

    def post(self, request, pk):
        sourcing.disqualify(request.user.id, pk, request.data.get("reason", ""))
        return Response({"disqualified": True})


class RfqAwardJustified(APIView):
    def get_permissions(self):
        return perm("procurement.tender.award")

    def post(self, request, pk):
        b = request.data
        po = sourcing.award(request.user.id, pk, b.get("quotation"), justification=b.get("justification", ""), order_date=date.fromisoformat(b["order_date"]) if b.get("order_date") else None)
        return Response({"po": str(po.id), "number": po.number}, status=201)


class RfqClarifications(APIView):
    def get_permissions(self):
        return perm("procurement.rfq.manage")

    def get(self, request, pk):
        return Response({"results": [{"id": str(c.id), "supplier": None if not c.supplier_id else str(c.supplier_id), "question": c.question, "answer": c.answer} for c in m.RfqClarification.objects.filter(rfq_id=pk)]})

    def post(self, request, pk):
        b = request.data
        if b.get("answer") is not None:
            c = sourcing.answer(request.user.id, b.get("clarification"), b["answer"])
        else:
            c = sourcing.ask(request.user.id, pk, supplier_id=b.get("supplier"), question=b.get("question", ""))
        return Response({"id": str(c.id)}, status=201)


class SingleSourcePO(APIView):
    def get_permissions(self):
        return perm("procurement.single_source" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        return Response({"results": sourcing.single_source_report()})

    def post(self, request):
        b = request.data
        po = sourcing.single_source_po(request.user.id, supplier_id=b.get("supplier"), currency=b.get("currency", ""), order_date=date.fromisoformat(b["order_date"]) if b.get("order_date") else date.today(), lines=b.get("lines") or [], justification=b.get("justification", ""), budget_id=b.get("budget"))
        return Response({"id": str(po.id), "number": po.number}, status=201)

from datetime import date

from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import models as m
from modules.procurement import services
from platform_core.authorization.permissions import require
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate


PROFILE_KEYS = ("legal_name", "registration_no", "phone", "website", "category", "address", "payment_terms_days", "currency", "risk_level", "is_preferred", "early_discount_percent", "early_discount_days", "wht_percent")


def perm(code):
    return [require(code)()]


def _s(v):
    return None if v is None else str(v)


def _supplier(s):
    return {"id": str(s.id), "name": s.name, "tax_id": s.tax_id, "email": s.email, "status": s.status, "partner": _s(s.partner_id), "qualified_at": s.qualified_at}


def _req(r, lines=False):
    d = {"id": str(r.id), "number": r.number, "title": r.title, "status": r.status, "requester_id": str(r.requester_id), "estimated_total": str(r.estimated_total), "needed_by": _s(r.needed_by), "workflow_instance_id": _s(r.workflow_instance_id), "priority": r.priority, "project_ref": r.project_ref, "cost_center_ref": r.cost_center_ref, "procurement_type": r.procurement_type, "source": r.source, "recurring_every_days": r.recurring_every_days}
    if lines:
        d["lines"] = [{"id": str(l.id), "line_no": l.line_no, "product": _s(l.product_id), "description": l.description, "quantity": str(l.quantity), "ordered_quantity": str(l.ordered_quantity), "estimated_unit_price": str(l.estimated_unit_price)} for l in r.lines.all()]
    return d


def _po(o, lines=False):
    d = {"id": str(o.id), "number": o.number, "supplier": {"id": str(o.supplier_id), "name": o.supplier.name}, "currency": o.currency, "status": o.status, "order_date": str(o.order_date), "expected_date": _s(o.expected_date), "total": str(o.total), "invoiced_value": str(o.invoiced_value), "version": o.version, "workflow_instance_id": _s(o.workflow_instance_id), "contract": _s(o.contract_id)}
    if lines:
        d["lines"] = [{"id": str(l.id), "line_no": l.line_no, "product": _s(l.product_id), "description": l.description, "quantity": str(l.quantity), "unit_price": str(l.unit_price), "received_quantity": str(l.received_quantity)} for l in o.lines.all()]
    return d


# ----------------------------------------------------------------------------- suppliers
class Suppliers(APIView):
    def get_permissions(self):
        return perm("procurement.supplier.manage" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        qs = m.Supplier.objects.all()
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _supplier)

    def post(self, request):
        b = request.data
        return Response(_supplier(services.create_supplier(request.user.id, name=b.get("name", ""), tax_id=b.get("tax_id", ""), email=b.get("email", ""), **{k: b[k] for k in PROFILE_KEYS if k in b})), status=201)


class SupplierDetail(APIView):
    def get_permissions(self):
        return perm("procurement.supplier.manage" if self.request.method == "PATCH" else "procurement.view")

    def patch(self, request, pk):
        from modules.procurement import suppliers
        b = request.data
        return Response(suppliers.profile(suppliers.update_supplier(request.user.id, pk, **{k: b[k] for k in PROFILE_KEYS + ("name", "tax_id", "email") if k in b})))

    def get(self, request, pk):
        return Response({**_supplier(get_object_or_404(m.Supplier, pk=pk)), "scorecard": services.supplier_scorecard(pk)})


def _simple_action(permission, fn, render, **fixed):
    class View(APIView):
        def get_permissions(self):
            return perm(permission)

        def post(self, request, pk):
            return Response(render(fn(request.user.id, pk, **{k: (request.data.get(v) if isinstance(v, str) else v) for k, v in fixed.items()})))

    return View


SupplierQualify = _simple_action("procurement.supplier.manage", services.qualify_supplier, _supplier, notes="notes")
SupplierBlock = _simple_action("procurement.supplier.manage", services.block_supplier, _supplier, reason="reason")


class SupplierEvaluate(APIView):
    def get_permissions(self):
        return perm("procurement.supplier.manage")

    def post(self, request, pk):
        b = request.data
        e = services.evaluate_supplier(request.user.id, pk, period=b.get("period", ""), delivery=b.get("delivery", 0), quality=b.get("quality", 0), price=b.get("price", 0), comment=b.get("comment", ""))
        return Response({"id": str(e.id)}, status=201)


# ----------------------------------------------------------------------------- requisitions
class ReqLineIn(serializers.Serializer):
    product = serializers.UUIDField(required=False, allow_null=True, default=None)
    description = serializers.CharField(required=False, allow_blank=True, default="", max_length=300)
    quantity = serializers.DecimalField(max_digits=18, decimal_places=4)
    estimated_unit_price = serializers.DecimalField(max_digits=20, decimal_places=4, required=False, default=0)


class ReqIn(serializers.Serializer):
    title = serializers.CharField(max_length=200)
    department_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    needed_by = serializers.DateField(required=False, allow_null=True, default=None)
    lines = ReqLineIn(many=True, allow_empty=False)
    priority = serializers.CharField(required=False, default=None, allow_null=True)
    emergency_justification = serializers.CharField(required=False, default=None, allow_null=True, max_length=500)
    project_ref = serializers.CharField(required=False, default=None, allow_null=True, max_length=60)
    cost_center_ref = serializers.CharField(required=False, default=None, allow_null=True, max_length=60)
    procurement_type = serializers.CharField(required=False, default=None, allow_null=True)
    recurring_every_days = serializers.IntegerField(required=False, default=None, allow_null=True)


class Requisitions(APIView):
    def get_permissions(self):
        return perm("procurement.requisition.create" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        return paginate(request, m.Requisition.objects.all(), _req)

    def post(self, request):
        v = ReqIn(data=request.data)
        v.is_valid(raise_exception=True)
        d = v.validated_data
        r = services.create_requisition(request.user.id, title=d["title"], department_id=d["department_id"], needed_by=d["needed_by"], lines=[{**l, "product": _s(l["product"])} for l in d["lines"]], **{k: d[k] for k in ("priority", "emergency_justification", "project_ref", "cost_center_ref", "procurement_type", "recurring_every_days")})
        return Response(_req(r, lines=True), status=201)


class RequisitionDetail(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, pk):
        return Response(_req(get_object_or_404(m.Requisition, pk=pk), lines=True))


RequisitionSubmit = _simple_action("procurement.requisition.create", services.submit_requisition, _req)
RequisitionApprove = _simple_action("procurement.requisition.approve", services.approve_requisition, _req)
RequisitionCancel = _simple_action("procurement.requisition.create", services.cancel_requisition, _req)


# ----------------------------------------------------------------------------- RFQ
class Rfqs(APIView):
    def get_permissions(self):
        return perm("procurement.rfq.manage" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        return paginate(request, m.Rfq.objects.all(), lambda r: {"id": str(r.id), "number": r.number, "title": r.title, "kind": r.kind, "status": r.status, "due_date": _s(r.due_date), "requisition": _s(r.requisition_id)})

    def post(self, request):
        b = request.data
        rfq = services.create_rfq(request.user.id, title=b.get("title", ""), supplier_ids=b.get("suppliers", []), requisition_id=b.get("requisition"), lines=b.get("lines"), due_date=date.fromisoformat(b["due_date"]) if b.get("due_date") else None)
        return Response({"id": str(rfq.id), "number": rfq.number, "lines": [{"id": str(l.id), "line_no": l.line_no, "description": l.description, "quantity": str(l.quantity)} for l in rfq.lines.all()]}, status=201)


class RfqDetail(APIView):
    """An RFQ with its lines, invited suppliers and (once visible) every quotation with its per-line prices.
    The bids of a tender stay hidden until the committee has opened them, exactly as in the comparison endpoint."""

    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, pk):
        from modules.procurement import sourcing

        rfq = get_object_or_404(m.Rfq.objects.prefetch_related("suppliers", "lines"), pk=pk)
        visible = sourcing.bids_visible(rfq)
        quotations = []
        if visible:
            for q in rfq.quotations.select_related("supplier").prefetch_related("lines"):
                quotations.append({"id": str(q.id), "supplier": {"id": str(q.supplier_id), "name": q.supplier.name}, "currency": q.currency, "lead_time_days": q.lead_time_days, "disqualified": q.disqualified,
                                   "disqualification_reason": q.disqualification_reason, "is_awarded": q.is_awarded, "prices": {str(l.rfq_line_id): str(l.unit_price) for l in q.lines.all()}})
        return Response({"id": str(rfq.id), "number": rfq.number, "title": rfq.title, "kind": rfq.kind, "status": rfq.status, "due_date": _s(rfq.due_date), "closing_at": _s(rfq.closing_at), "requisition": _s(rfq.requisition_id),
                         "open_to_all": rfq.open_to_all, "suppliers": [{"id": str(x.id), "name": x.name} for x in rfq.suppliers.all()],
                         "lines": [{"id": str(l.id), "line_no": l.line_no, "description": l.description, "quantity": str(l.quantity), "product": _s(l.product_id)} for l in sorted(rfq.lines.all(), key=lambda l: l.line_no)],
                         "sealed": not visible, "quotation_count": rfq.quotations.count(), "quotations": quotations})


class RfqQuotation(APIView):
    def get_permissions(self):
        return perm("procurement.rfq.manage")

    def post(self, request, pk):
        b = request.data
        q = services.record_quotation(request.user.id, pk, supplier_id=b.get("supplier"), currency=b.get("currency", ""), prices=b.get("prices") or {}, lead_time_days=b.get("lead_time_days", 0))
        return Response({"id": str(q.id)}, status=201)


class RfqCompare(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, pk):
        return Response(services.compare_bids(pk))


class RfqAward(APIView):
    def get_permissions(self):
        return perm("procurement.rfq.manage")

    def post(self, request, pk):
        return Response(_po(services.award_rfq(request.user.id, pk, request.data.get("quotation")), lines=True), status=201)


# ----------------------------------------------------------------------------- purchase orders
class POLineIn(serializers.Serializer):
    product = serializers.UUIDField(required=False, allow_null=True, default=None)
    description = serializers.CharField(required=False, allow_blank=True, default="", max_length=300)
    quantity = serializers.DecimalField(max_digits=18, decimal_places=4)
    unit_price = serializers.DecimalField(max_digits=20, decimal_places=4, required=False, allow_null=True, default=None)


class POIn(serializers.Serializer):
    supplier = serializers.UUIDField()
    currency = serializers.CharField(max_length=3)
    order_date = serializers.DateField()
    expected_date = serializers.DateField(required=False, allow_null=True, default=None)
    requisition = serializers.UUIDField(required=False, allow_null=True, default=None)
    budget = serializers.UUIDField(required=False, allow_null=True, default=None)
    contract = serializers.UUIDField(required=False, allow_null=True, default=None)
    lines = POLineIn(many=True, allow_empty=False)


class PurchaseOrders(APIView):
    def get_permissions(self):
        return perm("procurement.purchase_order.create" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        qs = m.PurchaseOrder.objects.select_related("supplier")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _po)

    def post(self, request):
        v = POIn(data=request.data)
        v.is_valid(raise_exception=True)
        d = v.validated_data
        o = services.create_po(request.user.id, supplier_id=d["supplier"], currency=d["currency"], order_date=d["order_date"], expected_date=d["expected_date"], requisition_id=d["requisition"], budget_id=d["budget"], contract_id=d["contract"], lines=[{**l, "product": _s(l["product"])} for l in d["lines"]])
        return Response(_po(o, lines=True), status=201)


class PurchaseOrderDetail(APIView):
    def get_permissions(self):
        return perm("procurement.purchase_order.create" if self.request.method == "PUT" else "procurement.view")

    def get(self, request, pk):
        return Response(_po(get_object_or_404(m.PurchaseOrder.objects.select_related("supplier"), pk=pk), lines=True))

    def put(self, request, pk):
        v = POIn(data=request.data, partial=True)
        v.is_valid(raise_exception=True)
        d = v.validated_data
        if "lines" not in d:
            raise ValidationFailed("lines are required.", code="no_lines")
        o = services.update_po(request.user.id, pk, lines=[{**l, "product": _s(l["product"])} for l in d["lines"]], expected_date=d.get("expected_date"), expected_version=request.data.get("version"))
        return Response(_po(o, lines=True))


def _po_render(o):
    return _po(m.PurchaseOrder.objects.select_related("supplier").get(pk=o.pk), lines=True)


POSubmit = _simple_action("procurement.purchase_order.create", services.submit_po, _po_render)
POApprove = _simple_action("procurement.purchase_order.approve", services.approve_po, _po_render)
POCancel = _simple_action("procurement.purchase_order.create", services.cancel_po, _po_render)


class POReceive(APIView):
    def get_permissions(self):
        return perm("inventory.goods.receive")

    def post(self, request, pk):
        b = request.data
        from platform_core.authorization import services as authz

        r = services.receive_goods(request.user.id, pk, location_id=b.get("location"), receipt_date=date.fromisoformat(b["receipt_date"]) if b.get("receipt_date") else date.today(), lines=b.get("lines") or [], delivery_note=b.get("delivery_note", ""), notes=b.get("notes", ""), approve_over=bool(b.get("approve_over")) and authz.has_permission(request.user.id, "procurement.receipt.over_receive"))
        return Response({"id": str(r.id), "number": r.number}, status=201)


class InvoiceMatchView(APIView):
    def get_permissions(self):
        return perm("procurement.invoice.match")

    def post(self, request, pk):
        match = services.match_invoice(request.user.id, request.data.get("invoice"), pk, mode=request.data.get("mode", "THREE_WAY"))
        return Response({"status": match.status, "detail": match.detail}, status=200)


class SpendReport(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        try:
            start, end = date.fromisoformat(request.query_params["from"]), date.fromisoformat(request.query_params["to"])
        except (KeyError, ValueError):
            raise ValidationFailed("from and to (YYYY-MM-DD) are required.", code="invalid_date")
        return Response({"rows": services.spend_by_supplier(start, end)})

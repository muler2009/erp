from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm import models as cm
from modules.crm import services as crm
from modules.finance import models as fm
from modules.sales import models as m
from modules.sales import services
from platform_core.authorization.permissions import require
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate
from modules.crm.views import _date


def perm(code):
    return [require(code)()]


def _s(v):
    return None if v is None else str(v)


def _line(l, extra=False):
    d = {"id": str(l.id), "line_no": l.line_no, "product": _s(l.product_id), "description": l.description, "quantity": str(l.quantity), "unit_price": str(l.unit_price), "discount_percent": str(l.discount_percent), "net_unit_price": str(l.net_unit_price), "tax_rate": _s(l.tax_rate_id), "line_total": str(l.line_total), "tax_amount": str(l.tax_amount)}
    if extra:
        d.update(delivered_quantity=str(l.delivered_quantity), returned_quantity=str(l.returned_quantity), invoiced_quantity=str(l.invoiced_quantity), credited_quantity=str(l.credited_quantity))
    return d


def _quote(q, lines=False):
    d = {"id": str(q.id), "number": q.number, "account": str(q.account_id), "opportunity": _s(q.opportunity_id), "currency": q.currency, "status": q.status, "valid_until": _s(q.valid_until), "subtotal": str(q.subtotal), "tax_total": str(q.tax_total), "total": str(q.total), "version": q.version}
    if lines:
        d["lines"] = [_line(l) for l in q.lines.all()]
    return d


def _order(o, lines=False):
    d = {"id": str(o.id), "number": o.number, "account": str(o.account_id), "opportunity": _s(o.opportunity_id), "currency": o.currency, "order_date": str(o.order_date), "status": o.status, "subtotal": str(o.subtotal), "tax_total": str(o.tax_total), "total": str(o.total), "max_discount": str(o.max_discount), "approval_required": o.approval_required, "created_by": str(o.created_by), "approved_by": _s(o.approved_by), "workflow_instance_id": _s(o.workflow_instance_id), "version": o.version}
    if lines:
        d["lines"] = [_line(l, True) for l in o.lines.all()]
    return d


def _invoice(i):
    return {"id": str(i.id), "kind": i.kind, "status": i.status, "total": str(i.total), "currency": i.currency, "number": getattr(i, "number", None)}


def _visible(qs, user_id):
    return crm.scope(qs, user_id, owner_field="account__owner_id")


def _order_for(request, pk):
    o = get_object_or_404(m.SalesOrder, pk=pk)
    crm._own(cm.CrmAccount, o.account_id, request.user.id, "Order")
    return o


# ----------------------------------------------------------------------------- price lists
class PriceLists(APIView):
    def get_permissions(self):
        return perm("sales.pricelist.manage" if self.request.method == "POST" else "sales.view")

    def get(self, request):
        return paginate(request, m.PriceList.objects.all(), lambda p: {"id": str(p.id), "name": p.name, "currency": p.currency, "valid_from": _s(p.valid_from), "valid_to": _s(p.valid_to), "is_active": p.is_active, "items": [{"product": str(i.product_id), "min_quantity": str(i.min_quantity), "unit_price": str(i.unit_price)} for i in p.items.all()]})

    def post(self, request):
        b = request.data
        p = services.create_price_list(request.user.id, name=b.get("name", ""), currency=b.get("currency", ""), items=b.get("items") or [], valid_from=_date(b.get("valid_from"), "valid_from"), valid_to=_date(b.get("valid_to"), "valid_to"))
        return Response({"id": str(p.id), "name": p.name}, status=201)


class PriceLookup(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request):
        q = request.query_params
        try:
            from decimal import Decimal

            qty = Decimal(q.get("quantity", "1"))
        except Exception:
            raise ValidationFailed("quantity must be a number.", code="invalid_amount")
        from django.utils import timezone

        price = services.price_for(q.get("product"), q.get("currency", ""), qty, _date(q.get("date"), "date") or timezone.now().date())
        return Response({"unit_price": _s(price)})


# ----------------------------------------------------------------------------- quotations
class Quotations(APIView):
    def get_permissions(self):
        return perm("sales.quote.create" if self.request.method == "POST" else "sales.view")

    def get(self, request):
        qs = _visible(m.Quotation.objects.all(), request.user.id)
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _quote)

    def post(self, request):
        b = request.data
        q = services.create_quotation(request.user.id, account_id=b.get("account"), currency=b.get("currency", ""), lines=b.get("lines") or [], valid_until=_date(b.get("valid_until"), "valid_until"), opportunity_id=b.get("opportunity"))
        return Response(_quote(q, True), status=201)


class QuotationDetail(APIView):
    def get_permissions(self):
        return perm("sales.quote.create" if self.request.method == "PUT" else "sales.view")

    def get(self, request, pk):
        q = get_object_or_404(m.Quotation, pk=pk)
        crm._own(cm.CrmAccount, q.account_id, request.user.id, "Quotation")
        return Response(_quote(q, True))

    def put(self, request, pk):
        b = request.data
        q = services.update_quotation(request.user.id, pk, lines=b.get("lines") or [], valid_until=_date(b.get("valid_until"), "valid_until"), expected_version=b.get("expected_version"))
        return Response(_quote(q, True))


def _q_action(fn, permission="sales.quote.create"):
    class View(APIView):
        def get_permissions(self):
            return perm(permission)

        def post(self, request, pk):
            return Response(_quote(fn(request.user.id, pk)))

    return View


QuotationSend = _q_action(services.send_quotation)
QuotationAccept = _q_action(services.accept_quotation)
QuotationReject = _q_action(services.reject_quotation)


class QuotationConvert(APIView):
    def get_permissions(self):
        return perm("sales.order.create")

    def post(self, request, pk):
        return Response(_order(services.convert_quotation(request.user.id, pk, order_date=_date(request.data.get("order_date"), "order_date")), True), status=201)


# ----------------------------------------------------------------------------- orders
class Orders(APIView):
    def get_permissions(self):
        return perm("sales.order.create" if self.request.method == "POST" else "sales.view")

    def get(self, request):
        qs = _visible(m.SalesOrder.objects.all(), request.user.id)
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _order)

    def post(self, request):
        b = request.data
        from django.utils import timezone

        o = services.create_order(request.user.id, account_id=b.get("account"), currency=b.get("currency", ""), order_date=_date(b.get("order_date"), "order_date") or timezone.now().date(), lines=b.get("lines") or [], opportunity_id=b.get("opportunity"))
        return Response(_order(o, True), status=201)


class OrderDetail(APIView):
    def get_permissions(self):
        return perm("sales.order.create" if self.request.method == "PUT" else "sales.view")

    def get(self, request, pk):
        return Response(_order(_order_for(request, pk), True))

    def put(self, request, pk):
        b = request.data
        return Response(_order(services.update_order(request.user.id, pk, lines=b.get("lines") or [], expected_version=b.get("expected_version")), True))


def _o_action(fn, permission):
    class View(APIView):
        def get_permissions(self):
            return perm(permission)

        def post(self, request, pk):
            return Response(_order(fn(request.user.id, pk)))

    return View


OrderSubmit = _o_action(services.submit_order, "sales.order.create")
OrderApprove = _o_action(services.approve_order, "sales.order.approve")
OrderCancel = _o_action(services.cancel_order, "sales.order.create")


# ----------------------------------------------------------------------------- fulfilment
class OrderDeliver(APIView):
    def get_permissions(self):
        return perm("sales.delivery.manage")

    def post(self, request, pk):
        from django.utils import timezone

        b = request.data
        d = services.create_delivery(request.user.id, pk, location_id=b.get("location"), delivery_date=_date(b.get("delivery_date"), "delivery_date") or timezone.now().date(), lines=b.get("lines") or [], carrier=b.get("carrier", ""), tracking_ref=b.get("tracking_ref", ""))
        return Response({"id": str(d.id), "number": d.number, "order": str(d.order_id), "lines": [{"order_line": str(l.order_line_id), "quantity": str(l.quantity), "unit_cost": str(l.unit_cost)} for l in d.lines.all()]}, status=201)


class OrderInvoice(APIView):
    def get_permissions(self):
        return perm("sales.invoice.create")

    def post(self, request, pk):
        b = request.data
        inv = services.invoice_order(request.user.id, pk, lines=b.get("lines"), invoice_date=_date(b.get("invoice_date"), "invoice_date"))
        return Response(_invoice(inv), status=201)


class OrderReturn(APIView):
    def get_permissions(self):
        return perm("sales.delivery.manage")

    def post(self, request, pk):
        from django.utils import timezone

        b = request.data
        r = services.process_return(request.user.id, pk, location_id=b.get("location"), return_date=_date(b.get("return_date"), "return_date") or timezone.now().date(), reason=b.get("reason", ""), lines=b.get("lines") or [])
        return Response({"id": str(r.id), "number": r.number, "credit_note": _s(r.credit_note_id)}, status=201)


class SalesReport(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request):
        from django.utils import timezone

        q = request.query_params
        today = timezone.now().date()
        return Response(services.sales_report(_date(q.get("from"), "from") or today.replace(day=1), _date(q.get("to"), "to") or today))

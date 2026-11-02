from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm.views import _date, _s
from modules.sales import models as m
from modules.sales import pricing
from modules.sales.views import perm
from shared.api.errors import ValidationFailed


def _profile(p):
    return {"product": str(p.product_id), "is_sellable": p.is_sellable, "is_discontinued": p.is_discontinued, "description": p.description, "min_price": _s(p.min_price), "min_margin_percent": _s(p.min_margin_percent), "max_discount_percent": _s(p.max_discount_percent), "default_tax_rate": _s(p.default_tax_rate_id)}


class Catalog(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request):
        q = request.query_params
        return Response(pricing.catalog(search=q.get("search", ""), category=q.get("category", ""), only_sellable=q.get("all") != "1"))


class ProductProfile(APIView):
    def get_permissions(self):
        return perm("sales.pricelist.manage" if self.request.method == "PUT" else "sales.view")

    def get(self, request, pk):
        p = m.ProductSales.objects.filter(pk=pk).first()
        return Response(_profile(p) if p else {"product": str(pk), "is_sellable": True, "is_discontinued": False})

    def put(self, request, pk):
        b = request.data
        keys = ("is_sellable", "is_discontinued", "description", "min_price", "min_margin_percent", "max_discount_percent")
        kw = {k: b[k] for k in keys if k in b}
        clear = tuple(k for k in ("min_price", "min_margin_percent", "max_discount_percent", "default_tax_rate") if k in b and b[k] is None)
        kw = {k: v for k, v in kw.items() if v is not None}
        return Response(_profile(pricing.set_profile(request.user.id, pk, default_tax_rate_id=b.get("default_tax_rate"), clear=clear, **kw)))


class BundleView(APIView):
    def get_permissions(self):
        return perm("sales.pricelist.manage" if self.request.method == "PUT" else "sales.view")

    def get(self, request, pk):
        b = m.Bundle.objects.filter(product_id=pk).first()
        return Response({"product": str(pk), "items": [{"product": str(i.product_id), "quantity": str(i.quantity)} for i in b.items.all()] if b else []})

    def put(self, request, pk):
        b = pricing.set_bundle(request.user.id, pk, request.data.get("items") or [])
        return Response({"product": str(pk), "items": [{"product": str(i.product_id), "quantity": str(i.quantity)} for i in b.items.all()]})


class Lists(APIView):
    def get_permissions(self):
        return perm("sales.pricelist.manage")

    def post(self, request):
        b = request.data
        pl = pricing.create_list(request.user.id, name=b.get("name", ""), currency=b.get("currency", ""), kind=b.get("kind", "STANDARD"), account_id=b.get("account"), items=b.get("items") or [], valid_from=_date(b.get("valid_from"), "valid_from"), valid_to=_date(b.get("valid_to"), "valid_to"))
        return Response({"id": str(pl.id), "name": pl.name, "kind": pl.kind}, status=201)


class ListItems(APIView):
    def get_permissions(self):
        return perm("sales.pricelist.manage")

    def put(self, request, pk):
        b = request.data
        i = pricing.set_item_price(request.user.id, pk, b.get("product"), b.get("unit_price"), b.get("min_quantity", 1))
        return Response({"product": str(i.product_id), "min_quantity": str(i.min_quantity), "unit_price": str(i.unit_price)})

    def delete(self, request, pk):
        pricing.remove_item(request.user.id, pk, request.query_params.get("product"), request.query_params.get("min_quantity", 1))
        return Response(status=204)


class ListActive(APIView):
    def get_permissions(self):
        return perm("sales.pricelist.manage")

    def post(self, request, pk):
        if "active" not in request.data:
            raise ValidationFailed("active is required.", code="invalid_request")
        pricing.set_list_active(request.user.id, pk, request.data["active"])
        return Response({"id": str(pk), "active": bool(request.data["active"])})


class History(APIView):
    def get_permissions(self):
        return perm("sales.pricelist.manage")

    def get(self, request):
        q = request.query_params
        rows = pricing.price_history(request.user.id, product_id=q.get("product"), price_list_id=q.get("price_list"))
        return Response([{"price_list": str(c.price_list_id), "product": str(c.product_id), "min_quantity": str(c.min_quantity), "old_price": _s(c.old_price), "new_price": _s(c.new_price), "changed_by": _s(c.changed_by), "changed_at": c.changed_at.isoformat()} for c in rows])


class DiscountRules(APIView):
    def get_permissions(self):
        return perm("sales.pricelist.manage" if self.request.method == "PUT" else "sales.view")

    def get(self, request):
        return Response([{"scope": r.scope, "key": r.key, "max_percent": str(r.max_percent), "is_active": r.is_active} for r in m.DiscountRule.objects.order_by("scope", "key")])

    def put(self, request):
        b = request.data
        r = pricing.set_discount_rule(request.user.id, b.get("scope", ""), b.get("key", ""), b.get("max_percent"), b.get("is_active", True))
        return Response({"scope": r.scope, "key": r.key, "max_percent": str(r.max_percent), "is_active": r.is_active})


# ----------------------------------------------------------------------------- quotation extras
from django.http import HttpResponse  # noqa: E402

from modules.sales import quotes  # noqa: E402
from modules.sales.views import _quote  # noqa: E402


class QuoteApprove(APIView):
    def get_permissions(self):
        return perm("sales.order.approve")

    def post(self, request, pk):
        return Response(_quote(quotes.approve(request.user.id, pk)))


class QuoteReturn(APIView):
    def get_permissions(self):
        return perm("sales.order.approve")

    def post(self, request, pk):
        return Response(_quote(quotes.reject_approval(request.user.id, pk, request.data.get("reason", ""))))


class QuoteRevise(APIView):
    def get_permissions(self):
        return perm("sales.quote.create")

    def post(self, request, pk):
        return Response(_quote(quotes.revise(request.user.id, pk, request.data.get("reason", "")), True))


class QuoteRevisions(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request, pk):
        return Response([{"version": r.version, "event": r.event, "created_by": _s(r.created_by), "created_at": r.created_at.isoformat(), "snapshot": r.snapshot} for r in quotes.revisions(request.user.id, pk)])


class QuoteDocument(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request, pk):
        return HttpResponse(quotes.document(request.user.id, pk), content_type="text/html; charset=utf-8")


class QuoteFromOpportunity(APIView):
    def get_permissions(self):
        return perm("sales.quote.create")

    def post(self, request, pk):
        b = request.data
        q = quotes.from_opportunity(request.user.id, pk, valid_until=_date(b.get("valid_until"), "valid_until"), **{k: b.get(k) for k in quotes.TERM_FIELDS})
        return Response(_quote(q, True), status=201)


# ----------------------------------------------------------------------------- order control
from modules.sales import orders_ext  # noqa: E402
from modules.sales.views import _order_for  # noqa: E402


def _amend(a):
    return {"id": str(a.id), "order": str(a.order_id), "status": a.status, "reason": a.reason, "changes": a.changes, "total_before": str(a.total_before), "total_after": _s(a.total_after), "requested_by": str(a.requested_by), "decided_by": _s(a.decided_by), "decision_note": a.decision_note}


class OrderOutstanding(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request, pk):
        return Response(orders_ext.outstanding(_order_for(request, pk)))


class OrderAmendments(APIView):
    def get_permissions(self):
        return perm("sales.order.create" if self.request.method == "POST" else "sales.view")

    def get(self, request, pk):
        return Response([_amend(a) for a in _order_for(request, pk).amendments.order_by("-created_at")])

    def post(self, request, pk):
        b = request.data
        a = orders_ext.request_amendment(request.user.id, pk, quantities=b.get("quantities"), add=b.get("add"), reason=b.get("reason", ""))
        return Response(_amend(a), status=201)


class AmendmentDecision(APIView):
    def get_permissions(self):
        return perm("sales.order.approve")

    def post(self, request, pk, action):
        if action == "approve":
            return Response(_amend(orders_ext.approve_amendment(request.user.id, pk)))
        if action == "reject":
            return Response(_amend(orders_ext.reject_amendment(request.user.id, pk, request.data.get("note", ""))))
        raise ValidationFailed("Unknown action.", code="invalid_action")


class AccountCredit(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request, pk):
        return Response(orders_ext.credit_position(request.user.id, pk))


class Backorders(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request):
        return Response(orders_ext.backorder_report(request.user.id))


class BackorderRetry(APIView):
    def get_permissions(self):
        return perm("sales.delivery.manage")

    def post(self, request):
        return Response({"lines_filled": orders_ext.retry_backorders()})


# ----------------------------------------------------------------------------- contracts
from modules.sales import contracts  # noqa: E402
from modules.sales import models as _m  # noqa: E402,F401
from shared.api.pagination import paginate  # noqa: E402


def _contract(c, detail=False):
    d = {"id": str(c.id), "number": c.number, "account": str(c.account_id), "title": c.title, "status": c.status, "start_date": str(c.start_date), "end_date": str(c.end_date), "currency": c.currency, "committed_value": _s(c.committed_value), "auto_renew": c.auto_renew,
         "renewal_term_months": c.renewal_term_months, "renewal_notice_days": c.renewal_notice_days, "payment_terms": c.payment_terms, "delivery_terms": c.delivery_terms, "terms": c.terms, "version": c.version, "renews": _s(c.renews_id)}
    if detail:
        d["items"] = [{"product": str(i.product_id), "min_quantity": str(i.min_quantity), "unit_price": str(i.unit_price)} for i in c.items.all()]
        d["obligations"] = [{"id": str(o.id), "description": o.description, "due_date": str(o.due_date), "party": o.party, "done": o.done_at is not None} for o in c.obligations.order_by("due_date")]
    return d


_FIELDS = ("title", "start_date", "end_date", "committed_value", "auto_renew", "renewal_term_months", "renewal_notice_days", "payment_terms", "delivery_terms", "terms")


def _contract_kwargs(b):
    kw = {k: b[k] for k in _FIELDS if k in b}
    for k in ("start_date", "end_date"):
        if k in kw:
            kw[k] = _date(kw[k], k)
    return kw


class Contracts(APIView):
    def get_permissions(self):
        return perm("sales.quote.create" if self.request.method == "POST" else "sales.view")

    def get(self, request):
        from modules.crm import services as crm

        qs = crm.scope(_m.SalesContract.objects.all(), request.user.id, owner_field="account__owner_id").order_by("-created_at")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _contract)

    def post(self, request):
        b = request.data
        kw = _contract_kwargs(b)
        c = contracts.create(request.user.id, account_id=b.get("account"), currency=b.get("currency", ""), items=b.get("items") or [], **kw)
        return Response(_contract(c, True), status=201)


class ContractDetail(APIView):
    def get_permissions(self):
        return perm("sales.quote.create" if self.request.method == "PATCH" else "sales.view")

    def get(self, request, pk):
        c = contracts._get(pk)
        contracts._visible(c, request.user.id)
        return Response(_contract(c, True))

    def patch(self, request, pk):
        return Response(_contract(contracts.update(request.user.id, pk, items=request.data.get("items"), **_contract_kwargs(request.data)), True))


class ContractAction(APIView):
    def get_permissions(self):
        return perm("sales.order.approve")

    def post(self, request, pk, action):
        u = request.user.id
        if action == "activate":
            return Response(_contract(contracts.activate(u, pk), True))
        if action == "terminate":
            return Response(_contract(contracts.terminate(u, pk, request.data.get("reason", "")), True))
        if action == "renew":
            return Response(_contract(contracts.renew(u, pk), True), status=201)
        raise ValidationFailed("Unknown action.", code="invalid_action")


class ContractObligations(APIView):
    def get_permissions(self):
        return perm("sales.quote.create")

    def post(self, request, pk):
        b = request.data
        o = contracts.add_obligation(request.user.id, pk, b.get("description", ""), _date(b.get("due_date"), "due_date"), b.get("party", "US"))
        return Response({"id": str(o.id)}, status=201)


class ObligationDone(APIView):
    def get_permissions(self):
        return perm("sales.quote.create")

    def post(self, request, pk):
        o = contracts.complete_obligation(request.user.id, pk)
        return Response({"id": str(o.id), "done": True})


class ContractUtilisation(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request, pk):
        return Response(contracts.utilisation(request.user.id, pk))


class ContractHistory(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request, pk):
        return Response([{"version": r.version, "event": r.event, "created_at": r.created_at.isoformat(), "snapshot": r.snapshot} for r in contracts.history(request.user.id, pk)])

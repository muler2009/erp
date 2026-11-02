"""HTTP endpoints for slices J-O: delivery lifecycle, invoicing extras, returns, commissions, territories, forecasting."""
import base64

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm.views import _date, _s
from modules.sales import dispatch
from modules.sales.views import perm
from shared.api.errors import ValidationFailed


def _b64(b):
    try:
        return base64.b64decode(b.get("content_base64", ""), validate=True)
    except Exception:
        raise ValidationFailed("content_base64 must be valid base64.", code="invalid_file")


def _delivery(d):
    return {"id": str(d.id), "number": d.number, "order": str(d.order_id), "status": d.status, "delivery_date": str(d.delivery_date), "expected_date": _s(d.expected_date), "delivered_at": d.delivered_at.isoformat() if d.delivered_at else None,
            "carrier": d.carrier, "tracking_ref": d.tracking_ref, "received_by": d.received_by, "pod_note": d.pod_note, "failure_reason": d.failure_reason,
            "discrepancies": [{"order_line": str(x.order_line_id), "kind": x.kind, "quantity": str(x.quantity), "note": x.note, "case": _s(x.case_id)} for x in d.discrepancies.all()]}


class DeliveryDetail(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request, pk):
        return Response(_delivery(dispatch.get(request.user.id, pk)))


class DeliveryConfirm(APIView):
    def get_permissions(self):
        return perm("sales.delivery.manage")

    def post(self, request, pk):
        b = request.data
        pod = (b.get("pod_filename", "pod"), _b64({"content_base64": b["pod_content_base64"]})) if b.get("pod_content_base64") else None
        return Response(_delivery(dispatch.confirm_delivered(request.user.id, pk, received_by=b.get("received_by", ""), note=b.get("note", ""), discrepancies=b.get("discrepancies") or [], pod=pod)))


class DeliveryFail(APIView):
    def get_permissions(self):
        return perm("sales.delivery.manage")

    def post(self, request, pk):
        return Response(_delivery(dispatch.mark_failed(request.user.id, pk, request.data.get("reason", ""))))


class DeliveryExpected(APIView):
    def get_permissions(self):
        return perm("sales.delivery.manage")

    def put(self, request, pk):
        return Response(_delivery(dispatch.set_expected(request.user.id, pk, _date(request.data.get("expected_date"), "expected_date"))))


class DeliveryPod(APIView):
    def get_permissions(self):
        return perm("sales.delivery.manage" if self.request.method == "POST" else "sales.view")

    def get(self, request, pk):
        return Response([{"id": str(f.id), "name": f.original_name, "size": f.size} for f in dispatch.attachments(request.user.id, pk)])

    def post(self, request, pk):
        f = dispatch.attach_pod(request.user.id, pk, request.data.get("filename", ""), _b64(request.data))
        return Response({"id": str(f.id), "name": f.original_name}, status=201)


class DeliveryPerformance(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request):
        q = request.query_params
        return Response(dispatch.performance(request.user.id, _date(q.get("from"), "from"), _date(q.get("to"), "to")))


# ----------------------------------------------------------------------------- billing
from modules.sales import billing  # noqa: E402
from modules.sales import models as _sm  # noqa: E402
from modules.sales.views import _invoice, _order_for  # noqa: E402


def _ms(x):
    return {"id": str(x.id), "description": x.description, "percent": str(x.percent), "due_date": _s(x.due_date), "invoice": _s(x.invoice_id)}


class OrderMilestones(APIView):
    def get_permissions(self):
        return perm("sales.invoice.create" if self.request.method == "PUT" else "sales.view")

    def get(self, request, pk):
        return Response([_ms(x) for x in _order_for(request, pk).milestones.order_by("created_at")])

    def put(self, request, pk):
        return Response([_ms(x) for x in billing.set_milestones(request.user.id, pk, request.data.get("milestones") or [])])


class MilestoneInvoice(APIView):
    def get_permissions(self):
        return perm("sales.invoice.create")

    def post(self, request, pk):
        return Response(_invoice(billing.invoice_milestone(request.user.id, pk, _date(request.data.get("invoice_date"), "invoice_date"))), status=201)


class Statement(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request, pk):
        q = request.query_params
        return Response(billing.statement(request.user.id, pk, _date(q.get("from"), "from"), _date(q.get("to"), "to"), q.get("currency")))


class Aging(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request):
        q = request.query_params
        return Response(billing.aging(request.user.id, _date(q.get("as_of"), "as_of"), q.get("currency")))


# ----------------------------------------------------------------------------- return requests
from modules.sales import returns as rt  # noqa: E402
from shared.api.pagination import paginate  # noqa: E402


def _rr(r):
    return {"id": str(r.id), "number": r.number, "order": str(r.order_id), "status": r.status, "reason": r.reason, "reason_code": r.reason_code, "wants_replacement": r.wants_replacement, "requested_by": str(r.requested_by), "decided_by": _s(r.decided_by), "decision_note": r.decision_note,
            "sales_return": _s(r.sales_return_id), "replacement_order": _s(getattr(getattr(r, "replacement_order", None), "id", None)),
            "lines": [{"order_line": str(l.order_line_id), "quantity": str(l.quantity), "disposition": l.disposition} for l in r.lines.all()]}


class ReturnRequests(APIView):
    def get_permissions(self):
        return perm("sales.order.create" if self.request.method == "POST" else "sales.view")

    def get(self, request):
        from modules.crm import services as crm

        qs = crm.scope(_sm.ReturnRequest.objects.all(), request.user.id, owner_field="order__account__owner_id").order_by("-created_at")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _rr)

    def post(self, request):
        b = request.data
        r = rt.request_return(request.user.id, b.get("order"), reason=b.get("reason", ""), reason_code=b.get("reason_code", "OTHER"), lines=b.get("lines") or [], replacement=bool(b.get("replacement")))
        return Response(_rr(r), status=201)


class ReturnRequestDetail(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request, pk):
        return Response(_rr(rt.get(request.user.id, pk)))


class ReturnRequestAction(APIView):
    def get_permissions(self):
        a = self.kwargs.get("action")
        return perm("sales.order.approve" if a in ("approve", "reject") else "sales.delivery.manage" if a == "receive" else "sales.order.create")

    def post(self, request, pk, action):
        u, b = request.user.id, request.data
        if action == "approve":
            return Response(_rr(rt.decide(u, pk, True, b.get("note", ""))))
        if action == "reject":
            return Response(_rr(rt.decide(u, pk, False, b.get("note", ""))))
        if action == "cancel":
            return Response(_rr(rt.cancel(u, pk)))
        if action == "receive":
            from django.utils import timezone

            return Response(_rr(rt.receive(u, pk, location_id=b.get("location"), return_date=_date(b.get("return_date"), "return_date") or timezone.now().date(), quarantine_location_id=b.get("quarantine_location"))))
        raise ValidationFailed("Unknown action.", code="invalid_action")


class ReturnReport(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request):
        q = request.query_params
        return Response(rt.report(request.user.id, _date(q.get("from"), "from"), _date(q.get("to"), "to")))


# ----------------------------------------------------------------------------- targets and commissions
from modules.sales import commissions as cmn  # noqa: E402


def _stmt(x):
    return {"id": str(x.id), "owner_id": str(x.owner_id), "plan": x.plan.name, "period_start": str(x.period_start), "period_end": str(x.period_end), "status": x.status, "sales_amount": str(x.sales_amount), "returns_amount": str(x.returns_amount), "commission": str(x.commission), "details": x.details, "approved_by": _s(x.approved_by), "payroll_input": _s(x.payroll_input_id)}


class Targets(APIView):
    def get_permissions(self):
        return perm("crm.assign" if self.request.method == "PUT" else "crm.view")

    def put(self, request):
        b = request.data
        t = cmn.set_target(request.user.id, b.get("owner_id"), _date(b.get("period_start"), "period_start"), _date(b.get("period_end"), "period_end"), b.get("amount"))
        return Response({"id": str(t.id), "owner_id": str(t.owner_id), "amount": str(t.amount)})

    def get(self, request):
        q = request.query_params
        start, end = _date(q.get("from"), "from"), _date(q.get("to"), "to")
        owner = q.get("owner") or str(request.user.id)
        return Response(cmn.attainment(request.user.id, __import__("uuid").UUID(owner), start, end))


class TeamAttainment(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def get(self, request):
        q = request.query_params
        return Response(cmn.team_attainment(request.user.id, _date(q.get("from"), "from"), _date(q.get("to"), "to")))


class CommissionPlans(APIView):
    def get_permissions(self):
        return perm("crm.assign" if self.request.method == "POST" else "crm.view")

    def get(self, request):
        return Response([{"id": str(p.id), "name": p.name, "tiers": p.tiers, "category_rates": p.category_rates, "is_active": p.is_active} for p in _sm.CommissionPlan.objects.order_by("name")])

    def post(self, request):
        b = request.data
        p = cmn.create_plan(request.user.id, b.get("name", ""), b.get("tiers") or [], b.get("category_rates"), b.get("is_active", True))
        return Response({"id": str(p.id), "name": p.name}, status=201)


class PlanAssign(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def put(self, request):
        a = cmn.assign_plan(request.user.id, request.data.get("owner_id"), request.data.get("plan"))
        return Response({"owner_id": str(a.owner_id), "plan": str(a.plan_id)})


class CommissionStatements(APIView):
    def get_permissions(self):
        return perm("crm.assign" if self.request.method == "POST" else "crm.view")

    def get(self, request):
        return paginate(request, cmn.statements(request.user.id, request.query_params.get("owner")), _stmt)

    def post(self, request):
        b = request.data
        return Response(_stmt(cmn.calculate(request.user.id, b.get("owner_id"), _date(b.get("period_start"), "period_start"), _date(b.get("period_end"), "period_end"))), status=201)


class CommissionAction(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def post(self, request, pk, action):
        u = request.user.id
        if action == "approve":
            return Response(_stmt(cmn.approve(u, pk)))
        if action == "transfer":
            st, inp = cmn.transfer_to_payroll(u, pk, _date(request.data.get("month"), "month"))
            return Response(_stmt(st))
        if action == "cancel":
            cmn.cancel(u, pk)
            return Response({"id": str(pk), "status": "CANCELLED"})
        raise ValidationFailed("Unknown action.", code="invalid_action")


# ----------------------------------------------------------------------------- analytics
from modules.sales import analytics as an  # noqa: E402


class AnalyticsPerformance(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request):
        q = request.query_params
        return Response(an.performance(request.user.id, _date(q.get("from"), "from"), _date(q.get("to"), "to")))


class AnalyticsBacklog(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request):
        return Response(an.backlog(request.user.id))


class AnalyticsForecast(APIView):
    def get_permissions(self):
        return perm("sales.view")

    def get(self, request):
        try:
            months = int(request.query_params.get("months", 3))
        except ValueError:
            raise ValidationFailed("months must be a whole number.", code="invalid_months")
        return Response(an.forecast(request.user.id, months=months))

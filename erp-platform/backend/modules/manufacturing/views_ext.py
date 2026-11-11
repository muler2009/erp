from datetime import date, datetime

from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.manufacturing import analytics as an
from modules.manufacturing import bom as bs
from modules.manufacturing import execution as ex
from modules.manufacturing import models as m
from modules.manufacturing import orders as os_
from modules.manufacturing import plans as pl
from modules.manufacturing.views import _d, _order, perm
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def _dt(v):
    if not v:
        return None
    r = parse_datetime(v)
    if r is None:
        raise ValidationFailed("Timestamps must be ISO 8601.", code="invalid_date")
    return r


def _order_of(pk):
    return _order(m.ProductionOrder.objects.select_related("product").get(pk=pk), True)


def _range(request):
    a, b = _d(request.query_params.get("from")), _d(request.query_params.get("to"))
    if not a or not b or b < a:
        raise ValidationFailed("from and to (YYYY-MM-DD) are required.", code="invalid_date")
    return a, b


def _plan(p, detail=False):
    d = {"id": str(p.id), "number": p.number, "name": p.name, "period_start": str(p.period_start), "period_end": str(p.period_end), "status": p.status, "revision": p.revision, "created_by": str(p.created_by), "approved_by": None if p.approved_by is None else str(p.approved_by)}
    if detail:
        d["lines"] = [{"id": str(x.id), "product": str(x.product_id), "sku": x.product.sku, "quantity": str(x.quantity), "required_date": str(x.required_date), "priority": x.priority, "order": None if x.order_id is None else str(x.order_id)} for x in p.lines.select_related("product")]
        d["revisions"] = [{"revision": r.revision, "changed_by": str(r.changed_by), "reason": r.reason, "lines": r.snapshot} for r in p.revisions.order_by("revision")]
    return d


def _simple(name, permission, fn):
    """POST /orders/<pk>/<action>: fn(request, pk) does the work; the order is returned."""
    class V(APIView):
        def get_permissions(self):
            return perm(permission)

        def post(self, request, pk):
            fn(request, pk)
            return Response(_order_of(pk))
    V.__name__ = name
    return V


OrderApprove = _simple("OrderApprove", "manufacturing.order.approve", lambda r, pk: os_.approve_order(r.user.id, pk))
OrderHold = _simple("OrderHold", "manufacturing.order.manage", lambda r, pk: os_.hold_order(r.user.id, pk, reason=r.data.get("reason", "")))
OrderResume = _simple("OrderResume", "manufacturing.order.manage", lambda r, pk: os_.resume_order(r.user.id, pk))
OrderPriority = _simple("OrderPriority", "manufacturing.order.manage", lambda r, pk: os_.set_priority(r.user.id, pk, r.data.get("priority", 3)))
OrderReschedule = _simple("OrderReschedule", "manufacturing.order.manage", lambda r, pk: os_.reschedule_order(r.user.id, pk, _d(r.data.get("start"))))
ReworkFinish = _simple("ReworkFinish", "manufacturing.order.manage", lambda r, pk: ex.finish_rework(r.user.id, pk))
ReworkTime = _simple("ReworkTime", "manufacturing.order.manage", lambda r, pk: ex.book_time(r.user.id, pk, work_center_id=r.data.get("work_center"), hours=r.data.get("hours")))
ByproductRecord = _simple("ByproductRecord", "manufacturing.order.manage", lambda r, pk: ex.record_byproduct(r.user.id, pk, product_id=r.data.get("product"), quantity=r.data.get("quantity"), unit_cost=r.data.get("unit_cost", 0), kind=r.data.get("kind", "BYPRODUCT"), decision=r.data.get("decision", "REUSE"), lot_code=r.data.get("lot_code")))


def _op_action(name, permission, fn):
    class V(APIView):
        def get_permissions(self):
            return perm(permission)

        def post(self, request, pk, op_id):
            fn(request, pk, op_id)
            return Response(_order_of(pk))
    V.__name__ = name
    return V


OperationPause = _op_action("OperationPause", "manufacturing.order.manage", lambda r, pk, op: ex.pause_operation(r.user.id, pk, op, reason=r.data.get("reason", "")))
OperationResume = _op_action("OperationResume", "manufacturing.order.manage", lambda r, pk, op: ex.resume_operation(r.user.id, pk, op))
OperationApprove = _op_action("OperationApprove", "manufacturing.operation.approve", lambda r, pk, op: ex.approve_operation(r.user.id, pk, op))


class ReceiptDispose(APIView):
    def get_permissions(self):
        return perm("manufacturing.disposition.approve")

    def post(self, request, receipt_id):
        b = request.data
        r = ex.dispose_receipt(request.user.id, receipt_id, decision=b.get("decision"), note=b.get("note", ""), release_location_id=b.get("release_location"))
        if isinstance(r, m.ProductionOrder):
            return Response({"decision": "REWORK", "rework_order": _order(r, True)})
        return Response({"id": str(r.id), "status": r.status})


class Lines(APIView):
    def get_permissions(self):
        return perm("manufacturing.master.manage" if self.request.method == "POST" else "manufacturing.view")

    def get(self, request):
        return paginate(request, m.ProductionLine.objects.all(), lambda x: {"id": str(x.id), "code": x.code, "name": x.name, "facility": x.facility}, ordering="code")

    def post(self, request):
        x = bs.create_line(request.user.id, code=request.data.get("code"), name=request.data.get("name"), facility=request.data.get("facility", ""))
        return Response({"id": str(x.id), "code": x.code}, status=201)


class ItemProfile(APIView):
    def get_permissions(self):
        return perm("manufacturing.master.manage")

    def put(self, request, product_id):
        b = request.data
        r = bs.set_item_profile(request.user.id, product_id, supply_type=b.get("supply_type", "MANUFACTURED"), drawing_ref=b.get("drawing_ref", ""), method=b.get("method", ""))
        return Response({"product": str(r.product_id), "supply_type": r.supply_type})


class Plans(APIView):
    def get_permissions(self):
        return perm("manufacturing.plan.manage" if self.request.method == "POST" else "manufacturing.view")

    def get(self, request):
        return paginate(request, m.ProductionPlan.objects.all(), _plan)

    def post(self, request):
        b = request.data
        lines = [{**ln, "required_date": _d(ln.get("required_date"))} for ln in b.get("lines") or []]
        return Response(_plan(pl.create_plan(request.user.id, name=b.get("name"), period_start=_d(b.get("period_start")), period_end=_d(b.get("period_end")), lines=lines), True), status=201)


class PlanDetail(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request, pk):
        p = m.ProductionPlan.objects.filter(pk=pk).first()
        if p is None:
            raise DomainError("Plan not found.", code="not_found", status_code=404)
        return Response(_plan(p, True))


class PlanRevise(APIView):
    def get_permissions(self):
        return perm("manufacturing.plan.manage")

    def post(self, request, pk):
        lines = [{**ln, "required_date": _d(ln.get("required_date"))} for ln in request.data.get("lines") or []]
        return Response(_plan(pl.revise_plan(request.user.id, pk, lines=lines, reason=request.data.get("reason", "")), True))


class PlanCheck(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request, pk):
        p = m.ProductionPlan.objects.filter(pk=pk).first()
        if p is None:
            raise DomainError("Plan not found.", code="not_found", status_code=404)
        return Response(pl.check_plan(p))


class PlanApprove(APIView):
    def get_permissions(self):
        return perm("manufacturing.plan.approve")

    def post(self, request, pk):
        return Response(_plan(pl.approve_plan(request.user.id, pk), True))


class PlanRelease(APIView):
    def get_permissions(self):
        return perm("manufacturing.plan.approve")

    def post(self, request, pk):
        orders = pl.release_plan(request.user.id, pk, location_id=request.data.get("location"))
        return Response([_order(o) for o in orders], status=201)


class PlanCancel(APIView):
    def get_permissions(self):
        return perm("manufacturing.plan.manage")

    def post(self, request, pk):
        return Response(_plan(pl.cancel_plan(request.user.id, pk, reason=request.data.get("reason", ""))))


class PlanSuggest(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request):
        return Response(pl.suggest_lines(*_range(request)))


class Conflicts(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request):
        return Response(pl.conflicts(*_range(request)))


class Downtimes(APIView):
    def get_permissions(self):
        return perm("manufacturing.downtime.manage" if self.request.method == "POST" else "manufacturing.view")

    def get(self, request):
        return paginate(request, m.Downtime.objects.select_related("work_center"), lambda d: {"id": str(d.id), "work_center": d.work_center.code, "category": d.category, "reason": d.reason, "started_at": str(d.started_at), "ended_at": None if d.ended_at is None else str(d.ended_at), "minutes": d.minutes, "breakdown_id": None if d.breakdown_id is None else str(d.breakdown_id)}, ordering="-started_at")

    def post(self, request):
        b = request.data
        d = ex.record_downtime(request.user.id, work_center_id=b.get("work_center"), category=b.get("category"), reason=b.get("reason", ""), started_at=_dt(b.get("started_at")) or datetime.now().astimezone(), ended_at=_dt(b.get("ended_at")), order_id=b.get("order"))
        return Response({"id": str(d.id)}, status=201)


class DowntimeEnd(APIView):
    def get_permissions(self):
        return perm("manufacturing.downtime.manage")

    def post(self, request, pk):
        d = ex.end_downtime(request.user.id, pk, _dt(request.data.get("ended_at")))
        return Response({"id": str(d.id), "minutes": d.minutes})


class MaintenanceRequest(APIView):
    def get_permissions(self):
        return perm("manufacturing.downtime.manage")

    def post(self, request):
        b = request.data
        d, bd = ex.request_maintenance(request.user.id, work_center_id=b.get("work_center"), symptoms=b.get("symptoms", ""), severity=b.get("severity", "MEDIUM"), order_id=b.get("order"))
        return Response({"downtime": str(d.id), "breakdown": str(bd.id), "affected_orders": [o.number for o in ex.affected_orders(d.work_center_id)]}, status=201)


REPORTS = {"plan-vs-actual": an.plan_vs_actual, "order-status": an.order_status, "output": an.output, "efficiency": an.efficiency, "utilization": an.utilization, "downtime": an.downtime, "consumption": an.consumption,
           "scrap": an.scrap, "rework": an.rework, "quality-rejection": an.quality_rejection, "cost": an.cost_report, "by-line": an.by_line, "labor-productivity": an.labor_productivity, "on-time": an.on_time, "oee": an.oee, "bottlenecks": an.capacity_bottlenecks}


class Report(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request, name):
        fn = REPORTS.get(name)
        if fn is None:
            raise DomainError("Unknown report.", code="not_found", status_code=404)
        return Response(fn(*_range(request)))


class WipAging(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request):
        return Response(an.wip_aging())

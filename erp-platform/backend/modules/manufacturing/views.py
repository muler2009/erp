from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.manufacturing import bom as bs
from modules.manufacturing import models as m
from modules.manufacturing import mrp, orders as os_, reports
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def perm(code):
    return [require(code)()]


def _d(v):
    try:
        return date.fromisoformat(v) if v else None
    except ValueError:
        raise ValidationFailed("Dates must be YYYY-MM-DD.", code="invalid_date")


def _s(v):
    return None if v is None else str(v)


def _wc(w):
    return {"id": str(w.id), "code": w.code, "name": w.name, "capacity_hours_per_day": str(w.capacity_hours_per_day), "labor_rate": str(w.labor_rate), "machine_rate": str(w.machine_rate), "overhead_rate": str(w.overhead_rate), "efficiency_percent": str(w.efficiency_percent), "is_active": w.is_active}


def _bom(b, detail=False):
    d = {"id": str(b.id), "product": str(b.product_id), "sku": b.product.sku, "version": b.version, "name": b.name, "quantity": str(b.quantity), "status": b.status, "created_by": str(b.created_by), "approved_by": _s(b.approved_by)}
    if detail:
        d["lines"] = [{"component": str(x.component_id), "sku": x.component.sku, "quantity": str(x.quantity), "scrap_percent": str(x.scrap_percent), "substitutes": [{"product": str(y.product_id), "ratio": str(y.ratio)} for y in x.substitutes.all()]} for x in b.lines.select_related("component")]
        d["steps"] = [{"sequence": s.sequence, "name": s.name, "work_center": str(s.work_center_id), "setup_hours": str(s.setup_hours), "run_hours": str(s.run_hours)} for s in b.steps.all()]
        d["checks"] = [{"name": c.name, "step_sequence": c.step_sequence, "specification": c.specification, "lower_limit": _s(c.lower_limit), "upper_limit": _s(c.upper_limit)} for c in b.checks.all()]
        d["standard_cost"] = str(bs.standard_cost(b))
        d["effective_from"], d["effective_to"] = (str(b.effective_from) if b.effective_from else None), (str(b.effective_to) if b.effective_to else None)
        d["byproducts"] = [{"product": str(x.product_id), "quantity": str(x.quantity)} for x in b.byproducts.all()]
    return d


def _order(o, detail=False):
    d = {"id": str(o.id), "number": o.number, "product": str(o.product_id), "sku": o.product.sku, "bom": str(o.bom_id), "quantity": str(o.quantity), "status": o.status, "planned_start": str(o.planned_start), "planned_end": str(o.planned_end),
         "produced_quantity": str(o.produced_quantity), "scrapped_quantity": str(o.scrapped_quantity), "standard_unit_cost": str(o.standard_unit_cost), "sales_order_id": _s(o.sales_order_id), "created_by": str(o.created_by)}
    if detail:
        d["components"] = [{"id": str(c.id), "product": str(c.product_id), "sku": c.product.sku, "required": str(c.required_quantity), "issued": str(c.issued_quantity), "returned": str(c.returned_quantity)} for c in o.components.select_related("product")]
        d["operations"] = [{"id": str(x.id), "sequence": x.sequence, "name": x.name, "work_center": x.work_center.code, "status": x.status, "planned_hours": str(x.planned_hours), "actual_hours": str(x.actual_hours), "planned_start": _s(x.planned_start), "planned_end": _s(x.planned_end)} for x in o.operations.select_related("work_center")]
        d["checks"] = [{"id": str(c.id), "name": c.name, "step_sequence": c.step_sequence, "result": c.result, "specification": c.specification} for c in o.checks.all()]
        d["receipts"] = [{"quantity": str(r.quantity), "unit_cost": str(r.unit_cost), "lot_code": r.lot_code} for r in o.receipts.all()]
    return d


class WorkCenters(APIView):
    def get_permissions(self):
        return perm("manufacturing.master.manage" if self.request.method == "POST" else "manufacturing.view")

    def get(self, request):
        return paginate(request, m.WorkCenter.objects.all(), _wc, ordering="code")

    def post(self, request):
        b = request.data
        return Response(_wc(bs.create_work_center(request.user.id, code=b.get("code"), name=b.get("name"), capacity_hours_per_day=b.get("capacity_hours_per_day", 8), labor_rate=b.get("labor_rate", 0), machine_rate=b.get("machine_rate", 0), overhead_rate=b.get("overhead_rate", 0), efficiency_percent=b.get("efficiency_percent", 100), line_id=b.get("line"), asset_id=b.get("asset"), working_days=b.get("working_days"))), status=201)


class WorkCenterDetail(APIView):
    def get_permissions(self):
        return perm("manufacturing.master.manage")

    def patch(self, request, pk):
        return Response(_wc(bs.update_work_center(request.user.id, pk, **request.data)))


class Boms(APIView):
    def get_permissions(self):
        return perm("manufacturing.master.manage" if self.request.method == "POST" else "manufacturing.view")

    def get(self, request):
        qs = m.Bom.objects.select_related("product")
        for k in ("status", "product"):
            if request.query_params.get(k):
                qs = qs.filter(**{k: request.query_params[k]})
        return paginate(request, qs, _bom)

    def post(self, request):
        b = request.data
        return Response(_bom(bs.create_bom(request.user.id, product_id=b.get("product"), lines=b.get("lines") or [], steps=b.get("steps"), checks=b.get("checks"), quantity=b.get("quantity", 1), name=b.get("name", ""), byproducts=b.get("byproducts"), effective_from=_d(b.get("effective_from")), effective_to=_d(b.get("effective_to"))), True), status=201)


class BomDetail(APIView):
    def get_permissions(self):
        return perm("manufacturing.master.manage" if self.request.method == "PATCH" else "manufacturing.view")

    def get(self, request, pk):
        b = m.Bom.objects.select_related("product").filter(pk=pk).first()
        if b is None:
            raise DomainError("Bill of materials not found.", code="not_found", status_code=404)
        return Response(_bom(b, True))

    def patch(self, request, pk):
        b = request.data
        return Response(_bom(bs.update_bom(request.user.id, pk, lines=b.get("lines"), steps=b.get("steps"), checks=b.get("checks"), quantity=b.get("quantity"), name=b.get("name")), True))


class BomApprove(APIView):
    def get_permissions(self):
        return perm("manufacturing.bom.approve")

    def post(self, request, pk):
        return Response(_bom(bs.approve_bom(request.user.id, pk)))


class BomRevise(APIView):
    def get_permissions(self):
        return perm("manufacturing.master.manage")

    def post(self, request, pk):
        return Response(_bom(bs.revise_bom(request.user.id, pk), True), status=201)


class BomArchive(APIView):
    def get_permissions(self):
        return perm("manufacturing.master.manage")

    def post(self, request, pk):
        return Response(_bom(bs.archive_bom(request.user.id, pk)))


class BomExplosion(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request, product_id):
        return Response({"requirements": bs.explode(product_id, request.query_params.get("quantity", 1)), "where_used": bs.where_used(product_id)})


class Orders(APIView):
    def get_permissions(self):
        return perm("manufacturing.order.manage" if self.request.method == "POST" else "manufacturing.view")

    def get(self, request):
        qs = m.ProductionOrder.objects.select_related("product")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _order)

    def post(self, request):
        b = request.data
        o = os_.create_order(request.user.id, product_id=b.get("product"), quantity=b.get("quantity"), location_id=b.get("location"), planned_start=_d(b.get("planned_start")), planned_end=_d(b.get("planned_end")), sales_order_id=b.get("sales_order"), parent_order_id=b.get("parent_order"))
        return Response(_order(o, True), status=201)


class OrderDetail(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request, pk):
        o = m.ProductionOrder.objects.select_related("product").filter(pk=pk).first()
        if o is None:
            raise DomainError("Production order not found.", code="not_found", status_code=404)
        d = _order(o, True)
        d["availability"] = os_.availability(o)
        return Response(d)


def _action(name, permission, fn):
    class V(APIView):
        def get_permissions(self):
            return perm(permission)

        def post(self, request, pk):
            return Response(_order(fn(request, pk), True))
    V.__name__ = name
    return V


OrderRelease = _action("OrderRelease", "manufacturing.order.manage", lambda r, pk: os_.release_order(r.user.id, pk))
OrderCancel = _action("OrderCancel", "manufacturing.order.manage", lambda r, pk: os_.cancel_order(r.user.id, pk))
OrderIssueAll = _action("OrderIssueAll", "manufacturing.order.manage", lambda r, pk: os_.issue_all(r.user.id, pk))
OrderComplete = _action("OrderComplete", "manufacturing.order.manage", lambda r, pk: os_.complete_short(r.user.id, pk))
OrderClose = _action("OrderClose", "manufacturing.order.close", lambda r, pk: os_.close_order(r.user.id, pk))


class OrderIssue(APIView):
    def get_permissions(self):
        return perm("manufacturing.order.manage")

    def post(self, request, pk):
        b = request.data
        os_.issue_material(request.user.id, pk, product_id=b.get("product"), quantity=b.get("quantity"), lot_code=b.get("lot_code"), serials=b.get("serials"), substitute_for=b.get("substitute_for"), additional=bool(b.get("additional")))
        return Response(_order(m.ProductionOrder.objects.get(pk=pk), True))


class OrderReturn(APIView):
    def get_permissions(self):
        return perm("manufacturing.order.manage")

    def post(self, request, pk):
        b = request.data
        os_.return_material(request.user.id, pk, product_id=b.get("product"), quantity=b.get("quantity"), lot_code=b.get("lot_code"))
        return Response(_order(m.ProductionOrder.objects.get(pk=pk), True))


class OperationStart(APIView):
    def get_permissions(self):
        return perm("manufacturing.order.manage")

    def post(self, request, pk, op_id):
        os_.start_operation(request.user.id, pk, op_id, operator_id=request.data.get("operator"), supervisor_id=request.data.get("supervisor"))
        return Response(_order(m.ProductionOrder.objects.get(pk=pk), True))


class OperationComplete(APIView):
    def get_permissions(self):
        return perm("manufacturing.order.manage")

    def post(self, request, pk, op_id):
        b = request.data
        os_.complete_operation(request.user.id, pk, op_id, hours=b.get("hours", 0), machine_hours=b.get("machine_hours"), good=b.get("good"), defective=b.get("defective", 0), rework=b.get("rework", 0), notes=b.get("notes", ""))
        return Response(_order(m.ProductionOrder.objects.get(pk=pk), True))


class CheckRecord(APIView):
    def get_permissions(self):
        return perm("manufacturing.quality.check")

    def post(self, request, pk, check_id):
        b = request.data
        os_.record_check(request.user.id, pk, check_id, result=b.get("result"), measured=b.get("measured", ""), note=b.get("note", ""))
        return Response(_order(m.ProductionOrder.objects.get(pk=pk), True))


class OrderScrap(APIView):
    def get_permissions(self):
        return perm("manufacturing.order.manage")

    def post(self, request, pk):
        b = request.data
        os_.report_scrap(request.user.id, pk, kind=b.get("kind"), quantity=b.get("quantity"), reason=b.get("reason", ""), product_id=b.get("product"))
        return Response(_order(m.ProductionOrder.objects.get(pk=pk), True), status=201)


class OrderReceive(APIView):
    def get_permissions(self):
        return perm("manufacturing.order.manage")

    def post(self, request, pk):
        b = request.data
        os_.receive_output(request.user.id, pk, quantity=b.get("quantity"), lot_code=b.get("lot_code"), serials=b.get("serials"), expiry_date=_d(b.get("expiry_date")), quarantine_location_id=b.get("quarantine_location"))
        return Response(_order(m.ProductionOrder.objects.get(pk=pk), True), status=201)


class OrderCost(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request, pk):
        o = m.ProductionOrder.objects.filter(pk=pk).first()
        if o is None:
            raise DomainError("Production order not found.", code="not_found", status_code=404)
        return Response(reports.cost_analysis(o))


class WipReport(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request):
        return Response(reports.wip())


class LoadReport(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request):
        a, b = _d(request.query_params.get("from")), _d(request.query_params.get("to"))
        if not a or not b or b < a:
            raise ValidationFailed("from and to (YYYY-MM-DD) are required.", code="invalid_date")
        return Response(reports.work_center_load(a, b))


class ScheduleReport(APIView):
    def get_permissions(self):
        return perm("manufacturing.view")

    def get(self, request):
        return Response(reports.schedule())


class MrpPreview(APIView):
    """What-if: net a list of demands [{product, quantity, date}] without writing anything."""
    def get_permissions(self):
        return perm("manufacturing.view")

    def post(self, request):
        today = date.today()
        dem = [(d["product"], d["quantity"], _d(d.get("date")) or today) for d in request.data.get("demands", [])]
        out = mrp.plan(dem, today)
        return Response([{**s, "quantity": str(s["quantity"]), "need_by": str(s["need_by"]), "start_by": str(s["start_by"])} for s in out])

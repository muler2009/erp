from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.assets import maintenance as mt
from modules.assets import models as m
from modules.assets.views import _d, _s, perm
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def _plan(p):
    return {"id": str(p.id), "asset": str(p.asset_id), "name": p.name, "kind": p.kind, "trigger": p.trigger, "interval_days": p.interval_days, "interval_usage": _s(p.interval_usage), "lead_days": p.lead_days, "next_due_on": _s(p.next_due_on), "next_due_meter": _s(p.next_due_meter), "last_done_on": _s(p.last_done_on), "is_active": p.is_active, "estimated_cost": str(p.estimated_cost)}


def _wo(w):
    return {"id": str(w.id), "number": w.number, "asset": {"id": str(w.asset_id), "number": w.asset.number}, "kind": w.kind, "status": w.status, "priority": w.priority, "description": w.description, "scheduled_on": _s(w.scheduled_on), "due_on": _s(w.due_on), "assigned_to_id": _s(w.assigned_to_id), "provider_supplier_id": _s(w.provider_supplier_id),
            "estimated_cost": str(w.estimated_cost), "labor_hours": str(w.labor_hours), "labor_cost": str(w.labor_cost), "material_cost": str(w.material_cost), "external_cost": str(w.external_cost), "total_cost": str(w.total_cost), "breakdown_id": _s(w.breakdown_id), "plan_id": _s(w.plan_id),
            "requested_by": str(w.requested_by), "approved_by": _s(w.approved_by), "completed_by": _s(w.completed_by), "verified_by": _s(w.verified_by), "completed_on": _s(w.completed_on),
            "materials": [{"product_id": _s(x.product_id), "description": x.description, "quantity": str(x.quantity), "unit_cost": str(x.unit_cost)} for x in w.materials.all()]}


def _bd(b):
    return {"id": str(b.id), "number": b.number, "asset": {"id": str(b.asset_id), "number": b.asset.number}, "reported_at": b.reported_at.isoformat(), "symptoms": b.symptoms, "cause": b.cause, "failure_code": b.failure_code, "severity": b.severity, "status": b.status, "restored_at": None if not b.restored_at else b.restored_at.isoformat(), "downtime_hours": _s(b.downtime_hours)}


class Meter(APIView):
    def get_permissions(self):
        return perm("assets.maintenance.manage")

    def post(self, request, pk):
        b = request.data
        a = mt.record_meter(request.user.id, pk, b.get("reading"), _d(b.get("read_on")) or date.today())
        return Response({"asset": a.number, "meter_reading": str(a.meter_reading)}, status=201)


class Plans(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.maintenance.manage")

    def get(self, request):
        qs = m.MaintenancePlan.objects.all()
        if request.query_params.get("asset"):
            qs = qs.filter(asset_id=request.query_params["asset"])
        return paginate(request, qs, _plan)

    def post(self, request):
        b = dict(request.data)
        p = mt.create_plan(request.user.id, b.pop("asset", None), name=b.pop("name", ""), first_due_on=_d(b.pop("first_due_on", None)), **{k: v for k, v in b.items() if k in ("trigger", "kind", "interval_days", "interval_usage", "lead_days", "lead_usage", "checklist", "estimated_cost", "assigned_to_id", "provider_supplier_id")})
        return Response(_plan(p), status=201)


class WorkOrders(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.maintenance.manage")

    def get(self, request):
        qs = m.WorkOrder.objects.select_related("asset").prefetch_related("materials")
        for k in ("status", "kind"):
            if request.query_params.get(k):
                qs = qs.filter(**{k: request.query_params[k]})
        if request.query_params.get("asset"):
            qs = qs.filter(asset_id=request.query_params["asset"])
        return paginate(request, qs, _wo)

    def post(self, request):
        b = request.data
        w = mt.create_work_order(request.user.id, b.get("asset"), kind=b.get("kind", "CORRECTIVE"), description=b.get("description", ""), scheduled_on=_d(b.get("scheduled_on")), due_on=_d(b.get("due_on")), estimated_cost=b.get("estimated_cost", 0), priority=b.get("priority", "MEDIUM"), assigned_to_id=b.get("assigned_to_id"), provider_supplier_id=b.get("provider_supplier_id"))
        return Response(_wo(m.WorkOrder.objects.select_related("asset").get(pk=w.pk)), status=201)


class WorkOrderAction(APIView):
    def get_permissions(self):
        a = self.kwargs.get("action")
        if a in ("approve", "reject"):
            return perm("assets.maintenance.approve")
        return perm("assets.maintenance.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "approve":
            mt.approve_work_order(uid, pk, approve=True)
        elif action == "reject":
            mt.approve_work_order(uid, pk, approve=False, note=b.get("note", ""))
        elif action == "assign":
            mt.assign(uid, pk, assigned_to_id=b.get("assigned_to_id"), provider_supplier_id=b.get("provider_supplier_id"), scheduled_on=_d(b.get("scheduled_on")))
        elif action == "start":
            mt.start(uid, pk)
        elif action == "labor":
            mt.add_labor(uid, pk, hours=b.get("hours"), rate=b.get("rate"))
        elif action == "material":
            mt.add_material(uid, pk, product_id=b.get("product_id"), location_id=b.get("location_id"), quantity=b.get("quantity"), lot_code=b.get("lot_code"))
        elif action == "external-cost":
            mt.add_external_cost(uid, pk, amount=b.get("amount"), invoice_id=b.get("invoice_id"), description=b.get("description", ""))
        elif action == "complete":
            mt.complete(uid, pk, notes=b.get("notes", ""), completed_on=_d(b.get("completed_on")))
        elif action == "verify":
            mt.verify_return_to_service(uid, pk, notes=b.get("notes", ""), passed=bool(b.get("passed", True)))
        elif action == "cancel":
            mt.cancel_work_order(uid, pk, reason=b.get("reason", ""))
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_wo(m.WorkOrder.objects.select_related("asset").prefetch_related("materials").get(pk=pk)))


class Breakdowns(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.breakdown.report")

    def get(self, request):
        qs = m.Breakdown.objects.select_related("asset")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _bd)

    def post(self, request):
        b = request.data
        r = mt.report_breakdown(request.user.id, b.get("asset"), symptoms=b.get("symptoms", ""), severity=b.get("severity", "MEDIUM"), failure_code=b.get("failure_code", ""))
        return Response(_bd(m.Breakdown.objects.select_related("asset").get(pk=r.pk)), status=201)


class BreakdownAction(APIView):
    def get_permissions(self):
        return perm("assets.maintenance.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "diagnose":
            mt.diagnose(uid, pk, cause=b.get("cause", ""), failure_code=b.get("failure_code", ""))
        elif action == "repair":
            w = mt.open_repair(uid, pk, description=b.get("description", ""), estimated_cost=b.get("estimated_cost", 0), assigned_to_id=b.get("assigned_to_id"), provider_supplier_id=b.get("provider_supplier_id"))
            return Response(_wo(m.WorkOrder.objects.select_related("asset").prefetch_related("materials").get(pk=w.pk)), status=201)
        elif action == "close":
            mt.close_breakdown(uid, pk)
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_bd(m.Breakdown.objects.select_related("asset").get(pk=pk)))


class MaintenanceReports(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request, report):
        q = request.query_params
        if report == "unavailable":
            return Response(mt.unavailable_assets())
        if report == "schedule":
            return Response(mt.schedule(int(q.get("days", 30))))
        f, t = _d(q.get("from")), _d(q.get("to"))
        if not (f and t):
            raise ValidationFailed("from and to are required (YYYY-MM-DD).", code="period_required")
        if report == "costs":
            return Response(mt.maintenance_costs(f, t, q.get("group_by", "asset")))
        if report == "breakdowns":
            return Response(mt.breakdown_analysis(f, t))
        raise DomainError("Unknown report.", code="not_found", status_code=404)

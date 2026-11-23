"""Phase 8b supply chain endpoints: demand, supply plans, risk, fleet, coordination and performance reports."""
from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.supply_chain import coordination as co
from modules.supply_chain import demand as dm
from modules.supply_chain import fleet as fl
from modules.supply_chain import models as m
from modules.supply_chain import performance as pf
from modules.supply_chain import planning as pl
from modules.supply_chain import risk as rk
from modules.supply_chain.views import _d, _s, _sg, perm
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def _range(request):
    a, b = _d(request.query_params.get("from")), _d(request.query_params.get("to"))
    today = date.today()
    return a or today.replace(day=1), b or today


def _demand(d):
    return {"id": str(d.id), "product": str(d.product_id), "sku": d.product.sku, "warehouse": _s(d.warehouse_id), "source": d.source, "source_ref": d.source_ref, "customer": d.customer, "kind": d.kind, "quantity": str(d.quantity), "required_date": str(d.required_date),
            "priority": d.priority, "status": d.status, "revision": d.revision, "approved_by": _s(d.approved_by), "cancel_reason": d.cancel_reason}


def _risk(r):
    return {"id": str(r.id), "number": r.number, "category": r.category, "title": r.title, "description": r.description, "supplier": _s(r.supplier_id), "product": _s(r.product_id), "likelihood": r.likelihood, "impact": r.impact, "score": r.score,
            "financial_impact": str(r.financial_impact), "status": r.status, "owner": str(r.owner_id)}


def _act(a):
    return {"id": str(a.id), "risk": str(a.risk_id), "description": a.description, "owner": str(a.owner_id), "due_date": str(a.due_date), "status": a.status}


def _dis(d):
    return {"id": str(d.id), "category": d.category, "title": d.title, "cause": d.cause, "started_on": str(d.started_on), "ended_on": _s(d.ended_on), "status": d.status, "resolution": d.resolution, "financial_impact": str(d.financial_impact)}


def _veh(v):
    return {"id": str(v.id), "code": v.code, "plate": v.plate, "vehicle_type": v.vehicle_type, "capacity_kg": str(v.capacity_kg), "capacity_m3": str(v.capacity_m3), "carrier": _s(v.carrier_id), "is_active": v.is_active}


def _plan(p, detail=False):
    d = {"id": str(p.id), "number": p.number, "plan_date": str(p.plan_date), "status": p.status, "revision": p.revision, "created_by": str(p.created_by), "approved_by": _s(p.approved_by)}
    if detail:
        d["balance"] = p.balance
        d["suggestions"] = [_sg(x) for x in p.suggestions.select_related("product").order_by("start_by")]
        d["changes"] = [{"revision": c.revision, "suggestion": str(c.suggestion_id), "field": c.field, "old": c.old_value, "new": c.new_value, "reason": c.reason, "by": str(c.changed_by), "at": str(c.changed_at)} for c in p.changes.all()]
    return d


def _policy(self):
    return perm((self.write or self.read) if self.request.method not in ("GET", "HEAD", "OPTIONS") else self.read)


class _V(APIView):
    """Reads need supply_chain.view, writes the permission named in `write`. Every subclass gets its own explicit get_permissions
    (the authorization contract test requires each routed view to declare one)."""
    read, write = "supply_chain.view", None

    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        cls.get_permissions = _policy


class Demands(_V):
    write = "supply_chain.demand.manage"

    def get(self, request):
        qs = m.Demand.objects.select_related("product")
        for k in ("status", "source", "kind", "product"):
            v = request.query_params.get(k)
            if v:
                qs = qs.filter(**{k + ("_id" if k == "product" else ""): v})
        return paginate(request, qs, _demand, ordering="required_date")

    def post(self, request):
        b = request.data
        return Response(_demand(dm.create_demand(request.user.id, product_id=b.get("product"), quantity=b.get("quantity"), required_date=_d(b.get("required_date"), True), source=b.get("source"), source_ref=b.get("source_ref", ""),
                                                 customer=b.get("customer", ""), kind=b.get("kind", "CONFIRMED"), priority=b.get("priority", 3), warehouse_id=b.get("warehouse"))), status=201)


class DemandDetail(_V):
    write = "supply_chain.demand.manage"

    def get(self, request, pk):
        d = m.Demand.objects.filter(pk=pk).first()
        if d is None:
            raise DomainError("Demand not found.", code="not_found", status_code=404)
        out = _demand(d)
        out["revisions"] = [{"revision": r.revision, "old_quantity": str(r.old_quantity), "old_required_date": str(r.old_required_date), "old_priority": r.old_priority, "reason": r.reason, "by": str(r.changed_by), "at": str(r.changed_at)} for r in d.revisions.order_by("revision")]
        return Response(out)

    def patch(self, request, pk):
        b = request.data
        return Response(_demand(dm.revise_demand(request.user.id, pk, reason=b.get("reason", ""), quantity=b.get("quantity"), required_date=_d(b.get("required_date")), priority=b.get("priority"))))


class DemandApprove(_V):
    write = "supply_chain.plan.approve"

    def post(self, request, pk):
        return Response(_demand(dm.approve_demand(request.user.id, pk)))


class DemandCancel(_V):
    write = "supply_chain.demand.manage"

    def post(self, request, pk):
        return Response(_demand(dm.cancel_demand(request.user.id, pk, reason=request.data.get("reason", ""))))


class DemandImpact(_V):
    def get(self, request, pk):
        return Response(dm.impact(pk, date.today()))


class DemandConsolidated(_V):
    def get(self, request):
        a, b = _d(request.query_params.get("from"), True), _d(request.query_params.get("to"), True)
        return Response(dm.consolidated(a, b))


class SupplyPlans(_V):
    def get(self, request):
        return paginate(request, m.SupplyPlan.objects.all(), _plan, ordering="-created_at")


class SupplyPlanDetail(_V):
    def get(self, request, pk):
        p = m.SupplyPlan.objects.filter(pk=pk).first()
        if p is None:
            raise DomainError("Supply plan not found.", code="not_found", status_code=404)
        return Response(_plan(p, True))


class SupplyPlanApprove(_V):
    write = "supply_chain.plan.approve"

    def post(self, request, pk):
        return Response(_plan(pl.approve_supply_plan(request.user.id, pk), True))


class SuggestionAdjust(_V):
    write = "supply_chain.plan.manage"

    def post(self, request, pk):
        b = request.data
        return Response(_sg(pl.adjust_suggestion(request.user.id, pk, quantity=b.get("quantity"), need_by=_d(b.get("need_by")), reason=b.get("reason", ""))))


class Risks(_V):
    write = "supply_chain.risk.manage"

    def get(self, request):
        qs = m.SupplyRisk.objects.all()
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _risk, ordering="-created_at")

    def post(self, request):
        b = request.data
        return Response(_risk(rk.create_risk(request.user.id, category=b.get("category"), title=b.get("title"), likelihood=b.get("likelihood", 0), impact=b.get("impact", 0), owner_id=b.get("owner"), description=b.get("description", ""),
                                             supplier_id=b.get("supplier"), product_id=b.get("product"), financial_impact=b.get("financial_impact", 0))), status=201)


class RiskDetail(_V):
    write = "supply_chain.risk.manage"

    def get(self, request, pk):
        r = m.SupplyRisk.objects.filter(pk=pk).first()
        if r is None:
            raise DomainError("Risk not found.", code="not_found", status_code=404)
        return Response({**_risk(r), "actions": [_act(a) for a in r.actions.order_by("due_date")], "disruptions": [_dis(x) for x in r.disruptions.all()]})

    def patch(self, request, pk):
        b = request.data
        return Response(_risk(rk.update_risk(request.user.id, pk, status=b.get("status"), likelihood=b.get("likelihood"), impact=b.get("impact"), owner_id=b.get("owner"))))


class RiskActions(_V):
    write = "supply_chain.risk.manage"

    def post(self, request, pk):
        b = request.data
        return Response(_act(rk.add_action(request.user.id, pk, description=b.get("description", ""), owner_id=b.get("owner"), due_date=_d(b.get("due_date"), True))), status=201)


class ActionComplete(_V):
    write = "supply_chain.risk.manage"

    def post(self, request, pk):
        return Response(_act(rk.complete_action(request.user.id, pk)))


class Disruptions(_V):
    write = "supply_chain.risk.manage"

    def get(self, request):
        a, b = _d(request.query_params.get("from")) or date(2000, 1, 1), _d(request.query_params.get("to")) or date.today()
        return Response(rk.incident_history(a, b))

    def post(self, request):
        b = request.data
        return Response(_dis(rk.record_disruption(request.user.id, category=b.get("category"), title=b.get("title"), cause=b.get("cause"), started_on=_d(b.get("started_on"), True), supplier_id=b.get("supplier"), product_id=b.get("product"),
                                                  shipment_id=b.get("shipment"), risk_id=b.get("risk"), operational_impact=b.get("operational_impact", ""), financial_impact=b.get("financial_impact", 0))), status=201)


class DisruptionResolve(_V):
    write = "supply_chain.risk.manage"

    def post(self, request, pk):
        return Response(_dis(rk.resolve_disruption(request.user.id, pk, resolution=request.data.get("resolution", ""), ended_on=_d(request.data.get("ended_on")))))


class CriticalMaterials(_V):
    write = "supply_chain.risk.manage"

    def get(self, request):
        return Response(rk.critical_materials_report())

    def post(self, request):
        b = request.data
        c = rk.mark_critical(request.user.id, b.get("product"), reason=b.get("reason", ""), min_sources=b.get("min_sources", 2))
        return Response({"product": str(c.product_id), "reason": c.reason, "min_sources": c.min_sources}, status=201)


class AlternativeSources(_V):
    write = "supply_chain.risk.manage"

    def post(self, request):
        b = request.data
        a = rk.add_alternative(request.user.id, product_id=b.get("product"), supplier_id=b.get("supplier"), rank=b.get("rank", 1), lead_time_days=b.get("lead_time_days", 0), notes=b.get("notes", ""))
        return Response({"id": str(a.id), "product": str(a.product_id), "supplier": str(a.supplier_id), "rank": a.rank}, status=201)


class Vehicles(_V):
    write = "supply_chain.logistics.manage"

    def get(self, request):
        return paginate(request, m.Vehicle.objects.all(), _veh, ordering="code")

    def post(self, request):
        b = request.data
        return Response(_veh(fl.create_vehicle(request.user.id, code=b.get("code"), plate=b.get("plate", ""), vehicle_type=b.get("vehicle_type", ""), capacity_kg=b.get("capacity_kg", 0), capacity_m3=b.get("capacity_m3", 0), carrier_id=b.get("carrier"))), status=201)


class VehicleDetail(_V):
    write = "supply_chain.logistics.manage"

    def patch(self, request, pk):
        return Response(_veh(fl.update_vehicle(request.user.id, pk, **{k: v for k, v in request.data.items() if k in ("plate", "vehicle_type", "capacity_kg", "capacity_m3", "is_active")})))


class ShipmentVehicle(_V):
    write = "supply_chain.logistics.manage"

    def post(self, request, pk):
        s = fl.assign_vehicle(request.user.id, pk, request.data.get("vehicle"))
        return Response({"id": str(s.id), "number": s.number, "vehicle": _s(s.vehicle_ref_id), "carrier": _s(s.carrier_id)})


class ShipmentConsolidate(_V):
    write = "supply_chain.logistics.manage"

    def post(self, request, pk):
        ids = request.data.get("shipments")
        if not isinstance(ids, list):
            raise ValidationFailed("shipments must be a list.", code="invalid_fields")
        p = fl.consolidate(request.user.id, pk, ids)
        return Response({"id": str(p.id), "number": p.number, "consolidated": [c.number for c in p.consolidated_from.all()]})


class ShipmentUnconsolidate(_V):
    write = "supply_chain.logistics.manage"

    def post(self, request, pk):
        k = fl.unconsolidate(request.user.id, pk)
        return Response({"id": str(k.id), "number": k.number})


REPORTS = {
    "dashboard": lambda r, a, b: pf.dashboard(date.today(), a, b),
    "fulfilment-risk": lambda r, a, b: pf.fulfilment_risk(date.today()),
    "backorders": lambda r, a, b: pf.backorders(),
    "inventory-turnover": lambda r, a, b: pf.inventory_turnover(a, b),
    "fulfilment-rate": lambda r, a, b: pf.fulfilment_rate(a, b),
    "supply-cost": lambda r, a, b: pf.supply_cost_analysis(a, b),
    "vehicle-utilisation": lambda r, a, b: fl.vehicle_utilisation(a, b),
    "stock-health": lambda r, a, b: co.stock_health(date.today()),
    "shortages": lambda r, a, b: co.shortages(),
    "transfer-recommendations": lambda r, a, b: co.transfer_recommendations(),
    "stock-in-transit": lambda r, a, b: co.stock_in_transit(),
    "warehouse-capacity": lambda r, a, b: co.warehouse_capacity(),
    "procurement-status": lambda r, a, b: co.procurement_status(date.today()),
    "supply-risks": lambda r, a, b: rk.detect_supply_risks(date.today()),
    "risk-register": lambda r, a, b: rk.risk_report(),
    "single-source": lambda r, a, b: rk.single_source_products(),
    "incidents": lambda r, a, b: rk.incident_history(a, b),
}


class Analytics(_V):
    def get(self, request, name):
        fn = REPORTS.get(name)
        if fn is None:
            raise DomainError("Unknown report.", code="not_found", status_code=404)
        a, b = _range(request)
        return Response(fn(request, a, b))


class AvailabilityByWarehouse(_V):
    def get(self, request, pk):
        return Response(co.availability_by_warehouse(pk))

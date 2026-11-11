from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.supply_chain import delivery as dv
from modules.supply_chain import logistics as lg
from modules.supply_chain import models as m
from modules.supply_chain import planning as pl
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def perm(code):
    return [require(code)()]


def _d(v, required=False):
    try:
        if not v:
            if required:
                raise ValueError
            return None
        return date.fromisoformat(v)
    except ValueError:
        raise ValidationFailed("Dates must be YYYY-MM-DD.", code="invalid_date")


def _s(v):
    return None if v is None else str(v)


def _carrier(c):
    return {"id": str(c.id), "code": c.code, "name": c.name, "mode": c.mode, "contact": c.contact, "is_active": c.is_active}


def _route(r):
    return {"id": str(r.id), "code": r.code, "name": r.name, "origin": r.origin, "destination": r.destination, "distance_km": str(r.distance_km), "transit_days": r.transit_days, "carrier": _s(r.carrier_id), "is_active": r.is_active}


def _ship(s, detail=False):
    d = {"id": str(s.id), "number": s.number, "kind": s.kind, "status": s.status, "carrier": _s(s.carrier_id), "route": _s(s.route_id), "origin": s.origin, "destination": s.destination, "planned_dispatch": str(s.planned_dispatch), "planned_arrival": str(s.planned_arrival),
         "actual_dispatch": _s(s.actual_dispatch), "actual_arrival": _s(s.actual_arrival), "tracking_ref": s.tracking_ref, "weight_kg": str(s.weight_kg), "sales_delivery_id": _s(s.sales_delivery_id), "purchase_order_id": _s(s.purchase_order_id), "transfer_order_id": _s(s.transfer_order_id), "vehicle_ref": _s(s.vehicle_ref_id), "consolidated_into": _s(s.consolidated_into_id), "pod_received_by": s.pod_received_by, "pod_at": _s(s.pod_at), "pod_file": _s(s.pod_file_id)}
    if detail:
        d["lines"] = [{"product": _s(x.product_id), "description": x.description, "quantity": str(x.quantity), "received": _s(x.received_quantity), "damaged": str(x.damaged_quantity), "discrepancy_note": x.discrepancy_note} for x in s.lines.all()]
        d["events"] = [{"status": e.status, "location": e.location, "note": e.note, "at": str(e.occurred_at)} for e in s.events.order_by("occurred_at", "id")]
        d["costs"] = [{"type": c.cost_type, "amount": str(c.amount), "description": c.description} for c in s.costs.all()]
        d["exceptions"] = [_exc(x) for x in s.exceptions.all()]
    return d


def _exc(x):
    return {"id": str(x.id), "shipment": str(x.shipment_id), "kind": x.kind, "severity": x.severity, "description": x.description, "status": x.status, "resolution": x.resolution, "auto_detected": x.auto_detected}


def _fc(f):
    return {"id": str(f.id), "product": str(f.product_id), "period_start": str(f.period_start), "quantity": str(f.quantity), "method": f.method, "status": f.status}


def _sg(s):
    return {"id": str(s.id), "product": str(s.product_id), "sku": s.product.sku, "action": s.action, "quantity": str(s.quantity), "need_by": str(s.need_by), "start_by": str(s.start_by), "lead_days": s.lead_days, "supplier_id": _s(s.supplier_id), "status": s.status, "note": s.note, "converted_ref_type": s.converted_ref_type, "converted_ref_id": _s(s.converted_ref_id)}


def _range(request):
    a, b = _d(request.query_params.get("from"), True), _d(request.query_params.get("to"), True)
    if b < a:
        raise ValidationFailed("to cannot be before from.", code="invalid_date")
    return a, b


class Carriers(APIView):
    def get_permissions(self):
        return perm("supply_chain.logistics.manage" if self.request.method == "POST" else "supply_chain.view")

    def get(self, request):
        return paginate(request, m.Carrier.objects.all(), _carrier, ordering="code")

    def post(self, request):
        b = request.data
        return Response(_carrier(lg.create_carrier(request.user.id, code=b.get("code"), name=b.get("name"), mode=b.get("mode", "ROAD"), contact=b.get("contact", ""))), status=201)


class CarrierDetail(APIView):
    def get_permissions(self):
        return perm("supply_chain.logistics.manage")

    def patch(self, request, pk):
        return Response(_carrier(lg.update_carrier(request.user.id, pk, **{k: request.data.get(k) for k in ("name", "mode", "contact", "is_active")})))


class Routes(APIView):
    def get_permissions(self):
        return perm("supply_chain.logistics.manage" if self.request.method == "POST" else "supply_chain.view")

    def get(self, request):
        return paginate(request, m.Route.objects.all(), _route, ordering="code")

    def post(self, request):
        b = request.data
        return Response(_route(lg.create_route(request.user.id, code=b.get("code"), name=b.get("name"), origin=b.get("origin"), destination=b.get("destination"), distance_km=b.get("distance_km", 0), transit_days=b.get("transit_days", 1), carrier_id=b.get("carrier"))), status=201)


class Shipments(APIView):
    def get_permissions(self):
        return perm("supply_chain.logistics.manage" if self.request.method == "POST" else "supply_chain.view")

    def get(self, request):
        qs = m.Shipment.objects.all()
        for k in ("status", "kind"):
            if request.query_params.get(k):
                qs = qs.filter(**{k: request.query_params[k]})
        return paginate(request, qs, _ship)

    def post(self, request):
        b = request.data
        s = lg.create_shipment(request.user.id, kind=b.get("kind"), origin=b.get("origin"), destination=b.get("destination"), planned_dispatch=_d(b.get("planned_dispatch"), True), planned_arrival=_d(b.get("planned_arrival")), carrier_id=b.get("carrier"), route_id=b.get("route"),
                               lines=b.get("lines"), weight_kg=b.get("weight_kg", 0), volume_m3=b.get("volume_m3", 0), tracking_ref=b.get("tracking_ref", ""), vehicle=b.get("vehicle", ""), driver=b.get("driver", ""), sales_delivery_id=b.get("sales_delivery"), purchase_order_id=b.get("purchase_order"), transfer_order_id=b.get("transfer_order"))
        return Response(_ship(s, True), status=201)


class ShipmentDetail(APIView):
    def get_permissions(self):
        return perm("supply_chain.view")

    def get(self, request, pk):
        s = m.Shipment.objects.filter(pk=pk).first()
        if s is None:
            raise DomainError("Shipment not found.", code="not_found", status_code=404)
        return Response(_ship(s, True))


def _sh_action(name, fn):
    class V(APIView):
        def get_permissions(self):
            return perm("supply_chain.logistics.manage")

        def post(self, request, pk):
            fn(request, pk)
            return Response(_ship(m.Shipment.objects.get(pk=pk), True))
    V.__name__ = name
    return V


ShipmentDispatch = _sh_action("ShipmentDispatch", lambda r, pk: lg.dispatch(r.user.id, pk, location=r.data.get("location", ""), note=r.data.get("note", "")))
ShipmentTrack = _sh_action("ShipmentTrack", lambda r, pk: lg.add_tracking(r.user.id, pk, location=r.data.get("location"), note=r.data.get("note", "")))
ShipmentDeliver = _sh_action("ShipmentDeliver", lambda r, pk: lg.deliver(r.user.id, pk, received_by=r.data.get("received_by", ""), note=r.data.get("note", ""), pod_file_id=r.data.get("pod_file"), lines=r.data.get("lines")))
ShipmentCancel = _sh_action("ShipmentCancel", lambda r, pk: lg.cancel(r.user.id, pk, reason=r.data.get("reason", "")))
ShipmentCost = _sh_action("ShipmentCost", lambda r, pk: lg.add_cost(r.user.id, pk, cost_type=r.data.get("cost_type"), amount=r.data.get("amount"), description=r.data.get("description", "")))
ShipmentException = _sh_action("ShipmentException", lambda r, pk: lg.report_exception(r.user.id, pk, kind=r.data.get("kind"), description=r.data.get("description", ""), severity=r.data.get("severity", "MEDIUM")))


class Exceptions(APIView):
    def get_permissions(self):
        return perm("supply_chain.view")

    def get(self, request):
        return paginate(request, lg.open_exceptions(), _exc)


class ExceptionResolve(APIView):
    def get_permissions(self):
        return perm("supply_chain.logistics.manage")

    def post(self, request, pk):
        return Response(_exc(lg.resolve_exception(request.user.id, pk, resolution=request.data.get("resolution", ""))))


class CostReport(APIView):
    def get_permissions(self):
        return perm("supply_chain.view")

    def get(self, request):
        return Response(lg.cost_report(*_range(request)))


class CarrierPerformance(APIView):
    def get_permissions(self):
        return perm("supply_chain.view")

    def get(self, request):
        return Response(lg.carrier_performance(*_range(request)))


class SupplierDelivery(APIView):
    def get_permissions(self):
        return perm("supply_chain.view")

    def get(self, request):
        a, b = _range(request)
        return Response({"suppliers": dv.supplier_delivery_performance(a, b), "lead_time_suggestions": dv.lead_time_suggestions(a, b)})


class Fulfilment(APIView):
    def get_permissions(self):
        return perm("supply_chain.view")

    def get(self, request):
        return Response(dv.fulfillment_board())


class Forecasts(APIView):
    def get_permissions(self):
        return perm("supply_chain.plan.manage" if self.request.method == "POST" else "supply_chain.view")

    def get(self, request):
        qs = m.DemandForecast.objects.all()
        if request.query_params.get("product"):
            qs = qs.filter(product_id=request.query_params["product"])
        return paginate(request, qs, _fc, ordering="period_start")

    def post(self, request):
        b = request.data
        return Response(_fc(pl.set_forecast(request.user.id, product_id=b.get("product"), period_start=_d(b.get("period_start"), True), quantity=b.get("quantity"))), status=201)


class ForecastGenerate(APIView):
    def get_permissions(self):
        return perm("supply_chain.plan.manage")

    def post(self, request):
        made = pl.generate_from_history(request.user.id, product_ids=request.data.get("products"))
        return Response([_fc(f) for f in made], status=201)


class ForecastApprove(APIView):
    def get_permissions(self):
        return perm("supply_chain.plan.approve")

    def post(self, request, pk):
        return Response(_fc(pl.approve_forecast(request.user.id, pk)))


class ForecastRevoke(APIView):
    def get_permissions(self):
        return perm("supply_chain.plan.approve")

    def post(self, request, pk):
        return Response(_fc(pl.revoke_forecast(request.user.id, pk)))


class ForecastAccuracy(APIView):
    def get_permissions(self):
        return perm("supply_chain.view")

    def get(self, request):
        return Response(pl.forecast_accuracy(int(request.query_params.get("months", 3)), date.today()))


class ReplenishmentRun(APIView):
    def get_permissions(self):
        return perm("supply_chain.plan.manage")

    def post(self, request):
        run, rows = pl.run_replenishment(request.user.id)
        return Response({"run": str(run), "suggestions": [_sg(r) for r in rows]}, status=201)


class Suggestions(APIView):
    def get_permissions(self):
        return perm("supply_chain.view")

    def get(self, request):
        return paginate(request, m.ReplenishmentSuggestion.objects.select_related("product").filter(status=request.query_params.get("status", "OPEN")), _sg, ordering="start_by")


class SuggestionConvert(APIView):
    def get_permissions(self):
        return perm("supply_chain.plan.manage")

    def post(self, request, pk):
        return Response(_sg(pl.convert(request.user.id, pk, location_id=request.data.get("location"))))


class SuggestionDismiss(APIView):
    def get_permissions(self):
        return perm("supply_chain.plan.manage")

    def post(self, request, pk):
        return Response(_sg(pl.dismiss(request.user.id, pk, note=request.data.get("note", ""))))

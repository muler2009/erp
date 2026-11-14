from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.assets import allocation as al
from modules.assets import fleet as fl
from modules.assets import models as m
from modules.assets.views import _d, _s, perm
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def _al(r):
    return {"id": str(r.id), "asset": {"id": str(r.asset_id), "number": r.asset.number}, "target_kind": r.target_kind, "target_id": str(r.target_id), "start_on": str(r.start_on), "end_on": _s(r.end_on), "share_percent": str(r.share_percent), "status": r.status}


def _veh(v):
    return {"id": str(v.id), "asset": {"id": str(v.asset_id), "number": v.asset.number}, "plate_number": v.plate_number, "vin": v.vin, "fuel_type": v.fuel_type, "registration_expiry": _s(v.registration_expiry), "driver_id": _s(v.driver_id), "driver_license_expiry": _s(v.driver_license_expiry), "odometer": str(v.asset.meter_reading)}


def _period(q):
    f, t = _d(q.get("from")), _d(q.get("to"))
    if not (f and t):
        raise ValidationFailed("from and to are required (YYYY-MM-DD).", code="period_required")
    return f, t


class Allocations(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.custody.manage")

    def get(self, request):
        q = request.query_params
        return paginate(request, al.allocations_for(q.get("asset"), q.get("target"), _d(q.get("on"))), _al, ordering="start_on")

    def post(self, request):
        b = request.data
        r = al.allocate(request.user.id, b.get("asset"), target_kind=b.get("target_kind"), target_id=b.get("target_id"), start_on=_d(b.get("start_on")) or date.today(), end_on=_d(b.get("end_on")), share_percent=b.get("share_percent", 100), notes=b.get("notes", ""))
        return Response(_al(m.AssetAllocation.objects.select_related("asset").get(pk=r.pk)), status=201)


class AllocationAction(APIView):
    def get_permissions(self):
        return perm("assets.custody.manage")

    def post(self, request, pk, action):
        if action != "end":
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        al.end_allocation(request.user.id, pk, _d(request.data.get("ended_on")) or date.today())
        return Response(_al(m.AssetAllocation.objects.select_related("asset").get(pk=pk)))


class Usage(APIView):
    def get_permissions(self):
        return perm("assets.custody.manage")

    def post(self, request, pk):
        b = request.data
        u = al.log_usage(request.user.id, pk, logged_on=_d(b.get("logged_on")) or date.today(), hours=b.get("hours"), allocation_id=b.get("allocation"))
        return Response({"id": str(u.id), "hours": str(u.hours)}, status=201)


class UtilizationReports(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request, report):
        f, t = _period(request.query_params)
        if report == "utilization":
            return Response(al.utilization_report(f, t, daily_hours=request.query_params.get("daily_hours", 8), underused_below=request.query_params.get("below", 20)))
        if report == "project-usage":
            return Response(al.project_usage(f, t))
        if report == "fleet-costs":
            return Response(fl.fleet_cost_report(f, t))
        raise DomainError("Unknown report.", code="not_found", status_code=404)


class Vehicles(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.fleet.manage")

    def get(self, request):
        return paginate(request, m.Vehicle.objects.select_related("asset"), _veh)

    def post(self, request):
        b = request.data
        v = fl.register_vehicle(request.user.id, b.get("asset"), plate_number=b.get("plate_number", ""), vin=b.get("vin", ""), fuel_type=b.get("fuel_type", "DIESEL"), registration_expiry=_d(b.get("registration_expiry")), driver_license_expiry=_d(b.get("driver_license_expiry")))
        return Response(_veh(m.Vehicle.objects.select_related("asset").get(pk=v.pk)), status=201)


class VehicleAction(APIView):
    def get_permissions(self):
        return perm("assets.fleet.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "driver":
            fl.assign_driver(uid, pk, b.get("driver_id"), _d(b.get("license_expiry")))
        elif action == "renew-registration":
            fl.renew_registration(uid, pk, _d(b.get("expiry")))
        elif action == "fuel":
            r = fl.log_fuel(uid, pk, filled_on=_d(b.get("filled_on")) or date.today(), liters=b.get("liters"), cost=b.get("cost"), odometer=b.get("odometer"))
            return Response({"id": str(r.id)}, status=201)
        elif action == "incidents":
            r = fl.report_incident(uid, pk, occurred_on=_d(b.get("occurred_on")) or date.today(), description=b.get("description", ""), severity=b.get("severity", "MINOR"), driver_id=b.get("driver_id"), damage_cost=b.get("damage_cost", 0))
            return Response({"id": str(r.id)}, status=201)
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_veh(m.Vehicle.objects.select_related("asset").get(pk=pk)))


class VehicleInfo(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request, pk, what):
        if what == "fuel-efficiency":
            return Response(fl.fuel_efficiency(pk))
        if what == "incidents":
            rows = m.VehicleIncident.objects.filter(vehicle_id=pk).order_by("-occurred_on", "-created_at")
            return Response({"results": [{"id": str(i.id), "occurred_on": str(i.occurred_on), "description": i.description, "severity": i.severity, "damage_cost": str(i.damage_cost), "status": i.status, "driver_id": _s(i.driver_id)} for i in rows]})
        raise DomainError("Unknown resource.", code="not_found", status_code=404)


class IncidentClose(APIView):
    def get_permissions(self):
        return perm("assets.fleet.manage")

    def post(self, request, pk):
        return Response({"status": fl.close_incident(request.user.id, pk).status})


class FleetExpiries(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        return Response(fl.expiries(int(request.query_params.get("days", 30))))

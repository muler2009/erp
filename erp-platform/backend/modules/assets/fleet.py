"""Vehicles and fleet: registration, drivers, odometer and fuel, incidents, expiry alerts and cost per kilometre."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.assets import maintenance as mt
from modules.assets import models as m
from modules.assets import services as svc
from modules.assets import warranty as wt
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify

ZERO = Decimal("0")
FUELS = ("PETROL", "DIESEL", "ELECTRIC", "HYBRID")
SEVERITIES = ("MINOR", "MAJOR", "TOTAL_LOSS")


def _vehicle(pk, lock=False):
    qs = m.Vehicle.objects.select_for_update(of=("self",)) if lock else m.Vehicle.objects
    v = qs.select_related("asset").filter(pk=pk).first()
    if v is None:
        raise DomainError("Vehicle not found.", code="not_found", status_code=404)
    return v


@transaction.atomic
def register_vehicle(actor_id, asset_id, *, plate_number, vin="", fuel_type="DIESEL", registration_expiry=None, driver_license_expiry=None):
    a = svc._get(asset_id)
    if a.asset_class != "VEHICLE":
        raise ValidationFailed("Only an asset of class VEHICLE can be registered as a vehicle.", code="not_a_vehicle")
    plate = (plate_number or "").strip().upper()
    if not plate:
        raise ValidationFailed("The plate number is required.", code="plate_required")
    if fuel_type not in FUELS:
        raise ValidationFailed("Unknown fuel type.", code="invalid_fuel")
    if m.Vehicle.objects.filter(asset=a).exists() or m.Vehicle.objects.filter(plate_number=plate).exists():
        raise DomainError("This vehicle or plate number is already registered.", code="duplicate_code")
    a.meter_unit = a.meter_unit or "km"
    a.save(update_fields=["meter_unit", "updated_at"])
    v = m.Vehicle.objects.create(asset=a, plate_number=plate, vin=vin[:40], fuel_type=fuel_type, registration_expiry=registration_expiry, driver_license_expiry=driver_license_expiry)
    svc.log(a, "VEHICLE_REGISTERED", actor_id=actor_id, plate=plate)
    return v


@transaction.atomic
def renew_registration(actor_id, vehicle_id, new_expiry):
    v = _vehicle(vehicle_id, lock=True)
    if v.registration_expiry and new_expiry <= v.registration_expiry:
        raise ValidationFailed("The new expiry must be later than the current one.", code="invalid_dates")
    v.registration_expiry, v.last_reminder_on = new_expiry, None
    v.save()
    svc.log(v.asset, "REGISTRATION_RENEWED", actor_id=actor_id, until=new_expiry)
    return v


@transaction.atomic
def assign_driver(actor_id, vehicle_id, driver_id, license_expiry, on=None):
    v = _vehicle(vehicle_id, lock=True)
    on = on or timezone.now().date()
    if v.asset.status in ("DISPOSED", "RETIRED"):
        raise DomainError("This vehicle is no longer in service.", code="asset_not_allocatable")
    if driver_id:
        from modules.hr.models import Employee

        if not Employee.objects.filter(pk=driver_id).exists():
            raise ValidationFailed("Unknown employee.", code="invalid_driver")
        if not license_expiry or license_expiry < on:
            raise DomainError("The driver's licence must be valid to assign a vehicle.", code="licence_expired")
    v.driver_id, v.driver_license_expiry = driver_id or None, license_expiry if driver_id else None
    v.save()
    svc.log(v.asset, "DRIVER_ASSIGNED", actor_id=actor_id, driver=driver_id)
    return v


@transaction.atomic
def log_fuel(actor_id, vehicle_id, *, filled_on, liters, cost, odometer):
    v = _vehicle(vehicle_id, lock=True)
    lit, c, odo = svc._dec(liters, "liters"), svc._dec(cost, "cost"), svc._dec(odometer, "odometer")
    if lit <= 0 or c < 0:
        raise ValidationFailed("Litres must be positive and cost cannot be negative.", code="invalid_amount")
    if v.fuel_type == "ELECTRIC":
        raise DomainError("An electric vehicle has no fuel log; record charging as a cost instead.", code="invalid_fuel")
    mt.record_meter(actor_id, v.asset_id, odo, filled_on)  # one monotonic odometer for the whole fleet
    return m.FuelLog.objects.create(vehicle=v, filled_on=filled_on, liters=lit, cost=c, odometer=odo, recorded_by=actor_id)


@transaction.atomic
def report_incident(actor_id, vehicle_id, *, occurred_on, description, severity="MINOR", driver_id=None, damage_cost=0):
    v = _vehicle(vehicle_id, lock=True)
    if severity not in SEVERITIES:
        raise ValidationFailed("Severity must be MINOR, MAJOR or TOTAL_LOSS.", code="invalid_severity")
    if not (description or "").strip():
        raise ValidationFailed("Describe the incident.", code="description_required")
    i = m.VehicleIncident.objects.create(vehicle=v, occurred_on=occurred_on, description=description, severity=severity, driver_id=driver_id or v.driver_id, damage_cost=svc._dec(damage_cost, "damage_cost"), reported_by=actor_id)
    svc.log(v.asset, "INCIDENT", actor_id=actor_id, severity=severity)
    if severity != "MINOR":
        notify(mt._staff_user_ids(), "assets.vehicle_incident", f"{severity} incident: {v.plate_number}", description[:200], ref_type="assets.vehicle", ref_id=str(v.id))
    return i


@transaction.atomic
def close_incident(actor_id, incident_id):
    i = m.VehicleIncident.objects.select_for_update(of=("self",)).filter(pk=incident_id).first()
    if i is None:
        raise DomainError("Incident not found.", code="not_found", status_code=404)
    if i.status != "OPEN":
        raise DomainError("Already closed.", code="invalid_state")
    i.status = "CLOSED"
    i.save(update_fields=["status", "updated_at"])
    return i


def fuel_efficiency(vehicle_id):
    """km per litre between consecutive fills: litres bought at a fill fuel the distance driven since the previous one."""
    logs = list(m.FuelLog.objects.filter(vehicle_id=vehicle_id).order_by("odometer"))
    out = []
    for prev, cur in zip(logs, logs[1:]):
        km = cur.odometer - prev.odometer
        out.append({"filled_on": str(cur.filled_on), "km": str(km), "liters": str(cur.liters), "km_per_liter": str((km / cur.liters).quantize(Decimal("0.01")))})
    return out


def fleet_cost_report(date_from, date_to):
    rows = []
    for v in m.Vehicle.objects.select_related("asset").order_by("plate_number"):
        fuel = m.FuelLog.objects.filter(vehicle=v, filled_on__range=(date_from, date_to)).aggregate(c=Sum("cost"), l=Sum("liters"))
        wo = m.WorkOrder.objects.filter(asset=v.asset, status="VERIFIED", completed_on__range=(date_from, date_to))
        maint = sum((w.total_cost for w in wo), ZERO)
        fuel_cost = fuel["c"] or ZERO
        odos = list(m.MeterReading.objects.filter(asset=v.asset, read_on__range=(date_from, date_to)).order_by("reading").values_list("reading", flat=True))
        km = (odos[-1] - odos[0]) if len(odos) > 1 else ZERO
        total = fuel_cost + maint
        rows.append({"plate": v.plate_number, "asset": v.asset.number, "fuel_cost": str(fuel_cost), "liters": str(fuel["l"] or ZERO), "maintenance_cost": str(maint), "total_cost": str(total), "km": str(km), "cost_per_km": None if km <= 0 else str((total / km).quantize(Decimal("0.0001"))),
                     "incidents": m.VehicleIncident.objects.filter(vehicle=v, occurred_on__range=(date_from, date_to)).count()})
    return rows


def expiries(days=30, today=None):
    today = today or timezone.now().date()
    limit = today + timedelta(days=days)
    out = []
    for v in m.Vehicle.objects.select_related("asset").exclude(asset__status__in=("DISPOSED", "RETIRED")).order_by("plate_number"):
        issues = []
        if v.registration_expiry and v.registration_expiry <= limit:
            issues.append({"item": "REGISTRATION", "date": str(v.registration_expiry), "expired": v.registration_expiry < today})
        if v.driver_id and v.driver_license_expiry and v.driver_license_expiry <= limit:
            issues.append({"item": "DRIVER_LICENCE", "date": str(v.driver_license_expiry), "expired": v.driver_license_expiry < today})
        if not wt.is_insured(v.asset_id, today):
            issues.append({"item": "INSURANCE", "date": None, "expired": True})
        if issues:
            out.append({"plate": v.plate_number, "asset": v.asset.number, "issues": issues})
    return out


@transaction.atomic
def run_reminders(today=None, days=30):
    today = today or timezone.now().date()
    sent = 0
    ids = mt._staff_user_ids()
    flagged = {r["plate"]: r for r in expiries(days, today)}
    for v in m.Vehicle.objects.select_for_update(of=("self",)).filter(plate_number__in=list(flagged)):
        if v.last_reminder_on and (today - v.last_reminder_on).days < 14:
            continue
        notify(ids, "assets.vehicle_expiry", f"{v.plate_number}: " + ", ".join(i["item"].lower() for i in flagged[v.plate_number]["issues"]), "Registration, licence or insurance needs attention.", ref_type="assets.vehicle", ref_id=str(v.id))
        v.last_reminder_on = today
        v.save(update_fields=["last_reminder_on", "updated_at"])
        sent += 1
    return sent

"""Vehicles and shipment consolidation."""
from decimal import Decimal

from django.db import IntegrityError, transaction

from modules.supply_chain import models as m
from modules.supply_chain.logistics import ACTIVE, audit, dec
from shared.api.errors import DomainError, ValidationFailed


@transaction.atomic
def create_vehicle(actor, *, code, plate="", vehicle_type="", capacity_kg=0, capacity_m3=0, carrier_id=None):
    kg, m3 = dec(capacity_kg, "capacity_kg"), dec(capacity_m3, "capacity_m3")
    if not (code or "").strip() or kg < 0 or m3 < 0:
        raise ValidationFailed("A code and non-negative capacities are required.", code="invalid_fields")
    if carrier_id and not m.Carrier.objects.filter(pk=carrier_id).exists():
        raise ValidationFailed("Unknown carrier.", code="invalid_carrier")
    try:
        with transaction.atomic():
            v = m.Vehicle.objects.create(code=code.strip()[:30], plate=plate[:30], vehicle_type=vehicle_type[:40], capacity_kg=kg, capacity_m3=m3, carrier_id=carrier_id or None)
    except IntegrityError:
        raise DomainError("A vehicle with this code exists.", code="duplicate_code")
    return v


@transaction.atomic
def update_vehicle(actor, pk, **f):
    v = m.Vehicle.objects.select_for_update().filter(pk=pk).first()
    if v is None:
        raise DomainError("Vehicle not found.", code="not_found", status_code=404)
    for k in ("plate", "vehicle_type", "is_active"):
        if k in f:
            setattr(v, k, f[k])
    for k in ("capacity_kg", "capacity_m3"):
        if k in f:
            val = dec(f[k], k)
            if val < 0:
                raise ValidationFailed(f"{k} cannot be negative.", code="invalid_amount")
            setattr(v, k, val)
    v.save()
    return v


def _load(shipment):
    return shipment.weight_kg + sum((c.weight_kg for c in shipment.consolidated_from.exclude(status="CANCELLED")), Decimal(0))


@transaction.atomic
def assign_vehicle(actor, shipment_id, vehicle_id):
    """A vehicle must be active, large enough for the shipment (including consolidated ones) and free for the planned dates."""
    s = m.Shipment.objects.select_for_update().filter(pk=shipment_id).first()
    v = m.Vehicle.objects.select_for_update().filter(pk=vehicle_id).first()
    if s is None or v is None:
        raise DomainError("Shipment or vehicle not found.", code="not_found", status_code=404)
    if s.status != "PLANNED":
        raise DomainError("A vehicle can only be assigned before dispatch.", code="invalid_state_transition")
    if not v.is_active:
        raise DomainError("This vehicle is not active.", code="vehicle_inactive")
    if v.capacity_kg and _load(s) > v.capacity_kg:
        raise DomainError(f"The load of {_load(s)} kg exceeds the vehicle capacity of {v.capacity_kg} kg.", code="over_capacity")
    clash = m.Shipment.objects.filter(vehicle_ref=v, status__in=ACTIVE, consolidated_into__isnull=True, planned_dispatch__lte=s.planned_arrival, planned_arrival__gte=s.planned_dispatch).exclude(pk=s.pk)
    if clash.exists():
        raise DomainError(f"The vehicle is already assigned to {clash.first().number} on those dates.", code="vehicle_busy")
    s.vehicle_ref, s.vehicle = v, v.plate or v.code
    if v.carrier_id and not s.carrier_id:
        s.carrier_id = v.carrier_id
    s.save()
    audit("supply_chain.shipment.vehicle_assigned", actor, "Shipment", s.id, vehicle=v.code)
    return s


@transaction.atomic
def consolidate(actor, parent_id, child_ids):
    """Combine planned shipments with the same destination under one carrying shipment; they are dispatched and delivered together."""
    parent = m.Shipment.objects.select_for_update().filter(pk=parent_id).first()
    if parent is None:
        raise DomainError("Shipment not found.", code="not_found", status_code=404)
    if parent.status != "PLANNED" or parent.consolidated_into_id:
        raise DomainError("The carrying shipment must be planned and not itself consolidated.", code="invalid_state_transition")
    kids = list(m.Shipment.objects.select_for_update().filter(pk__in=child_ids))
    if not kids or len(kids) != len(set(map(str, child_ids))):
        raise ValidationFailed("Every shipment to consolidate must exist.", code="invalid_fields")
    for k in kids:
        if k.pk == parent.pk or k.status != "PLANNED" or k.consolidated_into_id or k.consolidated_from.exists():
            raise DomainError(f"{k.number} cannot be consolidated.", code="invalid_state_transition")
        if k.destination != parent.destination or k.kind != parent.kind:
            raise DomainError(f"{k.number} has a different destination or kind.", code="destination_mismatch")
    if parent.vehicle_ref_id and parent.vehicle_ref.capacity_kg and _load(parent) + sum(k.weight_kg for k in kids) > parent.vehicle_ref.capacity_kg:
        raise DomainError("The combined load exceeds the vehicle capacity.", code="over_capacity")
    for k in kids:
        k.consolidated_into = parent
        k.save(update_fields=["consolidated_into", "updated_at"])
    audit("supply_chain.shipment.consolidated", actor, "Shipment", parent.id, count=len(kids))
    return parent


@transaction.atomic
def unconsolidate(actor, child_id):
    k = m.Shipment.objects.select_for_update().filter(pk=child_id).first()
    if k is None or not k.consolidated_into_id:
        raise DomainError("This shipment is not consolidated.", code="invalid_state_transition")
    if k.status != "PLANNED":
        raise DomainError("Only planned shipments can be separated.", code="invalid_state_transition")
    k.consolidated_into = None
    k.save(update_fields=["consolidated_into", "updated_at"])
    return k


def vehicle_utilisation(date_from, date_to):
    out = []
    for v in m.Vehicle.objects.all().order_by("code"):
        ships = m.Shipment.objects.filter(vehicle_ref=v, planned_dispatch__lte=date_to, planned_arrival__gte=date_from).exclude(status="CANCELLED")
        days = sum((min(s.planned_arrival, date_to) - max(s.planned_dispatch, date_from)).days + 1 for s in ships)
        span = (date_to - date_from).days + 1
        loads = [(_load(s) / v.capacity_kg * 100) for s in ships if v.capacity_kg]
        out.append({"vehicle": v.code, "shipments": ships.count(), "busy_days": days, "busy_pct": str((Decimal(days) * 100 / span).quantize(Decimal("0.01"))), "avg_load_pct": str((sum(loads) / len(loads)).quantize(Decimal("0.01"))) if loads else None})
    return out

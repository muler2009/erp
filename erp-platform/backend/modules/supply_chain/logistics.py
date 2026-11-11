"""Carriers, routes, shipments, tracking, logistics costs and delivery exceptions."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Sum
from django.utils import timezone

from modules.finance import services as finance
from modules.inventory import models as im
from modules.supply_chain import models as m
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")
MODES = ("ROAD", "AIR", "SEA", "RAIL", "COURIER")
KINDS = ("OUTBOUND", "INBOUND", "TRANSFER")
COST_TYPES = ("FREIGHT", "FUEL", "HANDLING", "CUSTOMS", "INSURANCE", "OTHER")
EXC_KINDS = ("DELAY", "DAMAGE", "LOSS", "WRONG_ITEM", "REFUSED", "SHORTAGE", "OTHER")
SEVERITIES = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
ACTIVE = ("PLANNED", "DISPATCHED", "IN_TRANSIT")


def dec(v, name="amount"):
    try:
        return Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a decimal number.", code="invalid_amount")


def audit(action, actor, target_type, target_id, **meta):
    record_tenant_event(current_tenant(), action, actor_user_id=actor, target_type=target_type, target_id=target_id, metadata={k: str(v) for k, v in meta.items()})


def _nf(label):
    return DomainError(f"{label} not found.", code="not_found", status_code=404)


# ----------------------------------------------------------------------------- carriers & routes
@transaction.atomic
def create_carrier(actor, *, code, name, mode="ROAD", contact=""):
    code = (code or "").strip().upper()
    if not code or not (name or "").strip() or mode not in MODES:
        raise ValidationFailed("code, name and a valid mode are required.", code="invalid_fields")
    if m.Carrier.objects.filter(code=code).exists():
        raise DomainError("A carrier with this code already exists.", code="duplicate_code")
    c = m.Carrier.objects.create(code=code, name=name.strip(), mode=mode, contact=contact[:200])
    audit("supply_chain.carrier.created", actor, "Carrier", c.id, code=code)
    return c


@transaction.atomic
def update_carrier(actor, pk, **f):
    c = m.Carrier.objects.select_for_update().filter(pk=pk).first()
    if c is None:
        raise _nf("Carrier")
    if f.get("mode") is not None and f["mode"] not in MODES:
        raise ValidationFailed("Invalid mode.", code="invalid_fields")
    for k in ("name", "mode", "contact", "is_active"):
        if f.get(k) is not None:
            setattr(c, k, f[k])
    c.save()
    return c


@transaction.atomic
def create_route(actor, *, code, name, origin, destination, distance_km=0, transit_days=1, carrier_id=None):
    code = (code or "").strip().upper()
    if not code or not origin or not destination:
        raise ValidationFailed("code, origin and destination are required.", code="invalid_fields")
    if m.Route.objects.filter(code=code).exists():
        raise DomainError("A route with this code already exists.", code="duplicate_code")
    carrier = None
    if carrier_id:
        carrier = m.Carrier.objects.filter(pk=carrier_id, is_active=True).first()
        if carrier is None:
            raise ValidationFailed("Unknown or inactive carrier.", code="invalid_carrier")
    km = dec(distance_km, "distance_km")
    if km < 0 or int(transit_days) < 0:
        raise ValidationFailed("distance and transit days cannot be negative.", code="invalid_amount")
    r = m.Route.objects.create(code=code, name=(name or code)[:120], origin=origin[:120], destination=destination[:120], distance_km=km, transit_days=int(transit_days), carrier=carrier)
    audit("supply_chain.route.created", actor, "Route", r.id, code=code)
    return r


# ----------------------------------------------------------------------------- shipments
@transaction.atomic
def create_shipment(actor, *, kind, origin, destination, planned_dispatch, planned_arrival=None, carrier_id=None, route_id=None, lines=None, weight_kg=0, volume_m3=0,
                    tracking_ref="", vehicle="", driver="", sales_delivery_id=None, purchase_order_id=None, transfer_order_id=None):
    if kind not in KINDS:
        raise ValidationFailed("Invalid shipment kind.", code="invalid_fields")
    if not (origin or "").strip() or not (destination or "").strip():
        raise ValidationFailed("origin and destination are required.", code="invalid_fields")
    carrier = route = None
    if route_id:
        route = m.Route.objects.filter(pk=route_id, is_active=True).first()
        if route is None:
            raise ValidationFailed("Unknown or inactive route.", code="invalid_route")
    if carrier_id or (route and route.carrier_id):
        carrier = m.Carrier.objects.filter(pk=carrier_id or route.carrier_id, is_active=True).first()
        if carrier is None:
            raise ValidationFailed("Unknown or inactive carrier.", code="invalid_carrier")
    if planned_arrival is None:
        if route is None:
            raise ValidationFailed("planned_arrival is required when no route is given.", code="invalid_dates")
        planned_arrival = planned_dispatch + timedelta(days=route.transit_days)
    if planned_arrival < planned_dispatch:
        raise ValidationFailed("Arrival cannot be before dispatch.", code="invalid_dates")
    w, v = dec(weight_kg, "weight_kg"), dec(volume_m3, "volume_m3")
    if w < 0 or v < 0:
        raise ValidationFailed("weight and volume cannot be negative.", code="invalid_amount")
    if sales_delivery_id:
        from modules.sales.models import Delivery
        d = Delivery.objects.filter(pk=sales_delivery_id).first()
        if d is None:
            raise ValidationFailed("Unknown sales delivery.", code="invalid_delivery")
        if m.Shipment.objects.filter(sales_delivery_id=sales_delivery_id).exclude(status="CANCELLED").exists():
            raise DomainError("A shipment already exists for this delivery.", code="duplicate_shipment")
        tracking_ref = tracking_ref or d.tracking_ref
    if purchase_order_id:
        from modules.procurement.models import PurchaseOrder
        if not PurchaseOrder.objects.filter(pk=purchase_order_id).exists():
            raise ValidationFailed("Unknown purchase order.", code="invalid_order")
    if transfer_order_id:
        if not im.TransferOrder.objects.filter(pk=transfer_order_id).exists():
            raise ValidationFailed("Unknown transfer order.", code="invalid_order")
        if m.Shipment.objects.filter(transfer_order_id=transfer_order_id).exclude(status="CANCELLED").exists():
            raise DomainError("A shipment already exists for this transfer.", code="duplicate_shipment")
    s = m.Shipment.objects.create(number=sequences.next_number("supply_chain.shipment", on_date=planned_dispatch, for_type="Shipment"), kind=kind, carrier=carrier, route=route, origin=origin[:200], destination=destination[:200],
                                  planned_dispatch=planned_dispatch, planned_arrival=planned_arrival, weight_kg=w, volume_m3=v, tracking_ref=tracking_ref[:80], vehicle=vehicle[:60], driver=driver[:120],
                                  sales_delivery_id=sales_delivery_id or None, purchase_order_id=purchase_order_id or None, transfer_order_id=transfer_order_id or None, created_by=actor)
    for i, ln in enumerate(lines or [], 1):
        qty = dec(ln.get("quantity"), "quantity")
        prod = None
        if ln.get("product"):
            prod = im.Product.objects.filter(pk=ln["product"]).first()
            if prod is None:
                raise ValidationFailed(f"Line {i}: unknown product.", code="invalid_product")
        desc = (ln.get("description") or (prod.name if prod else "")).strip()
        if qty <= 0 or not desc:
            raise ValidationFailed(f"Line {i}: a description (or product) and a positive quantity are required.", code="invalid_amount")
        m.ShipmentLine.objects.create(shipment=s, product=prod, description=desc[:300], quantity=qty)
    m.TrackingEvent.objects.create(shipment=s, status="PLANNED", note="Shipment planned", recorded_by=actor)
    audit("supply_chain.shipment.created", actor, "Shipment", s.id, number=s.number)
    return s


def _lock(pk):
    s = m.Shipment.objects.select_for_update().filter(pk=pk).first()
    if s is None:
        raise _nf("Shipment")
    return s


@transaction.atomic
def dispatch(actor, pk, *, location="", note=""):
    s = _lock(pk)
    if s.consolidated_into_id:
        raise DomainError("This shipment is part of a consolidated shipment; dispatch the consolidated shipment.", code="consolidated")
    if s.status != "PLANNED":
        raise DomainError(f"A {s.status} shipment cannot be dispatched.", code="invalid_state_transition")
    for x in [s, *s.consolidated_from.select_for_update().filter(status="PLANNED")]:
        x.status, x.actual_dispatch = "DISPATCHED", timezone.now()
        x.save()
        m.TrackingEvent.objects.create(shipment=x, status="DISPATCHED", location=location[:200] or x.origin, note=note[:300], recorded_by=actor)
    audit("supply_chain.shipment.dispatched", actor, "Shipment", s.id)
    return s


@transaction.atomic
def add_tracking(actor, pk, *, location, note="", occurred_at=None):
    s = _lock(pk)
    if s.status not in ("DISPATCHED", "IN_TRANSIT"):
        raise DomainError("Tracking updates need a dispatched shipment that has not arrived.", code="invalid_state_transition")
    if not (location or "").strip():
        raise ValidationFailed("location is required.", code="invalid_fields")
    s.status = "IN_TRANSIT"
    s.save()
    return m.TrackingEvent.objects.create(shipment=s, status="IN_TRANSIT", location=location[:200], note=note[:300], occurred_at=occurred_at or timezone.now(), recorded_by=actor)


@transaction.atomic
def deliver(actor, pk, *, received_by="", note="", pod_file_id=None, lines=None):
    """Confirm arrival. Proof of delivery (who received it, when, a signed note) is stored; per-line received and damaged quantities
    raise shortage / damage exceptions. Delivering a consolidated shipment delivers the shipments inside it."""
    s = _lock(pk)
    if s.consolidated_into_id:
        raise DomainError("This shipment is part of a consolidated shipment; deliver the consolidated shipment.", code="consolidated")
    if s.status not in ("DISPATCHED", "IN_TRANSIT"):
        raise DomainError(f"A {s.status} shipment cannot be marked delivered.", code="invalid_state_transition")
    if pod_file_id:
        from shared.files.models import StoredFile
        if not StoredFile.objects.filter(pk=pod_file_id).exists():
            raise ValidationFailed("Unknown proof-of-delivery file.", code="invalid_file")
    now = timezone.now()
    by_id = {str(x.id): x for x in s.lines.select_for_update()}
    for ln in lines or []:
        row = by_id.get(str(ln.get("line")))
        if row is None:
            raise ValidationFailed("Unknown shipment line.", code="invalid_line")
        rec, dmg = dec(ln.get("received", row.quantity), "received"), dec(ln.get("damaged", 0), "damaged")
        if rec < 0 or dmg < 0 or dmg > rec or rec > row.quantity:
            raise ValidationFailed("Received must be between 0 and the shipped quantity, and damaged cannot exceed received.", code="invalid_amount")
        row.received_quantity, row.damaged_quantity, row.discrepancy_note = rec, dmg, (ln.get("note") or "")[:300]
        row.save()
    for x in [s, *s.consolidated_from.select_for_update().filter(status__in=("DISPATCHED", "IN_TRANSIT"))]:
        x.status, x.actual_arrival = "DELIVERED", now
        if x.id == s.id:
            x.pod_received_by, x.pod_at, x.pod_note, x.pod_file_id = received_by[:120], now, note[:300], pod_file_id or None
        x.save()
        m.TrackingEvent.objects.create(shipment=x, status="DELIVERED", location=x.destination, note=(f"Received by {received_by}. " if received_by else "") + note[:250], recorded_by=actor)
        events.emit("supply_chain.shipment.delivered", {"shipment": str(x.id)}, dedup_key=f"shipment-delivered:{x.id}")
    for row in by_id.values():
        if row.received_quantity is None:
            continue
        if row.received_quantity < row.quantity:
            report_exception(actor, s.id, kind="SHORTAGE", severity="HIGH" if row.received_quantity == 0 else "MEDIUM", description=f"{row.description}: received {row.received_quantity} of {row.quantity}. {row.discrepancy_note}".strip())
        if row.damaged_quantity > 0:
            report_exception(actor, s.id, kind="DAMAGE", severity="MEDIUM", description=f"{row.description}: {row.damaged_quantity} damaged. {row.discrepancy_note}".strip())
    audit("supply_chain.shipment.delivered", actor, "Shipment", s.id, late=s.actual_arrival.date() > s.planned_arrival)
    return s


@transaction.atomic
def cancel(actor, pk, *, reason):
    s = _lock(pk)
    if s.status != "PLANNED":
        raise DomainError("Only a planned shipment can be cancelled.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    if s.costs.exists():
        raise DomainError("Costs have been booked against this shipment.", code="has_costs")
    s.status = "CANCELLED"
    s.save()
    m.TrackingEvent.objects.create(shipment=s, status="CANCELLED", note=reason[:300], recorded_by=actor)
    return s


# ----------------------------------------------------------------------------- costs
@transaction.atomic
def add_cost(actor, pk, *, cost_type, amount, description=""):
    s = _lock(pk)
    amt = dec(amount)
    if cost_type not in COST_TYPES or amt <= 0:
        raise ValidationFailed("A valid cost type and a positive amount are required.", code="invalid_amount")
    if s.status == "CANCELLED":
        raise DomainError("A cancelled shipment cannot carry costs.", code="invalid_state_transition")
    entry = finance.post_system_journal(actor, timezone.now().date(), f"Logistics {cost_type} {s.number}", "supply_chain", f"shp:{s.id}", [("logistics_cost", "debit", amt), ("accrued_logistics", "credit", amt)])
    c = m.ShipmentCost.objects.create(shipment=s, cost_type=cost_type, amount=amt, description=description[:300], journal_entry_id=entry.id if entry else None, recorded_by=actor)
    audit("supply_chain.shipment.cost_added", actor, "Shipment", s.id, type=cost_type, amount=amt)
    return c


def cost_report(date_from, date_to):
    qs = m.ShipmentCost.objects.filter(created_at__date__gte=date_from, created_at__date__lte=date_to)
    by_type = {r["cost_type"]: str(r["t"]) for r in qs.values("cost_type").annotate(t=Sum("amount"))}
    by_carrier = []
    for r in qs.values("shipment__carrier__code").annotate(t=Sum("amount"), n=Count("shipment", distinct=True)):
        kg = m.Shipment.objects.filter(carrier__code=r["shipment__carrier__code"], costs__in=qs).distinct().aggregate(w=Sum("weight_kg"))["w"] or ZERO
        by_carrier.append({"carrier": r["shipment__carrier__code"], "total": str(r["t"]), "shipments": r["n"], "cost_per_kg": str((r["t"] / kg).quantize(Decimal("0.0001"))) if kg else None})
    total = qs.aggregate(t=Sum("amount"))["t"] or ZERO
    return {"total": str(total), "by_type": by_type, "by_carrier": by_carrier}


# ----------------------------------------------------------------------------- exceptions
@transaction.atomic
def report_exception(actor, pk, *, kind, description, severity="MEDIUM", auto=False):
    s = _lock(pk)
    if kind not in EXC_KINDS or severity not in SEVERITIES or not (description or "").strip():
        raise ValidationFailed("A valid kind, severity and description are required.", code="invalid_fields")
    if s.status == "CANCELLED":
        raise DomainError("A cancelled shipment cannot have exceptions.", code="invalid_state_transition")
    x = m.DeliveryException.objects.create(shipment=s, kind=kind, severity=severity, description=description[:500], reported_by=actor, auto_detected=auto)
    events.emit("supply_chain.exception.reported", {"shipment": str(s.id), "kind": kind}, dedup_key=f"exception:{x.id}")
    notify([s.created_by], "supply_chain.exception", f"{kind.replace('_', ' ').title()} on shipment {s.number}", description[:200], ref_type="supply_chain.shipment", ref_id=str(s.id))
    audit("supply_chain.exception.reported", actor, "Shipment", s.id, kind=kind, severity=severity)
    return x


@transaction.atomic
def resolve_exception(actor, exception_id, *, resolution):
    x = m.DeliveryException.objects.select_for_update().filter(pk=exception_id).first()
    if x is None:
        raise _nf("Exception")
    if x.status != "OPEN":
        raise DomainError("Already resolved.", code="invalid_state_transition")
    if not (resolution or "").strip():
        raise ValidationFailed("A resolution is required.", code="resolution_required")
    if x.severity in ("HIGH", "CRITICAL") and x.reported_by == actor:
        raise DomainError("A high-severity exception must be resolved by someone other than its reporter.", code="separation_of_duties", status_code=403)
    x.status, x.resolution, x.resolved_by, x.resolved_at = "RESOLVED", resolution[:500], actor, timezone.now()
    x.save()
    audit("supply_chain.exception.resolved", actor, "Shipment", x.shipment_id)
    return x


# ----------------------------------------------------------------------------- performance
def carrier_performance(date_from, date_to):
    out = []
    for c in m.Carrier.objects.all().order_by("code"):
        done = list(m.Shipment.objects.filter(carrier=c, status="DELIVERED", actual_arrival__date__gte=date_from, actual_arrival__date__lte=date_to))
        if not done:
            continue
        on_time = sum(1 for s in done if s.actual_arrival.date() <= s.planned_arrival)
        transit = [(s.actual_arrival - s.actual_dispatch).total_seconds() / 86400 for s in done if s.actual_dispatch]
        exc = m.DeliveryException.objects.filter(shipment__in=done).count()
        cost = m.ShipmentCost.objects.filter(shipment__in=done).aggregate(t=Sum("amount"))["t"] or ZERO
        out.append({"carrier": c.code, "delivered": len(done), "on_time_pct": str((Decimal(on_time) * 100 / len(done)).quantize(Decimal("0.01"))), "avg_transit_days": str(round(sum(transit) / len(transit), 2)) if transit else None, "exceptions": exc, "exception_rate_pct": str((Decimal(exc) * 100 / len(done)).quantize(Decimal("0.01"))), "total_cost": str(cost)})
    return out


def open_exceptions():
    return m.DeliveryException.objects.filter(status="OPEN").select_related("shipment")

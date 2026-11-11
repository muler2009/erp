"""Warehouse structure: location kinds, hierarchy fields, capacity and access guards."""
from decimal import Decimal, InvalidOperation

from django.db.models import Sum

from modules.inventory import models as m
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed

WH_TYPES = {"MAIN", "BRANCH", "TRANSIT", "QUARANTINE", "VIRTUAL"}
LOC_KINDS = {"STORAGE", "QUARANTINE", "RESTRICTED", "TRANSIT"}
POLICIES = {"picking": {"FIFO", "FEFO", "LIFO"}, "allow_partial_issue": {True, False}}
RESTRICTED_PERMISSION = "inventory.restricted.access"


def clean_warehouse(a):
    allowed = {"warehouse_type", "branch_id", "manager_id", "address", "policies"}
    bad = set(a) - allowed
    if bad:
        raise ValidationFailed(f"Unknown warehouse attribute '{sorted(bad)[0]}'.", code="unknown_attribute")
    if a.get("warehouse_type", "MAIN") not in WH_TYPES:
        raise ValidationFailed("Invalid warehouse type.", code="invalid_warehouse_type")
    pol = a.get("policies")
    if pol is not None:
        for k, v in pol.items():
            if k not in POLICIES or v not in POLICIES[k]:
                raise ValidationFailed(f"Invalid warehouse policy '{k}'.", code="invalid_policy")
    return a


def clean_location(a):
    allowed = {"kind", "zone", "aisle", "rack", "shelf", "bin", "capacity", "is_blocked"}
    bad = set(a) - allowed
    if bad:
        raise ValidationFailed(f"Unknown location attribute '{sorted(bad)[0]}'.", code="unknown_attribute")
    if a.get("kind", "STORAGE") not in LOC_KINDS:
        raise ValidationFailed("Invalid location kind.", code="invalid_location_kind")
    if a.get("capacity") not in (None, ""):
        try:
            a["capacity"] = Decimal(str(a["capacity"]))
        except InvalidOperation:
            raise ValidationFailed("Capacity must be a number.", code="invalid_number")
        if a["capacity"] <= 0:
            raise ValidationFailed("Capacity must be positive.", code="invalid_number")
    else:
        a.pop("capacity", None)
    return a


def update_location(actor_id, location_id, **attrs):
    loc = m.Location.objects.filter(pk=location_id).first()
    if not loc:
        raise DomainError("Location not found.", code="not_found", status_code=404)
    active = attrs.pop("is_active", None)
    for k, v in clean_location(attrs).items():
        setattr(loc, k, v)
    if active is not None:
        loc.is_active = bool(active)
    loc.save()
    return loc


def update_warehouse(actor_id, warehouse_id, **attrs):
    wh = m.Warehouse.objects.filter(pk=warehouse_id).first()
    if not wh:
        raise DomainError("Warehouse not found.", code="not_found", status_code=404)
    name = attrs.pop("name", None)
    for k, v in clean_warehouse(attrs).items():
        setattr(wh, k, v)
    if name:
        wh.name = name
    wh.save()
    return wh


def occupancy(location):
    return m.StockLevel.objects.filter(location=location).aggregate(t=Sum("quantity"))["t"] or Decimal("0")


def check_capacity(loc, qty):
    if loc.capacity is not None and occupancy(loc) + qty > loc.capacity:
        raise DomainError(f"Location {loc.code} capacity exceeded ({occupancy(loc)} of {loc.capacity} used).", code="capacity_exceeded")


_ISSUE_GUARDS = []


def register_issue_guard(fn):
    """Another module (quality) can veto stock leaving a location: fn(product, location, lot, purpose, dest) raises DomainError."""
    _ISSUE_GUARDS.append(fn)


def run_issue_guards(product, loc, lot, *, purpose="issue", dest=None):
    for guard in _ISSUE_GUARDS:
        guard(product, loc, lot, purpose, dest)


def check_can_issue(loc, actor_id, allow_quarantine=False):
    if loc.is_blocked:
        raise DomainError(f"Location {loc.code} is blocked.", code="location_blocked")
    if loc.kind in ("QUARANTINE", "TRANSIT") and not (allow_quarantine and loc.kind == "QUARANTINE"):
        raise DomainError(f"Stock in a {loc.kind.lower()} location cannot be issued; release it by transfer first.", code="location_not_issuable")
    if loc.kind == "RESTRICTED" and actor_id and not authz.has_permission(actor_id, RESTRICTED_PERMISSION):
        raise DomainError("Restricted location: you do not have access.", code="restricted_location", status_code=403)


def check_can_transfer_out(loc, actor_id):
    if loc.is_blocked:
        raise DomainError(f"Location {loc.code} is blocked.", code="location_blocked")
    if loc.kind == "RESTRICTED" and actor_id and not authz.has_permission(actor_id, RESTRICTED_PERMISSION):
        raise DomainError("Restricted location: you do not have access.", code="restricted_location", status_code=403)


def utilisation(warehouse_id=None):
    qs = m.Location.objects.select_related("warehouse").filter(is_active=True)
    if warehouse_id:
        qs = qs.filter(warehouse_id=warehouse_id)
    out = []
    for l in qs.order_by("warehouse__code", "code"):
        used = occupancy(l)
        out.append({"warehouse": l.warehouse.code, "location": l.code, "kind": l.kind, "used": str(used), "capacity": None if l.capacity is None else str(l.capacity), "utilisation_pct": None if not l.capacity else str((used * 100 / l.capacity).quantize(Decimal("0.1")))})
    return out


def check_frozen(loc, allow_count_posting=False):
    """Locations under an in-progress frozen stocktake accept no movements (posting the approved count is the only exception)."""
    if allow_count_posting:
        return
    if m.StockCountLine.objects.filter(location=loc, count__status="IN_PROGRESS", count__freeze=True).exists():
        raise DomainError(f"Location {loc.code} is frozen for stocktaking.", code="location_frozen")

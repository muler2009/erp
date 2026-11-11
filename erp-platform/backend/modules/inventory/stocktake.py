"""Stocktaking: sessions with optional movement freeze, counter assignment, recounts, variance approval and posting."""
from decimal import Decimal

from django.db import transaction

from modules.inventory import models as m
from modules.inventory import services as svc
from shared.api.errors import DomainError, ValidationFailed
from shared.sequences import services as sequences

ZERO = Decimal("0")


def _count(count_id, lock=False):
    qs = m.StockCount.objects.select_for_update(of=("self",)) if lock else m.StockCount.objects
    c = qs.select_related("warehouse").filter(pk=count_id).first()
    if not c:
        raise DomainError("Stock count not found.", code="not_found", status_code=404)
    return c


@transaction.atomic
def create(actor_id, *, warehouse_id, kind="CYCLE", freeze=False, planned_date=None, location_ids=None, product_ids=None, note=""):
    wh = svc._get(m.Warehouse, warehouse_id, "Warehouse")
    if kind not in ("CYCLE", "FULL"):
        raise ValidationFailed("Invalid count kind.", code="invalid_kind")
    if kind == "CYCLE" and not (location_ids or product_ids):
        raise ValidationFailed("A cycle count needs locations or products to count.", code="scope_required")
    return m.StockCount.objects.create(number=sequences.next_number("inventory.stock_count", for_type="StockCount"), warehouse=wh, kind=kind, freeze=bool(freeze), planned_date=planned_date, created_by=actor_id, note=note[:300], scope={"locations": [str(i) for i in location_ids or []], "products": [str(i) for i in product_ids or []]})


@transaction.atomic
def start(actor_id, count_id):
    """Snapshot the system quantities (blind counting: counters never see them) and optionally freeze the locations."""
    c = _count(count_id, lock=True)
    if c.status != "DRAFT":
        raise DomainError("Only a draft count can be started.", code="invalid_state")
    qs = m.StockLevel.objects.select_related("product", "location", "lot").filter(location__warehouse=c.warehouse, location__is_active=True).exclude(product__tracking="SERIAL")
    if c.scope.get("locations"):
        qs = qs.filter(location_id__in=c.scope["locations"])
    if c.scope.get("products"):
        qs = qs.filter(product_id__in=c.scope["products"])
    n = 0
    for lv in qs:
        m.StockCountLine.objects.create(count=c, product=lv.product, location=lv.location, lot_code=lv.lot.code if lv.lot else "", system_quantity=lv.quantity)
        n += 1
    if not n:
        raise DomainError("There is no stock in the selected scope.", code="empty_scope")
    others = m.StockCountLine.objects.filter(count__status="IN_PROGRESS", count__freeze=True, location_id__in=m.StockCountLine.objects.filter(count=c).values("location_id")).exists()
    if c.freeze and others:
        raise DomainError("Some of these locations are already frozen by another count.", code="already_frozen")
    c.status = "IN_PROGRESS"
    c.save(update_fields=["status", "updated_at"])
    return c


@transaction.atomic
def assign(actor_id, count_id, *, user_id, line_ids=None, location_id=None):
    c = _count(count_id, lock=True)
    if c.status != "IN_PROGRESS":
        raise DomainError("Counters can only be assigned while the count is in progress.", code="invalid_state")
    qs = c.lines.all()
    if line_ids:
        qs = qs.filter(pk__in=line_ids)
    if location_id:
        qs = qs.filter(location_id=location_id)
    return qs.update(assigned_to=user_id)


@transaction.atomic
def record(actor_id, line_id, *, counted_quantity, note=""):
    line = m.StockCountLine.objects.select_for_update(of=("self",)).select_related("count").filter(pk=line_id).first()
    if not line:
        raise DomainError("Count line not found.", code="not_found", status_code=404)
    if line.count.status != "IN_PROGRESS":
        raise DomainError("This count is not open for counting.", code="invalid_state")
    if line.assigned_to and line.assigned_to != actor_id:
        raise DomainError("This line is assigned to another counter.", code="not_assigned", status_code=403)
    q = svc._dec(counted_quantity, "counted_quantity")
    if q < 0:
        raise ValidationFailed("The counted quantity cannot be negative.", code="invalid_amount")
    line.counted_quantity, line.counted_by, line.note, line.recount = q, actor_id, note[:300], False
    line.save(update_fields=["counted_quantity", "counted_by", "note", "recount"])
    return line


@transaction.atomic
def submit(actor_id, count_id):
    c = _count(count_id, lock=True)
    if c.status != "IN_PROGRESS":
        raise DomainError("Only a count in progress can be submitted.", code="invalid_state")
    missing = c.lines.filter(counted_quantity__isnull=True).count()
    if missing:
        raise DomainError(f"{missing} line(s) have not been counted.", code="uncounted_lines")
    c.status = "SUBMITTED"
    c.save(update_fields=["status", "updated_at"])
    return c


@transaction.atomic
def request_recount(actor_id, count_id, line_ids):
    c = _count(count_id, lock=True)
    if c.status != "SUBMITTED":
        raise DomainError("Recounts are requested on a submitted count.", code="invalid_state")
    n = c.lines.filter(pk__in=line_ids).update(recount=True, counted_quantity=None)
    if not n:
        raise ValidationFailed("No matching lines.", code="unknown_line")
    c.status = "IN_PROGRESS"
    c.save(update_fields=["status", "updated_at"])
    return c


def variances(count_id):
    c = _count(count_id)
    out = []
    for l in c.lines.select_related("product", "location"):
        if l.counted_quantity is None:
            continue
        diff = l.counted_quantity - l.system_quantity
        cost = m.ProductCost.objects.filter(product=l.product).first()
        value = l.variance_value if l.variance_value is not None else (diff * cost.average if cost else ZERO)
        out.append({"line": str(l.id), "sku": l.product.sku, "location": l.location.code, "lot": l.lot_code, "system": str(l.system_quantity), "counted": str(l.counted_quantity), "variance": str(diff), "variance_pct": None if l.system_quantity == 0 else str((diff * 100 / l.system_quantity).quantize(Decimal("0.01"))), "variance_value": str(Decimal(value).quantize(Decimal("0.0001")))})
    return out


@transaction.atomic
def approve(actor_id, count_id):
    """Post every variance as a stock adjustment (count_posting bypasses the freeze and the per-adjustment threshold)."""
    c = _count(count_id, lock=True)
    if c.status != "SUBMITTED":
        raise DomainError("Only a submitted count can be approved.", code="invalid_state")
    if c.created_by == actor_id:
        raise DomainError("Separation of duties: the person who created the count cannot approve its variances.", code="separation_of_duties", status_code=403)
    c.status, c.approved_by = "APPROVED", actor_id
    c.save(update_fields=["status", "approved_by", "updated_at"])
    for l in c.lines.select_related("product", "location"):
        if l.counted_quantity == l.system_quantity:
            continue
        mv = svc.adjust_stock(actor_id, product_id=l.product_id, location_id=l.location_id, counted_quantity=l.counted_quantity, lot_code=l.lot_code or None, reason=f"Stocktake {c.number}", approved=True, count_posting=True)
        l.variance_value = mv.quantity * mv.unit_cost
        l.save(update_fields=["variance_value"])
    return c


@transaction.atomic
def cancel(actor_id, count_id):
    c = _count(count_id, lock=True)
    if c.status in ("APPROVED", "CANCELLED"):
        raise DomainError("This count is final.", code="invalid_state")
    c.status = "CANCELLED"
    c.save(update_fields=["status", "updated_at"])
    return c


def worksheet(count_id, user_id=None):
    """Blind count sheet: no system quantities."""
    c = _count(count_id)
    qs = c.lines.select_related("product", "location")
    return [{"line": str(l.id), "sku": l.product.sku, "name": l.product.name, "location": l.location.code, "lot": l.lot_code, "counted": None if l.counted_quantity is None else str(l.counted_quantity), "assigned_to": None if not l.assigned_to else str(l.assigned_to), "recount": l.recount} for l in qs.order_by("location__code", "product__sku")]


def history(product_id=None):
    qs = m.StockCount.objects.select_related("warehouse").order_by("-created_at")
    if product_id:
        qs = qs.filter(lines__product_id=product_id).distinct()
    return [{"id": str(c.id), "number": c.number, "warehouse": c.warehouse.code, "kind": c.kind, "status": c.status, "freeze": c.freeze, "created_at": c.created_at} for c in qs]

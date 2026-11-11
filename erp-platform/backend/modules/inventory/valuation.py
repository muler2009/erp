"""FIFO cost layers, landed-cost allocation, and historical / per-warehouse valuation."""
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

from modules.finance import services as finance
from modules.inventory import models as m
from modules.inventory import services as svc
from shared.api.errors import DomainError, ValidationFailed
from shared.sequences import services as sequences

ZERO = Decimal("0")


def add_layer(product, movement_id, qty, value):
    return m.CostLayer.objects.create(product=product, movement_id=movement_id, quantity=qty, remaining=qty, remaining_value=value)


def fifo_take(cost, qty):
    """Consume the oldest layers first; stock without a layer (received before FIFO was set) is taken at the unlayered average."""
    layers = list(m.CostLayer.objects.select_for_update().filter(product=cost.product, remaining__gt=0).order_by("received_at", "id"))
    layered_qty = sum((l.remaining for l in layers), ZERO)
    layered_val = sum((l.remaining_value for l in layers), ZERO)
    need, total = qty, ZERO
    for l in layers:
        if need <= 0:
            break
        take = min(need, l.remaining)
        value = l.remaining_value if take == l.remaining else (l.remaining_value * take / l.remaining).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        l.remaining -= take
        l.remaining_value -= value
        l.save(update_fields=["remaining", "remaining_value"])
        total += value
        need -= take
    if need > 0:
        free_qty, free_val = cost.quantity - layered_qty, cost.total_value - layered_val
        if need > free_qty:
            raise DomainError("Insufficient stock.", code="insufficient_stock")
        total += free_val if need == free_qty else (free_val * need / free_qty).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    return total


@transaction.atomic
def post_landed_cost(actor_id, *, ref_type, ref_id, amount, description, basis="VALUE", on_date=None):
    try:
        amt = Decimal(str(amount))
    except Exception:
        raise ValidationFailed("amount must be a number.", code="invalid_amount")
    if amt <= 0:
        raise ValidationFailed("The landed cost amount must be positive.", code="invalid_amount")
    if basis not in ("VALUE", "QUANTITY"):
        raise ValidationFailed("basis must be VALUE or QUANTITY.", code="invalid_basis")
    moves = list(m.StockMovement.objects.select_related("product", "location").filter(ref_type=ref_type, ref_id=str(ref_id), movement_type="RECEIPT"))
    if not moves:
        raise DomainError("No stock receipt found for this reference.", code="receipt_not_found", status_code=404)
    weights = [(mv.quantity if basis == "QUANTITY" else mv.quantity * mv.unit_cost) for mv in moves]
    if sum(weights) <= 0:
        raise ValidationFailed("Nothing to allocate against (zero value); use QUANTITY basis.", code="nothing_to_allocate")
    decimals = svc._decimals()
    q = lambda d: Decimal(d).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)  # noqa: E731
    shares, running = [], ZERO
    for i, w in enumerate(weights):
        s = amt - running if i == len(weights) - 1 else q(amt * w / sum(weights))
        shares.append(s)
        running += s
    on_date = on_date or timezone.now().date()
    lc = m.LandedCost.objects.create(number=sequences.next_number("inventory.landed_cost", for_type="LandedCost"), ref_type=ref_type, ref_id=str(ref_id), description=description[:200], amount=amt, basis=basis, posted_on=on_date, created_by=actor_id)
    inv_total = cogs_total = ZERO
    for mv, share in zip(moves, shares):
        cost = svc._cost_row(mv.product)
        if mv.product.costing_method == "FIFO":
            layer = m.CostLayer.objects.select_for_update().filter(movement_id=mv.id).first()
            frac = (layer.remaining / layer.quantity) if layer and layer.quantity else ZERO
            to_inv = q(share * frac)
            if layer and to_inv:
                layer.remaining_value += to_inv
                layer.save(update_fields=["remaining_value"])
        else:  # weighted average keeps no per-receipt balance: the part still on hand is estimated as min(received, on hand)
            remaining = min(mv.quantity, cost.quantity)
            to_inv = q(share * remaining / mv.quantity)
        to_cogs = share - to_inv
        if to_inv:
            cost.total_value += to_inv
            cost.save(update_fields=["total_value"])
        m.LandedCostAllocation.objects.create(landed_cost=lc, product=mv.product, movement_id=mv.id, location=mv.location, share=share, to_inventory=to_inv, to_cogs=to_cogs)
        inv_total += to_inv
        cogs_total += to_cogs
    from modules.finance import models as fm
    if not fm.Account.objects.filter(system_key="landed_cost_payable").exists():
        finance.seed_defaults()  # tenants created before this account existed
    entry = finance.post_system_journal(actor_id, on_date, f"Landed cost {lc.number}: {description}", "inventory", f"landed:{lc.number}", [("inventory", "debit", inv_total), ("cogs", "debit", cogs_total), ("landed_cost_payable", "credit", amt)])
    lc.journal_entry_id = entry.id if entry else None
    lc.save(update_fields=["journal_entry_id"])
    return lc


def valuation_report(*, as_of=None, warehouse_id=None):
    """Value and quantity per product. With no date/warehouse this is the live ledger; otherwise it is rebuilt from movement history
    (movement quantity x unit cost, plus landed-cost uplifts), which agrees with the ledger up to cost rounding."""
    if as_of is None and warehouse_id is None:
        return svc.valuation()
    as_of = as_of or timezone.now().date()
    mv = m.StockMovement.objects.filter(created_at__date__lte=as_of)
    la = m.LandedCostAllocation.objects.filter(landed_cost__posted_on__lte=as_of)
    if warehouse_id:
        mv = mv.filter(location__warehouse_id=warehouse_id)
        la = la.filter(location__warehouse_id=warehouse_id)
    qty, val = {}, {}
    for pid, q, v in mv.values_list("product_id").annotate(q=Sum("quantity"), v=Sum(F("quantity") * F("unit_cost"))):
        qty[pid], val[pid] = q or ZERO, v or ZERO
    for pid, v in la.values_list("product_id").annotate(v=Sum("to_inventory")):
        val[pid] = val.get(pid, ZERO) + (v or ZERO)
    rows, total = [], ZERO
    for p in m.Product.objects.filter(pk__in=[k for k, v in qty.items() if v > 0]).order_by("sku"):
        value = Decimal(val.get(p.pk, ZERO)).quantize(Decimal("0.0001"))
        rows.append({"sku": p.sku, "name": p.name, "quantity": str(qty[p.pk]), "average_cost": str((value / qty[p.pk]).quantize(Decimal("0.0001"))), "value": str(value)})
        total += value
    return {"as_of": str(as_of), "warehouse": None if not warehouse_id else str(warehouse_id), "rows": rows, "total_value": str(total)}

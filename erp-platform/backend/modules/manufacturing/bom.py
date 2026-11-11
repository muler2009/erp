"""Work centers, bills of materials (versioned, approved, frozen), routings, standard cost and multi-level explosion."""
from decimal import ROUND_HALF_UP, Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone

from modules.inventory import models as im
from modules.manufacturing import models as m
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

ZERO = Decimal("0")
MAX_DEPTH = 20


def dec(v, name="quantity"):
    try:
        return Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a decimal number.", code="invalid_amount")


def q4(v):
    return Decimal(v).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def audit(action, actor, target_type, target_id, **meta):
    record_tenant_event(current_tenant(), action, actor_user_id=actor, target_type=target_type, target_id=target_id, metadata={k: str(v) for k, v in meta.items()})


# ----------------------------------------------------------------------------- work centers
@transaction.atomic
def create_work_center(actor, *, code, name, capacity_hours_per_day=8, labor_rate=0, machine_rate=0, overhead_rate=0, efficiency_percent=100, line_id=None, asset_id=None, working_days=None):
    code = (code or "").strip().upper()
    if not code or not (name or "").strip():
        raise ValidationFailed("code and name are required.", code="invalid_fields")
    vals = dict(capacity_hours_per_day=dec(capacity_hours_per_day, "capacity_hours_per_day"), labor_rate=dec(labor_rate, "labor_rate"), machine_rate=dec(machine_rate, "machine_rate"), overhead_rate=dec(overhead_rate, "overhead_rate"), efficiency_percent=dec(efficiency_percent, "efficiency_percent"))
    if vals["capacity_hours_per_day"] <= 0 or vals["efficiency_percent"] <= 0 or min(vals["labor_rate"], vals["machine_rate"], vals["overhead_rate"]) < 0:
        raise ValidationFailed("Capacity and efficiency must be positive and rates non-negative.", code="invalid_amount")
    if m.WorkCenter.objects.filter(code=code).exists():
        raise DomainError("A work center with this code already exists.", code="duplicate_code")
    wc = m.WorkCenter(code=code, name=name.strip(), **vals)
    _wc_links(wc, line_id, asset_id, working_days)
    wc.save()
    audit("manufacturing.work_center.created", actor, "WorkCenter", wc.id, code=code)
    return wc


def _wc_links(wc, line_id, asset_id, working_days):
    if line_id:
        if not m.ProductionLine.objects.filter(pk=line_id, is_active=True).exists():
            raise ValidationFailed("Unknown production line.", code="invalid_line")
        wc.line_id = line_id
    if asset_id:
        from modules.assets.models import Asset
        if not Asset.objects.filter(pk=asset_id).exists():
            raise ValidationFailed("Unknown asset.", code="invalid_asset")
        wc.asset_id = asset_id
    if working_days is not None:
        if not isinstance(working_days, list) or any(not isinstance(d, int) or not 0 <= d <= 6 for d in working_days):
            raise ValidationFailed("working_days must be a list of weekday numbers 0-6.", code="invalid_fields")
        wc.working_days = sorted(set(working_days))


@transaction.atomic
def create_line(actor, *, code, name, facility=""):
    code = (code or "").strip().upper()
    if not code or not (name or "").strip():
        raise ValidationFailed("code and name are required.", code="invalid_fields")
    if m.ProductionLine.objects.filter(code=code).exists():
        raise DomainError("A production line with this code already exists.", code="duplicate_code")
    return m.ProductionLine.objects.create(code=code, name=name.strip(), facility=facility[:120])


@transaction.atomic
def update_work_center(actor, pk, **fields):
    wc = m.WorkCenter.objects.select_for_update().filter(pk=pk).first()
    if wc is None:
        raise DomainError("Work center not found.", code="not_found", status_code=404)
    for k in ("name", "capacity_hours_per_day", "labor_rate", "machine_rate", "overhead_rate", "efficiency_percent", "is_active"):
        if k in fields and fields[k] is not None:
            setattr(wc, k, fields[k] if k in ("name", "is_active") else dec(fields[k], k))
    if wc.capacity_hours_per_day <= 0 or wc.efficiency_percent <= 0 or min(wc.labor_rate, wc.machine_rate, wc.overhead_rate) < 0:
        raise ValidationFailed("Capacity and efficiency must be positive and rates non-negative.", code="invalid_amount")
    _wc_links(wc, fields.get("line"), fields.get("asset"), fields.get("working_days"))
    wc.save()
    audit("manufacturing.work_center.updated", actor, "WorkCenter", wc.id)
    return wc


# ----------------------------------------------------------------------------- costing helpers
def unit_cost(product):
    """Current weighted-average cost; falls back to the standard purchase price when nothing is in stock."""
    row = im.ProductCost.objects.filter(product=product).first()
    if row is not None and row.quantity > 0:
        return row.total_value / row.quantity
    return product.purchase_price or ZERO


def active_bom(product_id, on_date=None):
    """The approved BOM for a product; with `on_date`, only if that date falls inside its effective window."""
    b = m.Bom.objects.filter(product_id=product_id, status="ACTIVE").first()
    if b is not None and on_date is not None and ((b.effective_from and on_date < b.effective_from) or (b.effective_to and on_date > b.effective_to)):
        return None
    return b


def supply_type(product_id):
    p = m.ItemProfile.objects.filter(product_id=product_id).first()
    return p.supply_type if p else "MANUFACTURED"


@transaction.atomic
def set_item_profile(actor, product_id, *, supply_type="MANUFACTURED", drawing_ref="", method=""):
    if supply_type not in ("MANUFACTURED", "SUBCONTRACTED", "PURCHASED"):
        raise ValidationFailed("supply_type must be MANUFACTURED, SUBCONTRACTED or PURCHASED.", code="invalid_fields")
    if not im.Product.objects.filter(pk=product_id).exists():
        raise ValidationFailed("Unknown product.", code="invalid_product")
    row, _ = m.ItemProfile.objects.update_or_create(product_id=product_id, defaults={"supply_type": supply_type, "drawing_ref": drawing_ref[:200], "method": method})
    audit("manufacturing.item_profile.set", actor, "Product", product_id, supply_type=supply_type)
    return row


def standard_cost(bom, _depth=0):
    """Per-unit standard cost: material at current cost (sub-assemblies with their own BOM are rolled up) + routing hours at work-center rates."""
    mat, conv = standard_cost_parts(bom, _depth)
    return q4(mat + conv)


def standard_cost_parts(bom, _depth=0):
    if _depth > MAX_DEPTH:
        raise DomainError("Bill of materials is nested too deeply.", code="bom_cycle")
    material = ZERO
    for ln in bom.lines.select_related("component"):
        sub = active_bom(ln.component_id)
        per = standard_cost(sub, _depth + 1) if sub is not None and unit_cost(ln.component) == ZERO else unit_cost(ln.component)
        material += per * ln.quantity * (1 + ln.scrap_percent / 100)
    conversion = sum(((s.setup_hours + s.run_hours) * s.work_center.hourly_cost for s in bom.steps.select_related("work_center")), ZERO)
    return q4(material / bom.quantity), q4(conversion / bom.quantity)


# ----------------------------------------------------------------------------- BOM lifecycle
def _check_lines(product, lines):
    if not lines:
        raise ValidationFailed("A bill of materials needs at least one component.", code="no_lines")
    seen, out = set(), []
    for i, ln in enumerate(lines, 1):
        comp = im.Product.objects.filter(pk=ln.get("component"), is_active=True).first()
        if comp is None:
            raise ValidationFailed(f"Line {i}: unknown or inactive component.", code="invalid_product")
        if comp.id == product.id:
            raise ValidationFailed("A product cannot be a component of itself.", code="bom_cycle")
        if comp.id in seen:
            raise ValidationFailed(f"Line {i}: duplicate component.", code="duplicate_component")
        qty, scrap = dec(ln.get("quantity"), "quantity"), dec(ln.get("scrap_percent", 0), "scrap_percent")
        if qty <= 0 or not (0 <= scrap < 100):
            raise ValidationFailed(f"Line {i}: quantity must be positive and scrap between 0 and 100.", code="invalid_amount")
        subs = []
        for sb in ln.get("substitutes") or []:
            sp = im.Product.objects.filter(pk=sb.get("product"), is_active=True).first()
            ratio = dec(sb.get("ratio", 1), "ratio")
            if sp is None or sp.id in (comp.id, product.id) or ratio <= 0:
                raise ValidationFailed(f"Line {i}: invalid substitute material.", code="invalid_substitute")
            subs.append((sp, ratio))
        seen.add(comp.id)
        out.append((comp, qty, scrap, subs))
    return out


def _create_lines(bom, rows):
    for c, q, sc, subs in rows:
        ln = m.BomLine.objects.create(bom=bom, component=c, quantity=q, scrap_percent=sc)
        for sp, ratio in subs:
            m.BomSubstitute.objects.create(line=ln, product=sp, ratio=ratio)


def _create_byproducts(bom, items):
    for b in items or []:
        pr, q = im.Product.objects.filter(pk=b.get("product")).first(), dec(b.get("quantity", 0), "quantity")
        if pr is None or q <= 0 or pr.id == bom.product_id:
            raise ValidationFailed("Each by-product needs a different product and a positive quantity.", code="invalid_byproduct")
        m.BomByproduct.objects.create(bom=bom, product=pr, quantity=q)


def _fill(bom, lines, steps, checks):
    _create_lines(bom, _check_lines(bom.product, lines))
    seqs = set()
    for st in steps or []:
        wc = m.WorkCenter.objects.filter(pk=st.get("work_center"), is_active=True).first()
        seq = int(st.get("sequence", 0))
        if wc is None or seq <= 0 or seq in seqs or dec(st.get("setup_hours", 0), "setup_hours") < 0 or dec(st.get("run_hours", 0), "run_hours") < 0:
            raise ValidationFailed("Each routing step needs a unique positive sequence, an active work center and non-negative hours.", code="invalid_step")
        seqs.add(seq)
        m.RoutingStep.objects.create(bom=bom, sequence=seq, name=(st.get("name") or f"Step {seq}")[:120], work_center=wc, setup_hours=dec(st.get("setup_hours", 0)), run_hours=dec(st.get("run_hours", 0)), required_skill=(st.get("required_skill") or "")[:120], tools=(st.get("tools") or "")[:300])
    for c in checks or []:
        sq = c.get("step_sequence")
        if not (c.get("name") or "").strip() or (sq is not None and int(sq) not in seqs):
            raise ValidationFailed("Each check needs a name and must refer to an existing routing step (or none for final inspection).", code="invalid_check")
        _make_check(bom, c)


def _make_check(bom, c):
    lo = dec(c["lower_limit"], "lower_limit") if c.get("lower_limit") not in (None, "") else None
    hi = dec(c["upper_limit"], "upper_limit") if c.get("upper_limit") not in (None, "") else None
    if lo is not None and hi is not None and lo > hi:
        raise ValidationFailed("lower_limit cannot exceed upper_limit.", code="invalid_check")
    m.BomCheck.objects.create(bom=bom, name=c["name"][:160], step_sequence=c.get("step_sequence"), specification=(c.get("specification") or "")[:300], lower_limit=lo, upper_limit=hi)


def _window(bom, effective_from, effective_to):
    if effective_from and effective_to and effective_to < effective_from:
        raise ValidationFailed("effective_to cannot be before effective_from.", code="invalid_dates")
    bom.effective_from, bom.effective_to = effective_from, effective_to


@transaction.atomic
def create_bom(actor, *, product_id, lines, steps=None, checks=None, quantity=1, name="", byproducts=None, effective_from=None, effective_to=None):
    product = im.Product.objects.filter(pk=product_id, is_active=True).first()
    if product is None:
        raise ValidationFailed("Unknown or inactive product.", code="invalid_product")
    qty = dec(quantity)
    if qty <= 0:
        raise ValidationFailed("quantity must be positive.", code="invalid_amount")
    last = m.Bom.objects.filter(product=product).order_by("-version").first()
    bom = m.Bom(product=product, version=(last.version + 1) if last else 1, name=name[:200], quantity=qty, created_by=actor)
    _window(bom, effective_from, effective_to)
    bom.save()
    _fill(bom, lines, steps, checks)
    _create_byproducts(bom, byproducts)
    audit("manufacturing.bom.created", actor, "Bom", bom.id, product=product.sku, version=bom.version)
    return bom


@transaction.atomic
def update_bom(actor, pk, *, lines=None, steps=None, checks=None, quantity=None, name=None, byproducts=None, effective_from=None, effective_to=None, set_window=False):
    bom = m.Bom.objects.select_for_update().filter(pk=pk).first()
    if bom is None:
        raise DomainError("Bill of materials not found.", code="not_found", status_code=404)
    if bom.status != "DRAFT":
        raise DomainError("Only a draft BOM can be edited; create a new version instead.", code="bom_frozen")
    if quantity is not None:
        bom.quantity = dec(quantity)
        if bom.quantity <= 0:
            raise ValidationFailed("quantity must be positive.", code="invalid_amount")
    if name is not None:
        bom.name = name[:200]
    if set_window:
        _window(bom, effective_from, effective_to)
    bom.save()
    if byproducts is not None:
        bom.byproducts.all().delete()
        _create_byproducts(bom, byproducts)
    if lines is not None:
        bom.lines.all().delete()
        _create_lines(bom, _check_lines(bom.product, lines))
    if steps is not None or checks is not None:
        bom.checks.all().delete()
        if steps is not None:
            bom.steps.all().delete()
        existing = [{"sequence": s.sequence} for s in bom.steps.all()]
        seqs = {s["sequence"] for s in existing}
        if steps is not None:
            _fill_steps = _fill_only_steps(bom, steps)
            seqs = _fill_steps
        for c in checks or []:
            sq = c.get("step_sequence")
            if not (c.get("name") or "").strip() or (sq is not None and int(sq) not in seqs):
                raise ValidationFailed("Each check needs a name and an existing routing step (or none for final inspection).", code="invalid_check")
            _make_check(bom, c)
    audit("manufacturing.bom.updated", actor, "Bom", bom.id)
    return bom


def _fill_only_steps(bom, steps):
    seqs = set()
    for st in steps:
        wc = m.WorkCenter.objects.filter(pk=st.get("work_center"), is_active=True).first()
        seq = int(st.get("sequence", 0))
        if wc is None or seq <= 0 or seq in seqs or dec(st.get("setup_hours", 0), "setup_hours") < 0 or dec(st.get("run_hours", 0), "run_hours") < 0:
            raise ValidationFailed("Each routing step needs a unique positive sequence, an active work center and non-negative hours.", code="invalid_step")
        seqs.add(seq)
        m.RoutingStep.objects.create(bom=bom, sequence=seq, name=(st.get("name") or f"Step {seq}")[:120], work_center=wc, setup_hours=dec(st.get("setup_hours", 0)), run_hours=dec(st.get("run_hours", 0)), required_skill=(st.get("required_skill") or "")[:120], tools=(st.get("tools") or "")[:300])
    return seqs


def _would_cycle(bom):
    """True if approving `bom` makes the product reachable from its own components through active BOMs."""
    stack, seen = [c.component_id for c in bom.lines.all()], set()
    while stack:
        pid = stack.pop()
        if pid == bom.product_id:
            return True
        if pid in seen:
            continue
        seen.add(pid)
        sub = active_bom(pid)
        if sub is not None:
            stack.extend(x.component_id for x in sub.lines.all())
    return False


@transaction.atomic
def approve_bom(actor, pk):
    bom = m.Bom.objects.select_for_update().filter(pk=pk).first()
    if bom is None:
        raise DomainError("Bill of materials not found.", code="not_found", status_code=404)
    if bom.status != "DRAFT":
        raise DomainError(f"A {bom.status} BOM cannot be approved.", code="invalid_state_transition")
    if bom.created_by == actor:
        raise DomainError("You cannot approve a bill of materials you created.", code="separation_of_duties", status_code=403)
    if _would_cycle(bom):
        raise DomainError("This bill of materials would make a product a component of itself.", code="bom_cycle")
    m.Bom.objects.filter(product=bom.product, status="ACTIVE").update(status="ARCHIVED")
    bom.status, bom.approved_by, bom.approved_at = "ACTIVE", actor, timezone.now()
    bom.save()
    audit("manufacturing.bom.approved", actor, "Bom", bom.id, version=bom.version)
    return bom


@transaction.atomic
def revise_bom(actor, pk):
    """Copy any version into a new DRAFT version."""
    src = m.Bom.objects.filter(pk=pk).first()
    if src is None:
        raise DomainError("Bill of materials not found.", code="not_found", status_code=404)
    last = m.Bom.objects.filter(product=src.product).order_by("-version").first()
    if last.status == "DRAFT":
        raise DomainError("A draft version already exists for this product.", code="draft_exists")
    new = m.Bom.objects.create(product=src.product, version=last.version + 1, name=src.name, quantity=src.quantity, created_by=actor)
    for x in src.lines.all():
        ln = m.BomLine.objects.create(bom=new, component=x.component, quantity=x.quantity, scrap_percent=x.scrap_percent)
        for sb in x.substitutes.all():
            m.BomSubstitute.objects.create(line=ln, product=sb.product, ratio=sb.ratio)
    for s in src.steps.all():
        m.RoutingStep.objects.create(bom=new, sequence=s.sequence, name=s.name, work_center=s.work_center, setup_hours=s.setup_hours, run_hours=s.run_hours, required_skill=s.required_skill, tools=s.tools)
    for c in src.checks.all():
        m.BomCheck.objects.create(bom=new, name=c.name, step_sequence=c.step_sequence, specification=c.specification, lower_limit=c.lower_limit, upper_limit=c.upper_limit)
    for b in src.byproducts.all():
        m.BomByproduct.objects.create(bom=new, product=b.product, quantity=b.quantity)
    audit("manufacturing.bom.revised", actor, "Bom", new.id, version=new.version)
    return new


@transaction.atomic
def archive_bom(actor, pk):
    bom = m.Bom.objects.select_for_update().filter(pk=pk).first()
    if bom is None:
        raise DomainError("Bill of materials not found.", code="not_found", status_code=404)
    if bom.status == "ARCHIVED":
        raise DomainError("Already archived.", code="invalid_state_transition")
    if m.ProductionOrder.objects.filter(bom=bom, status__in=("RELEASED", "IN_PROGRESS")).exists():
        raise DomainError("Production orders are running on this BOM.", code="bom_in_use")
    bom.status = "ARCHIVED"
    bom.save()
    audit("manufacturing.bom.archived", actor, "Bom", bom.id)
    return bom


# ----------------------------------------------------------------------------- explosion / where-used
def explode(product_id, quantity, _depth=0, _path=()):
    """Multi-level requirements for `quantity` of a product: [{product, quantity, level, make}] — leaves are raw/purchased items."""
    qty = dec(quantity)
    if _depth > MAX_DEPTH or product_id in _path:
        raise DomainError("Bill of materials is cyclic or nested too deeply.", code="bom_cycle")
    bom = active_bom(product_id)
    if bom is None:
        return []
    out = []
    for ln in bom.lines.select_related("component"):
        need = q4(qty / bom.quantity * ln.quantity * (1 + ln.scrap_percent / 100))
        sub = active_bom(ln.component_id)
        out.append({"product": str(ln.component_id), "sku": ln.component.sku, "quantity": str(need), "level": _depth + 1, "make": sub is not None})
        if sub is not None:
            out.extend(explode(ln.component_id, need, _depth + 1, _path + (product_id,)))
    return out


def where_used(product_id):
    return list(m.BomLine.objects.filter(component_id=product_id, bom__status="ACTIVE").values_list("bom__product__sku", flat=True))

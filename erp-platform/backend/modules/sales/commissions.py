"""Sales targets and commissions: monthly/period targets with attainment, tiered and category commission plans,
commission statements that net out returns, manager approval, and hand-over to HR as a payroll input."""
from collections import defaultdict
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.utils import timezone

from modules.crm import models as cm
from modules.crm import services as crm
from modules.sales import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.tenancy import current_tenant

ZERO = Decimal("0")
BILLABLE = ("CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED", "INVOICED")


def _manager(actor_id):
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("Only a sales manager can do this.", code="permission_denied", status_code=403)


def _dec(v, name):
    try:
        d = Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")
    if not d.is_finite():
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")
    return d


def _period(start, end):
    if not isinstance(start, date) or not isinstance(end, date) or end < start:
        raise ValidationFailed("A valid period is required.", code="invalid_dates")


def _base_2(v):
    return v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ----------------------------------------------------------------------------- targets
def set_target(actor_id, owner_id, start, end, amount):
    _manager(actor_id)
    _period(start, end)
    amt = _dec(amount, "amount")
    if amt <= 0:
        raise ValidationFailed("A target must be positive.", code="invalid_amount")
    t, _ = m.SalesTarget.objects.update_or_create(owner_id=owner_id, period_start=start, period_end=end, defaults={"amount": amt, "set_by": actor_id})
    return t


def net_sales(owner_id, start, end):
    """Net sales of the owner's customers in the period (base currency): order value minus the value of goods returned in the period, by product category."""
    sales_by_cat, returns_by_cat = defaultdict(lambda: ZERO), defaultdict(lambda: ZERO)
    lines = m.SalesOrderLine.objects.filter(order__account__owner_id=owner_id, order__status__in=BILLABLE, order__order_date__gte=start, order__order_date__lte=end).select_related("order", "product")
    for l in lines:
        sales_by_cat[(l.product.category if l.product_id else "") or ""] += l.line_total * org.get_rate(l.order.currency, l.order.order_date)
    rlines = m.SalesReturnLine.objects.filter(sales_return__order__account__owner_id=owner_id, sales_return__return_date__gte=start, sales_return__return_date__lte=end).select_related("order_line__product", "sales_return__order")
    for r in rlines:
        o = r.sales_return.order
        returns_by_cat[(r.order_line.product.category if r.order_line.product_id else "") or ""] += r.quantity * r.order_line.net_unit_price * org.get_rate(o.currency, o.order_date)
    return dict(sales_by_cat), dict(returns_by_cat)


def attainment(user_id, owner_id, start, end):
    from modules.crm import teams

    if owner_id not in teams.visible_owner_ids(user_id) and not crm.sees_all(user_id):
        raise DomainError("Not found.", code="not_found", status_code=404)
    s, r = net_sales(owner_id, start, end)
    net = sum(s.values(), ZERO) - sum(r.values(), ZERO)
    t = m.SalesTarget.objects.filter(owner_id=owner_id, period_start=start, period_end=end).first()
    return {"owner_id": str(owner_id), "net_sales": str(_base_2(net)), "target": str(t.amount) if t else None, "attainment_percent": round(float(net / t.amount * 100), 1) if t else None, "remaining": str(_base_2(t.amount - net)) if t else None}


def team_attainment(actor_id, start, end):
    _manager(actor_id)
    out = []
    for t in m.SalesTarget.objects.filter(period_start=start, period_end=end).order_by("owner_id"):
        out.append(attainment(actor_id, t.owner_id, start, end))
    return sorted(out, key=lambda r: -(r["attainment_percent"] or 0))


# ----------------------------------------------------------------------------- plans
def create_plan(actor_id, name, tiers, category_rates=None, active=True):
    _manager(actor_id)
    clean, last = [], Decimal(-1)
    for t in tiers or []:
        lo, rate = _dec(t.get("from", 0), "from"), _dec(t.get("rate"), "rate")
        if lo <= last or lo < 0 or not (0 <= rate <= 100):
            raise ValidationFailed("Tiers need increasing thresholds from 0 and rates between 0 and 100.", code="invalid_plan")
        clean.append({"from": str(lo), "rate": str(rate)})
        last = lo
    if not clean or Decimal(clean[0]["from"]) != 0:
        raise ValidationFailed("The first tier must start at 0.", code="invalid_plan")
    cats = {}
    for k, v in (category_rates or {}).items():
        rate = _dec(v, "category rate")
        if not (0 <= rate <= 100) or not str(k).strip():
            raise ValidationFailed("Category rates must be between 0 and 100.", code="invalid_plan")
        cats[str(k)] = str(rate)
    if not (name or "").strip():
        raise ValidationFailed("A plan needs a name.", code="invalid_plan")
    plan, _ = m.CommissionPlan.objects.update_or_create(name=name.strip()[:100], defaults={"tiers": clean, "category_rates": cats, "is_active": bool(active)})
    return plan


def assign_plan(actor_id, owner_id, plan_id):
    _manager(actor_id)
    plan = m.CommissionPlan.objects.filter(pk=plan_id, is_active=True).first()
    if plan is None:
        raise DomainError("Plan not found or inactive.", code="not_found", status_code=404)
    a, _ = m.PlanAssignment.objects.update_or_create(owner_id=owner_id, defaults={"plan": plan, "assigned_by": actor_id})
    return a


def _tiered(amount, tiers):
    if amount <= 0:  # a net-negative period claws back at the first tier's rate
        return amount * Decimal(tiers[0]["rate"]) / 100
    total = ZERO
    for i, t in enumerate(tiers):
        lo = Decimal(t["from"])
        hi = Decimal(tiers[i + 1]["from"]) if i + 1 < len(tiers) else None
        if amount <= lo:
            break
        top = min(amount, hi) if hi is not None else amount
        total += (top - lo) * Decimal(t["rate"]) / 100
    return total


# ----------------------------------------------------------------------------- statements
@transaction.atomic
def calculate(actor_id, owner_id, start, end):
    """(Re)calculate a DRAFT statement for the period; approved ones are immutable."""
    _manager(actor_id)
    _period(start, end)
    assignment = m.PlanAssignment.objects.select_related("plan").filter(owner_id=owner_id).first()
    if assignment is None or not assignment.plan.is_active:
        raise DomainError("This salesperson has no active commission plan.", code="no_plan", status_code=409)
    plan = assignment.plan
    existing = m.CommissionStatement.objects.select_for_update().filter(owner_id=owner_id, period_start=start, period_end=end).exclude(status="CANCELLED").first()
    if existing and existing.status != "DRAFT":
        raise DomainError("This statement is already approved.", code="invalid_state_transition")
    sales, returns = net_sales(owner_id, start, end)
    cat_rates = {k: Decimal(v) for k, v in plan.category_rates.items()}
    tier_base = ZERO
    detail = {}
    commission = ZERO
    for cat in sorted(set(sales) | set(returns)):
        net = sales.get(cat, ZERO) - returns.get(cat, ZERO)
        if cat in cat_rates:
            c = net * cat_rates[cat] / 100
            commission += c
            detail[cat or "(none)"] = {"net": str(_base_2(net)), "rate": str(cat_rates[cat]), "commission": str(_base_2(c))}
        else:
            tier_base += net
    tc = _tiered(tier_base, plan.tiers)
    commission += tc
    detail["_tiered"] = {"net": str(_base_2(tier_base)), "commission": str(_base_2(tc)), "tiers": plan.tiers}
    s_total, r_total = sum(sales.values(), ZERO), sum(returns.values(), ZERO)
    fields = dict(plan=plan, sales_amount=_base_2(s_total), returns_amount=_base_2(r_total), commission=_base_2(commission), details=detail, calculated_by=actor_id)
    if existing:
        for k, v in fields.items():
            setattr(existing, k, v)
        existing.save()
        return existing
    return m.CommissionStatement.objects.create(owner_id=owner_id, period_start=start, period_end=end, **fields)


@transaction.atomic
def approve(actor_id, statement_id):
    _manager(actor_id)
    st = m.CommissionStatement.objects.select_for_update().filter(pk=statement_id).first()
    if st is None:
        raise DomainError("Statement not found.", code="not_found", status_code=404)
    if st.status != "DRAFT":
        raise DomainError("Only a draft statement can be approved.", code="invalid_state_transition")
    if st.owner_id == actor_id:
        raise DomainError("You cannot approve your own commission.", code="separation_of_duties", status_code=403)
    st.status, st.approved_by, st.approved_at = "APPROVED", actor_id, timezone.now()
    st.save()
    record_tenant_event(current_tenant(), "sales.commission.approved", actor_user_id=actor_id, target_type="CommissionStatement", target_id=st.id, metadata={"owner": str(st.owner_id), "commission": str(st.commission)})
    notify([st.owner_id], "sales.commission.approved", "Your commission statement was approved", f"{st.period_start} to {st.period_end}: {st.commission:f}", ref_type="CommissionStatement", ref_id=str(st.id))
    return st


@transaction.atomic
def transfer_to_payroll(actor_id, statement_id, month=None):
    """Hand an approved statement to HR as a COMMISSION payroll input (HR approves it there).  Once only."""
    from modules.hr import payroll_ext

    _manager(actor_id)
    st = m.CommissionStatement.objects.select_for_update().filter(pk=statement_id).first()
    if st is None:
        raise DomainError("Statement not found.", code="not_found", status_code=404)
    if st.status != "APPROVED":
        raise DomainError("Only an approved statement can be transferred.", code="invalid_state_transition")
    month = month or date(st.period_end.year + (st.period_end.month == 12), st.period_end.month % 12 + 1, 1)
    if st.commission == 0:
        raise ValidationFailed("Nothing to transfer.", code="invalid_amount")
    inp = payroll_ext.receive_external_input(actor_id, user_id=st.owner_id, kind="COMMISSION", month=month, amount=st.commission, description=f"Sales commission {st.period_start}..{st.period_end}")
    st.status, st.payroll_input_id = "TRANSFERRED", inp.id
    st.save()
    return st, inp


def cancel(actor_id, statement_id):
    _manager(actor_id)
    n = m.CommissionStatement.objects.filter(pk=statement_id, status="DRAFT").update(status="CANCELLED")
    if not n:
        raise DomainError("Only a draft statement can be cancelled.", code="invalid_state_transition")


def statements(user_id, owner_id=None):
    qs = m.CommissionStatement.objects.all().order_by("-period_start")
    if not crm.sees_all(user_id):
        qs = qs.filter(owner_id=user_id, status__in=("APPROVED", "TRANSFERRED"))  # drafts are the manager's working copy
    if owner_id and crm.sees_all(user_id):
        qs = qs.filter(owner_id=owner_id)
    return qs

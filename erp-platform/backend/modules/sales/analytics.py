"""Sales analytics for managers and reps (each sees only their visible customers): performance, win rate, sales cycle,
average order value, discounting, customer concentration, backlog and a three-scenario revenue forecast.
Money is reported in the base currency (orders converted at their order-date rate)."""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Count
from django.utils import timezone

from modules.crm import models as cm
from modules.crm import services as crm
from modules.sales import models as m
from platform_core.organizations import services as org
from shared.api.errors import ValidationFailed

ZERO = Decimal("0")
BILLABLE = ("CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED", "INVOICED")


def _q2(v):
    return str(v.quantize(Decimal("0.01")))


def _orders(user_id, start, end):
    qs = crm.scope(m.SalesOrder.objects.filter(status__in=BILLABLE), user_id, owner_field="account__owner_id").select_related("account")
    return qs.filter(order_date__gte=start, order_date__lte=end)


def _check(start, end):
    if start is None or end is None or end < start:
        raise ValidationFailed("A valid period is required.", code="invalid_dates")


def performance(user_id, start, end):
    _check(start, end)
    orders = list(_orders(user_id, start, end))
    base = lambda o: o.total * org.get_rate(o.currency, o.order_date)
    revenue = sum((base(o) for o in orders), ZERO)
    by_month, by_customer = defaultdict(lambda: ZERO), defaultdict(lambda: ZERO)
    for o in orders:
        by_month[o.order_date.strftime("%Y-%m")] += base(o)
        by_customer[(str(o.account_id), o.account.name)] += base(o)
    ranked = sorted(by_customer.items(), key=lambda kv: -kv[1])
    top5 = sum((v for _, v in ranked[:5]), ZERO)
    hhi = sum(((v / revenue * 100) ** 2 for _, v in ranked), ZERO) if revenue else ZERO  # 10000 = one customer buys everything
    lines = m.SalesOrderLine.objects.filter(order__in=[o.id for o in orders])
    gross = sum((l.quantity * l.unit_price * org.get_rate(l.order.currency, l.order.order_date) for l in lines.select_related("order")), ZERO)
    net = sum((l.line_total * org.get_rate(l.order.currency, l.order.order_date) for l in lines.select_related("order")), ZERO)
    opps = crm.scope(cm.Opportunity.objects.filter(status__in=("WON", "LOST"), closed_at__date__gte=start, closed_at__date__lte=end), user_id)
    won, lost = opps.filter(status="WON"), opps.filter(status="LOST")
    cycles = [(o.closed_at - o.created_at).days for o in won if o.closed_at]
    quotes = crm.scope(m.Quotation.objects.filter(created_at__date__gte=start, created_at__date__lte=end), user_id, owner_field="account__owner_id")
    nq = quotes.count()
    return {
        "period": [str(start), str(end)], "orders": len(orders), "revenue": _q2(revenue), "average_order_value": _q2(revenue / len(orders)) if orders else "0.00",
        "average_discount_percent": round(float((gross - net) / gross * 100), 1) if gross else 0.0,
        "win_rate_percent": round(100 * won.count() / (won.count() + lost.count()), 1) if (won.count() + lost.count()) else None, "avg_sales_cycle_days": round(sum(cycles) / len(cycles), 1) if cycles else None,
        "quote_to_order_percent": round(100 * quotes.filter(status="CONVERTED").count() / nq, 1) if nq else None,
        "trend": {k: _q2(v) for k, v in sorted(by_month.items())},
        "top_customers": [{"account": a, "name": n, "revenue": _q2(v), "share_percent": round(float(v / revenue * 100), 1)} for (a, n), v in ranked[:5]] if revenue else [],
        "top5_share_percent": round(float(top5 / revenue * 100), 1) if revenue else 0.0, "concentration_hhi": round(float(hhi)),
    }


def backlog(user_id, today=None):
    """Value still to deliver and still to invoice on confirmed orders (base currency), with the oldest open orders."""
    today = today or timezone.now().date()
    to_deliver = to_invoice = ZERO
    rows = []
    qs = crm.scope(m.SalesOrder.objects.filter(status__in=("CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED")), user_id, owner_field="account__owner_id").select_related("account").prefetch_related("lines")
    for o in qs:
        rate = org.get_rate(o.currency, o.order_date)
        d = sum((max(l.quantity - l.delivered_quantity, ZERO) * l.net_unit_price for l in o.lines.all()), ZERO) * rate
        i = sum((l.invoiceable * l.net_unit_price for l in o.lines.all()), ZERO) * rate
        to_deliver += d
        to_invoice += i
        rows.append({"order": o.number, "customer": o.account.name, "age_days": (today - o.order_date).days, "to_deliver": _q2(d), "to_invoice": _q2(i)})
    rows.sort(key=lambda r: -r["age_days"])
    return {"to_deliver": _q2(to_deliver), "to_invoice": _q2(to_invoice), "orders": len(rows), "oldest": rows[:10]}


def forecast(user_id, today=None, months=3, committed_probability=90):
    """Three scenarios for the next months, base currency: WORST = backlog still to deliver + deals at or above the committed
    probability; LIKELY = backlog + probability-weighted pipeline; BEST = backlog + the whole open pipeline.
    Also the run-rate of the last three months for comparison."""
    today = today or timezone.now().date()
    if not 1 <= months <= 12:
        raise ValidationFailed("months must be between 1 and 12.", code="invalid_months")
    horizon = today + timedelta(days=30 * months)
    back = Decimal(backlog(user_id, today)["to_deliver"])
    worst = likely = best = ZERO
    per_month = defaultdict(lambda: {"worst": ZERO, "likely": ZERO, "best": ZERO})
    for o in crm.scope(cm.Opportunity.objects.filter(status="OPEN").select_related("stage"), user_id):
        if o.expected_close and o.expected_close > horizon:
            continue
        v = o.amount * org.get_rate(o.currency, today)
        key = o.expected_close.strftime("%Y-%m") if o.expected_close else "unscheduled"
        w = v * o.stage.probability / 100
        c = v if o.stage.probability >= committed_probability else ZERO
        for name, val in (("worst", c), ("likely", w), ("best", v)):
            per_month[key][name] += val
        worst += c
        likely += w
        best += v
    start = today - timedelta(days=90)
    run = sum((o.total * org.get_rate(o.currency, o.order_date) for o in _orders(user_id, start, today)), ZERO) / 3
    return {"months": months, "backlog": _q2(back), "worst": _q2(back + worst), "likely": _q2(back + likely), "best": _q2(back + best), "monthly_run_rate": _q2(run), "run_rate_over_horizon": _q2(run * months),
            "pipeline_by_month": {k: {n: _q2(x) for n, x in v.items()} for k, v in sorted(per_month.items())}}

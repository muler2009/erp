"""CRM insights: customer value segmentation, retention / churn risk, lifetime value, cross-sell and upsell hints,
satisfaction, and the CRM dashboards.  All figures are read-only aggregates over records the caller may see.
Revenue is summed per currency (orders in the chosen currency only; no silent conversion)."""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Avg, Count, Max, Sum
from django.utils import timezone

from modules.crm import models as m
from modules.crm.services import scope
from modules.finance import services as fin
from modules.sales import models as sm
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

REVENUE_STATUSES = ("CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED", "INVOICED")
AT_RISK_DAYS, CHURN_DAYS = 90, 180
TIERS = (("A", Decimal("0.8")), ("B", Decimal("0.95")), ("C", Decimal("1.01")))  # cumulative revenue share cut-offs (Pareto)


def _cur(currency):
    return (currency or fin.base_currency().code).upper()


def _orders(user_id, currency, accounts=None):
    qs = sm.SalesOrder.objects.filter(status__in=REVENUE_STATUSES, currency=currency, account__in=accounts if accounts is not None else scope(m.CrmAccount.objects.all(), user_id))
    return qs


def account_summary(user_id, account_id, currency=None):
    """One customer's purchase history and value (lifetime value, average order, last purchase, open items)."""
    from modules.crm.services import _own

    acct = _own(m.CrmAccount, account_id, user_id, "Account")
    cur = _cur(currency)
    orders = sm.SalesOrder.objects.filter(account=acct, status__in=REVENUE_STATUSES, currency=cur)
    agg = orders.aggregate(total=Sum("total"), n=Count("id"), last=Max("order_date"))
    n = agg["n"] or 0
    total = agg["total"] or Decimal("0")
    products = defaultdict(lambda: Decimal("0"))
    for ln in sm.SalesOrderLine.objects.filter(order__in=orders, product__isnull=False).select_related("product"):
        products[ln.product.name if hasattr(ln.product, "name") else str(ln.product_id)] += ln.line_total
    top = sorted(products.items(), key=lambda kv: -kv[1])[:5]
    cases = m.ServiceCase.objects.filter(account=acct)
    return {
        "account": str(acct.id), "currency": cur, "lifetime_value": str(total), "orders": n,
        "average_order_value": str((total / n).quantize(Decimal("0.01"))) if n else "0.00",
        "first_order": orders.order_by("order_date").values_list("order_date", flat=True).first(), "last_order": agg["last"],
        "top_products": [{"product": k, "revenue": str(v)} for k, v in top],
        "open_opportunities": m.Opportunity.objects.filter(account=acct, status="OPEN").count(),
        "open_cases": cases.filter(status__in=("NEW", "OPEN", "PENDING_CUSTOMER")).count(),
        "satisfaction": _round(cases.aggregate(a=Avg("satisfaction"))["a"]),
    }


def _round(v):
    return None if v is None else round(float(v), 2)


def _revenue_by_account(user_id, currency):
    rows = _orders(user_id, currency).values("account").annotate(total=Sum("total"), n=Count("id"), last=Max("order_date"))
    return {r["account"]: r for r in rows}


def segmentation(user_id, currency=None):
    """Value tiers (A = accounts making up the first 80 % of revenue, B the next 15 %, C the rest, N = no purchases)."""
    cur = _cur(currency)
    rev = _revenue_by_account(user_id, cur)
    accts = {a.id: a for a in scope(m.CrmAccount.objects.filter(is_active=True), user_id)}
    ranked = sorted(((aid, r["total"]) for aid, r in rev.items() if aid in accts), key=lambda x: -x[1])
    grand = sum((t for _, t in ranked), Decimal("0"))
    out = {"A": [], "B": [], "C": [], "N": []}
    run = Decimal("0")
    for aid, t in ranked:
        share_before = run / grand if grand else Decimal("0")
        run += t
        tier = next(k for k, cut in TIERS if share_before < cut)
        out[tier].append({"account": str(aid), "name": accts[aid].name, "revenue": str(t)})
    out["N"] = [{"account": str(a.id), "name": a.name, "revenue": "0"} for aid, a in accts.items() if aid not in rev]
    by_segment = defaultdict(lambda: Decimal("0"))
    by_industry = defaultdict(lambda: Decimal("0"))
    for aid, t in ranked:
        by_segment[accts[aid].segment or "(none)"] += t
        by_industry[accts[aid].industry or "(none)"] += t
    return {"currency": cur, "total_revenue": str(grand), "tiers": out, "by_segment": {k: str(v) for k, v in by_segment.items()}, "by_industry": {k: str(v) for k, v in by_industry.items()}}


def retention(user_id, today=None, currency=None):
    """Customers who used to buy but have gone quiet: AT_RISK after 90 days, CHURNED after 180 days without an order."""
    today = today or timezone.localdate()
    rev = _revenue_by_account(user_id, _cur(currency))
    out = {"active": [], "at_risk": [], "churned": [], "never_purchased": 0}
    for a in scope(m.CrmAccount.objects.filter(is_active=True), user_id):
        r = rev.get(a.id)
        if not r:
            out["never_purchased"] += 1
            continue
        idle = (today - r["last"]).days
        key = "churned" if idle >= CHURN_DAYS else "at_risk" if idle >= AT_RISK_DAYS else "active"
        out[key].append({"account": str(a.id), "name": a.name, "last_order": r["last"], "days_idle": idle, "lifetime_value": str(r["total"])})
    for k in ("at_risk", "churned"):
        out[k].sort(key=lambda x: -x["days_idle"])
    n = len(out["active"]) + len(out["at_risk"]) + len(out["churned"])
    out["churn_rate_percent"] = round(100 * len(out["churned"]) / n, 1) if n else 0.0
    return out


def refresh_lifecycle(actor_id, today=None, currency=None):
    """Write lifecycle_stage from purchasing behaviour (manager action).  Returns the number of accounts changed."""
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("Only a sales manager can refresh customer lifecycle stages.", code="permission_denied", status_code=403)
    r = retention(actor_id, today, currency)
    changed = 0
    for stage, rows in (("ACTIVE", r["active"]), ("AT_RISK", r["at_risk"]), ("CHURNED", r["churned"])):
        for row in rows:
            n = m.CrmAccount.objects.filter(pk=row["account"]).exclude(lifecycle_stage=stage).update(lifecycle_stage=stage)
            changed += n
    record_tenant_event(current_tenant(), "crm.lifecycle.refreshed", actor_user_id=actor_id, target_type="CrmAccount", target_id=None, metadata={"changed": str(changed)})
    return changed


def cross_sell(user_id, account_id, currency=None, limit=5):
    """Products bought by similar customers (same industry or segment) but not by this one."""
    from modules.crm.services import _own

    acct = _own(m.CrmAccount, account_id, user_id, "Account")
    cur = _cur(currency)
    bought = set(sm.SalesOrderLine.objects.filter(order__account=acct, order__status__in=REVENUE_STATUSES, product__isnull=False).values_list("product_id", flat=True))
    peers = m.CrmAccount.objects.exclude(pk=acct.id)
    if acct.industry:
        peers = peers.filter(industry=acct.industry)
    elif acct.segment:
        peers = peers.filter(segment=acct.segment)
    else:
        return []
    rows = (sm.SalesOrderLine.objects.filter(order__account__in=peers, order__status__in=REVENUE_STATUSES, order__currency=cur, product__isnull=False)
            .exclude(product_id__in=bought).values("product_id", "product__name").annotate(buyers=Count("order__account", distinct=True), revenue=Sum("line_total")).order_by("-buyers", "-revenue")[:limit])
    return [{"product": str(r["product_id"]), "name": r["product__name"], "peer_buyers": r["buyers"], "revenue": str(r["revenue"])} for r in rows]


def satisfaction(user_id, date_from=None, date_to=None):
    cases = m.ServiceCase.objects.filter(account__in=scope(m.CrmAccount.objects.all(), user_id), satisfaction__isnull=False)
    if date_from:
        cases = cases.filter(created_at__date__gte=date_from)
    if date_to:
        cases = cases.filter(created_at__date__lte=date_to)
    dist = {str(i): 0 for i in range(1, 6)}
    for r in cases.values("satisfaction").annotate(n=Count("id")):
        dist[str(r["satisfaction"])] = r["n"]
    n = sum(dist.values())
    by_acct = cases.values("account", "account__name").annotate(a=Avg("satisfaction"), n=Count("id")).order_by("a")[:10]
    return {"responses": n, "average": _round(cases.aggregate(a=Avg("satisfaction"))["a"]), "distribution": dist,
            "promoter_percent": round(100 * (dist["5"] + dist["4"]) / n, 1) if n else 0.0, "detractor_percent": round(100 * (dist["1"] + dist["2"]) / n, 1) if n else 0.0,
            "lowest_accounts": [{"account": str(r["account"]), "name": r["account__name"], "average": _round(r["a"]), "responses": r["n"]} for r in by_acct]}


def profitability(user_id, currency=None):
    """Gross margin per customer from delivered cost (DeliveryLine.unit_cost is base-currency; only valid when the
    chosen currency is the base currency)."""
    cur = _cur(currency)
    if cur != fin.base_currency().code:
        raise ValidationFailed("Profitability is reported in the base currency only.", code="base_currency_only")
    rows = defaultdict(lambda: [Decimal("0"), Decimal("0")])
    qs = sm.DeliveryLine.objects.filter(delivery__order__status__in=REVENUE_STATUSES, delivery__order__currency=cur, delivery__order__account__in=scope(m.CrmAccount.objects.all(), user_id)).select_related("order_line", "delivery__order__account")
    for dl in qs:
        a = dl.delivery.order.account
        rows[a].__setitem__(0, rows[a][0] + dl.quantity * dl.order_line.net_unit_price)
        rows[a].__setitem__(1, rows[a][1] + dl.quantity * dl.unit_cost)
    out = []
    for a, (rev, cost) in rows.items():
        margin = rev - cost
        out.append({"account": str(a.id), "name": a.name, "revenue": str(rev.quantize(Decimal("0.01"))), "cost": str(cost.quantize(Decimal("0.01"))), "margin": str(margin.quantize(Decimal("0.01"))), "margin_percent": round(float(margin / rev * 100), 1) if rev else 0.0})
    return sorted(out, key=lambda r: -Decimal(r["margin"]))


def dashboard(user_id, today=None, currency=None):
    """Manager / rep dashboard: lead sources and conversion, pipeline, neglected opportunities, activity performance."""
    today = today or timezone.localdate()
    leads = scope(m.Lead.objects.exclude(status="MERGED"), user_id)
    src = {}
    for r in leads.values("source").annotate(total=Count("id")):
        conv = leads.filter(source=r["source"], status="CONVERTED").count()
        src[r["source"] or "(unknown)"] = {"leads": r["total"], "converted": conv, "conversion_percent": round(100 * conv / r["total"], 1)}
    opps = scope(m.Opportunity.objects.all(), user_id)
    open_ = opps.filter(status="OPEN")
    cutoff = timezone.now() - timedelta(days=14)
    neglected = [{"id": str(o.id), "name": o.name, "owner_id": str(o.owner_id), "last_activity_at": o.last_activity_at, "amount": str(o.amount)} for o in open_.filter(last_activity_at__lt=cutoff).order_by("last_activity_at")[:20]] + \
                [{"id": str(o.id), "name": o.name, "owner_id": str(o.owner_id), "last_activity_at": None, "amount": str(o.amount)} for o in open_.filter(last_activity_at__isnull=True, created_at__lt=cutoff)[:20]]
    acts = scope(m.Activity.objects.all(), user_id)
    perf = []
    for r in acts.values("owner_id").annotate(total=Count("id"), done=Count("done_at")):
        perf.append({"owner_id": str(r["owner_id"]), "activities": r["total"], "completed": r["done"], "completion_percent": round(100 * r["done"] / r["total"], 1)})
    ret = retention(user_id, today, currency)
    return {
        "lead_sources": src,
        "pipeline": {"open_count": open_.count(), "open_value_by_currency": {r["currency"]: str(r["v"]) for r in open_.values("currency").annotate(v=Sum("amount"))}},
        "won": opps.filter(status="WON").count(), "lost": opps.filter(status="LOST").count(),
        "neglected_opportunities": neglected,
        "activity_performance": perf,
        "overdue_activities": acts.filter(done_at__isnull=True, due_at__lt=timezone.now()).count(),
        "customers": {"active": len(ret["active"]), "at_risk": len(ret["at_risk"]), "churned": len(ret["churned"]), "churn_rate_percent": ret["churn_rate_percent"]},
    }

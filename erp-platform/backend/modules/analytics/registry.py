"""Datasets (tabular results) and metrics (single numbers) that dashboards, KPIs and reports are built from.

Every dataset and metric names the permission a viewer must hold. Datasets reuse the owning module's own report
functions, so a number here is the same number the module shows."""
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Callable

from django.utils import timezone

from shared.api.errors import DomainError, ValidationFailed

PERIODS = ("TODAY", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "MTD", "LAST_MONTH", "QTD", "LAST_QUARTER", "YTD", "LAST_YEAR")


@dataclass(frozen=True)
class Dataset:
    code: str
    title: str
    module: str
    permission: str
    fn: Callable
    params: dict  # name -> "date" | "int" | "str" | tuple of choices


@dataclass(frozen=True)
class Metric:
    code: str
    label: str
    module: str
    permission: str
    unit: str
    direction: str  # which way is better, used as the default when a KPI is created
    fn: Callable  # fn(as_of, params) -> Decimal | None


DATASETS = {}
METRICS = {}


def dataset(code, title, module, permission, params=None):
    def deco(fn):
        DATASETS[code] = Dataset(code, title, module, permission, fn, params or {})
        return fn
    return deco


def metric(code, label, module, permission, unit="", direction="HIGHER"):
    def deco(fn):
        METRICS[code] = Metric(code, label, module, permission, unit, direction, fn)
        return fn
    return deco


def today():
    return timezone.localdate()


# ----------------------------------------------------------------------------- periods and parameters
def period_range(period, on=None):
    on = on or today()
    q_start = date(on.year, 3 * ((on.month - 1) // 3) + 1, 1)
    if period == "TODAY":
        return on, on
    if period == "LAST_7_DAYS":
        return on - timedelta(days=6), on
    if period == "LAST_30_DAYS":
        return on - timedelta(days=29), on
    if period == "LAST_90_DAYS":
        return on - timedelta(days=89), on
    if period == "MTD":
        return on.replace(day=1), on
    if period == "LAST_MONTH":
        end = on.replace(day=1) - timedelta(days=1)
        return end.replace(day=1), end
    if period == "QTD":
        return q_start, on
    if period == "LAST_QUARTER":
        end = q_start - timedelta(days=1)
        return date(end.year, 3 * ((end.month - 1) // 3) + 1, 1), end
    if period == "YTD":
        return date(on.year, 1, 1), on
    if period == "LAST_YEAR":
        return date(on.year - 1, 1, 1), date(on.year - 1, 12, 31)
    raise ValidationFailed("Unknown period. Use one of " + ", ".join(PERIODS) + ".", code="invalid_period")


def _parse(name, kind, value):
    if kind == "date":
        if isinstance(value, date):
            return value
        try:
            return date.fromisoformat(str(value))
        except ValueError:
            raise ValidationFailed(f"{name} must be YYYY-MM-DD.", code="invalid_date")
    if kind == "int":
        try:
            n = int(value)
        except (TypeError, ValueError):
            raise ValidationFailed(f"{name} must be a whole number.", code="invalid_fields")
        if not 0 <= n <= 3660:
            raise ValidationFailed(f"{name} is out of range.", code="invalid_fields")
        return n
    if isinstance(kind, tuple):
        if value not in kind:
            raise ValidationFailed(f"{name} must be one of {', '.join(kind)}.", code="invalid_fields")
        return value
    return str(value)[:80]


def resolve_params(ds, raw, on=None):
    """Validate the caller's parameters against what the dataset accepts and fill in date defaults. A `period` sets the dates."""
    raw = dict(raw or {})
    on = on or today()
    period = raw.pop("period", None)
    unknown = set(raw) - set(ds.params)
    if unknown:
        raise ValidationFailed("Unknown parameter(s): " + ", ".join(sorted(unknown)), code="unknown_param")
    out = {k: _parse(k, ds.params[k], v) for k, v in raw.items() if v not in (None, "")}
    if period:
        a, b = period_range(period, on)
        if "date_from" in ds.params:
            out["date_from"], out["date_to"] = a, b
        if "as_of" in ds.params:
            out["as_of"] = b
    if "date_from" in ds.params:
        out.setdefault("date_to", on)
        out.setdefault("date_from", out["date_to"].replace(day=1))
        if out["date_from"] > out["date_to"]:
            raise ValidationFailed("date_from is after date_to.", code="invalid_dates")
    if "as_of" in ds.params:
        out.setdefault("as_of", on)
    return out


# ----------------------------------------------------------------------------- shaping results into rows
def flatten(obj, prefix="", limit=20):
    """Nested dashboard data as metric/value rows, so any module's dashboard can be shown, filtered and exported as a table."""
    rows = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            rows.extend(flatten(v, f"{prefix}.{k}" if prefix else str(k), limit))
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj[:limit]):
            rows.extend(flatten(v, f"{prefix}[{i}]", limit))
    else:
        rows.append({"metric": prefix, "value": "" if obj is None else obj})
    return rows


def rows_of(result):
    if isinstance(result, list):
        return [r if isinstance(r, dict) else {"value": r} for r in result]
    return flatten(result)


def run_dataset(user_id, code, raw_params=None, on=None, checked=False):
    """Run a dataset for one user. The viewer needs the dataset's permission; nothing here widens what a module already allows."""
    from platform_core.authorization import services as authz
    ensure_quality_datasets()
    ds = DATASETS.get(code)
    if ds is None:
        raise DomainError("Dataset not found.", code="not_found", status_code=404)
    if not checked and not authz.has_permission(user_id, ds.permission):
        raise DomainError("You do not have access to this data.", code="permission_denied", status_code=403)
    params = resolve_params(ds, raw_params, on)
    return ds, params, rows_of(ds.fn(user_id, params))


def num(v):
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError):
        return None


def base_currency():
    from platform_core.organizations import services as org
    c = org.get_company().base_currency
    return getattr(c, "code", c) if c else None


# ----------------------------------------------------------------------------- finance
POSTED = ["POSTED", "REVERSED"]
FIN = "reports.financial.view"
ZERO = Decimal("0")


@dataset("finance.trial-balance", "Trial balance", "finance", FIN, {"as_of": "date"})
def ds_trial_balance(u, p):
    from modules.finance import reports
    tb = reports.trial_balance(p["as_of"])
    return tb["rows"] + [{"code": "", "name": "TOTAL", "type": "", "debit": "", "credit": "", "balance_debit": tb["total_debit"], "balance_credit": tb["total_credit"]}]


@dataset("finance.profit-loss", "Profit and loss", "finance", FIN, {"date_from": "date", "date_to": "date"})
def ds_pnl(u, p):
    from modules.finance import reports
    r = reports.profit_and_loss(p["date_from"], p["date_to"])
    rows = [{"section": "REVENUE", **x} for x in r["revenue"]] + [{"section": "EXPENSE", **x} for x in r["expenses"]]
    return rows + [{"section": "TOTAL REVENUE", "code": "", "name": "", "amount": r["total_revenue"]}, {"section": "TOTAL EXPENSES", "code": "", "name": "", "amount": r["total_expenses"]},
                   {"section": "NET PROFIT", "code": "", "name": "", "amount": r["net_profit"]}]


@dataset("finance.balance-sheet", "Balance sheet", "finance", FIN, {"as_of": "date"})
def ds_balance_sheet(u, p):
    from modules.finance import reports
    r = reports.balance_sheet(p["as_of"])
    rows = [{"section": s, **x} for s, key in (("ASSET", "assets"), ("LIABILITY", "liabilities"), ("EQUITY", "equity")) for x in r[key]]
    return rows + [{"section": "EQUITY", "code": "", "name": "Current earnings", "amount": r["current_earnings"]}, {"section": "TOTAL ASSETS", "code": "", "name": "", "amount": r["total_assets"]},
                   {"section": "TOTAL LIABILITIES", "code": "", "name": "", "amount": r["total_liabilities"]}, {"section": "TOTAL EQUITY", "code": "", "name": "", "amount": r["total_equity"]}]


def cash_flow_rows(date_from, date_to):
    from django.db.models import Sum
    from modules.finance import models as fm
    rows, tot = [], dict(opening=ZERO, inflows=ZERO, outflows=ZERO, closing=ZERO)
    for ba in fm.BankAccount.objects.filter(is_active=True).select_related("gl_account").order_by("name"):
        base = fm.JournalLine.objects.filter(account=ba.gl_account, entry__status__in=POSTED)
        before = base.filter(entry__entry_date__lt=date_from).aggregate(d=Sum("debit"), c=Sum("credit"))
        within = base.filter(entry__entry_date__gte=date_from, entry__entry_date__lte=date_to).aggregate(d=Sum("debit"), c=Sum("credit"))
        opening = (before["d"] or ZERO) - (before["c"] or ZERO)
        inflow, outflow = within["d"] or ZERO, within["c"] or ZERO
        closing = opening + inflow - outflow
        rows.append({"account": ba.name, "kind": "CASH" if ba.is_cash else "BANK", "opening": str(opening), "inflows": str(inflow), "outflows": str(outflow), "net_change": str(inflow - outflow), "closing": str(closing)})
        for k, v in (("opening", opening), ("inflows", inflow), ("outflows", outflow), ("closing", closing)):
            tot[k] += v
    rows.append({"account": "TOTAL", "kind": "", "opening": str(tot["opening"]), "inflows": str(tot["inflows"]), "outflows": str(tot["outflows"]), "net_change": str(tot["inflows"] - tot["outflows"]), "closing": str(tot["closing"])})
    return rows


@dataset("finance.cash-flow", "Cash flow by bank and cash account", "finance", FIN, {"date_from": "date", "date_to": "date"})
def ds_cash_flow(u, p):
    return cash_flow_rows(p["date_from"], p["date_to"])


BUCKETS = ("not_due", "d1_30", "d31_60", "d61_90", "d90_plus")


def aging(kind, as_of):
    from modules.finance import models as fm
    out = {}
    for inv in fm.Invoice.objects.filter(kind=kind, status="POSTED", invoice_date__lte=as_of).select_related("partner"):
        left = inv.total - inv.paid_amount
        if left <= 0:
            continue
        base = left * (inv.total_base / inv.total) if inv.total_base and inv.total else left
        late = (as_of - (inv.due_date or inv.invoice_date)).days
        key = "not_due" if late <= 0 else "d1_30" if late <= 30 else "d31_60" if late <= 60 else "d61_90" if late <= 90 else "d90_plus"
        row = out.setdefault(inv.partner.name, {k: ZERO for k in BUCKETS})
        row[key] += base
    return out


def aging_rows(kind, as_of):
    data = aging(kind, as_of)
    rows = [{"partner": k, **{b: str(v[b].quantize(Decimal("0.01"))) for b in BUCKETS}, "total": str(sum(v.values(), ZERO).quantize(Decimal("0.01")))} for k, v in data.items()]
    rows.sort(key=lambda r: Decimal(r["total"]), reverse=True)
    if rows:
        tot = {b: sum((Decimal(r[b]) for r in rows), ZERO) for b in BUCKETS}
        rows.append({"partner": "TOTAL", **{b: str(v) for b, v in tot.items()}, "total": str(sum(tot.values(), ZERO))})
    return rows


@dataset("finance.receivables-aging", "Receivables aging", "finance", FIN, {"as_of": "date"})
def ds_ar(u, p):
    return aging_rows("CUSTOMER_INVOICE", p["as_of"])


@dataset("finance.payables-aging", "Payables aging", "finance", FIN, {"as_of": "date"})
def ds_ap(u, p):
    return aging_rows("SUPPLIER_INVOICE", p["as_of"])


def _pnl_totals(a, b):
    from modules.finance import reports
    r = reports.profit_and_loss(a, b)
    return Decimal(r["total_revenue"]), Decimal(r["total_expenses"])


def _span(as_of, params):
    return period_range(params.get("period", "LAST_30_DAYS"), as_of)


@metric("finance.revenue", "Revenue", "finance", FIN, "currency")
def m_revenue(as_of, p):
    return _pnl_totals(*_span(as_of, p))[0]


@metric("finance.expenses", "Expenses", "finance", FIN, "currency", "LOWER")
def m_expenses(as_of, p):
    return _pnl_totals(*_span(as_of, p))[1]


@metric("finance.net_profit", "Net profit", "finance", FIN, "currency")
def m_profit(as_of, p):
    r, e = _pnl_totals(*_span(as_of, p))
    return r - e


@metric("finance.net_margin_pct", "Net margin", "finance", FIN, "%")
def m_margin(as_of, p):
    r, e = _pnl_totals(*_span(as_of, p))
    return None if r <= 0 else ((r - e) * 100 / r).quantize(Decimal("0.01"))


@metric("finance.cash_balance", "Cash and bank balance", "finance", FIN, "currency")
def m_cash(as_of, p):
    rows = cash_flow_rows(as_of, as_of)
    return Decimal(rows[-1]["closing"])


@metric("finance.ar_outstanding", "Receivables outstanding", "finance", FIN, "currency", "LOWER")
def m_ar(as_of, p):
    return sum((sum(v.values(), ZERO) for v in aging("CUSTOMER_INVOICE", as_of).values()), ZERO)


@metric("finance.ar_overdue", "Receivables overdue", "finance", FIN, "currency", "LOWER")
def m_ar_overdue(as_of, p):
    return sum((sum(v[b] for b in BUCKETS[1:]) for v in aging("CUSTOMER_INVOICE", as_of).values()), ZERO)


@metric("finance.ap_outstanding", "Payables outstanding", "finance", FIN, "currency", "LOWER")
def m_ap(as_of, p):
    return sum((sum(v.values(), ZERO) for v in aging("SUPPLIER_INVOICE", as_of).values()), ZERO)


# ----------------------------------------------------------------------------- sales and CRM
@dataset("sales.by-customer", "Sales by customer", "sales", "sales.view", {"date_from": "date", "date_to": "date"})
def ds_sales_customer(u, p):
    from modules.sales import services
    return services.sales_report(p["date_from"], p["date_to"])["by_customer"]


@dataset("sales.by-product", "Sales by product", "sales", "sales.view", {"date_from": "date", "date_to": "date"})
def ds_sales_product(u, p):
    from modules.sales import services
    return services.sales_report(p["date_from"], p["date_to"])["by_product"]


@dataset("crm.dashboard", "CRM dashboard", "crm", "crm.view")
def ds_crm(u, p):
    from modules.crm import insights
    return insights.dashboard(u)


@metric("sales.order_value", "Sales order value (base currency)", "sales", "sales.view", "currency")
def m_sales_value(as_of, p):
    from django.db.models import Sum
    from modules.sales import models as sm
    a, b = _span(as_of, p)
    qs = sm.SalesOrder.objects.filter(order_date__gte=a, order_date__lte=b, status__in=["CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED", "INVOICED"], currency=base_currency())
    return qs.aggregate(v=Sum("total"))["v"] or ZERO


@metric("sales.order_count", "Sales orders", "sales", "sales.view", "count")
def m_sales_count(as_of, p):
    from modules.sales import models as sm
    a, b = _span(as_of, p)
    return Decimal(sm.SalesOrder.objects.filter(order_date__gte=a, order_date__lte=b, status__in=["CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED", "INVOICED"]).count())


@metric("crm.open_pipeline", "Open pipeline (base currency)", "crm", "crm.view_all", "currency")
def m_pipeline(as_of, p):
    from django.db.models import Sum
    from modules.crm import models as cm
    return cm.Opportunity.objects.filter(status="OPEN", currency=base_currency()).aggregate(v=Sum("amount"))["v"] or ZERO


@metric("crm.win_rate_pct", "Opportunity win rate", "crm", "crm.view_all", "%")
def m_win_rate(as_of, p):
    from modules.crm import models as cm
    a, b = _span(as_of, p)
    qs = cm.Opportunity.objects.filter(closed_at__date__gte=a, closed_at__date__lte=b)
    won, lost = qs.filter(status="WON").count(), qs.filter(status="LOST").count()
    return None if not (won + lost) else (Decimal(won) * 100 / (won + lost)).quantize(Decimal("0.01"))


# ----------------------------------------------------------------------------- procurement
@dataset("procurement.spend", "Procurement spend", "procurement", "procurement.view", {"date_from": "date", "date_to": "date", "group_by": ("supplier", "category", "month")})
def ds_spend(u, p):
    from modules.procurement import analytics
    return analytics.spend(p["date_from"], p["date_to"], p.get("group_by", "supplier"))


@dataset("procurement.supplier-performance", "Supplier delivery and quality performance", "procurement", "procurement.view", {"date_from": "date", "date_to": "date"})
def ds_supplier_perf(u, p):
    from modules.procurement import analytics
    return analytics.supplier_performance(p["date_from"], p["date_to"])


@dataset("procurement.cycle-times", "Procurement cycle times", "procurement", "procurement.view", {"date_from": "date", "date_to": "date"})
def ds_cycle(u, p):
    from modules.procurement import analytics
    return analytics.cycle_times(p["date_from"], p["date_to"])


@dataset("procurement.price-variance", "Purchase price variance", "procurement", "procurement.view", {"date_from": "date", "date_to": "date"})
def ds_price_var(u, p):
    from modules.procurement import analytics
    return analytics.price_variance(p["date_from"], p["date_to"])


@metric("procurement.spend", "Procurement spend (base currency)", "procurement", "procurement.view", "currency", "LOWER")
def m_spend(as_of, p):
    from django.db.models import Sum
    from modules.procurement import models as pm
    a, b = _span(as_of, p)
    qs = pm.PurchaseOrder.objects.filter(order_date__gte=a, order_date__lte=b, currency=base_currency()).exclude(status__in=("DRAFT", "PENDING_APPROVAL", "CANCELLED"))
    return qs.aggregate(v=Sum("total"))["v"] or ZERO


@metric("procurement.on_time_receipt_pct", "Supplier on-time receipts", "procurement", "procurement.view", "%")
def m_on_time_receipt(as_of, p):
    from modules.procurement import models as pm
    a, b = _span(as_of, p)
    dated = ok = 0
    for ln in pm.GoodsReceiptLine.objects.filter(receipt__receipt_date__gte=a, receipt__receipt_date__lte=b).select_related("receipt__order"):
        target = ln.receipt.order.promised_date or ln.receipt.order.expected_date
        if target:
            dated += 1
            ok += 1 if ln.receipt.receipt_date <= target else 0
    return None if not dated else (Decimal(ok) * 100 / dated).quantize(Decimal("0.01"))


@metric("procurement.po_to_receipt_days", "Days from order to receipt", "procurement", "procurement.view", "days", "LOWER")
def m_po_days(as_of, p):
    from modules.procurement import analytics
    a, b = _span(as_of, p)
    v = analytics.cycle_times(a, b)["po_to_receipt_days"]
    return None if v is None else Decimal(v)


# ----------------------------------------------------------------------------- inventory
@dataset("inventory.stock-summary", "Stock on hand and value", "inventory", "inventory.view", {"group_by": ("warehouse", "location", "category")})
def ds_stock(u, p):
    from modules.inventory import reports
    return reports.stock_summary(p.get("group_by", "warehouse"))


@dataset("inventory.abc", "ABC analysis of consumption", "inventory", "inventory.view", {"days": "int"})
def ds_abc(u, p):
    from modules.inventory import reports
    return reports.abc_analysis(days=p.get("days", 365) or 365)


@dataset("inventory.turnover", "Inventory turnover", "inventory", "inventory.view", {"days": "int"})
def ds_turnover(u, p):
    from modules.inventory import reports
    return reports.turnover(days=p.get("days", 365) or 365)


@metric("inventory.stock_value", "Inventory value", "inventory", "inventory.view", "currency")
def m_stock_value(as_of, p):
    from django.db.models import Sum
    from modules.inventory import models as im
    return im.ProductCost.objects.aggregate(v=Sum("total_value"))["v"] or ZERO


@metric("inventory.turnover", "Inventory turnover (x)", "inventory", "inventory.view", "x")
def m_turnover(as_of, p):
    from modules.inventory import reports
    v = reports.turnover(days=int(p.get("days", 365)))["turnover"]
    return None if v is None else Decimal(v)


# ----------------------------------------------------------------------------- HR
@dataset("hr.dashboard", "HR dashboard", "hr", "hr.analytics.view", {"year": "int"})
def ds_hr(u, p):
    from modules.hr import analytics
    return analytics.dashboard(u, p.get("year") or None)


@dataset("hr.headcount", "Headcount", "hr", "hr.analytics.view", {"as_of": "date"})
def ds_headcount(u, p):
    from modules.hr import analytics
    return analytics.headcount(u, p["as_of"])


@metric("hr.headcount", "Headcount", "hr", "hr.analytics.view", "people")
def m_headcount(as_of, p):
    from modules.hr import analytics
    return Decimal(analytics._headcount_on(as_of))


# ----------------------------------------------------------------------------- manufacturing
MFG = "manufacturing.view"


@dataset("manufacturing.plan-vs-actual", "Production plan against actual", "manufacturing", MFG, {"date_from": "date", "date_to": "date"})
def ds_plan_actual(u, p):
    from modules.manufacturing import analytics
    return analytics.plan_vs_actual(p["date_from"], p["date_to"])


@dataset("manufacturing.output", "Production output", "manufacturing", MFG, {"date_from": "date", "date_to": "date"})
def ds_output(u, p):
    from modules.manufacturing import analytics
    return analytics.output(p["date_from"], p["date_to"])


@dataset("manufacturing.oee", "Overall equipment effectiveness", "manufacturing", MFG, {"date_from": "date", "date_to": "date"})
def ds_oee(u, p):
    from modules.manufacturing import analytics
    return analytics.oee(p["date_from"], p["date_to"])


@dataset("manufacturing.on-time", "Production on-time completion", "manufacturing", MFG, {"date_from": "date", "date_to": "date"})
def ds_mfg_on_time(u, p):
    from modules.manufacturing import analytics
    return analytics.on_time(p["date_from"], p["date_to"])


@metric("manufacturing.on_time_pct", "Production orders completed on time", "manufacturing", MFG, "%")
def m_mfg_on_time(as_of, p):
    from modules.manufacturing import analytics
    a, b = _span(as_of, p)
    v = analytics.on_time(a, b)["on_time_pct"]
    return None if v is None else Decimal(v)


@metric("manufacturing.oee_pct", "OEE (average of work centres)", "manufacturing", MFG, "%")
def m_oee(as_of, p):
    from modules.manufacturing import analytics
    a, b = _span(as_of, p)
    rows = analytics.oee(a, b)
    return None if not rows else (sum((Decimal(r["oee_pct"]) for r in rows), ZERO) / len(rows)).quantize(Decimal("0.01"))


@metric("manufacturing.efficiency_pct", "Labour efficiency", "manufacturing", MFG, "%")
def m_eff(as_of, p):
    from modules.manufacturing import analytics
    a, b = _span(as_of, p)
    v = analytics.efficiency(a, b)["efficiency_pct"]
    return None if v is None else Decimal(v)


# ----------------------------------------------------------------------------- supply chain
SCM = "supply_chain.view"


@dataset("supply-chain.dashboard", "Supply chain dashboard", "supply_chain", SCM, {"date_from": "date", "date_to": "date"})
def ds_scm(u, p):
    from modules.supply_chain import performance
    return performance.dashboard(today(), p["date_from"], p["date_to"])


@dataset("supply-chain.fulfilment-risk", "Order fulfilment risk", "supply_chain", SCM)
def ds_fulfil_risk(u, p):
    from modules.supply_chain import performance
    return performance.fulfilment_risk(today())


@metric("supply_chain.fill_rate_pct", "Orders delivered complete first time", "supply_chain", SCM, "%")
def m_fill_rate(as_of, p):
    from modules.supply_chain import performance
    a, b = _span(as_of, p)
    v = performance.fulfilment_rate(a, b)["fill_rate_pct"]
    return None if v is None else Decimal(v)


@metric("supply_chain.late_orders", "Late orders", "supply_chain", SCM, "count", "LOWER")
def m_late(as_of, p):
    from modules.supply_chain import performance
    return Decimal(len([r for r in performance.fulfilment_risk(as_of) if r["status"] == "LATE"]))


# ----------------------------------------------------------------------------- projects and assets
@dataset("projects.portfolio", "Project portfolio", "projects", "projects.view")
def ds_portfolio(u, p):
    from modules.projects import reporting
    return reporting.portfolio(u)["projects"]


@dataset("projects.profitability", "Project profitability", "projects", "projects.view")
def ds_proj_profit(u, p):
    from modules.projects import reporting, services
    rows = []
    for pr in services.visible_projects(u).order_by("code"):
        if services.can_see_costs(u, pr):
            rows.append({"name": pr.name, "status": pr.status, **reporting.profitability(pr.id)})
    return [{k: v for k, v in r.items() if k != "forecast"} | {"forecast_margin": r["forecast"]["margin"]} for r in rows]


@metric("projects.active", "Active projects", "projects", "projects.view_all", "count")
def m_projects_active(as_of, p):
    from modules.projects import models as pm
    return Decimal(pm.Project.objects.filter(status="ACTIVE").count())


@metric("projects.portfolio_margin", "Margin on active and closed projects", "projects", "projects.view_all", "currency")
def m_proj_margin(as_of, p):
    from modules.projects import models as pm
    from modules.projects import reporting
    return sum((Decimal(reporting.profitability(x.id, as_of)["margin"]) for x in pm.Project.objects.filter(status__in=("ACTIVE", "CLOSED"))), ZERO)


@dataset("assets.dashboard", "Assets dashboard", "assets", "assets.view")
def ds_assets(u, p):
    from modules.assets import planning
    return planning.dashboard()


# ----------------------------------------------------------------------------- quality
QA = "quality.analytics.view"


@dataset("quality.dashboard", "Quality dashboard", "quality", QA)
def ds_quality_dash(u, p):
    from modules.quality import analytics
    return analytics.dashboard()


def _register_quality_reports():
    from modules.quality import analytics as qa
    for code, (title, _fn) in qa.REPORTS.items():
        def make(code):
            def fn(u, p):
                return qa.run(code, {k: v for k, v in p.items()})["rows"]
            return fn
        DATASETS[f"quality.{code}"] = Dataset(f"quality.{code}", title, "quality", QA, make(code), {"date_from": "date", "date_to": "date", "status": "str", "severity": "str", "group_by": "str"})


def _quality_metric(code, label, key, unit="count", direction="LOWER"):
    def fn(as_of, p):
        from modules.quality import analytics as qa
        v = qa.dashboard()[key]
        return None if v is None else Decimal(str(v))
    METRICS[code] = Metric(code, label, "quality", QA, unit, direction, fn)


_quality_metric("quality.open_ncrs", "Open non-conformances", "open_ncrs")
_quality_metric("quality.overdue_capas", "Overdue CAPAs", "overdue_capas")
_quality_metric("quality.inspection_pass_rate", "Inspection pass rate (90 days)", "inspection_pass_rate_90d", "%", "HIGHER")
_quality_metric("quality.active_holds", "Active quality holds", "active_holds")
_quality_metric("quality.open_complaints", "Open customer complaints", "open_complaints")
_quality_metric("quality.equipment_overdue", "Equipment overdue for calibration", "equipment_overdue")


def catalog_for(user_id):
    from platform_core.authorization import services as authz
    ensure_quality_datasets()
    from modules.analytics import core
    perms = core.Perms(user_id)
    allowed = perms.can
    return {"datasets": [{"code": d.code, "title": d.title, "module": d.module, "params": {k: (list(v) if isinstance(v, tuple) else v) for k, v in d.params.items()}} for d in DATASETS.values() if allowed(d.permission)],
            "metrics": [{"code": m.code, "label": m.label, "module": m.module, "unit": m.unit, "direction": m.direction} for m in METRICS.values() if allowed(m.permission)]}


def ensure_quality_datasets():
    if "quality.ncr-register" not in DATASETS:
        _register_quality_reports()

"""KPI definitions, daily snapshots and traffic-light status."""
import logging
from datetime import timedelta

from django.db import transaction

from modules.analytics import core, registry
from modules.analytics import models as m
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify

log = logging.getLogger(__name__)

DEFAULT_KPIS = [
    # code, name, metric, params, direction, target, warn_at, critical_at
    ("revenue_30d", "Revenue, last 30 days", "finance.revenue", {"period": "LAST_30_DAYS"}, None, None, None, None),
    ("net_margin_30d", "Net margin, last 30 days", "finance.net_margin_pct", {"period": "LAST_30_DAYS"}, "HIGHER", "15", "10", "0"),
    ("cash_balance", "Cash and bank balance", "finance.cash_balance", {}, None, None, None, None),
    ("ar_overdue", "Receivables overdue", "finance.ar_overdue", {}, "LOWER", None, None, None),
    ("ap_outstanding", "Payables outstanding", "finance.ap_outstanding", {}, None, None, None, None),
    ("sales_orders_30d", "Sales order value, last 30 days", "sales.order_value", {"period": "LAST_30_DAYS"}, None, None, None, None),
    ("open_pipeline", "Open pipeline", "crm.open_pipeline", {}, None, None, None, None),
    ("win_rate_90d", "Win rate, last 90 days", "crm.win_rate_pct", {"period": "LAST_90_DAYS"}, "HIGHER", "30", "20", "10"),
    ("procurement_spend_30d", "Procurement spend, last 30 days", "procurement.spend", {"period": "LAST_30_DAYS"}, None, None, None, None),
    ("supplier_on_time_30d", "Supplier on-time receipts, last 30 days", "procurement.on_time_receipt_pct", {"period": "LAST_30_DAYS"}, "HIGHER", "95", "85", "70"),
    ("inventory_value", "Inventory value", "inventory.stock_value", {}, None, None, None, None),
    ("inventory_turnover", "Inventory turnover", "inventory.turnover", {"days": 365}, "HIGHER", None, None, None),
    ("headcount", "Headcount", "hr.headcount", {}, None, None, None, None),
    ("production_on_time_30d", "Production orders on time, last 30 days", "manufacturing.on_time_pct", {"period": "LAST_30_DAYS"}, "HIGHER", "90", "80", "65"),
    ("oee_30d", "OEE, last 30 days", "manufacturing.oee_pct", {"period": "LAST_30_DAYS"}, "HIGHER", "75", "60", "45"),
    ("fill_rate_30d", "Orders delivered complete, last 30 days", "supply_chain.fill_rate_pct", {"period": "LAST_30_DAYS"}, "HIGHER", "95", "85", "70"),
    ("late_orders", "Late orders", "supply_chain.late_orders", {}, "LOWER", "0", "3", "10"),
    ("active_projects", "Active projects", "projects.active", {}, None, None, None, None),
    ("open_ncrs", "Open non-conformances", "quality.open_ncrs", {}, "LOWER", "5", "10", "20"),
    ("overdue_capas", "Overdue CAPAs", "quality.overdue_capas", {}, "LOWER", "0", "2", "5"),
    ("inspection_pass_rate", "Inspection pass rate, 90 days", "quality.inspection_pass_rate", {}, "HIGHER", "97", "92", "85"),
]


def kpi_dict(k):
    mt = registry.METRICS.get(k.metric)
    return {"id": str(k.id), "code": k.code, "name": k.name, "description": k.description, "metric": k.metric, "module": mt.module if mt else None, "params": k.params, "unit": k.unit or (mt.unit if mt else ""),
            "direction": k.direction, "target": str(k.target) if k.target is not None else None, "warn_at": str(k.warn_at) if k.warn_at is not None else None,
            "critical_at": str(k.critical_at) if k.critical_at is not None else None, "owner_id": str(k.owner_id) if k.owner_id else None, "is_active": k.is_active, "is_system": k.is_system}


def status_of(k, value):
    if value is None:
        return "NO_DATA"
    if k.target is None and k.warn_at is None and k.critical_at is None:
        return "NO_TARGET"
    higher = k.direction == "HIGHER"
    worse = (lambda v, t: v <= t) if higher else (lambda v, t: v >= t)
    if k.critical_at is not None and worse(value, k.critical_at):
        return "CRITICAL"
    if k.warn_at is not None and worse(value, k.warn_at):
        return "WARN"
    if k.target is not None:
        met = value >= k.target if higher else value <= k.target
        return "GOOD" if met else "WARN"
    return "GOOD"


def _validate(data, existing=None):
    d = dict(data)
    metric = d.get("metric", existing.metric if existing else None)
    registry.ensure_quality_datasets()
    mt = registry.METRICS.get(metric)
    if mt is None:
        raise ValidationFailed("Unknown metric.", code="unknown_metric")
    params = d.get("params", existing.params if existing else {}) or {}
    bad = set(params) - {"period", "days"}
    if bad:
        raise ValidationFailed("Unknown KPI parameter(s): " + ", ".join(sorted(bad)), code="unknown_param")
    if "period" in params and params["period"] not in registry.PERIODS:
        raise ValidationFailed("Unknown period.", code="invalid_period")
    if "days" in params:
        registry._parse("days", "int", params["days"])
    direction = d.get("direction", existing.direction if existing else mt.direction)
    if direction not in ("HIGHER", "LOWER"):
        raise ValidationFailed("direction must be HIGHER or LOWER.", code="invalid_fields")
    vals = {n: core.dec(d[n], n) if n in d else getattr(existing, n, None) for n in ("target", "warn_at", "critical_at")}
    t, w, c = vals["target"], vals["warn_at"], vals["critical_at"]
    seq = [x for x in (c, w, t) if x is not None]
    ordered = seq == sorted(seq) if direction == "HIGHER" else seq == sorted(seq, reverse=True)
    if not ordered:
        raise ValidationFailed("Thresholds must run critical, warning, target in the better direction.", code="invalid_thresholds")
    return d, mt, vals, direction


@transaction.atomic
def create_kpi(actor, data):
    core.need(data, "code", "name", "metric")
    if m.Kpi.objects.filter(code=data["code"]).exists():
        raise ValidationFailed("A KPI with this code exists.", code="duplicate")
    d, mt, vals, direction = _validate(data)
    k = m.Kpi.objects.create(code=d["code"][:40], name=d["name"][:150], description=d.get("description", "")[:300], metric=d["metric"], params=d.get("params") or {}, unit=d.get("unit", ""), direction=direction,
                             owner_id=d.get("owner_id"), created_by=actor, **vals)
    core.audit("analytics.kpi.created", actor, "analytics.kpi", k.id, code=k.code)
    return k


@transaction.atomic
def update_kpi(actor, pk, data):
    k = m.Kpi.objects.select_for_update().filter(pk=pk).first()
    if k is None:
        raise core.nf("KPI")
    if "metric" in data and data["metric"] != k.metric and k.is_system:
        raise DomainError("The metric of a built-in KPI cannot be changed; create a new KPI instead.", code="system_kpi", status_code=409)
    d, mt, vals, direction = _validate(data, k)
    for f in ("name", "description", "unit", "owner_id", "params", "is_active"):
        if f in d:
            setattr(k, f, d[f])
    if "metric" in d:
        k.metric = d["metric"]
    k.direction = direction
    for n, v in vals.items():
        setattr(k, n, v)
    k.save()
    core.audit("analytics.kpi.updated", actor, "analytics.kpi", k.id, code=k.code)
    return k


def get(pk):
    k = m.Kpi.objects.filter(pk=pk).first()
    if k is None:
        raise core.nf("KPI")
    return k


def get_by_code(code):
    k = m.Kpi.objects.filter(code=code).first()
    if k is None:
        raise core.nf("KPI")
    return k


def compute(k, as_of=None):
    """Value and status for one KPI as of a date. A metric that fails is logged and shows as NO_DATA; it never stops the other KPIs."""
    as_of = as_of or core.today()
    mt = registry.METRICS.get(k.metric)
    if mt is None:
        return None, "NO_DATA"
    try:
        value = mt.fn(as_of, dict(k.params or {}))
    except Exception:
        log.exception("KPI %s could not be computed", k.code)
        return None, "NO_DATA"
    return value, status_of(k, value)


@transaction.atomic
def snapshot(k, as_of=None):
    as_of = as_of or core.today()
    value, status = compute(k, as_of)
    prev = k.snapshots.filter(as_of__lt=as_of).order_by("-as_of").first()
    snap, _ = m.KpiSnapshot.objects.update_or_create(kpi=k, as_of=as_of, defaults={"value": value, "status": status})
    return snap, prev


def snap_dict(s):
    return {"as_of": s.as_of.isoformat(), "value": str(s.value) if s.value is not None else None, "status": s.status}


def view(user_id, k, refresh=False, perms=None):
    """The KPI with its latest value, or a restricted marker when the viewer may not see the underlying data."""
    mt = registry.METRICS.get(k.metric)
    base = kpi_dict(k)
    if mt is None or not core.can(user_id, mt.permission, perms):
        return {**base, "restricted": True, "latest": None, "previous": None, "change_pct": None}
    snaps = [] if refresh else list(k.snapshots.order_by("-as_of")[:2])
    if not snaps:
        snapshot(k)
        snaps = list(k.snapshots.order_by("-as_of")[:2])
    latest, prev = (snaps + [None, None])[:2]
    change = None
    if latest and prev and latest.value is not None and prev.value not in (None, 0):
        change = str(((latest.value - prev.value) * 100 / abs(prev.value)).quantize(core.dec("0.01")))
    return {**base, "restricted": False, "latest": snap_dict(latest) if latest else None, "previous": snap_dict(prev) if prev else None, "change_pct": change}


def series(user_id, k, days=30, perms=None):
    mt = registry.METRICS.get(k.metric)
    if mt is None or not core.can(user_id, mt.permission, perms):
        raise DomainError("You do not have access to this data.", code="permission_denied", status_code=403)
    days = max(1, min(int(days), 730))
    since = core.today() - timedelta(days=days - 1)
    return [snap_dict(s) for s in k.snapshots.filter(as_of__gte=since).order_by("as_of")]


def list_kpis(user_id, module=None, include_inactive=False):
    qs = m.Kpi.objects.all().order_by("name")
    if not include_inactive:
        qs = qs.filter(is_active=True)
    out = []
    perms = core.Perms(user_id)
    for k in qs:
        mt = registry.METRICS.get(k.metric)
        if module and (not mt or mt.module != module):
            continue
        out.append(view(user_id, k, perms=perms))
    return out


@transaction.atomic
def ensure_defaults(actor=None):
    """Create the built-in KPIs once. Existing ones (and any edits to them) are left alone."""
    registry.ensure_quality_datasets()
    made = 0
    for code, name, metric, params, direction, target, warn, crit in DEFAULT_KPIS:
        if m.Kpi.objects.filter(code=code).exists() or metric not in registry.METRICS:
            continue
        mt = registry.METRICS[metric]
        m.Kpi.objects.create(code=code, name=name, metric=metric, params=params, unit=mt.unit, direction=direction or mt.direction, target=core.dec(target), warn_at=core.dec(warn), critical_at=core.dec(crit), is_system=True, created_by=actor)
        made += 1
    return made


def daily(as_of=None):
    """Snapshot every active KPI. Owners and KPI managers hear once when a KPI turns critical."""
    as_of = as_of or core.today()
    done = alerts = 0
    notify_on = org.get_setting("analytics.notify_kpi_critical", True)
    for k in m.Kpi.objects.filter(is_active=True):
        snap, prev = snapshot(k, as_of)
        done += 1
        if notify_on and snap.status == "CRITICAL" and (prev is None or prev.status != "CRITICAL"):
            users = set(core.users_with_permission("analytics.kpi.manage"))
            if k.owner_id:
                users.add(k.owner_id)
            if users:
                notify(list(users), "analytics.kpi_critical", f"KPI critical: {k.name}", f"Value {snap.value} against target {k.target}", ref_type="analytics.kpi", ref_id=str(k.id))
                alerts += 1
    return {"snapshots": done, "alerts": alerts}

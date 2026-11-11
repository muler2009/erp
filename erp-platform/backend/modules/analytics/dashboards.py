"""Dashboards and their widgets. A widget the viewer is not allowed to see is returned as restricted, with no data."""
from django.db import transaction

from modules.analytics import core, kpis, registry
from modules.analytics import models as m
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed

KINDS = ("KPI", "TREND", "DATASET")
VISIBILITY = ("PRIVATE", "ALL", "ROLES")

DEFAULT_DASHBOARDS = [
    ("executive", "Executive overview", "Company-wide results at a glance", 1, [
        ("KPI", "revenue_30d", None), ("KPI", "net_margin_30d", None), ("KPI", "cash_balance", None), ("KPI", "open_pipeline", None), ("KPI", "headcount", None), ("KPI", "active_projects", None),
        ("KPI", "open_ncrs", None), ("KPI", "fill_rate_30d", None), ("TREND", "revenue_30d", 30), ("TREND", "cash_balance", 30)]),
    ("finance", "Finance", "Profitability, cash and working capital", 2, [
        ("KPI", "revenue_30d", None), ("KPI", "net_margin_30d", None), ("KPI", "cash_balance", None), ("KPI", "ar_overdue", None), ("KPI", "ap_outstanding", None),
        ("DATASET", "finance.receivables-aging", {"period": "TODAY", "limit": 10}), ("DATASET", "finance.cash-flow", {"period": "MTD"})]),
    ("sales", "Sales", "Orders, pipeline and win rate", 3, [
        ("KPI", "sales_orders_30d", None), ("KPI", "open_pipeline", None), ("KPI", "win_rate_90d", None), ("TREND", "sales_orders_30d", 30),
        ("DATASET", "sales.by-customer", {"period": "MTD", "limit": 10}), ("DATASET", "sales.by-product", {"period": "MTD", "limit": 10})]),
    ("procurement", "Procurement", "Spend, supplier delivery and cycle times", 4, [
        ("KPI", "procurement_spend_30d", None), ("KPI", "supplier_on_time_30d", None), ("TREND", "supplier_on_time_30d", 30),
        ("DATASET", "procurement.spend", {"period": "MTD", "limit": 10}), ("DATASET", "procurement.supplier-performance", {"period": "LAST_30_DAYS", "limit": 10})]),
    ("inventory", "Inventory", "Stock value, turnover and consumption", 5, [
        ("KPI", "inventory_value", None), ("KPI", "inventory_turnover", None), ("DATASET", "inventory.stock-summary", {"limit": 10}), ("DATASET", "inventory.abc", {"limit": 10})]),
    ("hr", "People", "Headcount and workforce analytics", 6, [("KPI", "headcount", None), ("TREND", "headcount", 90), ("DATASET", "hr.headcount", {"limit": 20})]),
    ("production", "Production", "Output, on-time completion and equipment effectiveness", 7, [
        ("KPI", "production_on_time_30d", None), ("KPI", "oee_30d", None), ("KPI", "fill_rate_30d", None), ("KPI", "late_orders", None),
        ("DATASET", "manufacturing.oee", {"period": "LAST_30_DAYS", "limit": 10}), ("DATASET", "manufacturing.output", {"period": "LAST_30_DAYS", "limit": 10})]),
    ("projects", "Projects", "Portfolio status and profitability", 8, [("KPI", "active_projects", None), ("DATASET", "projects.portfolio", {"limit": 20}), ("DATASET", "projects.profitability", {"limit": 20})]),
    ("quality", "Quality", "Non-conformances, CAPA and inspection performance", 9, [
        ("KPI", "open_ncrs", None), ("KPI", "overdue_capas", None), ("KPI", "inspection_pass_rate", None), ("TREND", "open_ncrs", 30), ("DATASET", "quality.dashboard", {"limit": 25})]),
]


def role_names(user_id):
    return set(authz._active_assignments(user_id).values_list("role__name", flat=True))


def can_see(user_id, d):
    if not d.is_active:
        return False
    if d.owner_id and d.owner_id == user_id:
        return True
    if d.visibility == "ALL":
        return core.can(user_id, "analytics.view")
    if d.visibility == "ROLES":
        return core.can(user_id, "analytics.view") and bool(role_names(user_id) & set(d.roles or []))
    return False


def _own_or_404(user_id, pk):
    d = m.Dashboard.objects.filter(pk=pk).first()
    if d is None or not can_see(user_id, d):
        raise core.nf("Dashboard")
    return d


def dash_dict(d, widgets=False):
    out = {"id": str(d.id), "code": d.code, "name": d.name, "description": d.description, "visibility": d.visibility, "roles": d.roles, "owner_id": str(d.owner_id) if d.owner_id else None,
           "is_system": d.is_system, "is_active": d.is_active}
    if widgets:
        out["widgets"] = [{"id": str(w.id), "position": w.position, "kind": w.kind, "title": w.title, "config": w.config} for w in d.widgets.order_by("position", "created_at")]
    return out


def _check_widget(kind, config):
    if kind not in KINDS:
        raise ValidationFailed("kind must be KPI, TREND or DATASET.", code="invalid_fields")
    registry.ensure_quality_datasets()
    cfg = dict(config or {})
    if kind in ("KPI", "TREND"):
        if not m.Kpi.objects.filter(code=cfg.get("kpi")).exists():
            raise ValidationFailed("Choose an existing KPI.", code="unknown_kpi")
        if kind == "TREND":
            days = int(cfg.get("days", 30))
            if not 1 <= days <= 730:
                raise ValidationFailed("days must be 1-730.", code="invalid_fields")
            cfg["days"] = days
        return {"kpi": cfg["kpi"], **({"days": cfg["days"]} if kind == "TREND" else {})}
    ds = registry.DATASETS.get(cfg.get("dataset"))
    if ds is None:
        raise ValidationFailed("Choose an existing dataset.", code="unknown_dataset")
    raw = {k: v for k, v in cfg.items() if k not in ("dataset", "limit")}
    registry.resolve_params(ds, raw)  # rejects unknown or malformed parameters now, not when somebody opens the dashboard
    limit = int(cfg.get("limit", 10))
    if not 1 <= limit <= 200:
        raise ValidationFailed("limit must be 1-200.", code="invalid_fields")
    return {"dataset": ds.code, "limit": limit, **raw}


@transaction.atomic
def create_dashboard(actor, data):
    core.need(data, "code", "name")
    vis = data.get("visibility", "PRIVATE")
    if vis not in VISIBILITY:
        raise ValidationFailed("visibility must be PRIVATE, ALL or ROLES.", code="invalid_fields")
    roles = list(data.get("roles") or [])
    if vis == "ROLES" and not roles:
        raise ValidationFailed("Name the roles that can see this dashboard.", code="invalid_fields")
    if m.Dashboard.objects.filter(code=data["code"]).exists():
        raise ValidationFailed("A dashboard with this code exists.", code="duplicate")
    d = m.Dashboard.objects.create(code=data["code"][:40], name=data["name"][:150], description=data.get("description", "")[:300], visibility=vis, roles=roles, owner_id=actor)
    for i, w in enumerate(data.get("widgets") or [], start=1):
        add_widget(actor, d.id, w, _position=i)
    core.audit("analytics.dashboard.created", actor, "analytics.dashboard", d.id, code=d.code)
    return d


@transaction.atomic
def update_dashboard(actor, pk, data):
    d = _own_or_404(actor, pk)
    for f in ("name", "description"):
        if f in data:
            setattr(d, f, data[f])
    if "visibility" in data:
        if data["visibility"] not in VISIBILITY:
            raise ValidationFailed("visibility must be PRIVATE, ALL or ROLES.", code="invalid_fields")
        d.visibility = data["visibility"]
    if "roles" in data:
        d.roles = list(data["roles"] or [])
    if d.visibility == "ROLES" and not d.roles:
        raise ValidationFailed("Name the roles that can see this dashboard.", code="invalid_fields")
    if "is_active" in data:
        d.is_active = bool(data["is_active"])
    d.save()
    core.audit("analytics.dashboard.updated", actor, "analytics.dashboard", d.id)
    return d


@transaction.atomic
def add_widget(actor, dashboard_id, data, _position=None):
    d = _own_or_404(actor, dashboard_id)
    config = _check_widget(data.get("kind"), data.get("config"))
    pos = _position or data.get("position") or ((d.widgets.order_by("-position").values_list("position", flat=True).first() or 0) + 1)
    return m.Widget.objects.create(dashboard=d, position=pos, kind=data["kind"], title=(data.get("title") or "")[:150], config=config)


@transaction.atomic
def update_widget(actor, pk, data):
    w = m.Widget.objects.select_related("dashboard").filter(pk=pk).first()
    if w is None:
        raise core.nf("Widget")
    _own_or_404(actor, w.dashboard_id)
    if "config" in data or "kind" in data:
        kind = data.get("kind", w.kind)
        w.config = _check_widget(kind, data.get("config", w.config))
        w.kind = kind
    for f in ("title", "position"):
        if f in data:
            setattr(w, f, data[f])
    w.save()
    return w


@transaction.atomic
def delete_widget(actor, pk):
    w = m.Widget.objects.filter(pk=pk).first()
    if w is None:
        raise core.nf("Widget")
    _own_or_404(actor, w.dashboard_id)
    w.delete()


def widget_data(user_id, w, perms=None):
    base = {"id": str(w.id), "kind": w.kind, "title": w.title, "position": w.position, "config": w.config}
    cfg = w.config
    if w.kind in ("KPI", "TREND"):
        k = m.Kpi.objects.filter(code=cfg.get("kpi"), is_active=True).first()
        if k is None:
            return {**base, "restricted": False, "missing": True, "data": None}
        v = kpis.view(user_id, k, perms=perms)
        if v["restricted"]:
            return {**base, "restricted": True, "data": None}
        if w.kind == "KPI":
            return {**base, "restricted": False, "data": v}
        return {**base, "restricted": False, "data": {"kpi": v, "series": kpis.series(user_id, k, cfg.get("days", 30), perms=perms)}}
    ds = registry.DATASETS.get(cfg.get("dataset"))
    if ds is None or not core.can(user_id, ds.permission, perms):
        return {**base, "restricted": ds is not None, "missing": ds is None, "data": None}
    raw = {k: v for k, v in cfg.items() if k not in ("dataset", "limit")}
    _, params, rows = registry.run_dataset(user_id, ds.code, raw, checked=True)
    return {**base, "restricted": False, "data": {"rows": rows[: int(cfg.get("limit", 10))], "total_rows": len(rows), "params": {k: str(v) for k, v in params.items()}}}


def view(user_id, pk):
    d = _own_or_404(user_id, pk)
    out = dash_dict(d)
    perms = core.Perms(user_id)
    out["widgets"] = [widget_data(user_id, w, perms) for w in d.widgets.order_by("position", "created_at")]
    return out


def list_dashboards(user_id):
    return [dash_dict(d) for d in m.Dashboard.objects.filter(is_active=True).order_by("position", "name") if can_see(user_id, d)]


@transaction.atomic
def ensure_defaults(actor=None):
    """Create the built-in KPIs and dashboards once; later edits are kept."""
    made_k = kpis.ensure_defaults(actor)
    made_d = 0
    for code, name, desc, pos, widgets in DEFAULT_DASHBOARDS:
        if m.Dashboard.objects.filter(code=code).exists():
            continue
        d = m.Dashboard.objects.create(code=code, name=name, description=desc, visibility="ALL", is_system=True, position=pos, owner_id=actor)
        for i, (kind, ref, extra) in enumerate(widgets, start=1):
            if kind == "DATASET":
                cfg = {"dataset": ref, **(extra or {})}
                ds = registry.DATASETS.get(ref)
                if ds is None:
                    continue
                m.Widget.objects.create(dashboard=d, position=i, kind=kind, title=ds.title, config=cfg)
            else:
                k = m.Kpi.objects.filter(code=ref).first()
                if k is None:
                    continue
                cfg = {"kpi": ref, **({"days": extra} if kind == "TREND" else {})}
                m.Widget.objects.create(dashboard=d, position=i, kind=kind, title=k.name, config=cfg)
        made_d += 1
    return {"kpis": made_k, "dashboards": made_d}

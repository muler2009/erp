"""Analytics API. Each endpoint is a row in ROUTES: path, then method -> (permission, handler). Handlers call services only."""
from datetime import date

from django.http import HttpResponse
from rest_framework.parsers import JSONParser
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.analytics import core, dashboards, kpis, registry, reports, schedules
from modules.analytics import models as m
from platform_core.authorization.permissions import require
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate

V, EXP, KPI, DASH = "analytics.view", "analytics.export", "analytics.kpi.manage", "analytics.dashboard.manage"


def _policy(self):
    entry = self.table.get(self.request.method)
    return [require(entry[0])()] if entry else [require(V)()]


class _Base(APIView):
    parser_classes = [JSONParser]
    table = {}

    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        cls.get_permissions = _policy

    def _run(self, request, kw):
        out = self.table[request.method][1](request, **kw)
        if isinstance(out, HttpResponse):
            return out
        data, status = out if isinstance(out, tuple) else (out, 200)
        return Response(data, status=status)

    def get(self, request, **kw):
        return self._run(request, kw)

    post = patch = put = delete = get


def me(r):
    return r.user.id


def _params(r):
    d = {k: v for k, v in r.query_params.items() if v != ""}
    for k in ("fmt", "columns", "sort", "filters", "days", "module", "page_size", "cursor"):
        d.pop(k, None)
    return d


def _file(data, ctype, name):
    resp = HttpResponse(data, content_type=ctype)
    resp["Content-Disposition"] = f'attachment; filename="{name}"'
    resp["X-Content-Type-Options"] = "nosniff"
    return resp


def _json_list(r, key):
    import json
    raw = r.query_params.get(key)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        raise ValidationFailed(f"{key} must be valid JSON.", code="invalid_fields")


# ---------------------------------------------------------------- catalog and datasets
def h_catalog(r):
    return registry.catalog_for(me(r))


def h_dataset_run(r, code):
    cols = r.query_params.get("columns")
    ds, resolved, rows = reports.run_dataset_rows(me(r), code, _params(r), cols.split(",") if cols else None, _json_list(r, "filters"), _json_list(r, "sort"))
    return {"dataset": ds.code, "title": ds.title, "params": {k: str(v) for k, v in resolved.items()}, "row_count": len(rows), "rows": rows[:1000], "truncated": len(rows) > 1000}


def h_dataset_export(r, code):
    cols = r.query_params.get("columns")
    return _file(*reports.export_dataset(me(r), code, _params(r), r.query_params.get("fmt", "XLSX"), cols.split(",") if cols else None, _json_list(r, "filters"), _json_list(r, "sort")))


# ---------------------------------------------------------------- KPIs
def h_kpi_list(r):
    return kpis.list_kpis(me(r), r.query_params.get("module"), r.query_params.get("all") == "1" and core.can(me(r), KPI))


def h_kpi_create(r):
    return kpis.kpi_dict(kpis.create_kpi(me(r), dict(r.data))), 201


def h_kpi_get(r, pk):
    return kpis.view(me(r), kpis.get(pk), refresh=True)


def h_kpi_update(r, pk):
    return kpis.kpi_dict(kpis.update_kpi(me(r), pk, dict(r.data)))


def h_kpi_series(r, pk):
    return kpis.series(me(r), kpis.get(pk), int(r.query_params.get("days", 30)))




# ---------------------------------------------------------------- dashboards
def h_dash_list(r):
    return dashboards.list_dashboards(me(r))


def h_dash_create(r):
    return dashboards.dash_dict(dashboards.create_dashboard(me(r), dict(r.data)), widgets=True), 201


def h_dash_get(r, pk):
    return dashboards.view(me(r), pk)


def h_dash_update(r, pk):
    return dashboards.dash_dict(dashboards.update_dashboard(me(r), pk, dict(r.data)), widgets=True)


def h_widget_add(r, pk):
    w = dashboards.add_widget(me(r), pk, dict(r.data))
    return {"id": str(w.id), "kind": w.kind, "title": w.title, "position": w.position, "config": w.config}, 201


def h_widget_update(r, pk):
    w = dashboards.update_widget(me(r), pk, dict(r.data))
    return {"id": str(w.id), "kind": w.kind, "title": w.title, "position": w.position, "config": w.config}


def h_widget_delete(r, pk):
    dashboards.delete_widget(me(r), pk)
    return {}, 204


def h_defaults(r):
    dashboards.ensure_defaults(me(r))
    return {"ok": True}, 200


# ---------------------------------------------------------------- saved reports
def h_report_list(r):
    return [reports.report_dict(x) for x in reports.list_reports(me(r))]


def h_report_create(r):
    return reports.report_dict(reports.create(me(r), dict(r.data))), 201


def h_report_get(r, pk):
    return reports.report_dict(reports.get(me(r), pk))


def h_report_update(r, pk):
    return reports.report_dict(reports.update(me(r), pk, dict(r.data)))


def h_report_archive(r, pk):
    reports.archive(me(r), pk)
    return {}, 204


def h_report_run(r, pk):
    rep, ds, resolved, rows = reports.run(me(r), pk, _params(r))
    return {"report": rep.name, "params": {k: str(v) for k, v in resolved.items()}, "row_count": len(rows), "rows": rows[:1000], "truncated": len(rows) > 1000}


def h_report_export(r, pk):
    return _file(*reports.export_report(me(r), pk, r.query_params.get("fmt", "XLSX"), _params(r)))


# ---------------------------------------------------------------- schedules and runs
def h_sched_list(r):
    return [schedules.sched_dict(s) for s in schedules.list_schedules(me(r))]


def h_sched_create(r):
    return schedules.sched_dict(schedules.create(me(r), dict(r.data))), 201


def h_sched_update(r, pk):
    return schedules.sched_dict(schedules.update(me(r), pk, dict(r.data)))


def h_sched_stop(r, pk):
    return schedules.sched_dict(schedules.stop(me(r), pk))


def h_sched_run(r, pk):
    run = schedules.run_now(me(r), pk)
    return reports.run_dict(run), 201


def h_runs(r):
    return paginate(r, reports.run_log(me(r), r.query_params.get("report_id")), reports.run_dict)


ROUTES = [
    ("catalog", {"GET": (V, h_catalog)}),
    ("datasets/<str:code>", {"GET": (V, h_dataset_run)}),
    ("datasets/<str:code>/export", {"GET": (EXP, h_dataset_export)}),
    ("kpis", {"GET": (V, h_kpi_list), "POST": (KPI, h_kpi_create)}),
    ("kpis/<uuid:pk>", {"GET": (V, h_kpi_get), "PATCH": (KPI, h_kpi_update)}),
    ("kpis/<uuid:pk>/series", {"GET": (V, h_kpi_series)}),
    ("dashboards", {"GET": (V, h_dash_list), "POST": (DASH, h_dash_create)}),
    ("dashboards/defaults", {"POST": (DASH, h_defaults)}),
    ("dashboards/<uuid:pk>", {"GET": (V, h_dash_get), "PATCH": (DASH, h_dash_update)}),
    ("dashboards/<uuid:pk>/widgets", {"POST": (DASH, h_widget_add)}),
    ("widgets/<uuid:pk>", {"PATCH": (DASH, h_widget_update), "DELETE": (DASH, h_widget_delete)}),
    ("reports", {"GET": (V, h_report_list), "POST": (V, h_report_create)}),
    ("reports/<uuid:pk>", {"GET": (V, h_report_get), "PATCH": (V, h_report_update), "DELETE": (V, h_report_archive)}),
    ("reports/<uuid:pk>/run", {"GET": (V, h_report_run)}),
    ("reports/<uuid:pk>/export", {"GET": (EXP, h_report_export)}),
    ("schedules", {"GET": (EXP, h_sched_list), "POST": (EXP, h_sched_create)}),
    ("schedules/<uuid:pk>", {"PATCH": (EXP, h_sched_update), "DELETE": (EXP, h_sched_stop)}),
    ("schedules/<uuid:pk>/run", {"POST": (EXP, h_sched_run)}),
    ("runs", {"GET": (V, h_runs)}),
]


def _build():
    return [(f"api/v1/analytics/{path}", type(f"AnalyticsView{i}", (_Base,), {"table": table, "__module__": __name__})) for i, (path, table) in enumerate(ROUTES)]


VIEWS = _build()

"""Saved reports: a dataset, parameters, filters, sort and chosen columns. Running one applies the viewer's own permissions."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction

from modules.analytics import core, exports, registry
from modules.analytics import models as m
from shared.api.errors import DomainError, ValidationFailed

OPS = ("eq", "ne", "gt", "ge", "lt", "le", "contains")


def report_dict(r):
    return {"id": str(r.id), "name": r.name, "description": r.description, "dataset": r.dataset, "params": r.params, "columns": r.columns, "filters": r.filters, "sort": r.sort,
            "owner_id": str(r.owner_id), "shared": r.shared, "is_active": r.is_active}


def _validate(user_id, dataset, params, columns, filters, sort):
    registry.ensure_quality_datasets()
    ds = registry.DATASETS.get(dataset)
    if ds is None:
        raise ValidationFailed("Unknown dataset.", code="unknown_dataset")
    if not core.can(user_id, ds.permission):
        raise DomainError("You do not have access to this data.", code="permission_denied", status_code=403)
    registry.resolve_params(ds, params or {})
    if not isinstance(columns or [], list) or not all(isinstance(c, str) for c in columns or []):
        raise ValidationFailed("columns must be a list of names.", code="invalid_fields")
    for f in filters or []:
        if not isinstance(f, dict) or not f.get("column") or f.get("op") not in OPS:
            raise ValidationFailed("Each filter needs a column and an operator: " + ", ".join(OPS), code="invalid_filter")
    for s in sort or []:
        if not isinstance(s, dict) or not s.get("column"):
            raise ValidationFailed("Each sort needs a column.", code="invalid_fields")
    return ds


@transaction.atomic
def create(actor, data):
    core.need(data, "name", "dataset")
    _validate(actor, data["dataset"], data.get("params"), data.get("columns"), data.get("filters"), data.get("sort"))
    if m.SavedReport.objects.filter(owner_id=actor, name=data["name"], is_active=True).exists():
        raise ValidationFailed("You already have a report with this name.", code="duplicate")
    r = m.SavedReport.objects.create(name=data["name"][:150], description=data.get("description", "")[:300], dataset=data["dataset"], params=data.get("params") or {}, columns=data.get("columns") or [],
                                     filters=data.get("filters") or [], sort=data.get("sort") or [], owner_id=actor, shared=bool(data.get("shared")))
    core.audit("analytics.report.created", actor, "analytics.report", r.id, dataset=r.dataset)
    return r


def _visible(user_id, pk, owner_only=False):
    r = m.SavedReport.objects.filter(pk=pk, is_active=True).first()
    if r is None:
        raise core.nf("Report")
    if r.owner_id == user_id:
        return r
    if owner_only or not (r.shared and core.can(user_id, "analytics.view")):
        raise core.nf("Report")
    return r


def get(user_id, pk):
    return _visible(user_id, pk)


@transaction.atomic
def update(actor, pk, data):
    r = _visible(actor, pk, owner_only=True)
    merged = {f: data.get(f, getattr(r, f)) for f in ("dataset", "params", "columns", "filters", "sort")}
    _validate(actor, merged["dataset"], merged["params"], merged["columns"], merged["filters"], merged["sort"])
    for f, v in merged.items():
        setattr(r, f, v)
    for f in ("name", "description", "shared"):
        if f in data:
            setattr(r, f, data[f])
    r.save()
    return r


@transaction.atomic
def archive(actor, pk):
    r = _visible(actor, pk, owner_only=True)
    r.is_active = False
    r.save(update_fields=["is_active", "updated_at"])
    r.schedules.filter(is_active=True).update(is_active=False, last_status="STOPPED", last_error="The report was archived.")
    core.audit("analytics.report.archived", actor, "analytics.report", r.id)
    return r


def list_reports(user_id):
    out = []
    for r in m.SavedReport.objects.filter(is_active=True).order_by("name"):
        if r.owner_id == user_id or (r.shared and core.can(user_id, "analytics.view")):
            out.append(report_dict(r))
    return out


# ----------------------------------------------------------------------------- applying filters, sort and columns
def _cmp_values(cell, value):
    a, b = registry.num(cell), registry.num(value)
    if a is not None and b is not None and not isinstance(cell, bool):
        return a, b
    return str(cell if cell is not None else "").lower(), str(value if value is not None else "").lower()


def _match(row, f):
    cell = row.get(f["column"])
    a, b = _cmp_values(cell, f.get("value"))
    op = f["op"]
    if op == "contains":
        return str(b) in str(a)
    return {"eq": a == b, "ne": a != b, "gt": a > b, "ge": a >= b, "lt": a < b, "le": a <= b}[op]


def apply(rows, columns=None, filters=None, sort=None):
    if rows:
        known = set(exports.columns_of(rows))
        for f in filters or []:
            if f["column"] not in known:
                raise ValidationFailed(f"Unknown column in filter: {f['column']}", code="unknown_column")
        for s in sort or []:
            if s["column"] not in known:
                raise ValidationFailed(f"Unknown column in sort: {s['column']}", code="unknown_column")
    for f in filters or []:
        rows = [r for r in rows if _match(r, f)]
    for s in reversed(sort or []):
        def key(r, c=s["column"]):
            v = r.get(c)
            n = registry.num(v) if not isinstance(v, bool) else None
            return (0, n, "") if n is not None else (1, Decimal(0), str(v if v is not None else "").lower())
        rows = sorted(rows, key=key, reverse=bool(s.get("desc")))
    if columns and rows:
        exports.columns_of(rows, columns)  # validates the names
        rows = [{c: r.get(c) for c in columns} for r in rows]
    return rows


def run_dataset_rows(user_id, dataset, params, columns=None, filters=None, sort=None, on=None):
    ds, resolved, rows = registry.run_dataset(user_id, dataset, params, on)
    return ds, resolved, apply(rows, columns, filters, sort)


def run(user_id, pk, overrides=None, on=None):
    r = _visible(user_id, pk)
    params = {**(r.params or {}), **{k: v for k, v in (overrides or {}).items() if v not in (None, "")}}
    ds, resolved, rows = run_dataset_rows(user_id, r.dataset, params, r.columns, r.filters, r.sort, on)
    return r, ds, resolved, rows


def log_run(report, ds, resolved, fmt, user_id, rows, schedule=None, run_date=None, status="OK", error="", file_id=None, delivered=None):
    return m.ReportRun.objects.create(report=report, schedule=schedule, run_date=run_date, dataset=ds.code if ds else (report.dataset if report else ""), params={k: str(v) for k, v in (resolved or {}).items()},
                                      fmt=fmt, requested_by=user_id, row_count=len(rows or []), file_id=file_id, status=status, error=error[:300], delivered_to=[str(x) for x in (delivered or [user_id])])


def subtitle(ds, resolved):
    return f"{ds.title}. " + ", ".join(f"{k}={v}" for k, v in resolved.items())


def export_report(user_id, pk, fmt, overrides=None):
    r, ds, resolved, rows = run(user_id, pk, overrides)
    data, ctype, ext = exports.export(rows, fmt, r.name, subtitle(ds, resolved))
    log_run(r, ds, resolved, fmt.upper(), user_id, rows)
    core.audit("analytics.report.exported", user_id, "analytics.report", r.id, fmt=fmt, rows=len(rows))
    return data, ctype, exports.filename(r.name, ext, core.today())


def export_dataset(user_id, dataset, params, fmt, columns=None, filters=None, sort=None):
    ds, resolved, rows = run_dataset_rows(user_id, dataset, params, columns, filters, sort)
    data, ctype, ext = exports.export(rows, fmt, ds.title, subtitle(ds, resolved))
    log_run(None, ds, resolved, fmt.upper(), user_id, rows)
    core.audit("analytics.dataset.exported", user_id, "analytics.dataset", dataset, fmt=fmt, rows=len(rows))
    return data, ctype, exports.filename(ds.title, ext, core.today())


def run_log(user_id, report_id=None):
    qs = m.ReportRun.objects.all().order_by("-created_at")
    if not core.can(user_id, "analytics.report.manage"):
        qs = qs.filter(requested_by=user_id)
    if report_id:
        qs = qs.filter(report_id=report_id)
    return qs


def run_dict(x):
    return {"id": str(x.id), "report_id": str(x.report_id) if x.report_id else None, "schedule_id": str(x.schedule_id) if x.schedule_id else None, "dataset": x.dataset, "fmt": x.fmt,
            "row_count": x.row_count, "status": x.status, "error": x.error, "file_id": str(x.file_id) if x.file_id else None, "requested_by": str(x.requested_by), "delivered_to": x.delivered_to,
            "created_at": x.created_at.isoformat()}

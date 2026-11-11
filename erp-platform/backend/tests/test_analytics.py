import csv
import io
from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from modules.analytics import core, dashboards, exports, kpis, registry, reports, schedules
from modules.analytics import models as m
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from tests.conftest import ACME_HOST, Api
from tests.test_finance import user
from tests.test_sales import f as sales_f  # noqa: F401
from tests.test_supply_chain import codes
from tests.test_supply_chain import f as sc_f  # noqa: F401

TODAY = timezone.now().date()
pytestmark = pytest.mark.django_db


@pytest.fixture
def an(sc_f, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    p = sc_f["people"]
    p["exec"] = user(tenant, "exec@acme.test", "executive")
    p["fin"] = user(tenant, "fin@acme.test", "finance_manager")
    p["fin2"] = user(tenant, "fin2@acme.test", "finance_manager")
    p["qm"] = user(tenant, "qmx@acme.test", "quality_manager")
    dashboards.ensure_defaults(None)
    return p


def uid(p, k):
    return p[k].id


# ------------------------------------------------------------------ registry
def test_period_resolution_and_param_validation():
    on = date(2026, 3, 18)
    assert registry.period_range("MTD", on) == (date(2026, 3, 1), on)
    assert registry.period_range("LAST_MONTH", on) == (date(2026, 2, 1), date(2026, 2, 28))
    assert registry.period_range("YTD", on) == (date(2026, 1, 1), on)
    assert registry.period_range("LAST_QUARTER", on) == (date(2025, 10, 1), date(2025, 12, 31))
    with pytest.raises(ValidationFailed):
        registry.period_range("this_month", on)
    ds = registry.DATASETS["finance.profit-loss"]
    p = registry.resolve_params(ds, {"period": "MTD"}, on)
    assert p["date_from"] == date(2026, 3, 1) and p["date_to"] == on
    with pytest.raises(ValidationFailed) as e:
        registry.resolve_params(ds, {"bogus": "1"}, on)
    assert codes(e) == "unknown_param"
    with pytest.raises(ValidationFailed):
        registry.resolve_params(ds, {"date_from": "garbage"}, on)


def test_dataset_requires_its_module_permission(an):
    with pytest.raises(DomainError) as e:
        registry.run_dataset(uid(an, "emp"), "finance.trial-balance")
    assert e.value.status_code == 403
    with pytest.raises(DomainError) as e:
        registry.run_dataset(uid(an, "fin"), "nope")
    assert e.value.status_code == 404
    ds, params, rows = registry.run_dataset(uid(an, "fin"), "finance.trial-balance")
    assert isinstance(rows, list)


def test_catalog_lists_only_what_the_user_may_see(an):
    fin = {d["code"] for d in registry.catalog_for(uid(an, "fin"))["datasets"]}
    emp = registry.catalog_for(uid(an, "emp"))
    assert "finance.trial-balance" in fin and "hr.dashboard" not in fin
    assert not any(d["module"] == "finance" for d in emp["datasets"])


# ------------------------------------------------------------------ KPIs
def test_kpi_status_thresholds_and_validation(an):
    hi = m.Kpi(metric="x", direction="HIGHER", target=Decimal("100"), warn_at=Decimal("80"), critical_at=Decimal("50"))
    assert kpis.status_of(hi, Decimal("120")) == "GOOD"
    assert kpis.status_of(hi, Decimal("90")) == "WARN"
    assert kpis.status_of(hi, Decimal("70")) == "WARN"
    assert kpis.status_of(hi, Decimal("40")) == "CRITICAL"
    assert kpis.status_of(hi, None) == "NO_DATA"
    lo = m.Kpi(metric="x", direction="LOWER", target=Decimal("5"), warn_at=Decimal("10"), critical_at=Decimal("20"))
    assert kpis.status_of(lo, Decimal("3")) == "GOOD"
    assert kpis.status_of(lo, Decimal("15")) == "WARN"
    assert kpis.status_of(lo, Decimal("25")) == "CRITICAL"
    with pytest.raises(ValidationFailed):
        kpis.create_kpi(uid(an, "fin"), {"code": "bad", "name": "Bad", "metric": "does.not.exist"})
    with pytest.raises(ValidationFailed):
        kpis.create_kpi(uid(an, "fin"), {"code": "bad2", "name": "Bad", "metric": "finance.revenue", "direction": "HIGHER", "target": "100", "warn_at": "50", "critical_at": "80"})


def test_kpi_snapshot_is_once_a_day_and_restricted_for_others(an):
    k = kpis.create_kpi(uid(an, "fin"), {"code": "rev", "name": "Revenue", "metric": "finance.revenue", "params": {"period": "MTD"}})
    s1, _ = kpis.snapshot(k)
    s2, _ = kpis.snapshot(k)
    assert s1.id == s2.id and m.KpiSnapshot.objects.filter(kpi=k).count() == 1
    assert kpis.view(uid(an, "fin"), k)["restricted"] is False
    v = kpis.view(uid(an, "emp"), k)
    assert v["restricted"] is True and v["latest"] is None
    with pytest.raises(DomainError):
        kpis.series(uid(an, "emp"), k)
    with pytest.raises(ValidationFailed):
        kpis.create_kpi(uid(an, "fin"), {"code": "rev", "name": "Dup", "metric": "finance.revenue"})


def test_default_kpis_and_dashboards_are_created_once(an):
    n = m.Kpi.objects.count()
    d = m.Dashboard.objects.count()
    assert n > 10 and d >= 5
    kpis.ensure_defaults(None)
    dashboards.ensure_defaults(None)
    assert m.Kpi.objects.count() == n and m.Dashboard.objects.count() == d


def test_daily_snapshots_every_kpi_once(an):
    kpis.daily(TODAY)
    c = m.KpiSnapshot.objects.count()
    kpis.daily(TODAY)
    assert m.KpiSnapshot.objects.count() == c > 0


# ------------------------------------------------------------------ dashboards
def test_dashboard_widgets_are_restricted_not_leaked(an):
    fin_dash = m.Dashboard.objects.get(code="finance")
    view_fin = dashboards.view(uid(an, "fin"), fin_dash.id)
    assert any(not w["restricted"] for w in view_fin["widgets"])
    view_emp = dashboards.view(uid(an, "qm"), fin_dash.id)
    assert view_emp["widgets"] and all(w["restricted"] and w["data"] is None for w in view_emp["widgets"])


def test_private_dashboard_is_owner_only_and_widgets_validated(an):
    d = dashboards.create_dashboard(uid(an, "fin"), {"code": "mine", "name": "Mine"})
    assert dashboards.can_see(uid(an, "fin"), d) and not dashboards.can_see(uid(an, "fin2"), d)
    with pytest.raises(DomainError):
        dashboards.view(uid(an, "fin2"), d.id)
    with pytest.raises(DomainError):
        dashboards.add_widget(uid(an, "fin2"), d.id, {"kind": "KPI", "config": {"kpi": "x"}})
    with pytest.raises(ValidationFailed):
        dashboards.add_widget(uid(an, "fin"), d.id, {"kind": "WEIRD", "config": {}})
    w = dashboards.add_widget(uid(an, "fin"), d.id, {"kind": "DATASET", "title": "TB", "config": {"dataset": "finance.trial-balance", "limit": 5}})
    assert dashboards.view(uid(an, "fin"), d.id)["widgets"][0]["id"] == str(w.id)


def test_role_visibility(an):
    d = dashboards.create_dashboard(uid(an, "fin"), {"code": "fr", "name": "Fin only", "visibility": "ROLES", "roles": ["finance_manager"]})
    assert dashboards.can_see(uid(an, "fin2"), d) and not dashboards.can_see(uid(an, "emp"), d)


# ------------------------------------------------------------------ exports
ROWS = [{"name": "=HYPERLINK(\"http://evil\")", "amount": "1234.50", "note": "@cmd"}, {"name": "Plain, with comma", "amount": "10", "note": "ok"}]


def test_csv_neutralises_formulas(an):
    data, ctype, ext = exports.export(ROWS, "CSV", "T")
    assert ext == "csv" and ctype.startswith("text/csv")
    rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
    assert rows[1][0].startswith("'=") and rows[1][2].startswith("'@") and rows[2][0] == "Plain, with comma"


def test_xlsx_formulas_stored_as_text_and_numbers_numeric(an):
    import openpyxl
    data, _, ext = exports.export(ROWS, "XLSX", "T")
    ws = openpyxl.load_workbook(io.BytesIO(data)).worksheets[0]
    cells = [c for row in ws.iter_rows() for c in row]
    assert not any(c.data_type == "f" for c in cells)
    assert any(isinstance(c.value, (int, float, Decimal)) and float(c.value) == 1234.5 for c in cells)


def test_pdf_and_unknown_format_and_columns(an):
    data, ctype, ext = exports.export(ROWS, "PDF", "Title", "sub")
    assert data.startswith(b"%PDF") and ext == "pdf"
    with pytest.raises(ValidationFailed):
        exports.export(ROWS, "DOCX", "T")
    with pytest.raises(ValidationFailed):
        exports.export(ROWS, "CSV", "T", wanted_columns=["nope"])
    data, _, _ = exports.export(ROWS, "CSV", "T", wanted_columns=["amount"])
    assert "name" not in data.decode("utf-8-sig").splitlines()[0]


def test_row_limit_enforced(an):
    big = [{"a": i} for i in range(6000)]
    with pytest.raises(DomainError) as e:
        exports.export(big, "PDF", "T")
    assert e.value.status_code == 413


# ------------------------------------------------------------------ saved reports
def test_report_filters_sort_columns(an):
    rows = [{"n": "a", "v": "5"}, {"n": "b", "v": "20"}, {"n": "c", "v": "100"}]
    out = reports.apply(rows, ["n"], [{"column": "v", "op": "gt", "value": "9"}], [{"column": "v", "desc": True}])
    assert [r["n"] for r in out] == ["c", "b"] and list(out[0]) == ["n"]
    assert [r["n"] for r in reports.apply(rows, None, [{"column": "n", "op": "contains", "value": "b"}])] == ["b"]
    with pytest.raises(ValidationFailed):
        reports.create(uid(an, "fin"), {"name": "R", "dataset": "finance.trial-balance", "filters": [{"column": "x", "op": "drop"}]})


def test_report_sharing_and_dataset_permission(an):
    r = reports.create(uid(an, "fin"), {"name": "TB", "dataset": "finance.trial-balance"})
    with pytest.raises(DomainError):
        reports.get(uid(an, "fin2"), r.id)
    reports.update(uid(an, "fin"), r.id, {"shared": True})
    assert reports.get(uid(an, "fin2"), r.id).id == r.id
    with pytest.raises(DomainError) as e:
        reports.create(uid(an, "emp"), {"name": "X", "dataset": "finance.trial-balance"})
    assert e.value.status_code in (403, 404)
    data, ctype, name = reports.export_report(uid(an, "fin"), r.id, "CSV")
    assert name.endswith(".csv") and m.ReportRun.objects.filter(report=r).exists()


# ------------------------------------------------------------------ schedules
def test_next_after():
    assert schedules.next_after("DAILY", None, None, date(2026, 3, 18)) == date(2026, 3, 19)
    assert schedules.next_after("WEEKLY", 0, None, date(2026, 3, 18)) == date(2026, 3, 23)  # Monday
    assert schedules.next_after("MONTHLY", None, 5, date(2026, 3, 18)) == date(2026, 4, 5)
    assert schedules.next_after("MONTHLY", None, 25, date(2026, 3, 18)) == date(2026, 3, 25)
    assert schedules.next_after("MONTHLY", None, 5, date(2026, 12, 18)) == date(2027, 1, 5)


def _sched(an, recipients=None, fmt="CSV", owner="fin"):
    r = reports.create(uid(an, owner), {"name": f"TB-{timezone.now().timestamp()}", "dataset": "finance.trial-balance"})
    return schedules.create(uid(an, owner), {"report_id": r.id, "frequency": "DAILY", "fmt": fmt, "recipients": [str(uid(an, x)) for x in (recipients or ["fin2"])]})


def test_schedule_rejects_recipients_without_access(an):
    r = reports.create(uid(an, "fin"), {"name": "TB", "dataset": "finance.trial-balance"})
    with pytest.raises(ValidationFailed) as e:
        schedules.create(uid(an, "fin"), {"report_id": r.id, "frequency": "DAILY", "recipients": [str(uid(an, "emp"))]})
    assert codes(e) == "recipient_not_allowed"
    with pytest.raises(ValidationFailed):
        schedules.create(uid(an, "fin"), {"report_id": r.id, "frequency": "HOURLY", "recipients": [str(uid(an, "fin2"))]})
    with pytest.raises(ValidationFailed):
        schedules.create(uid(an, "fin"), {"report_id": r.id, "frequency": "WEEKLY", "recipients": [str(uid(an, "fin2"))]})


def test_schedule_runs_once_per_day_and_delivers_file(an):
    from shared.files import services as files
    s = _sched(an)
    s.next_run_on = TODAY
    s.save()
    res = schedules.run_due(TODAY)
    assert res == {"runs": 1, "failed": 0}
    run = m.ReportRun.objects.get(schedule=s)
    assert run.status == "OK" and run.file_id and run.delivered_to == [str(uid(an, "fin2"))]
    s.refresh_from_db()
    assert s.next_run_on > TODAY and s.last_status == "OK"
    # running the same day again does nothing
    assert schedules.run_schedule(s, TODAY) is None
    assert m.ReportRun.objects.filter(schedule=s).count() == 1
    # recipient may download; outsider may not
    assert schedules.file_access(uid(an, "fin2"), run.id) is True
    assert schedules.file_access(uid(an, "emp"), run.id) is False
    assert schedules.file_access(uid(an, "fin"), run.id) is True


def test_schedule_skips_recipients_who_lose_access_and_fails_when_none_left(an):
    from platform_core.authorization.models import RoleAssignment
    s = _sched(an, recipients=["fin2", "exec"])
    RoleAssignment.objects.filter(user_id=uid(an, "fin2")).delete()
    run = schedules.run_schedule(s, TODAY)
    assert run.status == "OK" and run.delivered_to == [str(uid(an, "exec"))] and "skipped" in run.error
    s2 = _sched(an, recipients=["exec"], owner="fin")
    RoleAssignment.objects.filter(user_id=uid(an, "exec")).delete()
    run2 = schedules.run_schedule(s2, TODAY)
    assert run2.status == "FAILED"
    s2.refresh_from_db()
    assert s2.last_status == "FAILED" and s2.next_run_on > TODAY


def test_schedule_fails_when_owner_loses_export_rights(an):
    from platform_core.authorization.models import RoleAssignment
    s = _sched(an)
    RoleAssignment.objects.filter(user_id=uid(an, "fin")).delete()
    run = schedules.run_schedule(s, TODAY)
    assert run.status == "FAILED" and m.ReportRun.objects.get(pk=run.pk).file_id is None


def test_only_owner_can_manage_schedule_and_run_now_is_once(an):
    s = _sched(an)
    with pytest.raises(DomainError):
        schedules.update(uid(an, "fin2"), s.id, {"fmt": "PDF"})
    with pytest.raises(DomainError):
        schedules.stop(uid(an, "fin2"), s.id)
    schedules.run_now(uid(an, "fin"), s.id)
    with pytest.raises(DomainError) as e:
        schedules.run_now(uid(an, "fin"), s.id)
    assert e.value.status_code == 409
    schedules.stop(uid(an, "fin"), s.id)
    s.refresh_from_db()
    assert not s.is_active
    reports.archive(uid(an, "fin"), s.report_id)


def test_archiving_report_stops_schedules(an):
    s = _sched(an)
    reports.archive(uid(an, "fin"), s.report_id)
    s.refresh_from_db()
    assert not s.is_active


# ------------------------------------------------------------------ finance datasets
def test_cash_flow_and_aging_datasets_run(an):
    for code in ("finance.cash-flow", "finance.receivables-aging", "finance.payables-aging", "finance.profit-loss", "finance.balance-sheet"):
        _, _, rows = registry.run_dataset(uid(an, "fin"), code)
        assert isinstance(rows, list)
    for code, mt in registry.METRICS.items():
        assert mt.permission and mt.module


def test_every_dataset_runs_for_a_user_who_holds_its_permission(an):
    """Smoke test: a dataset must never crash for a permitted user, even on an empty tenant."""
    from platform_core.authorization import services as authz
    registry.ensure_quality_datasets()
    me = uid(an, "exec")
    ran = 0
    for code, ds in registry.DATASETS.items():
        if authz.has_permission(me, ds.permission):
            registry.run_dataset(me, code)
            ran += 1
    assert ran >= 10


def test_every_metric_computes(an):
    from platform_core.authorization import services as authz
    for code, mt in registry.METRICS.items():
        if authz.has_permission(uid(an, "exec"), mt.permission):
            registry.METRICS[code].fn(TODAY, {})


# ------------------------------------------------------------------ HTTP
def test_http_permissions_and_flow(world, idp, acme, an):
    for key in ("fin", "fin2", "emp", "exec"):
        ExternalIdentity.objects.create(user=an[key], issuer="https://kc.test/realms/erp", subject=f"an-{key}")
    api = {}
    for key in ("fin", "fin2", "emp", "exec"):
        api[key] = Api(ACME_HOST)
        assert api[key].login(idp, f"an-{key}").status_code == 302
    assert Api(ACME_HOST).get("/api/v1/analytics/catalog").status_code == 401
    assert api["emp"].get("/api/v1/analytics/catalog").status_code == 403
    assert api["fin"].get("/api/v1/analytics/catalog").status_code == 200
    # dataset permission is enforced per module
    assert api["fin"].get("/api/v1/analytics/datasets/finance.trial-balance").status_code == 200
    assert api["fin"].get("/api/v1/analytics/datasets/hr.dashboard").status_code == 403
    assert api["fin"].get("/api/v1/analytics/datasets/finance.profit-loss?bogus=1").status_code == 400
    assert api["fin"].get("/api/v1/analytics/datasets/finance.profit-loss?date_from=garbage").status_code == 400
    csvr = api["fin"].get("/api/v1/analytics/datasets/finance.trial-balance/export?fmt=CSV")
    assert csvr.status_code == 200 and csvr["Content-Type"].startswith("text/csv") and "attachment" in csvr["Content-Disposition"]
    assert api["fin"].get("/api/v1/analytics/datasets/finance.trial-balance/export?fmt=DOCX").status_code == 400
    # only managers create KPIs and dashboards
    assert api["emp"].post("/api/v1/analytics/kpis", {"code": "k1", "name": "K", "metric": "finance.revenue"}).status_code == 403
    assert api["exec"].post("/api/v1/analytics/kpis", {"code": "k1", "name": "K", "metric": "finance.revenue"}).status_code == 403
    # dashboards: listing works, restricted widgets do not leak
    lst = api["exec"].get("/api/v1/analytics/dashboards")
    assert lst.status_code == 200 and len(lst.json()) >= 5
    fid = next(d["id"] for d in lst.json() if d["code"] == "finance")
    body = api["exec"].get(f"/api/v1/analytics/dashboards/{fid}")
    assert body.status_code == 200
    # reports and schedules
    rep = api["fin"].post("/api/v1/analytics/reports", {"name": "TB", "dataset": "finance.trial-balance"})
    assert rep.status_code == 201, rep.content
    rid = rep.json()["id"]
    assert api["fin2"].get(f"/api/v1/analytics/reports/{rid}").status_code == 404
    assert api["fin"].get(f"/api/v1/analytics/reports/{rid}/run").status_code == 200
    assert api["fin"].get(f"/api/v1/analytics/reports/{rid}/export?fmt=PDF")["Content-Type"] == "application/pdf"
    sch = api["fin"].post("/api/v1/analytics/schedules", {"report_id": rid, "frequency": "DAILY", "recipients": [str(an["fin2"].id)], "fmt": "CSV"})
    assert sch.status_code == 201, sch.content
    sid = sch.json()["id"]
    assert api["fin2"].patch(f"/api/v1/analytics/schedules/{sid}", {"fmt": "PDF"}).status_code == 404
    assert api["fin"].post(f"/api/v1/analytics/schedules/{sid}/run").status_code == 201
    again = api["fin"].post(f"/api/v1/analytics/schedules/{sid}/run")
    assert again.status_code == 409
    assert api["fin"].get("/api/v1/analytics/runs").status_code == 200
    bad = api["fin"].post("/api/v1/analytics/schedules", {"report_id": rid, "frequency": "DAILY", "recipients": [str(an["emp"].id)]})
    assert bad.status_code == 400

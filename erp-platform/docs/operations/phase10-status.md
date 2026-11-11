# Phase 10 — Business Intelligence and Reporting (Module 14)

## Implemented
- **Dataset registry** (`modules/analytics/registry.py`): ~35 tabular datasets across finance, sales, CRM, procurement, inventory, HR, manufacturing, supply chain, projects, assets and quality. Each dataset declares the permission needed to run it; it wraps the owning module's own report function (no duplicated business logic, no direct table access across modules).
- **Parameters**: typed and validated (`unknown_param`, bad dates -> 400). A `period` shortcut (TODAY, LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, MTD, LAST_MONTH, QTD, LAST_QUARTER, YTD, LAST_YEAR) resolves to date_from/date_to/as_of.
- **KPIs**: ~20 built-in plus tenant-defined. Higher/lower-is-better, target/warning/critical thresholds (ordering validated), daily snapshots (one per KPI per day), change versus previous snapshot, status NO_DATA/NO_TARGET/GOOD/WARN/CRITICAL, one notification when a KPI turns CRITICAL.
- **Dashboards**: 9 built-in (executive, finance, sales, procurement, inventory, HR, production, projects, quality); custom dashboards with KPI, TREND and DATASET widgets; visibility PRIVATE / ALL / ROLES. A widget whose data the viewer may not see comes back `restricted` with no data.
- **Saved reports**: dataset + params + column selection + filters (eq ne gt ge lt le contains) + multi-key sort; private or shared; archiving stops its schedules.
- **Exports**: CSV, XLSX, PDF. CSV/XLSX neutralise formula injection; row limits per format (settings `analytics.export_row_limit`, `analytics.pdf_row_limit`) -> 413. Every export is logged.
- **Scheduled reports**: DAILY/WEEKLY/MONTHLY. One run per schedule per day (database unique constraint), so retries and double-fired workers do nothing. Owner must still be an active member with export rights and dataset access; recipients are re-checked at run time and those who lost access are skipped (and recorded). Failures are recorded, the owner is notified, the schedule moves on. Output is stored through the shared file service, downloadable only by recipients who still hold the dataset permission.
- **Celery**: `analytics.daily_all` hourly beat -> per tenant: seed defaults, KPI snapshots, due schedules.
- **API** `/api/v1/analytics/`: catalog, datasets (+export), kpis, dashboards, widgets, reports (+run/export), schedules (+run), runs.
- **Permissions**: `analytics.view|export|report.manage|kpi.manage|dashboard.manage`; new `executive` role; view/export added to management roles and the auditor.

## Tested (executed)
`tests/test_analytics.py`: 27 tests — period/param validation, dataset permission gating, catalog filtering, KPI thresholds/snapshots/restriction, defaults idempotent, restricted widgets, dashboard visibility, CSV/XLSX injection, PDF, row limit, filters/sort/columns, report sharing, schedule date maths, once-per-day, recipient re-checking, owner losing rights, file access, run-now conflict, every dataset and metric smoke-run, HTTP permission flow. Authorization contract test passes.
Full-suite result: see the delivery message.

## Not done / known limits
- Reports are tabular; no chart rendering in exports (the frontend will chart dashboard data).
- Datasets use each module's own permission: e.g. `sales.view` sees all sales. Record-level scoping inside a module is the module's responsibility; documents data is deliberately not exposed.
- Amount metrics mix currencies only where the module reports in base currency; others filter to base currency.
- Email delivery is in-app notification plus file download; no SMTP attachment.
- No drill-through or pivoting; no custom SQL (intentional).

## Upgrade notes
1. `pip install -r requirements.txt` (adds openpyxl, reportlab).
2. `migrate_schemas` (analytics 0001).
3. Re-sync default roles for the new permissions and the `executive` role.
4. Call `POST /api/v1/analytics/dashboards/defaults` once per tenant (or wait for the hourly job) to seed KPIs and dashboards.

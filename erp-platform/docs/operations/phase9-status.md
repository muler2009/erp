# Phase 9: Document Management and Quality Management

## Implemented
- **Documents** (`modules/documents`, 22 tests): see `dms-gap-analysis.md`. 43 routes under `/api/v1/documents/`.
- **Quality** (`modules/quality`, 20 tests): see `qms-gap-analysis.md`. About 150 routes under `/api/v1/quality/`.
- **Cross-module hooks**
  - Inventory: `register_issue_guard`; a quality hold blocks stock issue and transfer of the held product or lot (HTTP 409 `quality_hold`).
  - Projects: `register_task_guard`; an unapproved quality hold point blocks dependent tasks (409 `quality_hold_point`).
  - Procurement: a supplier blocked in quality becomes `BLOCKED` in the supplier master; re-approval returns it to `QUALIFIED`.
  - Workflow engine: new subjects `documents.version`, `quality.plan`, `quality.ncr`, `quality.capa`; `register_subject` gained an `on_event` hook for changes requested / resubmitted.
- New permissions (`documents.*`, `quality.*`), roles Document Controller, Quality Manager, Quality Inspector; employees get `quality.report`; the auditor gets read access.
- Settings `documents.*` and `quality.*`; daily jobs `documents.daily_all` and `quality.daily_all` (beat entries added).

## Tested
Full suite on the combined tree: **637 passed, 0 failed** (595 earlier + 22 documents + 20 quality). `makemigrations --check` reports no changes.

## Not done / limits
See the "Known limits" sections of the two gap-analysis documents. Frontend is deferred as agreed.

## Upgrade notes
1. Run tenant migrations (`documents` 0001, `quality` 0001).
2. Re-sync role permissions so existing tenants receive the new permissions and roles.
3. Create workflow definitions for `documents.version`, `quality.plan`, `quality.ncr` and `quality.capa` per tenant; until then submission returns `no_workflow`.
4. Quality lists (severity, categories, methods) are seeded on first use and can be edited under `/quality/config/<kind>`.

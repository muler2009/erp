# Completion audit — 2026-11-17 (after frontend slice 63)

Method: every `path(...)` in `backend/config/urls_tenant.py` was compared with the URLs used in `frontend/src/shared/api/endpoints.ts`. The comparison is approximate (template-literal URLs are normalised), so counts can be off by a few, but the order of magnitude is reliable. All 14 modules exist and are tested in the **backend** (Phases 1–11). The **frontend** is not complete.

| # | Module | Backend endpoints | Not yet used by the frontend | Frontend state |
|---|---|---|---|---|
| 1 | Organization & administration | 24 (+ users, roles, sequences, settings) | 12 org, `settings`, `notification-preferences`, `role-assignments` | Company, structure, reference data, numbering, members done. **Missing:** tenant settings screen, role-assignment screens beyond roles, notification preferences, exchange-rate import |
| 2 | Finance & accounting | 27 | 8 | Largely covered (accounts, journals, invoices, reports); not compared endpoint-by-endpoint for the last 8 |
| 3 | HR & payroll | 119 | 23 | Broad coverage (25 routes); remaining admin/reporting endpoints |
| 4 | CRM | 70 | 18 | Accounts, contacts, leads/opps, activities, campaigns, service cases, teams, insights done. **Missing:** lead edit/duplicate/merge/import, stage configuration, calendar grid |
| 5 | Sales | 68 | ~25 | Quotations, orders, pricing, deliveries, returns, analytics, targets and commission, contracts, backorders, receivables aging done. **Missing:** contract editing/amendments, quotation extras, bundle editor, plan edit |
| 6 | Procurement | 89 | **71** | 7 routes only. **Largest gap in a started module:** supplier qualification/evaluation, RFQ and bid comparison, contracts, goods-receipt/3-way match views, analytics (spend, cycle times, price variance, supplier performance) |
| 7 | Inventory & warehouse | 43 | 26 | 8 routes. **Missing:** lots/serials, reservations, cycle counts, reorder rules, valuation, movement history views |
| 8 | Supply chain & logistics | 51 | **51 (all)** | **No frontend.** Carriers, shipments, routes, exceptions, forecasts, replenishment, demand plans, risks, vehicles, analytics |
| 9 | Manufacturing | 55 | **55 (all)** | **No frontend.** BOMs, work centers, production orders, operations, QC checks, scrap/receipts, MRP preview, plans, downtime, reports |
| 10 | Projects & tasks | 29 | 3 | Covered apart from 3 endpoints |
| 11 | Assets & maintenance | 73 | 14 | 14 routes; remaining endpoints are secondary |
| 12 | Quality | 105 (in QMS views) | — | Most complete frontend (39 routes) |
| 13 | Documents & workflow | 44 | 44 → ~30 after slice 63 | **Started in slice 63:** library, upload, versions, submit/withdraw/publish, comments, acknowledgements. **Still missing:** folders and categories admin, access grants, distribution, periodic review, disposal approvals, external documents, transmittals, RFIs, saved searches, favourites, reports; workflow *designer* UI |
| 14 | Business intelligence | generated views (`anv.VIEWS`) | most | Only 3 endpoints wired; **no dashboards/KPI/scheduled-report screens** |

## Cross-cutting items still open
- No screen has been driven in a real browser since the earliest slices (setup in `e2e-local.md`); everything since is covered by component tests with a mocked API only.
- Platform-admin "resend admin setup email" button; Keycloak outgoing mail is not configured.
- Document pickers (attach documents to records) and equipment picker for inspections.
- Bundle ≈ 550 kB (no route-level code splitting yet).
- `npm audit`: 5 high findings from one advisory (picomatch ReDoS) in build/test tooling; no patched release exists as of 2026-11-17 (see F62).
- Backend not re-run in full since slice 60 (only the sales dispatch and CRM/sales API files).

## Recommended order to finish
1. Sales remainder (quotation extras, amendments, bundle editor) — small.
2. Procurement: suppliers evaluation, RFQ/bids, contracts, analytics (largest started gap).
3. Inventory: lots/serials, cycle counts, reorder, valuation.
4. Manufacturing, then Supply chain (new modules; each ≈ 6–8 slices).
5. Documents remainder; BI dashboards.
6. Real-browser pass per module; full backend regression; production hardening checks.

## Verdict
The platform is **not finalized**. Backend: complete for all 14 modules. Frontend: roughly half of the backend surface has a screen; Manufacturing, Supply Chain and BI have none, Documents has its core only.

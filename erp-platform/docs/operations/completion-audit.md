# Completion audit — 2026-11-24 (after frontend slice 114)

Replaces the 2026-11-22 audit (slice 102), which listed foundation gaps that are now built.

## Method
Every `path(...)` in `backend/config/urls_tenant.py` (about 600 routes) was compared with the `api/v1/...` URLs built in non-test frontend source (script `/tmp/audit.py`, not kept in the repo). Candidates were then confirmed by grepping the frontend for the endpoint's own words. Routes reached through generic calls (for example inventory receipts/issues/transfers/adjustments through one movement mutation, manufacturing operation steps through the production-order page, `assets/capitalizations`, `/label`) are not gaps.

## Where things stand
- **Backend:** all 14 modules and the platform foundation exist. Last full regression: 2026-11-22, about 705 tests, 0 failures. It has not been re-run since; the slices after it changed no backend code.
- **Frontend:** every module has screens, and every route confirmed missing in the previous audit now has one: notifications and preferences, role assignment, tenant settings and module list, workflow designer, tenant audit log, event outbox, CRM segments/pipeline settings/account summary/lead consent/contact links, sales summary, procurement spend, project health/portfolio/task edit, document folder grants, asset documents.
- Last script run: the only uncovered routes are `public/config` (used before login by the auth bootstrap), the generic `files/*` routes (used through document, asset, HR and quality uploads and `downloadFile`; there is no stand-alone file browser, and none is specified), and routes confirmed as reached through generic calls above.

## Known small limits (backend gives no data, or not worth a screen)
- Folder access grants: the backend cannot list a folder's earlier grants, so the screen shows only grants made in the current session.
- Stage position is not exposed to the pipeline settings screen; lead consent state is not displayed (only changeable).
- Role grants from the UI are workspace-wide only.
- Document pickers (attach a document to arbitrary records) and an equipment picker for inspections do not exist.
- Asset documents can be attached and downloaded but not removed (the backend has no delete route).

## Cross-cutting items still open
1. **Real-browser pass done on 2026-11-24 (slice 114):** all 181 static routes load, downloads (CSV/XLSX/PDF) and new-tab opening work, phone-width overflow fixed. Still unverified: print layout of server-rendered documents, the 37 routes that need a record id, real data volumes, other browsers.
2. **Deployed-stack hardening:** rate-limit, upload and import abuse tests exist only as backend tests, not repeated against a running stack.
3. **Bundle** about 550 kB, no route-level code splitting.
4. **Backend regression** should be re-run before any release.
5. Keycloak outgoing mail is not configured in the dev setup.

## Recommended order
1. Seed realistic data and walk the id routes and main workflows in the browser.
2. Route-level code splitting.
3. Backend regression re-run and deployed-stack hardening checks.

## Verdict
The platform is **not finalized**. Backend: complete for all 14 modules with a passing regression (as of slice 102). Frontend: every confirmed backend route has a working, tested screen, but only the route walk, downloads and phone layout have been checked in a real browser, and nothing against a deployed stack.

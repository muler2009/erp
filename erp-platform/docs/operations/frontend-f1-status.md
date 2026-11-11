# Frontend — status (F1 foundation, F2 platform console, F3 finance, F4 approvals, F5 delegation, F6 procurement, F7 inventory, F8 CRM and sales)

Stack: React 19, TypeScript (strict), Vite 7, Tailwind CSS 4, Redux Toolkit + RTK Query (generated hooks), oidc-client-ts, TanStack Table v8, React Router 7, React Hook Form + Zod.

## Implemented
- **Sign-in**: oidc-client-ts, authorization code + PKCE, public Keycloak client `erp-spa`. Tokens live in memory only; a reload goes back through Keycloak (SSO makes it near-instant). Silent renewal by refresh token; a 401 triggers one shared renewal and one retry, otherwise a new sign-in. Return paths are validated (no open redirects). The SPA learns its issuer/client from `GET /api/v1/public/config` on its own host.
- **API layer**: one `baseApi`, endpoints in `src/shared/api/endpoints.ts` with generated hooks (`useGetMeQuery`, `useListUsersQuery`, `useInviteUserMutation`, …). Errors normalised to `ApiError`; cursor pagination helpers.
- **Access**: `/api/v1/me` drives `useAccess()` / `<Can>` and the sidebar. This only decides what is shown; the backend authorises every call.
- **UI kit**: Button, Card, Badge, Spinner, EmptyState, ErrorState, Modal, FormField, PageHeader, server-paginated `DataTable` (TanStack Table).
- **Screens**: Dashboard (KPI / trend / dataset widgets, restricted widgets, create defaults), Users (list, invite with validation and server field errors, deactivate/reactivate), Roles, Departments.
- **Finance (F3)**: chart of accounts (list, create), journal entries (list/filter, balanced-entry form with exact decimal arithmetic, post, reverse), invoices (list/filter by type and status, detail, submit / approve / post / void shown by state and permission; the server enforces separation of duties and shows its error), trial balance. Money is handled as scaled integers (`shared/lib/money.ts`), never floats.
- **Approvals (F4)**: inbox of tasks assigned to the user, review dialog with full history, approve / request changes / reject (reason required for the last two), and a Requests page (filter by status, requester can cancel a pending request). Visible to every workspace member; the API decides what each user sees and whether a decision is allowed (e.g. self-approval is refused and the message is shown).
- **Delegation / resubmit (F5)**: a `UserPicker` (search-as-you-type, 2+ characters) backed by a new minimal backend endpoint `GET /api/v1/directory/users?q=` open to any active member: it returns only id and display name, matches on name only (not e-mail), is capped at 20 rows, and is listed as self-service in the route-sweep test. Approvers can delegate a task; the requester can resubmit after changes were requested (optional new amount, 2 decimals).
- **Procurement (F6)**: suppliers (list/filter, create with server field errors, qualify with notes, block with required reason), purchase requisitions (list, create with exact running estimate, detail, submit / approve / cancel by state and permission), purchase orders (list/filter by status, detail with ordered vs received, submit / approve / cancel). Server refusals such as separation of duties are shown as-is.
- **Inventory (F7)**: products (search through the API, create with unit/tracking choices and server field errors), warehouses with locations (create warehouse, add location; blocked locations marked), stock on hand (filter by warehouse) and movement history, a movement dialog (receive / issue / transfer / count adjustment; only the types the user may perform; blocked locations not offered; exact-decimal validation; server refusals such as insufficient stock are shown), valuation with total, and stock alerts. A reusable `ProductPicker`. Procurement purchase orders gained **Receive goods** (location, per-line quantities, service-receipt note rule; over-receipt refused by the server is shown).
- **CRM and sales (F8)**: leads (list/filter, create with server field errors, contacted / qualify, disqualify with required reason, convert to opportunity with exact amount and validated currency code; buttons follow the server's lead flow), opportunities (list defaulting to open, account names, move stage, mark won, mark lost with required reason), quotations (list/filter, detail with lines and totals, send / accept / reject / convert to order by state and permission, discount-approval notice), sales orders (list/filter, detail with ordered / delivered / invoiced per line, submit / approve / cancel / create invoice by state and permission; server refusals such as separation of duties shown as-is).
- **Platform console** (platform host, `/platform-admin/*`): tenants list, create tenant (Idempotency-Key per dialog), suspend / reactivate / deactivate, retry provisioning, and the platform audit log; actions shown by platform permission.
- **Serving**: nginx serves `frontend/dist` with SPA fallback; `/api`, `/auth`, `/admin`, `/static` still go to the backend.

## Tested (executed)
130 vitest tests pass (incl. CRM and sales, inventory and goods receipt, procurement, delegation picker and resubmit, approvals inbox/requests, finance: balance rules, exact decimals, invoice actions and server errors, trial balance): sign-in flow (redirect with return path, callback once, error cases, session lost), platform tenants page, modal focus, return-path safety, error envelope, cursor helpers, base query (bearer header, 401 renew+retry, re-sign-in, error normalisation), DataTable states, permission gating, Users page (list, hidden actions, deactivate, invite validation + submit + server field errors). `tsc -b` clean, `vite build` OK, `npm audit`: 0 vulnerabilities.
Backend: full suite re-run after the directory endpoint was added, 684 tests passed, none failed (counted from the run output).

## Not done / not verified
- Not run against a real Keycloak + backend in a browser (only mocked HTTP; oidc-client-ts itself is stubbed in the sign-in tests).
- Platform console: no module entitlements screen, no tenant detail/provisioning-job view, no platform-admin or access-grant screens. Procurement: no RFQ/quotation comparison, contracts, supplier invoice matching or payments screens. No invoice or payment creation form, bank reconciliation, P&L / balance sheet pages. Inventory: no transfer orders, stock counts, reservations, lots/serial trace, reorder rules or landed-cost screens; the warehouse/location pickers use the first page of warehouses only. CRM/sales: no create or edit forms for accounts, opportunities, quotations and orders (quotation/order lines need a price lookup), no deliveries, returns, activities, campaigns or cases screens; account names come from the first page of accounts. Screens for the other modules (finance, HR, …), approvals inbox, notifications, audit view, search.
- No code-splitting yet (main chunk ~546 kB).

## Keycloak setup
1. Import `infrastructure/keycloak/erp-realm.json` (contains `erp-spa`) or create a public client `erp-spa` with PKCE (S256), standard flow only.
2. Set `KEYCLOAK_SPA_CLIENT_UUID` for the backend admin integration so provisioning registers each tenant's redirect URIs (`{scheme}://{host}/signin-callback`, post-logout `{scheme}://{host}/`). Keycloak does not allow host wildcards, so this is per tenant.
3. Dev: `cd frontend && npm install && npm run dev`; use a tenant host such as `http://acme.erp.localhost:5173`.

## F9 — Finance invoice and payment forms (2026-11-10)

Added
- **New invoice** dialog (customer or supplier invoice): partner list filtered by customer/supplier, dates, optional currency, supplier reference, any number of lines (description, quantity, price, postable account, tax rate filtered by sales/purchase). Zod + React Hook Form validation. Net/tax/total are an exact bigint estimate (`percentOf` added to `money.ts`); the server calculates the final amounts. Server refusals are shown as returned. Needs `finance.invoice.create`.
- **Payment dialog** on a POSTED invoice with an outstanding balance: receipt (customer) or payment (supplier), only bank/cash accounts in the invoice currency, amount checked against the outstanding balance (`validatePayment`). One `Idempotency-Key` per dialog, so a double click or retry replays the same payment instead of paying twice. Needs `finance.payment.release`.
- **Payments** list at `/app/finance/payments` (nav entry, needs `finance.invoice.view`).
- Endpoints: partners, tax rates, bank accounts, createInvoice, recordPayment, listPayments.

Tests: 141 passing (11 new). One AuthProvider test failed once in a parallel full run and passed on every re-run; it looks load-sensitive and has not been root-caused.

Not done in this slice: paying several invoices in one payment, partial-payment history per invoice, editing a draft invoice, credit/debit note forms, partner and tax-rate maintenance screens, bank reconciliation.

## F10 — Profit and loss, balance sheet (2026-11-10)

Closes two finance gaps. Pages `/app/finance/profit-loss` (period from/to, reversed period refused client-side) and `/app/finance/balance-sheet` (as-of date, shows unclosed current earnings in equity and the server's balanced flag). Both need `reports.financial.view`; figures are shown exactly as the server returns them. No backend change. 146 tests passing (5 new).

Still open in finance: cash-flow report, bank reconciliation, credit and debit note forms, draft invoice editing, partner and tax-rate screens.

## F11 — Credit notes (2026-11-10)

On a POSTED invoice (needs `finance.invoice.create`): **Issue credit note** opens the invoice dialog fixed to the matching credit-note kind, partner and currency, and sends `credit_for` so the server ties it to the original. On a POSTED credit note with credit left (needs `finance.invoice.approve`): **Apply to invoice** lists open posted invoices of the same side, partner and currency (first page only; the dialog says so) and checks the amount against the smaller outstanding balance (`validateCredit`); server refusals are shown as returned. Credit notes no longer show receipt/payment buttons. 151 tests passing (5 new). No backend change.

Note: the backend has customer and supplier credit notes only. There is no separate debit-note document type, so no debit-note form exists. If a supplier debit note is wanted, it needs a backend decision first.

Still open in finance: cash-flow report, bank reconciliation, draft invoice editing, partner and tax-rate screens.

## F12 — Bank reconciliation (backend + screens) (2026-11-10)

This feature was missing from the backend, so the slice includes it.

Backend (finance module, tenant schema, migration `0003_bank_reconciliation`)
- Models `BankStatement` (bank account, date, opening/closing balance, OPEN/RECONCILED) and `BankStatementLine` (signed amount: money in positive, out negative; optional one-to-one link to a ledger line; DB check that the amount is non-zero).
- Rules: a statement must add up (opening + lines = closing) when created and again when reconciled; a line can only be matched to a posted (or reversed) ledger line on that bank account's GL account with exactly the same signed amount; one ledger line can back only one statement line (DB unique constraint, concurrent attempts get `already_matched`); a reconciled statement is locked; reconciling needs every line matched and is audited.
- Endpoints under `/api/v1/finance/bank-statements` (list, create, detail, `candidates?amount=`, `lines/<id>/match`, `lines/<id>/unmatch`, `reconcile`). Viewing needs `finance.accounts.view`; everything else needs the new permission `finance.bank.reconcile`, granted to the Finance Controller only (so the person who approves invoices does not also reconcile the bank).
- Tests: 5 new in `tests/test_finance.py` (add-up and line validation, match rules and full cycle, drafts and other accounts refused, withdrawals, API permission matrix and flow). Full backend suite: 689 dots, no failures (previously 684). The candidates list is capped at 200 rows (newest first); narrow it with the amount filter.

Frontend
- `/app/finance/reconciliation`: statements list and **New statement** dialog (bank account, date, balances, pasted lines `date,description,amount`; exact bigint add-up check; line-numbered parse errors).
- `/app/finance/reconciliation/:id`: lines with matched/unmatched state; **Match…** lists unmatched ledger lines with the same amount from the server; Unmatch; **Reconcile statement** enabled only when every line is matched. Server refusals are shown as returned.
- Frontend tests: 162 passing in total (11 new).

Not done: importing bank files (CSV upload, OFX, MT940) beyond pasted lines, automatic match suggestions, matching one statement line to several ledger lines (or the reverse), bank charges/interest posting from the reconciliation screen, a reconciliation report, checking that a statement's opening balance equals the previous statement's closing balance.

## F13 — Edit drafts, partners, tax rates (2026-11-10)

- **Edit draft** on a DRAFT invoice or credit note (needs `finance.invoice.create`): the invoice dialog in edit mode, prefilled from the document (the stored lines carry the account code, so the form fills once the chart of accounts has loaded and maps the code back to its id). Sends `PUT` with the document `version`; a concurrent change is refused by the server (`version_conflict`) and shown. Partner, kind and currency cannot be changed.
- **Partners** `/app/finance/partners` (list; **New partner** needs `finance.invoice.create`, the backend's rule) and **Tax rates** `/app/finance/tax-rates` (list; **New tax rate** needs `finance.accounts.manage`). Tax account choices follow the backend rule: sales tax posts to a liability account, purchase tax to an asset account. Rate is checked 0–100 with up to 4 decimals, exactly.
- 170 frontend tests passing (8 new). No backend change in this slice (backend suite last run: 689 passed, no failures).

Not done: editing or deactivating partners and tax rates (the backend has no update endpoint for them), creating bank accounts, a cash-flow report (the figures exist only as the analytics dataset `finance.cash-flow` and will come with the analytics screens), paging beyond the first 50 partners or tax rates.

## F14 — RFQs and quotation comparison (backend read endpoint + screens) (2026-11-10)

Backend: new read-only `GET /api/v1/procurement/rfqs/<id>` (needs `procurement.view`): lines, invited suppliers, and every quotation with its per-line prices. The bids of a **tender** stay hidden (`sealed: true`, only a count) until the committee has opened them, the same rule the comparison endpoint applies. The RFQ list now also returns `kind` and `due_date`. Test added in `tests/test_procurement_sourcing.py` (permissions, lines and prices, sealed tender, comparison still 403 while sealed).

Frontend
- `/app/procurement/rfqs`: list and **New RFQ** (needs `procurement.rfq.manage`): title, due date, invite qualified suppliers, and either lines entered by hand (optional product picker) or an approved requisition.
- `/app/procurement/rfqs/:id`: lines × quotations matrix with the lowest unit price per line and the lowest total marked (company-currency totals come from the server's comparison), lead times, disqualified and awarded badges.
- **Record quotation** (`procurement.rfq.manage`, RFQ open, only invited suppliers that have not quoted): currency, lead time, a price for every line, exact decimal checks.
- **Award** (`procurement.tender.award`, RFQ open or evaluating) uses the justified-award endpoint, so the server enforces its rules (disqualified bids, non-compliant bids, separation of duties for tenders). Awarding a bid that is not the lowest needs a written justification, checked in the browser and again by the server. It creates the draft purchase order.

Not done: tender opening by the committee, scoring and disqualifying bids, clarifications, supplier-facing bid submission (quotations are recorded by procurement staff), open-to-all RFQs in the create form, RFQ cancellation (no endpoint), contracts, supplier-invoice matching, supplier evaluation screens.

F14 test results: backend full suite 690 passed, no failures (689 before plus the new RFQ detail test); frontend 180 passing (10 new).

## F15 — Supplier-invoice matching (2026-11-10/11)

No backend change; uses the existing match, exceptions and override endpoints.

- **Match invoice** button on a purchase order (needs `procurement.invoice.match`; shown once the order is approved, not for draft, pending or cancelled orders). Lists unposted supplier invoices in the order's currency, runs a three-way (or two-way, if the company allows it) match and shows the result: ordered, received, previously invoiced and this invoice's goods value, the tolerance, and each problem in plain words (duplicate invoice, more invoiced than received or ordered, goods awaiting inspection) plus similar invoices already recorded. Server refusals (different supplier, currency, nothing to match, two-way disabled) are shown as returned. The list is not filtered by supplier in the browser; the server refuses a different supplier.
- **Match exceptions** page `/app/procurement/match-exceptions` (needs `procurement.invoice.match`): every invoice that failed matching, with its problems. **Override** (needs `procurement.invoice.override`) takes a reason; the server requires a different person from whoever ran the match and refuses duplicates (the page does not even offer override for a duplicate).
- Tests: 189 frontend tests passing (9 new). Backend last full run: 690 passed, no failures (no backend change since).

Not done: seeing an invoice's match status on the finance invoice screen (there is no endpoint that returns it per invoice; a failed match shows up as the server's refusal when posting), recording a supplier invoice for received goods from the PO screen (it is created on the finance Invoices screen, with the goods-received account on the line), debit notes against supplier invoices, supplier payments with early-payment discount and withholding tax, payment ageing and due lists, contracts, supplier evaluation.

## F16 — Supplier payments (2026-11-11)

No backend change; uses the existing supplier-payment endpoints. Page `/app/procurement/payments` (needs `procurement.payment.release`) with three views:
- **Due for payment** (as-of date, due within N days): supplier, invoice and supplier reference, due date and days late, outstanding, early-payment discount available, withholding tax. **Pay…** opens a dialog: bank or cash account in the invoice currency, payment date, take the discount, withhold tax, memo, and an estimated cash-out (exact bigint, from the figures listed for the as-of date; the server recalculates for the payment date). One `Idempotency-Key` per dialog, so a double click or retry replays the same payment, and the dialog says when it was a replay. Pay is not offered when the supplier has no verified bank account or is blacklisted. Server refusals (separation of duties, no verified bank, blacklisted, nothing to pay) are shown as returned.
- **Ageing**: open balances per supplier and currency in not-yet-due, 1–30, 31–60, 61–90 and 90+ day buckets.
- **Withholding tax**: tax withheld per supplier and currency for a period (reversed periods refused in the browser).
- 196 frontend tests passing (7 new). Backend last full run: 690 passed, no failures (no backend change since).

Not done: paying several invoices in one run, part-payments (the server pays the whole balance), supplier statement view (endpoint exists), supplier bank-account maintenance and verification, debit notes against supplier invoices, supplier contracts and evaluation screens.

## F17 — Stock counts (2026-11-11)

No backend change; uses the existing stock-count endpoints. Pages `/app/inventory/counts` (list; **New count** needs `inventory.stock.adjust`) and `/app/inventory/counts/:id`.
- **New count**: warehouse, cycle (chosen locations and/or products) or full, optional planned date, note, and the option to freeze stock movements at the counted locations.
- **Workflow in the screens**: Start (takes the system-quantity snapshot and creates the sheet) → counters enter quantities on a **blind** sheet (system quantities are never sent to or shown on it; each line saved on its own, 0 or more, up to 4 decimals) → Submit (server refuses while lines are uncounted) → an approver (`inventory.adjustment.approve`) sees **variances** (system, counted, variance and percentage, value), can request a **recount** of chosen lines, or **Approve and post adjustments** (the server posts the stock adjustments and refuses the person who created the count). Cancel until the count is final. Lines assigned to another counter are refused by the server and the message is shown.
- 205 frontend tests passing (9 new). Backend last full run: 690 passed, no failures (no backend change since).

Not done: assigning counters to locations or lines (endpoint exists), serial-tracked products (the server excludes them from counts), count history per product, transfer orders and reservations screens, adjustment requests and policy, lot tracing, landed costs, material requisitions.

## F18 — Transfer orders and reservations (2026-11-11)

No backend change; uses the existing transfer-order, reservation and availability endpoints.
- **Transfers** `/app/inventory/transfers` (list; **New transfer** needs `inventory.stock.issue`): source and destination warehouses (must differ), lines with product, source location, quantity and optional lot, expected date, reason. The detail dialog offers only the actions that fit the status and the user's permissions: Submit (draft), Approve and Reject (requested; `inventory.transfer.approve`; rejection needs a note in the browser too), Dispatch with optional carrier (approved), **Receive goods** (in transit or partly received; `inventory.goods.receive`) with accepted, rejected and damaged quantities and a put-away location per line, and Cancel (before dispatch). The browser refuses over-receipt against what is still in transit; the server repeats every check, including refusing the requester approving their own transfer, and its messages are shown as returned.
- **Reservations** `/app/inventory/reservations`: active/released/all list, **New reservation** (shows current availability for the chosen product and warehouse; the server refuses more than is available) and **Release** (both need `inventory.stock.issue`).
- Tests: 214 frontend tests passing (9 new), tsc clean, build OK, 0 vulnerabilities. Backend last full run: 690 passed (no backend change since).

Not done: a full browser walkthrough of the create-transfer dialog through to a saved transfer (the test covers client-side validation only), transfer line-level partial dispatch, reservations created from sales orders (the API takes a free reference), adjustment requests and policy, lot tracing, landed costs, material requisitions, counter assignment.

## F19 — HR: leave and employee directory (2026-11-11)

First HR screens. No backend change; uses the existing `/api/v1/hr/me`, `leave/types`, `leave/requests` (+ cancel/approve/reject) and `employees` endpoints. Both pages need `hr.self`.
- **Leave** `/app/hr/leave`: my leave balances (shown as the server returns them), a status filter, and the requests the server lets me see (mine, my direct reports', everyone's for HR). **Request leave** (type, first and last day, optional half day and reason) checks in the browser that dates are in order, within one calendar year, and that a half day is a single day; the server owns balances, eligibility and overlap and its refusals are shown as returned. **Cancel** on my own pending or approved requests. **Approve** and **Reject** (`hr.leave.approve`) are offered only on other people's pending requests; rejecting needs a reason.
- **Employees** `/app/hr/employees`: the directory the server allows (HR sees everyone, others themselves and direct reports), status filter, and a search that filters the current page only. Bank, tax and phone details are not displayed.
- Tests: 220 frontend tests passing (6 new), tsc clean, build OK, 0 vulnerabilities. Backend last full run: 690 passed (no backend change since).

Not done: employee detail/edit/create/onboarding/offboarding/contracts, attendance and check-in, timesheets, payslips and payroll runs, overtime, schedules, delegations, leave calendar and reports, recruitment, performance, learning, resignation, org chart. The Who column on leave requests shows an id prefix for other people because the API returns the employee id, not the name; it should be resolved once the directory is loaded or the API adds a name.

## F20 — HR: attendance and timesheets (2026-11-11)

No backend change; uses `hr/me/check-in`, `hr/me/check-out`, `hr/attendance` and `hr/timesheets` (+ submit/approve/reject). Both pages need `hr.self`.
- **Attendance** `/app/hr/attendance`: **Check in** with a work mode (office, remote, field, travel) or **Check out** when a day is open. The clock time is set by the server; the browser sends none. Server refusals (already clocked in, not clocked in, not active) are shown as returned. History of my recorded days (date, in, out, hours).
- **Timesheets** `/app/hr/timesheets`: new/edit weekly sheet (Monday start, entries with date, hours, optional project and description, running total in exact arithmetic). The browser checks Monday start, entries inside the week, hours above 0 and at most 24, and 24 hours per day; the server repeats the checks. Save draft, **Submit** (own draft), **Edit** (own draft or rejected). **Approve** and **Reject** (needs `hr.timesheet.approve`) only on other people's submitted sheets; rejecting needs a reason.
- Tests: 226 frontend tests passing (6 new), tsc clean, build OK, 0 vulnerabilities. Backend last full run: 690 passed (no backend change since).

Not done: attendance of my team, manual corrections and their approval, overtime requests, schedules, attendance reports and exceptions, linking timesheet hours to projects (project is a free reference), the "who" column showing an id prefix for other people's sheets (the API returns the employee id).

## F21 — HR: payroll runs and payslips (2026-11-11)

No backend change; uses `hr/payroll/runs` (+ recalculate, submit, cancel, approve, reject, post, pay) and `hr/me/payslips`.
- **Payroll** `/app/hr/payroll` (needs `hr.payroll.view`): list of runs; **New run** for a period (`hr.payroll.process`; the server refuses a second run for the same period). The run dialog shows totals (gross, tax, employee and employer pension, other deductions, net) and per-employee payslip lines. Buttons follow the status and the user's permissions: Recalculate, Submit for approval and Cancel (draft), Approve and Send back with a required note (pending, `hr.payroll.approve`), Post to ledger (approved), Record payment with optional date (posted, `hr.payroll.pay`). A run governed by an approval workflow shows a pointer to the approval inbox instead of approve/send back. Separation of duties (preparer, approver, poster, payer must differ) is enforced by the server and its refusals are shown as returned; the UI does not guess who prepared a run.
- **My payslips** `/app/hr/payslips` (needs `hr.self`): the signed-in employee's payslips with a line-by-line breakdown and net pay. The server returns only approved, posted or paid runs.
- Tests: 233 frontend tests passing (7 new), tsc clean, build OK, 0 vulnerabilities. Backend last full run: 690 passed (no backend change since).

Not done: payroll reversal, register, cost allocation and payment instructions views (endpoints exist), payroll inputs (variable pay) and their approval, pay components, tax brackets and pension rule maintenance, other employees' payslips by HR, downloading payslips as PDF, payroll posting preview of the ledger entry.

## F22 — Projects: list, project page, tasks, my tasks (2026-11-11)

No backend change; uses `projects/projects` (+ status), `projects/projects/<id>/tasks`, `projects/tasks/<id>/progress` and `projects/my-tasks`. Needs `projects.view` (New project: `projects.create`).
- **Projects** `/app/projects/projects`: list with name search and status filter, **New project** (name, planned dates, billing type, contract value, optional manager picked from the directory, description; the browser checks name, date order, non-negative value and no value on a non-billable project; the server repeats the checks and decides the manager and customer).
- **Project page** `/app/projects/projects/:id`: header with dates, billing and value, status buttons for the moves the server allows (Planning → Active/Cancelled, Active → On hold/Completed/Cancelled, On hold → Active/Cancelled), each asking for a reason; the server refuses, for example, completing a project with open tasks, and the message is shown as returned. Task table (WBS, name, planned dates and hours, percent done, status), **Add task** (needs manager rights on the server; milestone option, optional assignee), and **Update progress** (0–100, milestones reached or not) shown only while the project is active; the server limits it to the assignee or project manager.
- **My tasks** `/app/projects/my-tasks`: my open tasks on active projects, with the same progress dialog.
- Tests: 242 frontend tests passing (9 new), tsc clean, build OK, 0 vulnerabilities. Backend last full run: 690 passed (no backend change since).

Not done: Gantt chart and critical path (endpoint exists), task dependencies, shifting dates, editing or deleting tasks and projects, sub-tasks (parent) in the form, team members and rates, budgets, expenses, cost report, time report, risks and issues, billing, profitability, health, portfolio, resource load; customer, department and cost-centre pickers on the project form; task assignees are shown by id elsewhere in the API but this page does not display them.

## F23 — HR: employee record and lifecycle (2026-11-11)

No backend change. First of the slices that finish HR and payroll.
- **Employees** `/app/hr/employees`: names link to the record; **New employee** (`hr.employee.manage`): name, hire date, email, phone, department, position (pickers from the organisation lists), employment type. The server's duplicate refusal is shown and only then is the "different person, create anyway" option offered.
- **Employee page** `/app/hr/employees/:id`, tabs:
  - Overview: details, probation status, onboarding/offboarding checklist (Mark done: the server decides who may complete each item), and **Evaluate probation** (confirm, extend, fail; the server refuses evaluating your own probation and requires notes/new date).
  - Employment (`hr.compensation.view`; changes need `hr.compensation.manage`): contracts, add, end, and final settlement.
  - Records: emergency contacts, skills, qualifications (add/remove) and documents (upload with type, title, expiry; missing required documents counted).
  - Assignment: transfers, promotions and reporting-line changes: request, approve/reject (HR), cancel.
  - History: the employment event log.
  - Header buttons for HR: Edit, Activate (onboarding), Start offboarding (last day, type, reason), Complete termination.
- Leave and timesheet pages now show people's names instead of an id prefix (resolved from the first page of the directory; falls back to a short id).
- Tests: 252 frontend tests passing (10 new), tsc clean, build OK, 0 vulnerabilities. Backend last full run: 690 passed.

Not done in this slice (later HR slices): bulk employee import, grades and position plans, org chart, separations list/resignation, pay components on an employee, salary history, edit of department/position selection is "change only if chosen" (use the Assignment tab for approved changes).

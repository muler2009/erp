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

## F24 — Payroll administration and compensation (2026-11-12)

No backend change. Also corrects four mismatches in F23 found by reading the backend enums: employment types are Full time/Part time/Contractor/Intern; contract kinds Permanent/Fixed term/Casual; skill level is 1–5; assignment changes are Promotion/Transfer/Reporting line and must name something to change (department, position, manager or remove manager), which the form now requires. Dialog checks that throw plain errors are now shown as written.
- **Pay setup** `/app/hr/pay-setup` (`hr.compensation.view`, edit with `hr.compensation.manage`): allowance/deduction components (create: code, kind, fixed or percent of basic, value, taxable) and income tax brackets (editable table; the browser checks start at 0, rising bounds, rate 0–100; read-only without manage).
- **Compensation** `/app/hr/compensation`: tabs *Salary revisions* (request, approve/reject; `hr.compensation.view/manage`), *Variable pay* (add bonus/commission/arrears/adjustment/reimbursement for a month, approve/reject needs `hr.payroll.approve`; negative only for adjustments), *Loans* (any employee requests their own loan or advance; HR requests for others and approves/rejects/cancels; amount, 1–60 installments, first deduction month).
- **Payroll run dialog**: Payroll register, Cost by department, Payment instructions (`hr.payroll.pay`; shows total, employees with no bank account, and downloads a CSV generated in the browser with spreadsheet-formula neutralising), and **Reverse run** with a required reason (posted or paid runs, `hr.payroll.pay`).
- **Employee page, Employment tab**: salary history, assign a pay component (with optional end date and override value), and the employee's payslips (`hr.payroll.view`).
- Tests: 262 frontend tests passing (10 new), tsc clean, build OK, 0 vulnerabilities. Backend last full run: 690 passed.

Not done in this slice: editing or deactivating components, viewing an employee's assigned components (no read endpoint exists), loan schedule detail, bank account entry for employees, PDF payslips.

## F25 — HR: attendance management, leave management, work time setup (2026-11-12)

No backend change. All three pages need `hr.self`; each tab shows only what the user's permissions allow, and the server limits every list and report to the people the user may see.
- **Attendance management** `/app/hr/attendance-admin`: *Corrections* (request for yourself, or for an employee with `hr.employee.manage`; clock times are sent as UTC instants; approve/reject with `hr.timesheet.approve`), *Overtime* (same pattern; hours above 0 and at most 24), *Exceptions* (late, early, missed punch, absent, with any correction or overtime request status) and *Report* (period and day/week/month grouping).
- **Leave management** `/app/hr/leave-admin`: *Calendar* (who is away, holidays), *Report* (by employee, department or leave type, plus absence by month), *Leave types* (`hr.config.manage`: name, grant mode, annual days, carry-over, eligibility, notice, half days, employment types, active), *Allocations* (`hr.employee.manage`: set an employee's days for a year; with `hr.config.manage`, run accrual or year-end, which the server makes idempotent) and *Delegations* (`hr.leave.approve`: delegate approvals to a colleague for a period and revoke; the server has no list endpoint, so only delegations made in the current session are shown).
- **Work time setup** `/app/hr/work-time`: *Schedules* (list, create with `hr.config.manage`, assign to an employee with `hr.employee.manage`) and *Overtime policy* (view; edit with `hr.config.manage`; multipliers at least 1, daily maximum 0–24).
- Employee edit dialog now also takes bank account and tax ID (blank keeps the current value), which payment instructions need.
- Tests: 273 frontend tests passing (11 new), tsc clean, build OK, 0 vulnerabilities. Backend last full run: 690 passed.

Not done: punch import from devices (`hr/attendance/import`), per-employee daily attendance summary view, other employees' attendance list, holiday calendar maintenance (organisation module), delegations history.

## F26 — HR recruitment

**Implemented**
- Job requisitions (`/app/hr/recruitment`): list, create (title, headcount 1–500, justification, optional department/position), submit, approve/reject (`hr.recruitment.approve`; reject needs a reason), close; candidates-by-stage funnel.
- Candidate pipeline (`/app/hr/recruitment/:id`): add candidate, move Applied→Screening→Interview, reject/withdraw (reason required), schedule interview (interviewer picker + date/time sent with zone), scorecard, create offer (salary > 0, 3-letter currency, start date today or later; money as a decimal string), approve/accept/decline offer, hire (shows the new employee number).
- My interviews (`/app/hr/my-interviews`): interviews awaiting feedback; feedback with score 1–5 and Hire/No-hire recommendation.
- Backend: candidate payload now includes `offer` and `interviews` so the screen has the ids it needs (assertions added to `tests/test_hr_talent.py`).
- Naming: frontend type/hook names use `JobRequisition` to avoid clashing with procurement requisitions.

**Tested**: 11 new frontend tests (validators, permission-gated approval, reject reason, server refusal shown, offer past-date block, hire, feedback). Frontend total 284 passing; tsc clean; build OK; `npm audit` 0 vulnerabilities.

**Not done**: not run in a real browser against real Keycloak/backend; no endpoint to list offers across requisitions; no list of a requisition's interviews outside the candidate payload.

## F27 — HR talent

**Implemented**
- Performance (`/app/hr/performance`): cycles (create, activate, close — `hr.performance.manage`), goals (add with weight, update progress 0–100), reviews with self / manager / acknowledge actions by status.
- Learning (`/app/hr/learning`): courses, training records, record training, mandatory-training compliance (missing/expired/expiring, managers only).
- Employee relations (`/app/hr/cases`): case list and detail, open case, file a grievance (any employee), notes and close (managers; notes only returned to managers by the backend).
- Policies (`/app/hr/policies`): list/read, create and edit drafts, publish, acknowledge, who has not acknowledged.
- Reimbursements (`/app/hr/reimbursements`): submit claim (amount as decimal string, no future date), approve/reject (reason required to reject) with separation-of-duties refusals shown as returned.
- Money is formatted with the shared bigint helper; all permission-aware controls are UX only.

**Tested**: 11 new tests (validators, permission gating, refusals shown, local validation before calls, payload shapes). Frontend total 295 passing; tsc clean; build OK; `npm audit` 0 vulnerabilities.

**Not done**: not run in a real browser against real Keycloak/backend; manager-review button is shown to everyone with `hr.self` (the backend decides who may rate); no goal-edit/delete; policy edit shows an empty form rather than pre-filled text.

## F28 — HR administration: separations, organization, monitoring, analytics, imports

**Implemented**
- Separations (`/app/hr/separations`): HR list with status filter, accept / reject (note required), record settlement (amount as decimal string, ≥ 0); employee self-service resignation (future last day, reason) and withdraw.
- Organization (`/app/hr/organization`): reporting-line tree, headcount plan (approved / filled / vacant / over plan), job grades list and create (`hr.config.manage`, salary range checked).
- Monitoring (`/app/hr/monitoring`): probation, contracts, documents, qualifications, retirements for a 30–180 day look-ahead.
- HR analytics (`/app/hr/analytics`): headcount, turnover, tenure, recruitment funnel, leave days, payroll cost (shown only when the server returns it).
- Imports (`/app/hr/imports`): employee CSV — check first, import enabled only when every row is valid, row errors listed; attendance punches (`employee_no,timestamp` with zone, max 5,000), results incl. unknown employees. Sections follow `hr.employee.manage` / `hr.attendance.import`.

**Tested**: 11 new tests. Frontend total 306 passing (clean run); tsc clean; build OK; `npm audit` 0 vulnerabilities. Note: running the full suite while a build runs in parallel caused two timing-related failures in unrelated tests; both pass alone and in a clean full run.

**Not done**: not run in a real browser against real Keycloak/backend; a resigning employee can withdraw only in the same session (there is no endpoint returning their own resignation); position-plan editing (`PUT hr/positions/:id/plan`) has an endpoint hook but no screen; policy edit form is not pre-filled; punch-only importers have no nav entry unless they also hold `hr.employee.manage`; no worker-pay or other analytics kinds beyond the dashboard.

## F29 — Projects: money side, registers and team

**Implemented** (all under `/app/projects/projects/:id/…`, with a section nav on every project page)
- Budget & costs (`/finance`): budget revisions (create with category lines, edit a draft, submit, approve/reject with `projects.budget.approve`, revision reason required), cost report by category with over-budget flags and earned-value indices (CPI/SPI/forecast), profitability and billing summary. Server refusals (e.g. only manager/finance may see costs; separation of duties) are shown as returned.
- Expenses (`/expenses`): list, submit (non-labour categories, amount > 0, no future date), approve/reject (reason required).
- Risks & issues (`/risks`): raise risks (probability/impact 1–5, score badge) and issues (severity), only legal status moves offered, note required to close a risk / resolve an issue.
- Team (`/team`): members with role, rates, allocation; add (person picker, rates ≥ 0, allocation 0–100), remove (manager cannot be removed; server refusals shown).
- Money is decimal strings / bigint-based formatting throughout.

**Tested**: 13 new tests. Frontend total 318 passing; tsc clean; build OK; `npm audit` 0 vulnerabilities.

**Not done**: not run in a real browser against real Keycloak/backend; Gantt chart, task dependencies, resource-load report, time report, project invoicing (POST billing) and expense receipt upload have no screens; team page shows "User <id>" for members it did not add this session (no user-name lookup by id); risk/issue owner/assignee editing not exposed; budget approve/reject buttons are permission-hidden but approval limits are decided by the server.

## F30 — Projects: schedule, dependencies, time & billing, resource load

**Implemented**
- Schedule (`/app/projects/projects/:id/schedule`): Gantt bars on the project timeline (clamped to the span), critical path and slack, critical tasks flagged, link tasks (finish-to-start / start-to-start, lag), remove a link, move a task by N days with or without dependents; server refusals (circular link, dependency violated) shown as returned.
- Time & billing (`/billing`): approved hours with cost for a chosen period, time-billing preview (`projects.billing.manage` only), create invoice (milestone / approved time / advance; amount as decimal string), invoices raised summary.
- Resource load (`/app/projects/resource-load`): per-person allocation and planned-hours load for a period and weekly capacity, over-allocated/overloaded flags.
- Backend: the Gantt payload's predecessor links now carry their `id` (needed to remove a dependency); assertion added to `tests/test_projects_wbs.py`.
- Test fix: the AuthProvider "session lost" test raced the effect that registers the handler (failed ~1 in 3 runs); it now waits for the registration. 8/8 consecutive runs pass.

**Tested**: 9 new frontend tests. Frontend total 327 passing (clean run); tsc clean; build OK; `npm audit` 0 vulnerabilities. Backend: all `projects` tests pass (29).

**Not done**: not run in a real browser against real Keycloak/backend; Gantt is read-only (no drag to reschedule; use "Move"); no task editing of planned dates/hours outside the existing task dialogs; time and resource reports show "User <id>" instead of names (no name lookup by id); the full backend suite was not re-run this slice (change limited to one payload key).

## F31 — Assets: register, asset record, setup

**Implemented**
- Register (`/app/assets/register`): searchable, status-filterable asset list (cursor paging), create asset (category, name, purchase cost as decimal string, acquisition date, maker/model/serial) with `assets.asset.manage`.
- Asset record (`/app/assets/register/:id`): details, manual status moves limited to the ones the backend allows (Requested→Ordered/Received, Ordered→Received, Received→Available, Available→Retired; reason required to retire), edit with the record's `version` sent so concurrent edits are refused by the server, depreciation schedule (next 12 periods; the server's reason is shown when the asset is not capitalised), change history.
- Setup (`/app/assets/setup`): asset categories (code, class, depreciation method straight-line / reducing balance / none, useful life, residual %, annual rate, capitalisation threshold, serial required) and locations; create dialogs gated by `assets.category.manage` / `assets.location.manage`.

**Tested**: 8 new tests. Frontend total 335 passing; tsc clean; build OK; `npm audit` 0 vulnerabilities. No backend change.

**Not done**: not run in a real browser against real Keycloak/backend. Rest of the assets module has no screens yet: acquisition & capitalisation approval, custody (assignments, transfers, handover form), depreciation runs & valuation/adjustments & reconciliation, maintenance (plans, work orders, breakdowns, meters), inspections / warranties / insurance, fleet (allocations, usage, vehicles), disposals & verification counts, planning (dashboard, replacement plan, capex budgets). Documents upload, barcode/QR label view and category editing/deactivation are also not exposed.

## F32 — Assets: acquisition, capitalisation, custody, transfers

**Implemented**
- Acquisition card on the asset record: record acquisition (source, cost as decimal string), add acquisition costs (freight, installation, duty, …), accept delivery, record commissioning (passed/failed), request capitalisation; totals and readiness shown. Actions need `assets.acquisition.manage`.
- Capitalisation requests (`/app/assets/capitalizations`): status filter, shows depreciable base and flags below-threshold requests as expensed; approve / reject (reason required) with `assets.capitalization.approve`; separation-of-duties refusals shown as returned.
- Custody (`/app/assets/custody`): assignments (new assignment for employee / department / project / location, permanent or temporary with return date; approve, reject, hand over with condition, acknowledge receipt, record return, cancel — each shown only in the status where it is legal and with its permission), transfers (new transfer with destination location/department; approve, reject, dispatch, receive with condition, cancel), and custody exceptions (overdue returns, unacknowledged handovers).
- Backend: the transfer history rows now carry their `id` (needed to act on a transfer); assertion added to `tests/test_assets_custody.py` (6 passed).

**Tested**: 10 new frontend tests. Frontend total 345 passing; tsc clean; build OK; `npm audit` 0 vulnerabilities.

**Not done**: not run in a real browser against real Keycloak/backend. Asset pickers list the first page of AVAILABLE assets only (no search); transfers cannot name a new custodian from the UI; handover form (print/HTML) and acquisition links to PO / goods receipt / invoice are not exposed; still no screens for depreciation runs / valuation / adjustments / reconciliation, maintenance, inspections / warranties / insurance, fleet, disposals / verification counts, planning (dashboard, replacement plan, capex budgets).

## F33 — Assets: depreciation, valuation and value adjustments

**Implemented**
- `/app/assets/depreciation`: monthly runs by year (run, reverse with reason), register-vs-ledger reconciliation with a visible "Does not reconcile" state, valuation report with as-of and category filters and totals, value-adjustment list with status filter, approve, and reject (reason required).
- Asset page: "Adjust value" (improvement, revaluation, impairment) and "Change depreciation policy" dialogs, gated by `assets.valuation.manage`.
- Backend: `depreciation_report` rows now carry the run `id` (assertion added).
- Sequence, separation-of-duties and below-residual refusals come from the server and are shown as returned.

**Tested**: 7 backend depreciation tests; 352 frontend tests (7 new in `depreciation.test.tsx`), tsc clean, build OK.

**Not done**: real-browser run against Keycloak; the maintenance, inspections/insurance, fleet, disposals/counts and planning parts of assets; the adjustment list shows asset numbers, not names.

## F34 — Assets: maintenance

**Implemented** (`/app/assets/maintenance`, four tabs)
- Work orders: status filter, create, approve / reject (reason), assign (technician or service provider), start, add labour, add spare part (issued from inventory stock), add external cost, complete, verify (pass or fail), cancel. Actions show only for the matching state and permission; every refusal (for example separation of duties) is shown as the server returns it.
- Breakdowns: report, diagnose, open repair, close, status filter.
- Plans and meters: plan list, new time- or usage-based plan, record a meter reading.
- Reports: out-of-service assets, coming-due schedule (7–90 days), verified cost by asset / category / kind, breakdown analysis (MTTR, MTBF, recurring failures).
- No backend change was needed.

**Tested**: 361 frontend tests (9 new in `maintenance.test.tsx`), tsc clean, build OK, 0 vulnerabilities.

**Not done**: real-browser run against Keycloak; plan edit / deactivate (no backend endpoint); technician and provider show as ids on a work order (no name lookup); inspections, warranties, insurance, fleet, disposals, counts and planning screens.

## F35 — Assets: inspections, warranties and insurance

**Implemented**
- `/app/assets/inspections`: scheduled inspections (schedule, complete against the checklist, cancel), findings (raise a repair, resolve), checklist templates, condition-by-category report with overdue inspections. Completing checks pass/fail answers, readings, the condition and the "failed item needs a finding" rule before sending.
- `/app/assets/coverage`: insurance policies (create, cover or remove an asset, renew, file a claim with a policy-period check), a claims list for both warranty and insurance claims (accept, reject, settle with amount recovered), and a watch list of uninsured assets and expiring warranties/policies.
- Asset page: warranty card (in-force warranty, history, add a warranty, file a warranty claim).
- Backend: new `GET /api/v1/assets/claims` (both claim kinds, optional status) because claims could only be decided right after filing; test added (403 for a user without `assets.view`).
- Fixed an existing HR test that raced its own option loading.

**Tested**: backend inspection/warranty and maintenance tests pass; 369 frontend tests (8 new in `coverage.test.tsx`), tsc clean, build OK, 0 vulnerabilities.

**Not done**: uploading inspection evidence files (multipart; the backend supports it); real-browser run against Keycloak; warranty claim linked to a breakdown; fleet, disposals and counts, planning screens for assets.

## F36 — Assets: disposals, verification counts and planning

**Implemented**
- `/app/assets/disposals`: request (sale needs a buyer), approve / reject (reason), execute (proceeds only for a sale), cancel, completed-disposal certificate, disposal report by period with totals.
- `/app/assets/counts`: start a count (by location and category), scan assets by code with found-at location and condition, finish scanning, results with accuracy, resolve each discrepancy with only the choices the server allows for that kind, close (disabled until all resolved), cancel.
- `/app/assets/planning`: dashboard (value, ledger match, attention tiles, assets by status), replacement candidates with one-click planning, replacement plan (approve / reject), capital budgets (propose, approve / reject) and budget-against-spend report with an over-budget flag.
- Separation-of-duties and other refusals are shown as the server returns them. No backend change was needed.

**Tested**: 379 frontend tests (10 new in `lifecycle.test.tsx`), tsc clean, build OK, 0 vulnerabilities.

**Not done**: real-browser run against Keycloak; camera/barcode-reader scanning (typed or scanner-keyboard entry only); the count list does not show per-line expected assets, only discrepancies; fleet screens (usage, vehicle expiries, utilization reports); a disposal's buyer reference field.

## F37 — Assets: fleet, allocation and utilization (assets module frontend complete)

**Implemented**
- `/app/assets/fleet`: vehicles (register, assign driver with a licence expiry, renew registration, log fuel, report incident), per-vehicle history (fuel efficiency in km/L, incidents with close), expiries of registration, licence and insurance, running-cost report with cost per km.
- `/app/assets/allocations`: allocate an asset to a project or department with a share percentage, end an allocation, log hours (1–24) against it; utilization report with idle / under-used flags and configurable hours and threshold; hours by project and department.
- Backend: new `GET /api/v1/assets/vehicles/<id>/info/incidents` (incidents could only be closed right after reporting); test added (open→closed, 403 without view).
- Server refusals (electric vehicle fuel log, over-allocation, licence expired) are shown as returned.

**Tested**: backend fleet tests pass (7); 389 frontend tests (10 new in `fleet.test.tsx`), tsc clean, build OK, 0 vulnerabilities.

**Not done**: allocation to a cost centre (no cost-centre API in the frontend yet — project and department only); fuel logs are not listed, only the efficiency they produce; real-browser run against Keycloak.

## F38 — Quality: dashboard, non-conformances, my actions

**Implemented**
- `/app/quality/dashboard`: tiles for open NCRs, CAPAs, overdue work, inspections, holds, complaints, findings, risks, compliance; severity and supplier-status breakdowns.
- `/app/quality/ncrs`: filterable list (status, severity, hide closed) and a raise dialog that requires a source record unless the source is Other.
- `/app/quality/ncrs/:id`: status-driven actions (edit investigation, assign, contain with optional hold, submit, resubmit after changes requested, dismiss, raise CAPA, start implementation, request verification, verify and close, reopen). Shared panels for actions, evidence (upload and download), costs and history.
- `/app/quality/my-actions`: assigned actions with overdue flag and completion note.
- Shared pieces: `shared/lib/fileDownload.ts`, `features/quality/{names,panels}`.

**Tested**: 11 new tests (validators, permission gating, source-record rule, submission gate, resubmit detection, server refusal display, dashboard, my actions). Full suite 400 passed, `tsc -b` clean, build OK, `npm audit` 0 vulnerabilities.

**Not done**: CAPA pages, inspections and holds, audits, supplier quality, complaints, risks, equipment, project QA, plans and reports, config admin. Not run in a real browser against Keycloak and the backend. The server remains the authority for every rule the UI pre-checks.

## F39 — Quality: CAPA

**Implemented**
- `/app/quality/capas`: list with status, kind and overdue filters; "New CAPA" dialog (kind, title, trigger, source record unless Other, problem, owner, effectiveness reviewer, due date). The owner and reviewer must differ.
- `/app/quality/capas/:id`: plan editor, root cause analysis (method from configuration), submit (pre-checks analysis, plan and at least one corrective or preventive action), resubmit after changes requested, start implementation, mark implemented (pre-checks that all actions are complete and evidence is attached), verify effectiveness (effective closes; not effective returns it to analysis), cancel. Shows past effectiveness reviews, actions, evidence and history.
- The NCR page's "Open the linked CAPA" link now resolves.
- New API: `listCapas`, `getCapa`, `createCapa`, `updateCapa`, `addCapaRootCause`, `capaAction`.

**Tested**: 10 new tests (validators, permission gating, owner and reviewer rule, submit and implement gates, resubmit detection, server refusal on effectiveness). Full suite 410 passed, `tsc -b` clean, build OK, `npm audit` 0 vulnerabilities. No backend changes.

**Not done**: the reviewer-only check is enforced by the server, not hidden in the UI (the UI does not know the signed-in user id). Inspections, holds, audits, supplier quality, complaints, risks, equipment, project QA, plans, reports and config admin remain. Not run in a real browser against Keycloak and the backend.

## F40 — Quality: inspection plans, inspections, holds

**Implemented**
- `/app/quality/inspection-plans` and `/:id`: list by stage; create (stage, subject, sampling all/percent/fixed with validation, ITP flag); parameter table with measured, pass/fail and text parameters, limits, mandatory and critical flags; add and retire parameters. A note explains that changes after use raise the revision.
- `/app/quality/inspections` and `/:id`: list by status, result and stage; schedule; start; record a result per parameter (measured value, pass/fail, text) with a required reason to correct an existing result (superseded results listed); record defects (types from configuration); complete (pre-checks mandatory results, quantities, conditional-acceptance note; the server decides the result and, on failure, places the hold and raises the NCR); cancel; schedule a re-inspection of a failed or conditional one. Links to the holds and NCRs a failure created.
- `/app/quality/holds` and `/:id`: list by status; place a hold (product, optional lot and quantity, reason); decide disposition, release (needs an accepting disposition), reject (needs reject or scrap). Without `quality.hold.release` the page says only releasers can decide.
- New API hooks for plans, parameters, inspections, results, defects and holds.

**Tested**: 18 new tests (validators; plan, parameter, schedule, result, correction, completion gates; hold placement; disposition and release gates; separation-of-duties refusal; permission gating). Full suite 428 passed, `tsc -b` clean, build OK, `npm audit` 0 vulnerabilities. No backend changes.

**Not done**: equipment selection when starting an inspection (needs the equipment pages), inspection evidence is shown and uploadable but not tested beyond the shared panel, the place-hold UI does not know the signed-in user so separation of duties is shown from the server's refusal. Audits, supplier quality, complaints, risks, equipment, project QA, plans and standards, reports and config admin remain. Not run in a real browser against Keycloak and the backend.

## F41 — Quality: audits, findings, checklist templates

**Implemented**
- `/app/quality/audits` and `/:id`: list by status and type; schedule (type, title, scope, dates, lead auditor, team, area audited, checklist template; end before start rejected); start; answer each checklist question (a note is required for non-conforming and observation answers); add questions; raise findings (type, severity, requirement, linked question, owner, due date); report (pre-checks unanswered questions, summary, and non-conforming answers with no finding); close (pre-checks open findings); cancel (planned only).
- `/app/quality/findings` and `/:id`: list by status, severity and overdue; assign owner and due date; raise a CAPA (owner and reviewer must differ); verify and close (a non-conformity needs a corrective action or CAPA first, and every action verified; the server also checks the linked CAPA is closed); actions panel.
- `/app/quality/checklist-templates`: list and create (one question per line, optional `STANDARD:clause | question`).
- Backend: finding payload now includes `checklist_item_id` so the UI can tell which non-conformances already have a finding; assertion added to `test_audit_findings_stay_open_until_actioned_and_audit_closes_last` (passes).

**Tested**: 16 new frontend tests. Full suite 444 passed, `tsc -b` clean, build OK, `npm audit` 0 vulnerabilities.

**Known flake** (resolved in F44): `shared/auth/AuthProvider.test.tsx` failed in loaded full runs with "Authentication is not initialised". See F44 for the cause and fix.

**Not done**: supplier quality, complaints, risks, equipment and calibration, project QA, plans and standards, reports, config admin. The auditor-cannot-audit-own-area rule (`auditee_user_ids`) is enforced by the server only; the UI has no field for it. Not run in a real browser against Keycloak and the backend.

## F42 — Quality: supplier quality and corrective action requests (SCARs)

**Implemented**
- `/app/quality/suppliers`: supplier list linking to each supplier's quality page.
- `/app/quality/suppliers/:id`: status badge with criteria (minimum score, maximum rejection rate), change status (reason required; approving is refused client-side while requests are open, and the server enforces it), certificates (add, expired flag, expiry before issue rejected), evaluation history and "Evaluate performance" for a date range with an option to move an approved supplier to conditional when below criteria, the supplier's corrective action requests. The score formula is shown on the page.
- `/app/quality/scars` and `/:id`: list by status with overdue flag; raise a request (supplier, description, due date, follow-up person, optional related NCR); record the supplier's response; accept or reject it with a note; close an accepted one.
- New API hooks for profile, status, certificates, evaluations and SCARs. No backend changes.

**Tested**: 13 new tests (validators; list; expired certificate and evaluation display; viewer gating; approve-blocked-by-open-requests; status change payload; certificate date rule; evaluation payload; raising a request; response, review and close flows; server refusal). Full suite 457 passed, `tsc -b` clean, build OK, `npm audit` 0 vulnerabilities.

**Not done**: the supplier list shows only the procurement status, not each supplier's quality status (that would need one profile call per row, or a backend list field); certificate document attachment (the backend takes a document id, the UI has no picker); a status history on the supplier page (the backend does not return it). Complaints, risks, equipment and calibration, project QA, plans and standards, reports and config admin remain. Not run in a real browser against Keycloak and the backend.

## F43 — Quality: customer complaints

**Implemented**
- `/app/quality/complaints`: list by status and severity with a recurring flag; register a complaint (customer name, type, severity, investigator, optional product, lot and channel, description).
- `/app/quality/complaints/:id`: record findings, raise a non-conformance (category), raise a CAPA (owner and reviewer must differ), respond to the customer (response and resolution), close (customer confirmation date or a note; a severity that requires a CAPA is blocked until one is linked, with a notice on the page). Actions, evidence, costs and history panels; link to the linked CAPA.
- New API hooks for complaints. No backend changes.

**Tested**: 10 new tests (validators, list and recurring flag, registering, findings, responding gate by status, respond payload, critical-severity close block, close confirmation rule, CAPA owner and reviewer rule, viewer gating). Full suite 467 passed, `tsc -b` clean, build OK, `npm audit` 0 vulnerabilities.

**Not done**: the customer is a free-text name (the backend also accepts a customer id, but the UI has no customer picker); sales order and delivery links are not offered; a complaint cannot be linked to an existing CAPA from the UI, only a new one raised. Risks, improvement, equipment and calibration, project QA, plans and standards, reports and config admin remain. Not run in a real browser against Keycloak and the backend.

## F44 — Quality: risks and continuous improvement; auth test flake fixed

**Implemented**
- `/app/quality/risks`: 5×5 risk matrix of open risks (cells coloured by level and labelled with the count for screen readers), list filtered by status and level (plain array from the backend, not paginated), register a risk (likelihood and impact must be whole numbers 1–5; the score and level are shown as you type).
- `/app/quality/risks/:id`: reassess, record residual risk, start mitigation (needs an open or done mitigation action), accept (a high risk, score 15 or more, cannot be accepted; a reason is required), close (every action verified and a residual recorded). Actions and history panels.
- `/app/quality/improvement`: suggestions (anyone with report rights can make one; managers accept or decline with a reason) and initiatives (start one, optionally from an accepted suggestion, with measure, baseline and target).
- `/app/quality/initiatives/:id`: approve (the server refuses the creator), start work with progress, complete (numeric result and lessons learned, every action verified), cancel with a reason.
- New API hooks for risks, suggestions and initiatives. No backend changes.

**Auth test flake: cause and fix.** `AuthProvider` registers its session-lost handler in a `useEffect` after the render commits. Two tests ("renders children when a session exists" and "completes the callback once…") finished as soon as the status showed "authenticated", so on a busy machine that effect could run after `afterEach` had restored the real `onSessionLost`, which throws "Authentication is not initialised". I reproduced it by running the file under CPU load (it failed about one run in four), and the diagnosis fits which tests failed. Both tests now wait for the handler to be registered. 8 of 8 loaded runs pass afterwards. This is a test-only change; the application code is unchanged. It is evidence, not proof, since the failure is timing dependent.

**Tested**: 14 new tests (validators incl. the risk status rules and initiative completion rules; matrix and list; register with live score; high-risk acceptance refused; residual flag; close gating; suggestion submit and decide; initiative creation from a suggestion; separation-of-duties refusal; numeric result). Full suite 481 passed, `tsc -b` clean, build OK, `npm audit` 0 vulnerabilities.

**Not done**: risk area is free text (the backend does not define a list); risk links to products, suppliers and projects are not offered; objectives (planning) and initiative-to-objective links, equipment and calibration, project QA, plans and standards, reports and config admin remain. Not run in a real browser against Keycloak and the backend.

## F45 — Quality: equipment and calibration

**Implemented**
- `/app/quality/equipment` (register, status and overdue filters, paginated) and `/app/quality/equipment/:id`.
- Detail page: calibration history; schedule a calibration (hidden while one is pending); record the result as multipart with an optional certificate file; impact assessment per affected inspection (affected yes/no, note required); return to service; retire with a reason.
- Mirrored server rules (the server stays the authority): tag, positive interval and no future dates on registration; on recording, who/certificate/date are required, and FAIL needs the as-found condition; return to service is blocked until a passing in-tolerance calibration exists and no impact on the last failed calibration is pending.
- Actions need `quality.calibration.manage`; viewing needs `quality.view`. Retired equipment offers no actions.
- API: 8 endpoints and types (`QEquipment`, `QEquipmentDetail`, `QCalibration`).

**Tested (executed):** `tsc -b` clean; 492 frontend tests pass across 52 files (11 new in `equipment.test.tsx`); build OK; `npm audit` 0 vulnerabilities.
Note: the test transport drops a multipart file's name, so the test asserts the file part's size; the page passes the name explicitly.

**Not done:** not run in a real browser against Keycloak and the backend; no equipment picker when starting an inspection yet (`start` accepts `equipment_ids`); the asset link is not shown; certificate files are visible only through the evidence record, not listed on this page; the bundle is still about 550 kB.

## F46 — Quality: project QA (inspection requests and punch items)

**Implemented**
- `/app/quality/inspection-requests` (filters by project, status and hold points only; request dialog with kind, date, location, contractor, activity and hold-point flag), `/app/quality/inspection-requests/:id` and `/app/quality/punch-list`.
- Request detail: schedule (inspector, and an ITP when the request names none), approve or reject the work with a decision note, cancel with a reason, punch items for that request, evidence upload and history.
- Punch items: raise (against the request's project from a request, or any project from the list), mark fixed with a note, verify (accept, or reopen with a note).
- Mirrored rules (the server stays the authority): a hold point needs an activity; a punch item needs a description and severity; approval is blocked while a MAJOR punch item is not closed. Server refusals (inspection not passed, separation of duties on hold points and on verifying one's own fix) are shown from the error envelope.
- Writes need `quality.project.manage`; viewing needs `quality.view`.
- API: 10 endpoints and types (`QRequest`, `QRequestDetail`, `QPunch`).

**Tested (executed):** `tsc -b` clean; 506 frontend tests pass across 53 files (14 new in `projectqa.test.tsx`); build OK; `npm audit` 0 vulnerabilities.

**Not done:** not run in a real browser against Keycloak and the backend; the project and task pickers read only the first page of projects; the drawing document is not selectable; the inspection result is not shown on the request page, so approving a failed inspection is refused by the server only; the signed-in user id is unavailable, so separation-of-duties is enforced server-side only; bundle about 550 kB.

## F47 — Quality: plans, objectives, standards and compliance

**Implemented**
- Quality plans (`/app/quality/plans`, `/:id`): list with status and scope filters, create; detail with objectives (target, direction, latest measurement, met or not met), control points, earlier revisions and history. Draft plans take objectives and control points; submit for approval, resubmit when the last approval event is "changes requested", start a revision of an approved plan with a reason; measurements are recorded only on approved plans.
- Standards (`/app/quality/standards`, `/:id`): list and add; detail with requirements (clause, owner, status, next review, re-assess flag), add requirement, assess (a gap is needed for partial or non-compliant, an explanation for not applicable), record a new version (flags requirements for re-assessment) and version history.
- Compliance summary (`/app/quality/compliance`): percent compliant, counts by status, open gaps, due-for-review count, filter by standard.
- Mirrored rules (the server stays the authority): plan needs an objective or control point before submit; numeric target and measurement; date order; duplicate clause; same-version refusal. Writes need `quality.plan.manage` or `quality.standards.manage`; viewing needs `quality.view`.
- API: 14 endpoints and types.

**Tested (executed):** `tsc -b` clean; 523 frontend tests pass across 54 files (17 new in `standards.test.tsx`); build OK; `npm audit` 0 vulnerabilities.

**Not done:** not run in a real browser against Keycloak and the backend; mapping documents to requirements and attaching an evidence document to an assessment need a document picker (documents module not built in the frontend yet); a draft plan's header fields cannot be edited after creation; plan department and control-point inspection-plan links are not selectable; the objective-to-initiative link (improvement) is still absent; bundle about 550 kB.

## F48 — Quality: reports and CSV export

**Implemented**
- `/app/quality/reports` (nav and server permission `quality.analytics.view`): choose any registered report (the list comes from the server, so new reports appear without a frontend change), optional from/to dates, results table whose columns come from the report's own keys (booleans as Yes/No, empty as a dash), first 500 rows shown with a note to export for the rest.
- Export CSV: `shared/lib/csvDownload.ts` fetches the export with the bearer token and the same date range, saves it as `quality-<code>.csv`, and shows the server's message if refused. The server neutralises spreadsheet formulas in the CSV.
- A date range with the end before the start is refused before any request is sent (found by a test: the page first also showed a generic error, now fixed).
- API: report list and run endpoints and types.

**Tested (executed):** `tsc -b` clean; 532 frontend tests pass across 56 files (9 new: `reports.test.tsx` 6, `csvDownload.test.ts` 3); build OK; `npm audit` 0 vulnerabilities.

**Not done:** not run in a real browser against Keycloak and the backend (the real file save is covered only with stubbed browser APIs); only the date range is offered as a filter (the server also supports severity, status, category and similar on some reports); no charts; the route itself is not permission-guarded (the server refuses without the permission and the page shows that); bundle about 550 kB.

## F49 — Quality: lists administration (closes the quality module screens)

**Implemented**
- `/app/quality/settings` (nav and server permission `quality.admin`): pick one of nine lists (severity levels, non-conformance categories, defect types, root-cause methods, audit types, finding types, complaint types, risk categories, improvement categories), see entries by rank with retired ones marked, add, edit (code locked) and retire or restore. Severity entries also carry a rank and whether a closed record needs a CAPA; other lists show only code and name.
- Retiring keeps the entry for records that already use it (the server only offers active entries on new forms).
- Mirrored rules (the server stays the authority): code letters, digits and underscores up to 30 and unique within the list; name up to 120; rank a whole number 1 to 32767. Server refusals show on the page.
- API: one save endpoint (the list endpoint already existed).

**Tested (executed):** `tsc -b` clean; 538 frontend tests pass across 57 files (6 new in `settings.test.tsx`); build OK; `npm audit` 0 vulnerabilities.

**Not done:** not run in a real browser against Keycloak and the backend; the server upserts by code, so the UI cannot rename a code (a new code is a new entry); no reordering control beyond editing the rank; the existing forms still read these lists through their own queries, with no live refresh across open tabs; bundle about 550 kB.

**Quality module screen coverage:** dashboard, NCRs, CAPA, my actions, inspection plans, inspections, holds, audits, findings, checklist templates, supplier quality, SCARs, complaints, risks, improvement, equipment, project QA, plans, standards, compliance, reports and lists. Remaining gaps are listed per slice above (document pickers, equipment picker when starting an inspection, real-browser run).

## F50 — First real-browser pass (real Keycloak, real backend, real Chromium)

Run on 2026-11-15 without Docker: Keycloak 26 from the release tarball, the Django backend with a tenant provisioned through the real Keycloak admin client, the Vite dev server, and headless Chromium. Repeatable with `docs/operations/e2e-local.md` and `infrastructure/e2e/`.

**What worked first time:** the authorization-code flow with PKCE (redirect to Keycloak, login, callback, token in memory), tenant routing by host, `/api/v1/public/config`, the Vite proxy, tenant provisioning (schema, migrations, seed data, redirect-URI registration, admin account creation and linking), adding a quality list entry, running a quality report, and a real CSV download.

**Real defects found (all fixed):**
1. **App crashed right after sign-in.** The tenant `/me` returns `permissions` as an object keyed by code (`{tenant_wide, scopes}`); the frontend, its types and every mocked test assumed a string array. Fixed in `AccessProvider` (reads both the tenant object and the platform list; a scoped-only permission still shows the page, a code with no reach does not). The test helper now builds the real shape, so the whole suite exercises what the backend sends.
2. **Provisioning could never work against a real Keycloak.** `erp-realm.json` gave the `erp-identity-admin` service account no realm-management roles, so every admin call returned 403. Added the service-account user with only manage/view users and clients (verified by importing into a throwaway realm).
3. **A Keycloak mail failure blocked tenant activation** (the set-up email was inside a required step, and a retried job could not resend it). Moved to its own non-required step (`send_setup_email`): the tenant activates, the job finishes with warnings, and a new platform action `POST /api/v1/platform/tenants/<id>/resend-admin-setup` (permission `platform.tenants.provision`, audited) repeats it. Jobs created before the step existed gain it on resume.

**Smoke walk:** all 95 static tenant routes were loaded against the live backend. No page errors and no failed API calls, except the expected "no employee record" 404s on HR self-service pages (the tenant admin is not an employee): `hr/me`, `hr/me/payslips` on attendance, leave, timesheets and payslips.

**Tested (executed):** frontend `tsc -b` clean; 540 frontend tests pass across 57 files (2 new permission-shape tests); build OK; `npm audit` 0 vulnerabilities. Backend: `tests/test_provisioning.py` and `tests/test_platform_admin.py`, 38 tests pass (4 new: mail failure does not block activation, resend, resend refused for a non-active tenant, resend via the API with audit, and a job gaining the new step).

**Still not done / found but not fixed:**
- "Responsible"/owner dropdowns on quality dialogs are built from HR employees that have a linked user, so in a new tenant nobody is offered (the admin is a user, not an employee). The proper fix is a search-as-you-type user picker on the existing directory endpoint (`/api/v1/directory/users`, two characters minimum); this touches many dialogs and is the next frontend task.
- No button in the platform admin UI for "resend administrator set-up email" yet (the API exists).
- Only the happy paths and page loads were exercised in the browser, not every dialog; the platform-admin console (which needs MFA claims) and sign-out were not driven; one long Chromium session crashed, so the walk runs in batches.
- Keycloak's own mail was not configured, so the set-up email itself was not received; password was set through the admin API for the test.

## F51 — Find any colleague as an owner/assignee (user picker)

**Problem:** in a new tenant nobody is an HR employee yet, so every owner/inspector/assignee dropdown in the quality screens was empty.

**Implemented**
- Backend: `GET /api/v1/directory/users?ids=a,b,…` resolves display names for up to 50 ids (400 `invalid_id` / `too_many_ids`); works for any membership of the current tenant, including deactivated colleagues, so old records keep readable names.
- Frontend: `shared/ui/UserSelect` (employee options + "Find someone else" search, picked person is added and selected); `ActionDialog` field flag `searchUsers`; 15 quality screens switched to it; `useUserNames` falls back from employees → cache → one batched directory lookup (after employees have loaded, to avoid duplicate lookups).

**Tested (executed):** backend `test_directory_resolves_names_for_known_ids_including_deactivated_colleagues` passed; frontend `tsc -b` clean, full vitest 58 files / 546 tests passed, `npm run build` ok, `npm audit` 0 vulnerabilities. New tests: UserSelect (search→pick, min-2-chars, inside dialog), names lookup (batch, fallback), equipment registration with a non-employee owner.

**Not done / not driven in a real browser:** this slice was not re-run against live Keycloak/backend; bundle still ~550 kB.

## F52 — Organization structure and company profile

**Gap closed:** Organization had one read-only Departments list. Backend already offered full CRUD for the rest.

**Implemented**
- `/app/organization/structure`: tabbed screen for departments, teams, positions, business units, cost centers, branches, legal entities; create and edit (optimistic-locking `version` sent on every edit, conflicts shown), deactivate/reactivate (records are never deleted). Parent/department/unit/branch pickers load the full active list (follows cursors, max 10 pages). Heads/leads/managers use the user picker. A department can't be chosen as its own parent.
- `/app/organization/company`: company profile (legal/trade name, registration, tax ID, country, address, contact, fiscal-year start month, working days; empty working days shown as Mon–Fri as the backend applies). Read-only without `org.settings.manage`.
- `/app/organization/departments` redirects to the new screen. Create/edit buttons only with `org.structure.manage` (UX only; backend enforces).

**Tested (executed):** `tsc -b` clean; full vitest 59 files / 552 tests passed (6 new: list + tab switch + view-only, create team with required-field checks and department select, edit with version/deactivate/parent exclusion, version conflict, company save with version and working days, company read-only); build ok; audit 0 vulnerabilities.

**Not done:** legal-entity currency field (needs the currency list — next slice with currencies); base currency on company profile; fiscal years/periods, exchange rates, holidays, numbering sequences, member assignment screens (slice 53); not driven in a real browser.

## F53 — Reference data, numbering and member assignments (completes Organization)

**Implemented**
- `/app/organization/reference` (permission `org.reference.view`): tabs for currencies (turn on/off, "only in use" filter, server refusals shown), exchange rates (filter by currency, add rate; rate validated positive with ≤8 decimals before the call), fiscal calendar (years with periods, add year, close period with `org.fiscal.close`, reopen with a required reason), holidays (company-wide or per branch).
- `/app/organization/numbering` (`org.sequences.manage`): list, create (code validated), edit name/template/restart policy/next number/active, with the server's preview of the next number.
- `/app/organization/members` (`org.structure.view`; assign needs `org.profiles.manage`): active members with department and position; assign department, team, position, business unit, cost center and manager (a member cannot report to themselves).
- Added the currency field to legal entities and base currency to the company profile (gaps from F52).
- Buttons shown only with the relevant permission (UX only; backend enforces).

**Tested (executed):** `tsc -b` clean; full vitest 60 files / 562 tests passed (10 new in `reference.test.tsx`, company test extended); build ok; audit 0 vulnerabilities.

**Not done:** tenant settings screen (`/api/v1/settings`, generic key/value), exchange-rate import, fiscal year editing/deleting (backend has none); tabs not driven in a real browser; currency list pages through 50 at a time.

## F54 — CRM accounts and contacts (first of the CRM gap slices)

**Gap:** CRM backend has ~70 endpoints; the UI had only leads and opportunities. Plan: 54 accounts+contacts, 55 activities/opportunity detail/forecast, 56 campaigns, 57 service cases, 58 teams/territories/insights.

**Backend change (tested):** `GET /api/v1/crm/contacts` now accepts `?account=<uuid>` (400 `invalid_id` on junk) and `?q=` (name/email). Test `test_contacts_can_be_filtered_by_account_and_search_and_stay_private_to_the_owner` passed (run alone).

**Implemented**
- `/app/crm/accounts`: searchable list, create (owner field only for `crm.assign`).
- `/app/crm/accounts/:id`: profile (edit), credit terms (`crm.assign`; reason required unless OK; limit validated), contacts of the account (add/edit/consent), addresses (add/remove), timeline (activities, opportunities, quotations, orders, deliveries, invoices, cases, changes).
- `/app/crm/contacts`: search, create, edit, record email consent, opt out and resume. Opt-out is shown clearly; actions only with `crm.manage`.
- `ActionDialog` gained an `initial` prop for edit forms.

**Tested (executed):** `tsc -b` clean; full vitest 61 files / 572 tests passed (14 new in `crm/accounts.test.tsx`); build ok; audit 0 vulnerabilities. A test race (list reload swallowing a click) was a test timing issue, fixed by waiting for the reload.

**Not done:** phone/SMS consent toggles (email only in UI; API supports all), contact links to other accounts, contact dates/reminders, account hierarchy (parent) editing, territory assignment, lead duplicates/merge/import (backend exists), real-browser run; full backend suite not re-run this slice (only the changed test).

## F55 — CRM activities, opportunity detail and sales reports

**Implemented**
- `/app/crm/activities`: tabs Upcoming (next 7/14/30 days; "Whole team" only with `crm.view_all`), Follow-ups due, Overdue; schedule an activity (type, subject, due time sent as an absolute UTC time, priority, account, notes); complete with outcome. Actions only with `crm.manage`.
- `/app/crm/opportunities/:id`: details (edit amount, close date, next action, competitors, requirements, decision makers, risks), products considered (edit list: distinct products, quantity > 0, price ≥ 0), stage history with who/when/note. Read-only once won or lost. Opportunity names in the list link here; list gained "New opportunity".
- `/app/crm/reports`: pipeline by expected-close month, breakdown by rep/stage/product/month (weighted = amount × stage probability), lead→opportunity and win rates ("–" when there is no data).

**Tested (executed):** `tsc -b` clean; full vitest 62 files / 583 tests passed (11 new in `crm/pipeline.test.tsx`); build ok; audit 0 vulnerabilities. No backend change this slice.

**Not done:** lead edit/duplicate/merge/import screens; owner/assignee reassignment UI (`/crm/<kind>/<id>/assign`); stage configuration (`crm.assign`); activity linking to leads; calendar grid view; real-browser run.

## F56 — CRM campaigns

**Implemented**
- `/app/crm/campaigns` (`crm.campaign.manage`): list with spend, leads generated and ROI (from the overview endpoint); create with channel, active currency, dates (end ≥ start), budget and audience rules (leads or customer contacts; field/value rules validated, no half-filled or repeated rules).
- `/app/crm/campaigns/:id`: results (budget, spent, remaining, cost per lead, funnel, response rate, leads, opportunities, pipeline, won revenue, ROI), audience list with status filter and exclusion reasons (no consent / opted out / no address / consent withdrawn), build audience, activate, mark all as sent, complete, cancel, record expense, capture lead (with marketing consent flag), record a response, change budget (`crm.assign` only). Actions offered only while the campaign is draft/active; server refusals (e.g. empty audience) shown verbatim.

**Tested (executed):** `tsc -b` clean; full vitest 63 files / 594 tests passed (11 new in `crm/campaigns.test.tsx`); build ok; audit 0 vulnerabilities. Two older tests were timing-sensitive under load: the currency toggle test (list reload swallowed a click; fixed by waiting for the reload) and `finance/credit.test.tsx` (4 s timeout only when the machine is busy; passes alone and on rerun, not changed).

**Not done:** sending real messages (the system records "sent"; no email/SMS delivery exists), member names beyond the first page of leads/contacts fall back to a short id, per-member removal, campaign editing after creation (no backend endpoint), real-browser run.

## F57 — CRM service cases

**Implemented**
- `/app/crm/cases`: list with filters (status, priority, overdue only), service-level badge (on track / first response late / resolution target missed / met) and escalation level; open a case (customer, subject, description, type, category, priority, severity).
- `/app/crm/cases/:id`: case facts and deadlines; actions by state (start, waiting for customer, customer replied, resolve with required resolution, reopen, close, cancel with reason, record customer feedback 1–5 once, assign with user picker — `crm.assign`); conversation with internal notes visibly marked; attachments (uploaded as base64, as the API requires). Closed/cancelled cases take no comments or files. Server refusals shown verbatim.
- `/app/crm/service-report`: summary (cases, open, complaints, escalated, average resolution hours, resolved on time %, customer rating), by category / month / handler, date range (reversed range not sent), service-level table and editing (`crm.assign`; whole hours, resolution ≥ first response).
- `ActionDialog` now renders `type: "textarea"` fields.

**Tested (executed):** `tsc -b` clean; full vitest 64 files / 608 tests passed (14 new in `crm/service.test.tsx`); build ok; audit 0 vulnerabilities. No backend change this slice.

**Not done:** linking a case to an order/delivery/invoice/product from the UI (API supports it), contact on a case, attachment download (no endpoint to fetch content was found), customer-facing view of comments (`?customer=1`), real-browser run.

## F58 — CRM teams, territories, portfolios and customer insights

**Implemented**
- `/app/crm/teams` (tabs Teams / Territories / Portfolios): team hierarchy with managers and members (add with lead flag, remove, move, edit parent/manager/disband); territories (countries as 2-letter codes validated before sending, industries, segments, priority, active) ; portfolios per owner (accounts, open deals, open value) and "Transfer a portfolio" (two different people and a reason). Management needs `crm.assign`; others see read-only lists.
- `/app/crm/insights` (tabs Overview / Customer tiers / Retention / Satisfaction / Profitability): lead sources and conversion, open pipeline, deals with no recent activity, activity by rep, overdue activities; A/B/C/N tiers with revenue by segment and industry; at-risk / churned / active customers and "Update customer lifecycle stages" (`crm.assign`); ratings distribution and lowest-rated customers; margin per customer (server refusal outside base currency shown).
- "Change owner" on account detail and (open) opportunity detail, "Assign by territory" on account detail — `crm.assign` only; server refusals shown verbatim.
- Nav: Customer insights, Sales teams.

**Tested (executed):** `tsc -b` clean; full vitest 65 files / 622 tests passed (14 new: `crm/teams.test.tsx` 10, owner tests in `accounts.test.tsx` 3 and `pipeline.test.tsx` 1); build ok; audit 0 vulnerabilities. No backend change.

**Not done:** owner change on leads (no lead detail screen yet), ownership history view (API exists), team-based visibility indicator, charts (tables only), real-browser run.

## F59 — Sales pricing

**Implemented**
- `/app/sales/pricing` (nav "Pricing", `sales.view`; changes need `sales.pricelist.manage`): four tabs.
  - **Price lists:** list with type, currency, validity, price count, status; create (standard / promotion / customer-specific / contract, customer picker, validity dates; end-before-start rejected before sending; backend rules such as "contract needs dates" shown verbatim); activate/deactivate; per-list prices dialog (quantity breaks, unit price validated as a non-negative decimal, save, remove) with the list's price-change history.
  - **Products:** searchable catalog with sale status, lowest price, largest discount, stock; "include products that cannot be sold"; per-product selling limits (can be sold, discontinued, lowest price, lowest margin %, largest discount %; blank clears; percentages ≤ 100).
  - **Discount limits:** per category / customer classification ceilings (create, edit, switch off).
  - **Price check:** which price a customer gets today for a product, currency, quantity and optional customer; "no price set" case.
- Prices are sent as decimal strings, never floats.

**Tested (executed):** `tsc -b` clean; full vitest 66 files / 630 tests passed (8 new in `sales/pricing.test.tsx`); build ok; audit 0 vulnerabilities. No backend change.

**Not done:** product bundles editor (API exists), price-list pagination beyond first/next, tax rate on product profile, returns / deliveries / analytics screens (next Sales slices), real-browser run.

## F60 — Sales deliveries

**Backend change (small, tested):** `GET /api/v1/sales/deliveries?status=&order=` (paginated; logistics staff with `sales.delivery.manage` see all, others only deliveries of customers they may see; unknown status → 400) and the delivery payload now includes its `lines` (needed to record problems on arrival). Tests: `test_sales_dispatch.py` (listing scope/filter, lines) and `test_crm_sales_api.py` (permission matrix, pagination, status validation) — 10 passed.

**Implemented (frontend)**
- `/app/sales/deliveries` (nav "Deliveries"): performance card (deliveries, on-time %, average days in transit, late right now, problems on arrival, per carrier; reversed date range not sent), list with status filter, order numbers, Late and "Problem reported" flags, paging.
- `/app/sales/deliveries/:id`: facts, goods, problems with link to the service case the server opened, proof-of-delivery documents (upload for `sales.delivery.manage`); for in-transit deliveries: confirm delivery (who received it, note, optional proof file, any number of reported problems — item, kind short/damaged/wrong, quantity within what was delivered, no duplicates), mark as failed (reason), set expected date (not before dispatch).
- Sales order detail: "Dispatch goods" for confirmed / part-delivered orders (`sales.delivery.manage`): pick location from warehouses, dates, carrier, tracking, quantities defaulting to what is left (cannot exceed it); links to the new delivery.

**Tested (executed):** backend 10 passed; `tsc -b` clean; full vitest 67 files / 642 tests passed (12 new in `sales/deliveries.test.tsx`); build ok; audit 0 vulnerabilities.

**Not done:** deliveries listed on the order screen itself, lot codes on dispatch, downloading proof documents (no download endpoint), returns and sales analytics screens (next), real-browser run.

## F61 — Sales returns

**Implemented (frontend only; no backend change)**
- `/app/sales/returns` (nav "Returns"): "Returns at a glance" (requests, by status, by reason, goods received back by disposition; reversed date range not sent), request list with status filter and paging.
- Request a return (`sales.order.create`): pick a delivered order, quantity per item (limited to delivered minus already returned), what happens to each item (back in stock / hold for inspection / scrap), reason, description, free-replacement option. Server rules (return window, over-return, nothing delivered) shown verbatim.
- Request detail: facts, items, decision; Approve / Reject (`sales.order.approve`; rejection needs a reason; the server's refusal to approve your own request is shown), Receive goods (`sales.delivery.manage`; location, a quarantine location only when an item is held for inspection, date), Cancel request (`sales.order.create`, pending or approved).

**Tested (executed):** `tsc -b` clean; full vitest 68 files / 651 tests passed (9 new in `sales/returns.test.tsx`); build ok; audit 0 vulnerabilities.

**Not done:** link from a received return to its credit note / the replacement order detail (links to the orders list), returns shown on the order screen, sales analytics / commissions / targets / contracts / backorders screens, real-browser run.

## F62 — Sales analytics

**Implemented (frontend only)**
- `/app/sales/analytics` (nav "Sales analytics", `sales.view`; the server limits figures to the customers the viewer may see): performance for a date range (default last 90 days; a missing or reversed range is not sent) — orders, revenue, average order and discount, deals won %, days to close, quotes that became orders, top-5 share with a plain-words concentration reading, revenue by month bars, top customers; order backlog (still to deliver / invoice, oldest open orders); forecast (cautious / most likely / optimistic on top of the backlog, run rate, pipeline by month, 1–12 months ahead).
- Amounts are the server's decimal strings, formatted for display only.

**Tested (executed):** `tsc -b` clean; full vitest 69 files / 656 tests passed (5 new in `sales/analytics.test.tsx`); build ok. **`npm audit` now reports 5 high findings, all one advisory (picomatch ReDoS, GHSA-fc5q-39xc-vjpf) reached through vite/vitest/tinyglobby/fdir.** It is new since F61 (which audited clean). The installed picomatch 4.0.7 is the newest published release, so no patched version exists yet; the only "fix" npm offers is a downgrade to vitest 3.1.4, which I did not apply. These packages run only at build/test time and are not in the shipped bundle. Re-check `npm audit` next slice and upgrade once a patched picomatch is released. No backend change.

**Not done:** targets, team attainment, commission plans/statements (next slice), receivables aging, contracts and backorders screens; chart library (CSS bars only); export; real-browser run.

## F63 — Documents library (module 13, first frontend)

**Implemented (frontend only)**
- `/app/documents` (nav "Documents", `documents.view`): searchable library (title/number/tag, optional search inside files), filters for status, category, folder, expired; flags for expired / review overdue / legal hold; paging. "New document" (`documents.create`): title, category, visibility classification, folder, dates, description, file (size and empty-file checks; categories that require an expiry date enforce it before sending; multipart upload).
- `/app/documents/:id`: details, versions table with status and rejection note, authenticated download, actions driven by the server's `can` flags (send for approval, send again, withdraw, publish), upload a new file, start a revision (both need a file and a reason), comments (add, reply with optional resolve, resolve), history, related documents, "I have read this" acknowledgement.
- `/app/documents/acknowledgements`: my pending acknowledgements with overdue marking.
- `downloadFromApi()` helper for token-authenticated downloads.

**Tested (executed):** `tsc -b` clean; full vitest 70 files / 666 tests passed (10 new in `documents/documents.test.tsx`); build ok; `npm audit` still shows the picomatch advisory described in F62. No backend change.

**Not done:** see `completion-audit.md` (folders/categories admin, grants, distribution, reviews, disposals, external documents, transmittals, RFIs, saved searches, reports; downloading is untested in the browser).

## F64 — Sales targets and commission

**Implemented (frontend only)**
- `/app/sales/commissions` (nav "Targets and commission", `crm.view`; manager tabs need `crm.assign`): 
  - **My results** — net sales, target, % reached, still to go for a date range (default this month; reversed range not sent).
  - **Team** (managers) — everyone's attainment for the period and "Set a target" (amount must be above zero).
  - **Plans** (managers) — commission plans with tiers and per-category special rates; create from plain text (`0:2` per line for tiers, `Category:5` for special rates; first tier must start at 0, tiers strictly increasing, rates 0–100, duplicates refused before sending); "Give someone a plan".
  - **Statements** — list with status; managers work out a statement for a person and period; detail shows how the commission was calculated (per category and tiered part); Approve, Cancel (drafts), Send to payroll with optional pay month (approved). Salespeople see only approved/sent statements (the server filters) and get no action buttons. The server's separation-of-duties refusal is shown verbatim.

**Tested (executed):** `tsc -b` clean; full vitest 71 files / 674 tests passed (8 new in `sales/commissions.test.tsx`); build ok. `npm audit` still shows the picomatch advisory from F62 (5 high, build/test tooling, no patched release). No backend change.

**Not done:** editing/deactivating an existing plan (API supports create and assign only), a salesperson's own plan display, contracts, backorders, receivables aging (next Sales slice), real-browser run.

## F65 — Sales: backorders, customer contracts, receivables aging

**Implemented** (frontend only; existing endpoints):
- `/app/sales/backorders` — lines waiting for stock; "Retry backorders" (`sales.delivery.manage`) reports how many lines were filled.
- `/app/sales/contracts` — list with status filter, create dialog (customer, dates, optional committed value, auto-renew, agreed prices per product) with client-side checks mirrored by the server.
- `/app/sales/contracts/:id` — use of contract (ordered vs committed, overdue obligations), agreed prices, obligations (add / mark done, `sales.quote.create`), revision history, activate / renew / end early (`sales.order.approve`).
- `/app/sales/aging` — per-customer aging buckets with totals and an "as of" date.

**Tested:** `features/sales/contracts.test.tsx` — 11 tests (validation helper, list, create body, activate, obligations, terminate with reason, backorder retry, aging date param, empty states). Full-suite, build and audit results are recorded in the delivery summary.

**Not done in Sales:** editing a DRAFT contract's fields, amendments/milestones, quotation extras, bundle editor, commission plan edit/deactivate, account statement/credit view.

## F66 — Procurement: overview and analytics

**Implemented** (frontend only; existing endpoints):
- `/app/procurement/overview` — the nine work-queue counts (linked to a screen where one exists: requisitions, purchase orders, match exceptions) and the late-deliveries table.
- `/app/procurement/analytics` — date range; time to order / receive, supplier performance (on-time, rejection, defect, claims), spending grouped by supplier / category / month, and price paid against estimate. A backwards range is refused before any request.

**Tested:** `features/procurement/analytics.test.tsx` — 5 tests. Full-suite, build and audit results are in the delivery summary.

**Still without screens in Procurement:** purchase contracts, blanket orders, receipts and inspections, supplier returns and claims, PO amendments/terms/acknowledgement/close, tenders and plans, budgets, supplier profile/contacts/bank accounts/documents/standing/catalogue, supplier risk, requisition generate/consolidate/stock-check, settings.

## F67 — Procurement: receiving and inspection

**Implemented** (frontend only; existing endpoints): `/app/procurement/receiving` with two tabs.
- Inspections (`procurement.receipt.inspect`): goods held in quarantine; record accept / reject quantities, reason required for rejection, optional serial numbers (not mixed with a split accept/reject, as the server also requires).
- Receipts: goods received with per-line inspection status, lot, over-delivery and rejected quantities; attach evidence file (`inventory.goods.receive`).
- The overview's "waiting for inspection" count now links here.

**Tested:** `features/procurement/receiving.test.tsx` — 5 tests (helper, reject with reason, serials, evidence upload, permission hiding). Full-suite/build/audit results are in the delivery summary.

**Still without screens in Procurement:** supplier returns and claims, purchase contracts, blanket orders, PO amendments/terms/acknowledgement/close, tenders and plans, budgets, supplier profile/contacts/bank/documents/standing/catalogue, supplier risk, requisition extras, settings.

## F68 — Procurement: supplier returns and claims

**Implemented** (frontend only; existing endpoints): `/app/procurement/returns` with two tabs.
- Returns: list with status filter; new return from an order's received lines (quantity capped at what was received); approve (`procurement.return.approve`), send back (optional serial numbers), record the supplier credit note when the goods were invoiced (posted credit notes from that supplier only), close when nothing was invoiced, cancel a draft/approved return.
- Claims: list with status filter; new claim (supplier, kind, amount, description); send, record the supplier's acceptance (amount not above the claim) or rejection (reason required), settle with a credit note. Separation of duties and all state rules stay on the server; its refusals are shown verbatim.
- The overview's claims and credit counts now link here.

**Tested:** `features/procurement/returnsClaims.test.tsx` — 11 tests. Full-suite/build/audit results are in the delivery summary.

**Still without screens in Procurement:** purchase contracts, blanket orders, PO amendments/terms/acknowledgement/close, tenders and plans, budgets, supplier profile/contacts/bank/documents/standing/catalogue, supplier risk, requisition extras, settings.

## F69 — Procurement: supplier contracts

**Implemented** (frontend only; existing endpoints): `/app/procurement/contracts` — list with status filter; create (supplier, dates, currency, optional spending limit, auto-renew with notice days, agreed prices per product); a per-contract view of spending against the limit, days left and prices; approve a draft (`procurement.contract.approve`; the server refuses your own contract and unqualified suppliers, and the message is shown); extend (new end date must be later) and end early with a reason (`procurement.contract.manage`). The overview's "contracts ending" count links here.

**Tested:** `features/procurement/contracts.test.tsx` — 7 tests. Full-suite/build/audit results are in the delivery summary.

**Not done:** blanket orders — the backend has create/release endpoints but no list endpoint, so a screen would need a small backend addition first (blanket POs are not yet filterable in the PO list view). Also still without screens: PO amendments/terms/acknowledgement/close, tenders and plans, budgets, supplier profile/contacts/bank/documents/standing/catalogue, supplier risk, requisition extras, settings.

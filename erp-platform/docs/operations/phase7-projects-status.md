# Phase 7 (part 2) — Projects and Task Management

App: `backend/modules/projects` (tenant app). **No Projects FRS was supplied**; scope follows Module 10 of the master prompt. Send a detailed spec and it will be reconciled.
Full suite: **549 tests pass** (29 are project tests); `makemigrations --check` reports no changes.

## Implemented

| Master-prompt feature | What exists |
|---|---|
| Projects, teams | Numbered projects (PRJ-yyyy-nnnn), manager, customer, billing type (fixed / time-and-material / non-billable), status lifecycle with reasons, optimistic versioning; team with roles (manager/member/observer), cost and bill rates, allocation percent |
| WBS, tasks, milestones | Nested tasks up to 6 levels with automatic WBS codes, milestones, summary tasks that roll dates, hours and progress up from their children |
| Dependencies, Gantt | Finish-to-start and start-to-end links with lag, cycle detection, dependency-respecting date edits, `shift` that cascades to successors, schedule endpoint with float and **critical path** |
| Progress | Assignee or manager updates; status and percentage always agree; predecessors gate starting/finishing; reopening needs a percentage |
| Budgets | Per-category budget with approved revisions (finance approves, never the submitter); expenses cannot exceed the approved category budget |
| Expenses | Members submit, manager approves (never the claimant), amounts above `projects.expense_approval_limit` need a budget approver; out-of-pocket cost posts Dr 5800 / Cr 2250; costs backed by a booked supplier invoice post nothing and cannot over-allocate the invoice; receipts via the file service |
| Timesheets, cost | Approved HR timesheet hours booked to the project code, priced at member cost rate; hours by non-members reported as unmatched |
| Resource allocation | A person cannot be allocated above 100 % across overlapping projects; resource-load report (allocation and planned hours against capacity) |
| Planned vs actual | Cost report by category, planned labour from task hours, earned value (PV, EV, AC, CPI, SPI, EAC, VAC) |
| Risks and issues | Scored risk register with owners, review dates and closure rules; issues with severity, assignment, resolution confirmed by someone other than the resolver; a project cannot complete with open or unconfirmed high/critical issues or pending expenses |
| Revenue, profitability | Milestone, time-and-material (from approved hours, no double billing of a period) and advance invoices drafted in Finance, capped at the contract value; recognized revenue from posted invoices; margin, forecast margin, under-billing |
| Reporting | Health (RAG with reasons), portfolio view, resource load; members never see costs or margin |
| Integration | Assets can be allocated to a real, live project; daily Celery job (`projects.daily_all`) reminds about overdue tasks, past-end projects, risk reviews and overdue issues |

Access is object-level: a non-member gets 404 (existence is not revealed); `projects.view_all` (finance, auditors) is read-only; managing needs the project manager role or `projects.manage`.

## Tested

Service tests and HTTP permission tests in `tests/test_projects_wbs.py`, `test_projects_costs.py`, `test_projects_delivery.py`; the authorization contract test covers every new view class.

## Upgrade notes

1. `migrate_schemas` — migrations `modules/projects/migrations/0001`–`0004` are additive.
2. `finance.seed_defaults()` per tenant for the new accounts 5800 (project costs) and 2250 (employee claims payable).
3. Re-sync permissions and roles: new `projects.*` permissions, new role `project_manager`; `employee`, `finance_controller` and `read_only_auditor` gain project access.
4. Beat entry `projects-daily` is in `CELERY_BEAT_SCHEDULE`; `modules.projects` is in the Celery autodiscover list.
5. Asset allocation to a PROJECT target is now validated against real projects (previously any id was accepted).
6. Setting: `projects.expense_approval_limit` (default 1000).

## Not done / known limits

- HR timesheet entries still carry the project **code** as free text; entries with an unknown code are not rejected at entry time, they simply do not cost any project (matched by approved timesheet, project code and team membership).
- Labour is costed at each member's **current** cost rate; rate history is not kept. Labour cost is a management view and is not posted to the ledger (payroll already is).
- Equipment and asset cost is not charged to projects; allocation reports usage hours only.
- Dependencies are finish-to-start and start-to-start only; scheduling is in calendar days (no working calendars or resource levelling).
- Billing creates a draft customer invoice; submit/approve/post stay in Finance. Credit notes against project invoices are not netted out of project revenue.
- Expenses are single-currency (base). No purchase-order commitments on the project cost view.
- The construction-specific extensions the master prompt mentions are not built; the foundation (WBS, billing, cost, risk) is designed to take them.
- No frontend (deferred by agreement).

# Phase 6 — Human resources and payroll: status

Built against the 18-section HRMS Functional Requirements Specification; see `hrms-gap-analysis.md` for the section-by-section result.

## Implemented
- **Core HR**: employees (numbering, duplicate detection, probation, grades, emergency contacts, qualifications, skills, documents with versions and expiry), contracts (overlap-checked), onboarding/offboarding checklists by assignee role, resignation and separation types, final settlement, automatic IAM access revocation, append-only employee history (database trigger), effective-dated assignment changes with approval, headcount plans and org chart, bulk import (dry run by default, all-or-nothing).
- **Attendance**: work modes, schedules, overtime policy and approved overtime, late/early/absent/missed-punch exceptions, corrections, idempotent device import, reports.
- **Leave**: configurable leave types, monthly accrual (hire month prorated) and upfront grants, carry-over cap with expiry, eligibility, half days, notice and max-consecutive rules, delegated approval, calendar, utilization and absence reports, daily scheduled job.
- **Payroll**: tax brackets, components, proration across contracts and unpaid leave, salary revisions (second approver, contract split, no retroactive change into locked months), bonuses/commissions/arrears/adjustments, overtime pay with policy multipliers, loans and advances with schedules, reimbursements (non-taxable), preparation → approval (direct or workflow) → posting → payment with separation of duties, reversal of a posted run, payroll register, cost allocation by department, payment instructions (CSV safe against formula injection).
- **Talent and relations**: recruitment (requisition approval, candidates, interviews, scorecards, offers, hire), performance (cycles, weighted goals, self/manager review, acknowledgment), learning (courses, expiring certificates, mandatory-course compliance), confidential cases, versioned policies with acknowledgments.
- **Analytics** (`/api/v1/hr/analytics/*`), HR reminders and leave notifications.
- 8 new permissions plus role updates (catalog); ledger accounts 2400/2410/2420/5300; sequences `hr.employee`, `hr.payroll`, `hr.requisition`; events `hr.employee.created/terminated`, `hr.payroll.posted/paid/reversed`.

## Tested (executed)
Full suite: **309 passed**, `makemigrations --check` clean. HR-specific: test_hr 20, lifecycle 13, attendance 11, leave policy 8, payroll extensions 9, talent 10, reminders 2 — covering business rules, separation of duties, object-level visibility, concurrency on payroll, ledger balances and HTTP permissions.

## Not done / known limits
- Employee groups for payroll; cost-centre dimensions on payroll journals (allocation is a report).
- Loan deductions credit account 2410 (deductions payable), not a dedicated loans-receivable account.
- Benefit-plan enrolment and insurance claims; 360° feedback and calibration; training enrolment and budgets; careers portal and CV attachments.
- Employee personal-data change requests.
- Project timesheet costing and asset returns wait for Phases 7+ (hooks exist).
- No frontend (deferred by agreement).

## Corrections to earlier behaviour
- `update_employee` no longer edits department, position, manager or grade; these go through `change_assignment` so history is kept (error `use_assignment_change`).
- Payroll runs are full calendar months only; one live run per period (database constraint).
- Leave balance is now computed from allocation entries (manual, accrual, carry-over) instead of one annual number.

## Upgrade notes
The HR migration was regenerated (not yet released). Existing tenants need `migrate_tenants`, then the HR seed (leave types, schedules) and the finance default accounts 2400/2410/2420/5300.

# Phase 7 (part 1) — Asset Management

Delivered against the Asset Management FRS §2.1–2.18. App: `backend/modules/assets` (tenant app). The Projects half of Phase 7 is not started.
Full suite: **520 tests pass** (56 are asset tests); `makemigrations --check` reports no changes.

## Implemented

| FRS | What exists |
|---|---|
| 2.1–2.2 | Register with unique numbers (`category.prefix-000001`), statuses and guarded transitions, barcode/QR/RFID/serial uniqueness, scan lookup, labels, documents, immutable history; category tree with capitalization threshold, depreciation defaults, tracking, insurance and maintenance policy |
| 2.3 | Acquisition by purchase/donation/construction/transfer/opening (purchase needs a PO, receipt, invoice or contract reference), extra costs, delivery acceptance, commissioning, capitalization request approved by a different person (or an approval workflow), Finance journal |
| 2.4, 2.6 | Assignment with approval and acknowledgement, hand-over form, returns with condition, temporary assignments and reminders, transfers that change location/custodian only on acknowledged receipt |
| 2.9 | Straight-line and reducing-balance, monthly runs in sequence with catch-up, reversal of the latest run, improvements, revaluation, impairment (each approved by someone else), policy change, schedule, valuation report, **register-to-GL reconciliation** |
| 2.7–2.8 | Time- and meter-based maintenance plans, generated preventive work orders (idempotent), repair approval above a threshold, labour/spare parts (real inventory issue expensed to 5700)/external cost, repair verified by someone other than the technician, breakdown reporting by any employee, diagnosis, downtime, MTTR/MTBF, repeat-failure analysis |
| 2.10–2.11 | Inspection templates and scheduled inspections, findings with corrective work orders, photo evidence, condition report; warranties and claims; insurance policies, cover, renewal, claims, uninsured-asset detection, expiry reminders |
| 2.5, 2.12 | Shared allocation to projects/departments/cost centres (never above 100 %), usage hours, idle/underutilized detection; vehicles, drivers (licence must be valid), odometer via the shared meter, fuel efficiency, incidents, registration/licence/insurance alerts, cost per km |
| 2.13–2.14 | Scan-based counts with MISSING / FOUND_ELSEWHERE / CONDITION_CHANGED / UNEXPECTED discrepancies, resolved by someone other than the counter, close blocked while any is open; disposal (sale/scrap/donation/write-off) with approval, gain or loss to 5950, revaluation surplus released to retained earnings, allocations ended, certificate |
| 2.15–2.17 | Replacement candidates (rules are tenant settings), replacement plan and capex budgets with approval and budget-vs-actual, dashboard, daily Celery job (`assets.daily_all`), settings, permissions and roles |
| 2.18 | Unique identifiers, traceable acquisition, approvals everywhere money or custody moves, no assignment/allocation of disposed assets, Finance reconciliation |

## Tested

Service tests and HTTP permission tests per slice (`tests/test_assets*.py`); the authorization contract test covers every new view class.

## Upgrade notes

1. `migrate_schemas` — all migrations are additive (`modules/assets/migrations/0001`–`0009`).
2. Run `finance.seed_defaults()` per tenant for the new accounts 1500, 1510, 1590, 3200, 4300, 5500, 5600, 5700, 5950. **Account code 5700 is now "Maintenance Expense"**: a tenant that already created its own 5700 must renumber it first.
3. Re-sync the permission catalog and roles (new `assets.*` permissions; roles `asset_manager`, `maintenance_technician`; `finance_controller` gains depreciation/valuation/disposal approval).
4. Beat entry `assets-daily` is in `CELERY_BEAT_SCHEDULE`; `modules.assets` is in the Celery autodiscover list.
5. Settings: `assets.repair_approval_threshold`, `assets.maintenance_lead_days`, `assets.replacement_maintenance_percent`, `assets.replacement_breakdowns`, `assets.underutilized_percent`.

## Not done / known limits

- Sale proceeds are debited to the asset clearing account (1510) pending settlement; matching them to a customer invoice or receipt is a manual step.
- Depreciation is monthly only, no partial-month or units-of-production method; none is charged in the month of disposal.
- Fleet and project allocation reference projects by id only; the Projects module does not exist yet, so allocations are not validated against it and cost is not charged to a project.
- Allocation reports hours, not cost; allocated depreciation/maintenance cost per project is not computed.
- Photo evidence is stored through the shared file service; there is no mobile scanning client, only the scan API.
- Insurance claims and warranty claims record recoveries but do not post accounting entries.
- Capex budget actuals count capitalizations and improvements by posting date only.
- No frontend (deferred by agreement).

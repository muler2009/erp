# Asset Management — gap analysis against the Asset Management FRS (§2.1–2.18)

Inspected 2026-11-03. **Finding: there is no `modules/assets` app yet.** "assets" exists only as a module name in the entitlement
catalog (`platform_core/catalog.py`). Everything below is new. Finance (accounts, journals, periods, system accounts), Procurement
(POs, goods receipts, supplier invoices, contracts), Inventory (locations, spare parts), HR (employees) and the shared services
(numbering, workflow, files, notifications, audit, events) are reused rather than rebuilt.

| FRS | Area | Status | Plan |
|---|---|---|---|
| 2.1 | Asset master | ❌ | A-A: asset register, unique numbers, statuses, identification (barcode/QR/RFID), documents, ownership and history |
| 2.2 | Categories | ❌ | A-A: category tree, capitalization threshold, depreciation defaults, tracking and maintenance policy, numbering prefix |
| 2.3 | Acquisition and capitalization | ❌ | A-B: acquisition sources, PO/GRN/invoice/contract links, extra costs, commissioning, capitalization request with approval, journals |
| 2.4 | Assignment and custody | ❌ | A-C |
| 2.5 | Allocation and utilization | ❌ | A-G |
| 2.6 | Transfers | ❌ | A-C |
| 2.7 | Maintenance | ❌ | A-E |
| 2.8 | Repairs and breakdowns | ❌ | A-E |
| 2.9 | Depreciation and valuation | ❌ | A-D: straight-line and reducing-balance, runs by period, revaluation, impairment, improvements, reversals, Finance journals |
| 2.10 | Inspection and condition | ❌ | A-F |
| 2.11 | Warranty and insurance | ❌ | A-F |
| 2.12 | Vehicles and fleet | ❌ | A-G |
| 2.13 | Physical verification | ❌ | A-H |
| 2.14 | Disposal and retirement | ❌ | A-H |
| 2.15 | Budgeting and replacement planning | ❌ | A-I |
| 2.16 | Dashboards and reporting | ❌ | A-I (reports land with each slice) |
| 2.17 | Administration | ❌ | A-I (settings, reminders), roles and permissions per slice |
| 2.18 | Business rules | ❌ | enforced per slice: unique IDs, traceable acquisition, approvals, no assignment of disposed assets, Finance reconciliation |

## Key design decisions

- One new tenant app `modules.assets`, owner of the asset register. Finance owns the ledger: the register posts through
  `finance.post_system_journal`, using new system accounts (fixed assets at cost, accumulated depreciation, depreciation expense,
  gain/loss on disposal, revaluation reserve, impairment loss, asset clearing).
- Cross-module references are by id (no FK into other apps' tables except where the existing code already does so), as in procurement.
- Asset value is always the sum of ledger-backed movements (cost, improvements, revaluations, impairments, depreciation), so the
  register can be reconciled to the Finance accounts (rule 2.18).
- Assignments, transfers, capitalization, disposal and verification discrepancies require approval by a different person.
EOF
## Status after Phase 7 (assets)

All of §2.1–2.18 now exist as working, tested features (see `phase7-assets-status.md` for what is implemented, tested, and not done).
The "❌" markers in the table above describe the position at inspection time, not today.

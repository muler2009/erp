# Phase 8b status: SCM and Manufacturing requirement gaps

Reconciles Phase 8 with the supplied requirement documents. See `scm-manufacturing-gap-analysis.md` for the full mapping.

## Implemented
Manufacturing: production lines, item profiles, BOM effective dates, substitutes and by-products, production plans (check, revise, approve, release), order approval, hold, priority and reschedule, material reservation on release, consumption ledger, operation pause/approve and cost split, tolerance-based quality checks, quarantine receipts with disposition, rework, by-products, downtime and maintenance requests, 15 reports including OEE and bottlenecks.

Supply chain: demand management with revisions and approval, supply plans with revision history and approval, risk register with mitigation, disruptions, critical and single-source materials, alternative sources, vehicles, consolidation, proof of delivery, per-line discrepancies, inventory coordination reports, fulfilment risk, performance dashboard.

New permissions: `manufacturing.order.approve`, `.plan.manage`, `.plan.approve`, `.operation.approve`, `.disposition.approve`, `.downtime.manage`, `supply_chain.demand.manage`, `supply_chain.risk.manage`. Roles Production Manager, Production Planner and Logistics Coordinator were extended.

New settings: `manufacturing.order_approval_value`, `manufacturing.require_material_on_release`, `manufacturing.operation_approval_required`, `supply_chain.plan_approval_required`, `.fulfilment_days`, `.critical_risk_score`, `.slow_moving_days`, `.obsolete_days`.

## Upgrade notes
- Migrations: `manufacturing 0002_phase8b`, `supply_chain 0002_phase8b` (run `migrate_schemas`).
- Run `finance.services.seed_defaults()` once per existing tenant so the Phase 8 accounts exist; re-sync roles so the new permissions reach existing role assignments.
- Celery beat is unchanged; the supply-chain daily job now also sends risk reminders.

## Tests
New: `test_manufacturing_ext.py` (13), `test_supply_chain_ext.py` (10). Full-suite count and result are in the delivery message.

## Not done / limits
- Standard costing only; setup hours counted per BOM batch in the standard cost.
- Operations are sequential; no alternative routes, shift calendars or WIP transfers between work centers.
- Compliance, safety and training items (Manufacturing §16) and inspection plans beyond production checks are for the Quality and Documents phase.
- Product lifecycle uses the inventory product status; supplier certification documents belong to procurement and the Documents module.
- A shipment's proof of delivery does not confirm the sales delivery.
- Draft requisitions count as supply in the planner, so an unapproved requisition can hide a shortage.
- Sales orders have no promised date; fulfilment risk uses order date plus `supply_chain.fulfilment_days`.
- Consolidated shipments are handled one level deep, and discrepancies are only captured on the carrying shipment.

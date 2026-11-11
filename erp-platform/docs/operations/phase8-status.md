# Phase 8 status: Supply Chain & Logistics (module 8) and Manufacturing & Production (module 9)

No functional spec was supplied, so scope follows Modules 8 and 9 of the master prompt. Send a spec and the gaps can be reconciled, as was done for Projects.

## Implemented

### Manufacturing (`modules/manufacturing`, `/api/v1/manufacturing/*`)
- Work centers with labour, machine and overhead rates, capacity and efficiency.
- Versioned bills of materials with routing steps and quality checks. One ACTIVE version per product (database constraint). Approved versions are frozen and changed by creating a new version. The approver cannot be the creator. Direct and indirect BOM cycles are rejected. Multi-level explosion and where-used.
- Standard cost: material at current average cost plus routing hours at work-center rates, per BOM output quantity. Sub-assemblies with no stock cost are rolled up from their own BOM.
- Production orders: scheduled forward by work-center capacity, released, then material issue and return (through inventory, Dr WIP / Cr inventory), sequential operations with hours booked (Dr WIP / Cr production absorbed), quality checks (a step's checks must pass before the operation completes; the final inspection must pass before receipt), scrap (output and material), finished-goods receipt at standard cost (Dr inventory / Cr WIP), short completion, cancellation (only with no activity) and closing.
- Closing releases what is left in WIP: scrap up to the recorded scrap cost goes to Scrap Loss, the rest to Production Variances. The creator cannot close their own order.
- Reports: order cost analysis, WIP, work-center load, schedule. Daily overdue-order reminders (at most weekly).
- Settings: `manufacturing.enabled` (a tenant that does not manufacture can switch it off; module entitlement still applies), `manufacturing.over_produce_percent`, `manufacturing.scrap_tolerance_percent`.
- MRP engine (`mrp.py`): nets demand against stock minus reservations plus open supply (purchase orders, requisitions, open production orders), explodes make-items through their BOMs, applies supplier MOQ and lead times, and returns planned MAKE/BUY actions. A what-if endpoint is provided.

### Supply chain (`modules/supply_chain`, `/api/v1/supply-chain/*`)
- Carriers, routes (transit days, distance).
- Shipments (outbound, inbound, transfer), optionally linked to a sales delivery (one live shipment per delivery) or purchase order. Dispatch, append-only tracking events, delivery, cancellation.
- Logistics costs booked to the ledger (Dr Logistics Costs / Cr Accrued Logistics) with cost-per-kg by carrier.
- Delivery exceptions (delay, damage, loss, wrong item, refused). High or critical severity must be resolved by someone other than the reporter. A daily job raises one automatic delay exception per late shipment and reminds about shipments not dispatched on time.
- Carrier performance (on-time %, transit days, exception rate, cost). Supplier delivery performance (on-time, in-full, days late, actual versus agreed lead time) with lead-time correction suggestions.
- Demand forecasts: manual or moving-average from delivered history, approved by someone other than the creator; accuracy report.
- Replenishment: reorder-rule minimums, approved forecasts (net of confirmed orders), confirmed sales orders and open production-order components feed the MRP engine. Suggestions can be converted to a draft requisition (BUY) or a draft production order (MAKE), or dismissed with a reason. Each run supersedes earlier open suggestions.
- Fulfilment board: open customer orders with ordered, reserved and short quantities and the shipments carrying them.

### Platform
- New permissions `manufacturing.*` and `supply_chain.*`; roles Production Manager, Production Planner, Logistics Coordinator; the auditor gets read access.
- New finance accounts: 1250 WIP, 5310 Production Conversion Absorbed, 5320 Production Variances, 5330 Production Scrap Loss, 5340 Logistics Costs, 2260 Accrued Logistics Costs.
- Celery beat: `manufacturing.daily_all`, `supply_chain.daily_all`.

## Tests
New: `test_manufacturing.py` (12), `test_supply_chain.py` (10), `test_supply_chain_suppliers.py` (1). The whole suite and `makemigrations --check` pass (572 tests).

## Not done / limits
- Standard costing only: finished goods are received at the standard cost and the difference is posted at close. There is no actual-cost roll-up and no co-/by-products.
- Setup hours are counted once per BOM batch in the standard cost and once per order in planned hours.
- Scheduling is forward and finite by day only (no shift calendars, no machine-level sequencing). Operations are strictly sequential.
- Serial-tracked finished goods are accepted through `serials` but there is no genealogy report.
- A shipment's delivery does not confirm the sales delivery's proof of delivery; that stays with the sales dispatch flow.
- Draft requisitions count as supply in MRP, so an abandoned draft hides a real shortage until it is cancelled.
- Forecasting is a moving average only. Demand sensing, seasonality and safety-stock statistics are not implemented.
- Quality checks here are production checks only; the Quality module (Phase 9) will own non-conformances and corrective actions.
- Logistics costs are accrued with no payable-invoice matching.

## Upgrade notes
Run tenant migrations (`manufacturing` 0001, `supply_chain` 0001). Existing tenants need the new finance accounts: run `finance.services.seed_defaults()` in each tenant schema, and assign the new roles as needed.

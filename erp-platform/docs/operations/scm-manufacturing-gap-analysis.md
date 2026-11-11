# Gap analysis: SCM and Manufacturing functional requirements vs the implementation

Source: the two requirement documents supplied after Phase 8 ("Supply Chain Management (SCM) – Functional Requirements", 13 sections; "Manufacturing Management – Functional Requirements", 19 sections). Phase 8 had been built from the master prompt alone; Phase 8b closes the gaps below. "Deferred" items are listed again in `phase8b-status.md`.

## Manufacturing

| Area | Gap found in Phase 8 | Phase 8b |
|---|---|---|
| Item / BOM master | No supply type, drawing reference, effective dates, substitutes or by-products | `ItemProfile`, BOM effective window, `BomSubstitute`, `BomByproduct`; only approved BOMs that are effective on the order date can be released |
| Work centers / lines | No production lines, linked asset or working days | `ProductionLine`, work-center line, asset link and working days; scheduling skips non-working days |
| Production plans | None | Plans with lines, shortage and capacity/bottleneck check, revision history, approval (not by the creator), release into planned orders, cancellation |
| Order approval and hold | Orders were released directly | Approval with value threshold setting, hold/resume with reason, priority, reschedule; optional "material must be available" check on release (reserves components) |
| Execution detail | Operation costs were one figure | Operator and supervisor, pause/resume, labour/machine/overhead split, good/defective/rework quantities, operation approval setting |
| Consumption | Planned quantities could be overwritten by issues | Append-only consumption ledger (issue, return, substitute, additional); planned quantities never change |
| Quality | Check pass/fail only | Tolerance limits decide the result, conditional pass with note, rejected output goes to a quarantine location as an on-hold receipt until an approved disposition (release, scrap or rework); the receiver cannot approve it |
| Rework and by-products | None | Rework orders linked to the original, time booking, by-product receipts |
| Downtime / maintenance | None | Downtime with reason, affected orders, maintenance request that raises an asset breakdown |
| Partial production | Supported | Unchanged; the order closes only with nothing on hold and no open rework |
| Reports | Cost, WIP, load, schedule | Plan vs actual, order status, output, efficiency, utilisation, downtime, planned vs actual consumption, scrap, rework, quality rejection, WIP aging, cost with variances, by line, labour productivity, on-time, OEE, bottlenecks |
| Compliance, safety, training (§16) | None | Deferred to the Quality and Documents phase |

## Supply chain

| Area | Gap found in Phase 8 | Phase 8b |
|---|---|---|
| Demand management | Forecasts only | Demand records (customer forecast, project, manufacturing, department, manual) with confirmed/forecast kind, revision history, approval, cancellation, consolidated view and an impact check. Sales-order demand is read live and cannot be entered again, so the same demand is never counted twice |
| Supply plans | Loose suggestions | A numbered supply plan per run with a balance snapshot (available, inbound, demand, projected, shortage, surplus), manual adjustments logged in an append-only history, approval by someone other than the creator and every changer, optional gate before conversion |
| Supply risk | None | Risk register (score = likelihood × impact, critical threshold setting), mitigation actions with owners and weekly overdue reminders, disruption history, critical materials and single-source report, alternative sources, automatic risk detection (overdue POs, delivery-delay risk, projected shortages, late shipments, thin sourcing) |
| Inventory coordination | Fulfilment board only | Slow-moving / excess / obsolete stock, shortages against reorder rules, transfer recommendations, stock in transit, warehouse capacity use, availability per warehouse, procurement status |
| Logistics | Carrier, route, shipment | Vehicles with capacity, assignment with over-capacity and double-booking checks, consolidation (dispatched and delivered together), transfer shipments linked to transfer orders, proof of delivery (receiver, time, signed file), per-line received/damaged quantities that raise shortage and damage exceptions |
| Fulfilment | Board | Late and at-risk orders, backorders |
| Performance | Carrier and supplier delivery | Dashboard, inventory turnover, fill rate, supply cost analysis, vehicle utilisation |

## Rules from the requirements and where they are enforced
- Only approved BOM versions on released orders: `orders.release_order`.
- Actual consumption never overwrites planned: `Consumption` ledger.
- Finished goods are not available stock before an authorised receipt, and rejected goods stay on hold: quarantine receipts and `dispose_receipt`.
- Shipments never move stock; purchase and transfer receipts do: unchanged, and `deliver` only records discrepancies.
- Plan changes keep revision history: `PlanChange`, `PlanRevision`, `DemandRevision`.
- Critical shortages are visible to responsible users: owner notification on critical risks, shortages and risk-detection reports.

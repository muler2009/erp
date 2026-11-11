# Phase 4b — Inventory and Procurement update (status)

Brings both modules up to the Inventory FRS (§1.1–1.15) and Procurement FRS (§2.1–2.14). Full suite: **464 tests, all passing**
(run from the packaged zip after extraction); `makemigrations --check` reports no pending changes.

## Implemented

**Inventory** — item master (categories, UoM and conversions, min/max/reorder/safety, status, QR); warehouse structure
(zone/aisle/rack/shelf/bin, quarantine/restricted/transit locations, capacity, blocking); availability and reservations with
expiry; transfers with approval, in-transit and damaged handling; material requisitions and issue vouchers; adjustment requests
with thresholds and evidence; stocktaking (freeze, blind count, recount, approval); weighted-average and FIFO costing, landed costs;
lots with status, FEFO/FIFO picking, expiry, serial numbers and traceability; returns; reports (stock card, summary, movements,
ABC, turnover, ageing, slow-moving, excess; CSV export with formula defusing); daily jobs.

**Procurement** — supplier master (contacts, dual-control bank details, documents, standing, catalogue and price history, risk);
requisitions (priority, emergency, stock check, auto-generation from reorder rules, consolidation, partial ordering, recurring,
attachments); budgets, commitments and procurement plans; RFQs and tenders (sealed bids, committee opening, weighted evaluation,
award rules, clarifications, single-source); purchase orders (terms, schedules, acknowledgment, amendments with approval, blanket
orders and releases, short-close, printable document); **supplier contracts** (contract prices, ceilings, expiry/renewal job);
**receiving** (over-receipt tolerance with approval, inspection into quarantine with accept/reject, service receipts, evidence);
**invoice verification** (duplicate detection, exception queue, controlled override, opt-in two-way match, debit notes);
**returns and claims**; **supplier payments** (due list, ageing, statements, early-payment discount, withholding tax via
finance's idempotent payment engine); **analytics** (measured supplier performance, spend, cycle times, price variance, work
queue) and a settings endpoint.

## Tested

Each slice has service-level tests plus HTTP permission tests (`tests/test_inventory_*.py`, `tests/test_procurement_*.py`);
the authorization contract test covers every new view class.

## Upgrade notes

1. Run tenant migrations (`migrate_schemas`). All migrations are additive.
2. Call `finance.seed_defaults()` per tenant for the new accounts 2210 (landed costs payable), 2310 (withholding tax payable) and 4200 (purchase discounts received).
3. Re-sync the permission catalog and roles (many new permissions; new role `inventory_manager`; `finance_controller` gains `procurement.payment.release`).
4. Schedule the new beat entries `inventory-daily` and `procurement-daily` (already in `CELERY_BEAT_SCHEDULE`).
5. New tenant settings: `procurement.over_receipt_percent`, `procurement.allow_two_way_match`.
6. The existing invoice-match behaviour is stricter: a repeated supplier invoice number is now a hard exception, and goods awaiting inspection block matching.

## Not done / known limits

- Negative stock is not supported.
- Landed-cost share on weighted-average items is estimated as min(received, on hand).
- Serial items are reconciled by identity; stocktake excludes serial items; serial items cannot be adjusted by quantity.
- No supplier portal or e-signature on tender documents.
- Withholding tax is booked to the liability account and reported; remitting it to the tax authority is a manual journal.
- Early-payment discount applies only to a wholly unpaid invoice; rounding uses the base-currency decimals.
- Claims in the performance report are filtered by creation date.

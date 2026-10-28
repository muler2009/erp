# Phase 4 status — Procurement and inventory

Test run: `cd backend && python -m pytest tests` → **215 passed** (188 earlier + 27 new). `makemigrations --check` clean.

## Implemented and tested
**Inventory (module 7)** — `modules/inventory`
- Products (SKU, barcode lookup, variants, lot tracking, non-stock items), warehouses, locations, reorder rules + below-minimum report.
- Stock is an **append-only movement ledger** (DB trigger) with derived balances under row locks and a DB `quantity >= 0` check. Receipt, issue, transfer (two linked legs), adjustment and cycle count (adjust to counted quantity), lot-level balances.
- **Weighted-average valuation** with no rounding residue; every receipt/issue/adjustment posts a balanced GL journal through finance (Dr/Cr inventory against GRNI, COGS or inventory adjustments); subledger valuation ties to the GL inventory account (tested).
- Concurrency: 6 simultaneous issues against 10 units → exactly 3 succeed, no oversell.

**Procurement (module 6)** — `modules/procurement`
- Suppliers with qualification (creates the finance partner exactly once), blocking, periodic evaluation and scorecard.
- Purchase requisitions → approval (shared workflow engine when a definition exists, otherwise direct approval with separation of duties).
- RFQ → supplier quotations (multi-currency) → **bid comparison in base currency** → award creates the PO and marks the requisition converted.
- Purchase orders: draft/edit/submit/approve/cancel, amount-threshold workflow chains (tested), `procurement.purchase_order.approved` event.
- **Goods receipt**: partial/full receipts, over-receipt refused, foreign-currency valuation at the receipt-date rate, lot capture, service lines create no stock; posts Dr Inventory / Cr GRNI; concurrent receipts cannot exceed the ordered quantity (tested with threads).
- **Three-way match**: supplier-invoice stock lines (GRNI account) are compared with ordered and received value within a per-tenant tolerance (`procurement.match_tolerance_percent`, default 2%). Finance **refuses to post** such an invoice until it is MATCHED; posting clears GRNI into AP; voiding releases the PO's invoiced value.
- Spend-by-supplier report; module entitlement enforced; new roles (Procurement Officer) and permissions.

Integration contracts: procurement → inventory/finance only (no reverse dependency); finance exposes `POST_CHECKS`/`VOID_HOOKS` and `post_system_journal`; inventory calls finance for GL postings in the same transaction.

## Not done / honest limits
- Not built: stock **reservations**, **serial-number** tracking, barcode/QR **image generation** (lookup by code only), cycle-count scheduling/sessions, putaway rules, stock valuation methods other than weighted average.
- Price variance between invoice and PO price is not booked (differences remain in GRNI); matching is value-based, not per line.
- Supplier invoices are still entered in finance; no auto-creation from the PO. No supplier portal / e-mailing RFQs. No contract (blanket) purchasing yet.
- Returns to supplier / receipt reversal are not implemented (correct with adjustments or credit notes).
- Tenants provisioned before this phase need `migrate_tenants` and `finance.services.seed_defaults()` (adds Inventory, GRNI and Inventory-adjustment accounts) and sequence seeding.
- No frontend (deferred).

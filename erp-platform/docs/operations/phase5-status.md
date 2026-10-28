# Phase 5 status — CRM and sales

Test run: `cd backend && python -m pytest tests` → **236 passed** (215 earlier + 21 new in `tests/test_sales.py`). `makemigrations --check` clean.

## Implemented and tested
**CRM (module 4)** — `modules/crm`, API under `/api/v1/crm/*`
- Accounts, contacts, leads, pipeline stages (seeded per tenant), opportunities, activities (calls/meetings/tasks/notes).
- **Object-level ownership**: records carry an owner; users without `crm.view_all` only see/change their own, and get 404 (not 403) for others' records. Only `crm.assign` holders can reassign; the new owner must be an active member.
- **Round-robin lead assignment** to the sales rep with fewest open leads (tested balance).
- Lead lifecycle with required disqualification reason; **conversion exactly once** (qualified only) creating account + contact + opportunity and emitting `crm.lead.converted`.
- Opportunity stages, win/lose (loss reason required), `crm.opportunity.won` event; follow-ups due; **probability-weighted forecast** by month/currency; lead conversion/win-rate report; customer segments.

**Sales (module 5)** — `modules/sales`, API under `/api/v1/sales/*`
- Price lists with quantity breaks and validity dates; prices are **computed on the server** (client-supplied prices are only accepted where the user can set them; discount 0–100, tax rates validated); Decimal maths with currency-aware rounding.
- Quotations: draft → sent → accepted/rejected → converted to an order once; expiry enforced; frozen after sending.
- Sales orders: approval required when any discount exceeds `sales.max_discount_percent`, or the base-currency value reaches `sales.approval_threshold`. Governed by the shared workflow engine when an active `sales.order` definition exists, otherwise direct approval with separation of duties (creator ≠ approver). Confirmation emits `sales.order.confirmed` and marks the linked opportunity WON. Workflow rejection returns the order to draft.
- Deliveries: partial/full, no over-delivery, stock issued through inventory (weighted-average cost recorded, COGS posted), service items need no stock, insufficient stock rolls back everything.
- **Customer invoicing integration**: invoice creates a *draft* finance customer invoice for delivered-and-not-yet-invoiced quantities (never over-invoices, due date from `sales.payment_terms_days`), finance partner created once per account. Posting still goes through finance's own approval/SoD. Voiding the draft releases the order quantities (finance `VOID_HOOKS`).
- Returns: stock restored at the cost it left with (COGS reversed); a draft finance **credit note** is raised for the already-invoiced part; voiding the credit note frees the credit.
- Sales report by customer and product; module entitlements for `crm` and `sales` enforced; roles Sales Manager and Sales Rep; warehouse staff can deliver.
- Concurrency (threads): two simultaneous deliveries of 6 against 10 → one succeeds; two simultaneous invoice runs → exactly one invoice.

## Not done / honest limits
- Not built: stock **reservations** on order confirmation, customer **credit limits**, tax-inclusive pricing, customer-specific price lists/contract pricing, e-signature/e-mail sending/PDF of quotations, lead scoring and import, territories, recurring invoices, backorder/shipment carrier integration (that is Phase 8).
- Invoices are created as drafts; they are posted via the existing finance flow (not automatic).
- A return credit note links to the original invoice only when all credited lines came from one invoice.
- Tenants provisioned before this phase need `migrate_tenants`, `crm.services.seed_defaults()` and sequence seeding.
- No frontend (deferred).

Next: Phase 6 — HR and payroll.

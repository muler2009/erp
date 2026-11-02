# Phase 5b — CRM and Sales corrected against the functional requirements: status

Built against the CRM (§1.1–1.9) and Sales (§2.1–2.11) specification, integration §3 and business rules §4. Section-by-section result: `crm-sales-gap-analysis.md`. All changes are additive (new migrations `crm 0002–0006`, `sales 0002–0009`); existing behaviour and APIs keep working.

## Implemented
- **A Leads, accounts, contacts**: qualification data, duplicate detection and merge, dry-run bulk import, account hierarchy/types/classification/addresses, credit status and limit (managers only), contact roles, consent and opt-out, important dates, unified customer timeline.
- **B Opportunities and activities**: competitors/requirements/risks/next action, stage history, configurable stages, product lines, forecast by owner/stage/product/month, scheduled activities with outcomes and overdue reminders.
- **C Campaigns**: audiences with consent gating, sends/responses, lead capture, budget-capped expenses, ROI report.
- **D Customer service**: cases linked to order/delivery/invoice/product, SLA policies (first response and resolution), internal vs customer-visible comments, two-level escalation job, resolution, 1–5 feedback, attachments with object-level file access, service report.
- **E Insights**: value tiers (Pareto), retention (active/at-risk/churned) and lifecycle refresh, lifetime value and account summary, cross-sell hints, satisfaction, customer profitability, CRM dashboard.
- **F Catalog and pricing**: sellable/discontinued, minimum price, minimum margin over average cost, discount ceilings (product, category, customer class), default tax, bundles, customer/contract/promotional price lists with precedence, price-change history, and a server-side price-override permission (`sales.price.override`).
- **G Quotations**: payment/delivery terms, revision history (snapshots), approval before sending with separation of duties, expiry job, printable HTML document (escaped), quote from an opportunity's product lines.
- **H Orders**: credit check (blocked customer refused, on-hold and over-limit orders need approval, exposure = unpaid posted invoices + uninvoiced open orders), stock reservations and backorders with an hourly refill job, outstanding quantities, controlled amendments (request → different approver; never below delivered/invoiced).
- **I Contracts**: versions, activation creating a CONTRACT price list, overlap guard, termination, renewal and auto-renewal, renewal and obligation reminders, utilisation vs committed value.
- **J Delivery lifecycle**: dispatched → delivered (with proof of delivery) or failed, discrepancies (short/damaged/wrong) that open a service case, expected dates, late-delivery alerts, delivery performance.
- **K Billing**: milestone billing plans (exact to the cent; an order is billed by milestones or by delivery, never both), customer statements, receivables aging, graduated overdue reminders (1, 15, 30 days).
- **L Returns**: return requests with window and approval, per-line disposition (restock / quarantine / dispose), receipt through the existing credit-note processing, optional zero-value replacement order.
- **M Targets and commissions**: targets and attainment, tiered and category commission plans, statements net of returns, manager approval (not self), transfer to HR as a pending COMMISSION payroll input.
- **N Teams and territories**: team hierarchy, team managers/leads see their team's records, territory rules and load-balanced assignment, ownership history, portfolio transfer.
- **O Analytics**: performance (AOV, discount, win rate, sales cycle, quote-to-order, concentration), backlog, three-scenario forecast with run-rate.
- New permission `sales.price.override` (sales manager) and `crm.campaign.manage`; daily jobs `crm.daily_all` and `sales.daily_all`.

## Tested (executed)
Full suite: **375 tests pass**, `makemigrations --check` clean. New tests: CRM records 6, pipeline 5, campaigns 5, service 5, insights 5, teams 3; sales pricing 5, quotes 5, orders 5, contracts 3, dispatch 3, billing 3, returns 3, commissions 3, analytics 3; HTTP permission matrix 4 (plus the view-policy contract test covering every new route).

## Upgrade notes
- Run `migrate_tenants` and, per tenant, `crm.services.seed_defaults()` (SLA defaults) so new sequences and SLA policies exist.
- Existing roles: re-sync the permission catalog so `sales.price.override` reaches Sales Manager.
- Behaviour changes: a rep who types a unit price different from an existing list price now gets `price_override_denied`; products flagged not sellable are refused; converting an accepted quotation keeps its agreed prices.

## Not done / known limits
- Web-form lead capture endpoint, e-mail/calendar sync, PDF or e-signature for quotations (printable HTML only).
- No "pending" delivery state before dispatch (stock is issued when the delivery is created).
- Revenue figures are summed per currency in the base currency at order-date rates; customer profitability is base-currency only.
- Reservations are product-level (not location-level) and do not block other modules' issues of the same stock.
- Contract prices cannot change once active (terminate or renew instead); amendments cover quantities and added lines only.
- No frontend (deferred by agreement).

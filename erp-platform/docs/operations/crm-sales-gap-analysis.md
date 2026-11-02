# CRM and Sales — gap analysis against the functional requirements

Reviewed: the Phase 5 build (`modules/crm`, `modules/sales`) against the CRM (§1), Sales (§2), integration (§3) and business-rule (§4) requirements.
Legend: ✅ in place at review · 🟡 partial · ❌ missing. Slice = where the gap is closed in this correction phase ("Phase 5b").
Phase 5 migrations were already released, so every change ships as an additive migration.

## CRM
| § | Area | At review | Main gaps | Slice |
|---|---|---|---|---|
| 1.1 | Leads | 🟡 | Only name/company/email/phone/source/status. No priority, qualification level, potential value, budget, industry, interests, follow-up date, notes; no duplicate detection or merge; no import or web-form capture; no source analytics beyond conversion counts | A |
| 1.2 | Accounts | 🟡 | No customer type (individual/business), parent-child, addresses (billing/delivery/branches), classification, territory, status/credit restriction, communication preferences; no unified timeline | A |
| 1.3 | Contacts | 🟡 | No role, preferences, consent / opt-out, important dates, multi-account links | A |
| 1.4 | Opportunities | 🟡 | No competitors, requirements, decision makers, risks, next action, stage history, product lines, configurable stages, forecast by owner/product | B |
| 1.5 | Activities | 🟡 | No priority, assignee/team, calendars, overdue reminders, outcome | B |
| 1.6 | Campaigns | ❌ | Whole section | C |
| 1.7 | Customer service | ❌ | Whole section (cases, SLA, escalation, satisfaction) | D |
| 1.8 | Segmentation/retention | 🟡 | Only a segment count. No inactive/at-risk, lifetime value, cross-sell, surveys, profitability | E |
| 1.9 | Dashboards | 🟡 | Forecast and conversion only | E |

## Sales
| § | Area | At review | Main gaps | Slice |
|---|---|---|---|---|
| 2.1 | Catalog | 🟡 | Reuses inventory products ✅. No sellable/discontinued flag, minimum price, discount limit, default tax class, bundles, availability | F |
| 2.2 | Prices and discounts | 🟡 | Quantity-break price lists only. No customer-specific/contract/promotional lists, discount rules, minimum margin, override restriction, change history | F |
| 2.3 | Quotations | 🟡 | No terms, delivery/payment conditions, version history, approval, printable document, sent/viewed tracking, expiry job | G |
| 2.4 | Orders | 🟡 | No credit check or customer restriction, stock reservation, backorders, controlled amendment, outstanding-quantity view | H |
| 2.5 | Contracts | ❌ | Whole section | I |
| 2.6 | Delivery | 🟡 | Delivery is posted in one step. No pending/dispatched/delivered/failed lifecycle, proof of delivery, discrepancies | J |
| 2.7 | Invoicing | 🟡 | Draft invoice from delivered quantities ✅. No milestone/partial-amount billing, statements, aging, reminders | K |
| 2.8 | Returns | 🟡 | Immediate processing ✅. No approval, inspection disposition (restock/quarantine/dispose), replacement | L |
| 2.9 | Targets/commissions | ❌ | Whole section | M |
| 2.10 | Territories/teams | ❌ | Whole section | N |
| 2.11 | Forecast/analytics | 🟡 | Sales report by customer/product only | O |

## Integration (§3) and rules (§4)
- Lead → customer + opportunity ✅; opportunity → quotation/order ✅ (quotation → order ✅); **won opportunity → quotation directly** missing (G).
- Order ↔ inventory: delivery issues stock ✅; **reservations** missing (H, adds `StockReservation` to inventory).
- Delivery → fulfilment status ✅; invoice generation ✅; credit notes ✅; **commission → payroll** missing (M, uses the HR payroll input).
- Complaints must link to orders/deliveries/invoices (D).
- Rules 3–4 (effective-dated pricing, mandatory credit/pricing checks) partial → F, H. Rule 8 (traceable reassignment, status change) partial → A, N. Rule 9 (portfolio access) ownership only → N. Rule 10 (report permissions) → O.


## Status after the correction (Phase 5b)
All slices A–O are implemented and tested; see `phase5b-status.md`. Remaining exceptions: web-form/public lead capture, e-mail/calendar integration, PDF/e-signature (the quotation document is printable HTML), a "pending" delivery state before dispatch (stock is issued at dispatch), customer self-service survey links, and cross-currency customer profitability (base currency only).

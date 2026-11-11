# Inventory and Procurement — gap analysis against the functional requirements

Legend: ✅ covered · 🟡 partial · ❌ missing. "Slice" = the work package in Phase 4b that closes it.

## Inventory (spec §1.1–1.15)
| § | Area | At review | Main gaps | Slice |
|---|---|---|---|---|
| 1.1 | Item management | 🟡 | SKU, barcode, category, lot tracking, variants ✅. No description/subcategory/item type, status (inactive/discontinued), units of measure + conversions, serial tracking, min/max/safety/reorder per item, preferred supplier, images/documents, QR | A |
| 1.2 | Warehouses and locations | 🟡 | Warehouses and locations ✅. No zone/aisle/rack/shelf/bin structure, manager, restricted/quarantine locations, capacity and utilisation, branch | B |
| 1.3 | Inbound | 🟡 | Receipt against PO ✅ (procurement). No inspection hold, damaged/missing/excess recording, GRN document, supplier returns | P-F, I-H |
| 1.4 | Outbound | 🟡 | Issue and delivery ✅. No issue vouchers, destinations (department/project/employee), issue history by purpose, outstanding/returned tracking | E |
| 1.5 | Transfers | 🟡 | Instant transfer only. No request/approval, in-transit, partial receipt, rejected/damaged quantities, transfer note | D |
| 1.6 | Requisition and issue | ❌ | Material requisitions, approval, availability check, reservation, partial fulfilment, consumption and returns | E |
| 1.7 | Availability | 🟡 | On-hand only. No reserved/allocated/in-transit/quarantined/available split, alerts, aging, slow-moving, excess/obsolete | C |
| 1.8 | Valuation and costing | 🟡 | Weighted average ✅. No FIFO, landed costs, historical valuation, valuation by warehouse | G |
| 1.9 | Adjustments | 🟡 | Immediate manual adjustment. No request/approval thresholds, evidence, reason codes | F |
| 1.10 | Stocktaking | 🟡 | Count-to-adjust only. No sessions, freeze, assignment, variance review/approval, history | F |
| 1.11 | Batch / serial / expiry | 🟡 | Lots with expiry ✅. No serials, FEFO/FIFO picking, expired/blocked issue guard, recall and traceability | H |
| 1.12 | Returns | ❌ | Returns from departments/projects/customers with inspection and disposition | H |
| 1.13 | Reporting | 🟡 | Valuation and reorder report only | I |
| 1.14 | Administration | 🟡 | No categories/UoM admin, approval rules, policies, numbering for new documents | A, F |
| 1.15 | Rules | 🟡 | No negative stock ✅, movement ledger append-only ✅. Quarantine/expired guards, reserved-stock protection missing | B, C, H |

## Procurement (spec §2.1–2.14)
| § | Area | At review | Main gaps | Slice |
|---|---|---|---|---|
| 2.1 | Suppliers | 🟡 | Name, tax id, e-mail, qualify/block, evaluation ✅. No registration number, addresses, contacts, bank details, categories, documents with expiry, suspension/blacklisting history, payment terms, catalogs and price history, preferred lists, risk | P-A |
| 2.2 | Requisitions | 🟡 | Basic requisition + approval ✅. No department/project/cost-centre/budget link, stock vs non-stock, emergency/recurring, attachments, stock availability check, auto-generation from reorder, consolidation, partially-ordered status | P-B |
| 2.3 | Planning and budget | ❌ | Plans, budgets, commitments, reservation/release, revisions, execution report | P-C |
| 2.4 | RFQ | 🟡 | RFQ, quotations, comparison, award ✅. No deadline enforcement, commercial terms, technical/financial split, weighted criteria, justification, single-source | P-D |
| 2.5 | Tenders | ❌ | Whole section | P-E |
| 2.6 | Purchase orders | 🟡 | PO, approval, receive ✅. No delivery schedules, amendments with approval, acknowledgment, printable document, blanket orders/releases, close | P-F |
| 2.7 | Supplier contracts | ❌ | Whole section | P-G |
| 2.8 | Receiving | 🟡 | Receive with lots ✅. No GRN rules (tolerance, over-receipt approval), inspection (accepted/rejected/quarantine), service receipts, evidence | P-H |
| 2.9 | Invoice verification | 🟡 | Three-way match, GRNI ✅. Duplicate detection, 2-way, configurable tolerance, exceptions workflow, supplier credit/debit notes to confirm | P-I |
| 2.10 | Returns and claims | ❌ | Whole section | P-J |
| 2.11 | Supplier payments | 🟡 | Payments via finance ✅. No supplier statement, due/overdue monitor, early-payment discount, withholding tax | P-K |
| 2.12 | Analytics | 🟡 | Spend by supplier only | P-L |
| 2.13 | Administration | 🟡 | Tolerances, thresholds, categories, criteria configurable | P-L |
| 2.14 | Rules | 🟡 | Separation of duties ✅, duplicate invoices and amendment approval partial | across |

Cross-module: requisition → budget check → RFQ/tender → PO (contract-linked) → receipt (inspection) → inventory → invoice match → payment; stock shortage → auto requisition; returns update stock and finance.

---

## Status after Phase 4b

All sections of both FRS documents now have an implementation with automated tests (see `phase4b-status.md`).
Inventory 1.1–1.15 and Procurement 2.1–2.14 moved from ❌/🟡 to ✅ except the explicit limits listed in the status document
(no negative stock, no supplier portal, no e-signature on tender documents, withholding tax remittance is a manual journal).

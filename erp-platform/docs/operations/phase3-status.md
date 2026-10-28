# Phase 3 status — Finance and accounting (core ledger, AR/AP, reports)

Test run: `cd backend && python -m pytest tests` → **188 passed** (167 earlier + 21 finance). `makemigrations --check` clean.

## Implemented and tested
- **Chart of accounts**: typed, hierarchical, header vs postable, control accounts (AR/AP) writable only by subledger postings, system accounts protected, seeded per tenant at provisioning.
- **Double-entry general ledger**: draft → posted → reversed. Balance is checked in the service **and** by a database trigger; posted entries and their lines are immutable at database level (update/delete/insert rejected); one-sided line check constraint; gapless sequence numbers (JV-yyyy-nnnnnn).
- **Fiscal control**: posting requires an open fiscal period; period close is vetoed while draft journals exist (via the Phase 2 close hook).
- **Customer / supplier invoices and credit notes**: Decimal arithmetic, per-line tax, base-currency conversion at the invoice-date rate (stored), posting to AR/AP control, revenue/expense and tax accounts; separation of duties (creator cannot approve or post); posted documents corrected only by credit notes; credit-note settlement against invoices.
- **Approval**: direct approval (`finance.invoice.approve`) or, when a workflow exists for subject `finance.invoice`, the Phase 2 workflow engine (reject/cancel returns the invoice to draft, approval advances it).
- **Payments**: receipts and disbursements allocated to posted invoices, partial payments, over-allocation refused, realized FX difference booked to the FX account, controller-only release (`finance.payment.release`), approver/poster/creator cannot release, **idempotent** on `Idempotency-Key` (same payload replays, different payload → 409; concurrent duplicates serialized by an advisory lock — verified with 6 threads).
- **Reports** (posted ledger only, permission `reports.financial.view`): trial balance, profit & loss, balance sheet (balance verified), account ledger with running balance.
- **Events/audit**: `finance.invoice.posted`, `finance.payment.completed`, `finance.journal.posted` through the outbox; tenant audit events for all finance actions. Module entitlement is enforced (disabled module → 403).
- Roles: officer creates; manager approves/posts journals; controller releases payments; auditor read-only.

## Not done / honest limits
- **Bank reconciliation, budgeting, cash-flow statement** not built. Year-end close (retained-earnings entry) not built: the balance sheet rolls unclosed P&L into "current earnings".
- Journals entered manually are base-currency only; no unrealized FX revaluation.
- Payments cannot be reversed/voided yet (no payment reversal flow); one payment pays invoices of one partner and one currency.
- Partners are a minimal finance-side record; CRM/Procurement will own them later (`external_ref`).
- Tax: simple percentage rates per line; no tax-inclusive pricing, withholding or tax returns.
- Existing tenants provisioned before this phase need `migrate_tenants` and a one-off `finance.services.seed_defaults()` (new tenants are seeded automatically).
- No frontend (deferred).

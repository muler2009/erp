import { useState } from "react";

import { useGetProcurementSettingsQuery, useGetProductSourcingQuery, useGetReturnsSummaryQuery, useListAccountsQuery, useListTaxRatesQuery, useRaiseDebitNoteMutation, useUpdateProcurementSettingsMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DueInvoice } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

/** Percentages the server accepts: tolerance 0–20, over-receipt 0–50. Returns a message or null. */
export function settingsProblem(tolerance: string, overReceipt: string): string | null {
  const ok = (v: string, max: number) => /^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) <= max;
  if (!ok(tolerance, 20)) return "The match tolerance must be a percentage from 0 to 20.";
  return ok(overReceipt, 50) ? null : "The over-receipt allowance must be a percentage from 0 to 50.";
}

export function ProcurementSettingsPage() {
  const { can } = useAccess();
  const q = useGetProcurementSettingsQuery();
  const [save, { isLoading }] = useUpdateProcurementSettingsMutation();
  const [tol, setTol] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [two, setTwo] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const d = q.data;
  const t = tol ?? String(d["procurement.match_tolerance_percent"]);
  const o = over ?? String(d["procurement.over_receipt_percent"]);
  const w = two ?? d["procurement.allow_two_way_match"];
  const edit = can("procurement.settings.manage");
  const go = async () => {
    setOk(false);
    const p = settingsProblem(t, o);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await save({ "procurement.match_tolerance_percent": Number(t), "procurement.over_receipt_percent": Number(o), "procurement.allow_two_way_match": w }).unwrap(); setTol(null); setOver(null); setTwo(null); setOk(true); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Procurement settings" description="Rules the system applies when matching supplier invoices to orders and receipts." />
      <Card title="Matching and receiving">
        <FormField label="Invoice match tolerance (%)" htmlFor="ps-tol"><input id="ps-tol" inputMode="decimal" disabled={!edit} className={`${inputClass} w-32`} value={t} onChange={(e) => setTol(e.target.value)} /></FormField>
        <p className="-mt-2 mb-3 text-xs text-slate-500">How far an invoice may differ from the order and receipt before it needs review (0–20).</p>
        <FormField label="Over-receipt allowance (%)" htmlFor="ps-over"><input id="ps-over" inputMode="decimal" disabled={!edit} className={`${inputClass} w-32`} value={o} onChange={(e) => setOver(e.target.value)} /></FormField>
        <p className="-mt-2 mb-3 text-xs text-slate-500">How much more than the ordered quantity may be received (0–50).</p>
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" disabled={!edit} checked={w} onChange={(e) => setTwo(e.target.checked)} />Allow two-way matching (invoice to order only) for services</label>
        {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
        {ok && <p role="status" className="mb-2 text-sm text-green-700">Settings saved.</p>}
        {edit ? <Button loading={isLoading} onClick={() => void go()}>Save settings</Button> : <p className="text-sm text-slate-600">You can view these settings but not change them.</p>}
      </Card>
    </>
  );
}

export function ProductSourcingPage() {
  const [product, setProduct] = useState<string | null>(null);
  const q = useGetProductSourcingQuery(product ?? "", { skip: !product });
  return (
    <>
      <PageHeader title="Product sourcing" description="Who can supply a product, who is preferred, and how its supplier prices have changed." />
      <Card><ProductPicker label="Product" onChange={(p) => setProduct(p?.id ?? null)} /></Card>
      {product && (q.isFetching ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : q.data && (
        <>
          <Card title="Suppliers to use now">
            {q.data.preferred.length === 0 ? <EmptyState title="No qualified supplier has a current price" /> : (
              <table className="w-full text-sm"><caption className="sr-only">Preferred suppliers</caption><thead><tr className="text-left text-slate-500"><th>Supplier</th><th className="text-right">Price</th><th className="text-right">Lead time (days)</th><th /></tr></thead>
                <tbody>{q.data.preferred.map((s) => <tr key={s.supplier_id} className="border-t border-slate-100"><td>{s.supplier}</td><td className="text-right">{formatMoney(s.unit_price)} {s.currency}</td><td className="text-right">{s.lead_time_days ?? "–"}</td><td>{s.preferred && <Badge tone="green">preferred</Badge>}</td></tr>)}</tbody></table>
            )}
            <p className="mt-2 text-xs text-slate-500">Only qualified suppliers in good standing with a price valid today. Prices in different currencies are listed as they are.</p>
          </Card>
          <Card title="Price history">
            {q.data.history.length === 0 ? <EmptyState title="No prices recorded" /> : (
              <table className="w-full text-sm"><caption className="sr-only">Supplier price history</caption><thead><tr className="text-left text-slate-500"><th>Supplier</th><th className="text-right">Price</th><th>From</th><th>To</th></tr></thead>
                <tbody>{q.data.history.map((h, i) => <tr key={i} className="border-t border-slate-100"><td>{h.supplier}</td><td className="text-right">{formatMoney(h.unit_price)} {h.currency}</td><td>{h.valid_from}</td><td>{h.valid_to ?? "open"}</td></tr>)}</tbody></table>
            )}
          </Card>
        </>
      ))}
    </>
  );
}

export function ReturnsSummary() {
  const q = useGetReturnsSummaryQuery();
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const rows = q.data?.results ?? [];
  return rows.length === 0 ? <EmptyState title="No returns or claims yet" /> : (
    <Card title="By supplier">
      <table className="w-full text-sm"><caption className="sr-only">Returns and claims by supplier</caption>
        <thead><tr className="text-left text-slate-500"><th>Supplier</th><th className="text-right">Returns</th><th className="text-right">Value returned</th><th className="text-right">Claims</th><th className="text-right">Claimed</th><th className="text-right">Accepted</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.supplier} className="border-t border-slate-100"><td>{r.supplier}</td><td className="text-right">{r.returns}</td><td className="text-right">{formatMoney(r.return_value)}</td><td className="text-right">{r.claims}</td><td className="text-right">{formatMoney(r.claimed)}</td><td className="text-right">{formatMoney(r.accepted)}</td></tr>)}</tbody></table>
    </Card>
  );
}

const DEC = /^\d+(\.\d{1,4})?$/;
export function debitNoteProblem(amount: string, reason: string, account: string, date: string, outstanding: number): string | null {
  if (!DEC.test(amount.trim()) || Number(amount) <= 0) return "Enter the amount to credit, above 0.";
  if (!reason.trim()) return "A reason is required.";
  if (!account) return "Choose the expense account to credit.";
  if (!date) return "Choose the date.";
  return Number(amount) > outstanding ? "The amount is more than the invoice total." : null;
}

/** A single-line debit note (supplier credit) against a posted invoice; the server enforces that credits never exceed the invoice. */
export function DebitNoteDialog({ row, onClose }: { row: DueInvoice; onClose: () => void }) {
  const [raise, { isLoading }] = useRaiseDebitNoteMutation();
  const accounts = useListAccountsQuery();
  const taxes = useListTaxRatesQuery();
  const [f, setF] = useState({ amount: "", reason: "", account: "", tax: "", date: new Date().toISOString().slice(0, 10), ref: "" });
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const expense = (accounts.data?.results ?? []).filter((a) => a.type === "EXPENSE" && a.is_postable && !a.is_control && a.is_active);
  const purchase = (taxes.data?.results ?? []).filter((t) => t.kind === "PURCHASE" && t.is_active);
  const go = async () => {
    const p = debitNoteProblem(f.amount, f.reason, f.account, f.date, Number(row.total));
    if (p) { setErr(p); return; }
    setErr(null);
    try {
      const r = await raise({ invoice: row.invoice, reason: f.reason.trim(), invoice_date: f.date, ...(f.ref.trim() ? { supplier_ref: f.ref.trim() } : {}), lines: [{ description: f.reason.trim().slice(0, 300), quantity: "1", unit_price: f.amount.trim(), account: f.account, ...(f.tax ? { tax_rate: f.tax } : {}) }] }).unwrap();
      setDone(`Debit note created for ${formatMoney(r.total)} ${row.currency} (${r.status.toLowerCase()}).`);
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Debit note against ${row.number}`} open onClose={onClose}>
      {done ? <><p role="status" className="mb-3 text-sm text-green-700">{done}</p><div className="flex justify-end"><Button onClick={onClose}>Close</Button></div></> : (
        <>
          <p className="mb-3 text-sm text-slate-600">Credits part of this invoice back from {row.supplier}, for example for a price correction. It is created as a supplier credit note.</p>
          <FormField label={`Amount to credit (${row.currency}, before tax)`} htmlFor="dn-amt"><input id="dn-amt" inputMode="decimal" className={inputClass} value={f.amount} onChange={(e) => set("amount", e.target.value)} /></FormField>
          <FormField label="Reason" htmlFor="dn-reason"><input id="dn-reason" className={inputClass} value={f.reason} onChange={(e) => set("reason", e.target.value)} /></FormField>
          <FormField label="Expense account" htmlFor="dn-acct"><select id="dn-acct" className={inputClass} value={f.account} onChange={(e) => set("account", e.target.value)}><option value="">Choose…</option>{expense.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></FormField>
          <FormField label="Tax (optional)" htmlFor="dn-tax"><select id="dn-tax" className={inputClass} value={f.tax} onChange={(e) => set("tax", e.target.value)}><option value="">No tax</option>{purchase.map((t) => <option key={t.id} value={t.id}>{t.name} ({Number(t.rate)}%)</option>)}</select></FormField>
          <FormField label="Date" htmlFor="dn-date"><input id="dn-date" type="date" className={inputClass} value={f.date} onChange={(e) => set("date", e.target.value)} /></FormField>
          <FormField label="Supplier's reference (optional)" htmlFor="dn-ref"><input id="dn-ref" className={inputClass} value={f.ref} onChange={(e) => set("ref", e.target.value)} /></FormField>
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Create debit note</Button></div>
        </>
      )}
    </Modal>
  );
}

import { useState } from "react";

import { useCreatePurchaseContractMutation, useGetPurchaseContractReportQuery, useListProductsQuery, useListPurchaseContractsQuery, useListSuppliersQuery, usePurchaseContractActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { PurchaseContractRow } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export const STATUS: Record<PurchaseContractRow["status"], { label: string; tone: "green" | "red" | "amber" | "slate" }> = { DRAFT: { label: "Waiting for approval", tone: "amber" }, ACTIVE: { label: "In force", tone: "green" }, EXPIRED: { label: "Expired", tone: "slate" }, TERMINATED: { label: "Ended early", tone: "red" } };
const DEC = /^\d+(\.\d{1,4})?$/;
export interface PriceDraft { product: string; unit_price: string }

export function contractProblem(f: { supplier: string; title: string; start_date: string; end_date: string; currency: string; value_limit: string; auto_renew: boolean; renewal_notice_days: string }, prices: PriceDraft[]): string | null {
  if (!f.supplier) return "Choose the supplier.";
  if (!f.title.trim()) return "Give the contract a title.";
  if (!f.start_date || !f.end_date) return "Enter the start and end dates.";
  if (f.end_date < f.start_date) return "The contract cannot end before it starts.";
  if (!/^[A-Za-z]{3}$/.test(f.currency.trim())) return "Enter the three-letter currency code, such as USD.";
  if (f.value_limit.trim() && (!DEC.test(f.value_limit.trim()) || Number(f.value_limit) <= 0)) return "The spending limit must be an amount above zero.";
  if (f.auto_renew && !/^\d+$/.test(f.renewal_notice_days.trim())) return "Notice days must be a whole number.";
  if (prices.length === 0) return "Add at least one agreed price.";
  const seen = new Set<string>();
  for (const p of prices) {
    if (!p.product) return "Choose a product for every price row.";
    if (seen.has(p.product)) return "A product is listed twice.";
    seen.add(p.product);
    if (!DEC.test(p.unit_price.trim())) return "Every price must be a number such as 4.50.";
  }
  return null;
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const suppliers = useListSuppliersQuery({});
  const products = useListProductsQuery({});
  const [create, { isLoading }] = useCreatePurchaseContractMutation();
  const [f, setF] = useState({ supplier: "", title: "", start_date: "", end_date: "", currency: "", value_limit: "", payment_terms: "", auto_renew: false, renewal_notice_days: "60" });
  const [prices, setPrices] = useState<PriceDraft[]>([{ product: "", unit_price: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string | boolean) => setF({ ...f, [k]: v });
  const go = async () => {
    const p = contractProblem(f, prices);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { supplier: f.supplier, title: f.title.trim(), start_date: f.start_date, end_date: f.end_date, currency: f.currency.trim().toUpperCase(), payment_terms: f.payment_terms.trim(), auto_renew: f.auto_renew, prices: prices.map((x) => ({ product: x.product, unit_price: x.unit_price.trim() })) };
    if (f.value_limit.trim()) body.value_limit = f.value_limit.trim();
    if (f.auto_renew) body.renewal_notice_days = Number(f.renewal_notice_days);
    try { await create(body).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New supplier contract" open onClose={onClose}>
      <FormField label="Supplier" htmlFor="pc-sup"><select id="pc-sup" className={inputClass} value={f.supplier} onChange={(e) => set("supplier", e.target.value)}><option value="">Choose…</option>{(suppliers.data?.results ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></FormField>
      <FormField label="Title" htmlFor="pc-title"><input id="pc-title" className={inputClass} value={f.title} onChange={(e) => set("title", e.target.value)} /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Starts" htmlFor="pc-start"><input id="pc-start" type="date" className={inputClass} value={f.start_date} onChange={(e) => set("start_date", e.target.value)} /></FormField>
        <FormField label="Ends" htmlFor="pc-end"><input id="pc-end" type="date" className={inputClass} value={f.end_date} onChange={(e) => set("end_date", e.target.value)} /></FormField>
        <FormField label="Currency" htmlFor="pc-cur"><input id="pc-cur" maxLength={3} className={inputClass} value={f.currency} onChange={(e) => set("currency", e.target.value)} /></FormField>
        <FormField label="Spending limit (optional)" htmlFor="pc-lim"><input id="pc-lim" className={inputClass} value={f.value_limit} onChange={(e) => set("value_limit", e.target.value)} /></FormField>
      </div>
      <FormField label="Payment terms (optional)" htmlFor="pc-pay"><input id="pc-pay" className={inputClass} value={f.payment_terms} onChange={(e) => set("payment_terms", e.target.value)} /></FormField>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.auto_renew} onChange={(e) => set("auto_renew", e.target.checked)} />Renew automatically</label>
      {f.auto_renew && <FormField label="Warn this many days before it ends" htmlFor="pc-notice"><input id="pc-notice" className={inputClass} value={f.renewal_notice_days} onChange={(e) => set("renewal_notice_days", e.target.value)} /></FormField>}
      <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Agreed prices</legend>
        {prices.map((p, n) => (
          <div key={n} className="mb-2 flex items-center gap-2">
            <select aria-label={`Product ${n + 1}`} className={inputClass} value={p.product} onChange={(e) => setPrices(prices.map((x, j) => (j === n ? { ...x, product: e.target.value } : x)))}><option value="">Product…</option>{(products.data?.results ?? []).map((x) => <option key={x.id} value={x.id}>{x.sku} — {x.name}</option>)}</select>
            <input aria-label={`Price ${n + 1}`} placeholder="Price" className={`${inputClass} w-28`} value={p.unit_price} onChange={(e) => setPrices(prices.map((x, j) => (j === n ? { ...x, unit_price: e.target.value } : x)))} />
            {prices.length > 1 && <Button variant="secondary" onClick={() => setPrices(prices.filter((_, j) => j !== n))}>Remove</Button>}
          </div>
        ))}
        <Button variant="secondary" onClick={() => setPrices([...prices, { product: "", unit_price: "" }])}>Add a price</Button>
      </fieldset>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Create contract</Button></div>
    </Modal>
  );
}

function Report({ row, onClose }: { row: PurchaseContractRow; onClose: () => void }) {
  const q = useGetPurchaseContractReportQuery(row.id);
  const products = useListProductsQuery({});
  const d = q.data;
  const name = (id: string) => { const p = products.data?.results.find((x) => x.id === id); return p ? `${p.sku} — ${p.name}` : "Product"; };
  return (
    <Modal title={`${row.number} — ${row.title}`} open onClose={onClose}>
      {q.isLoading ? <Spinner /> : q.isError || !d ? <ErrorState error={q.error ?? new Error("Could not load.")} onRetry={() => void q.refetch()} /> : (
        <>
          <p className="text-sm">{d.supplier} · {d.start_date} → {d.end_date} · {d.days_left >= 0 ? `${d.days_left} days left` : `ended ${-d.days_left} days ago`}</p>
          <p className="mt-2 text-sm">Spent so far: <strong>{formatMoney(d.consumed)} {d.currency}</strong>{d.value_limit ? <> of {formatMoney(d.value_limit)} ({formatMoney(d.remaining)} left)</> : " (no spending limit)"}.</p>
          <table className="mt-3 w-full text-sm"><caption className="sr-only">Agreed prices</caption><thead><tr className="text-left text-slate-500"><th>Product</th><th className="text-right">Price</th></tr></thead>
            <tbody>{d.prices.map((p) => <tr key={p.product} className="border-t border-slate-100"><td className="py-1">{name(p.product)}</td><td className="text-right">{formatMoney(p.unit_price)} {d.currency}</td></tr>)}</tbody></table>
        </>
      )}
      <div className="mt-4 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Modal>
  );
}

export function PurchaseContractsPage() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<PurchaseContractRow | null>(null);
  const [dlg, setDlg] = useState<{ c: PurchaseContractRow; kind: "terminate" | "extend" } | null>(null);
  const q = useListPurchaseContractsQuery(status ? { status } : undefined);
  const [act] = usePurchaseContractActionMutation();
  const [err, setErr] = useState<string | null>(null);
  const manage = can("procurement.contract.manage"), approve = can("procurement.contract.approve");
  const activate = async (id: string) => { setErr(null); try { await act({ id, action: "activate" }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <div>
      <PageHeader title="Supplier contracts" description="Agreed prices and spending limits with suppliers." actions={manage ? <Button onClick={() => setCreating(true)}>New contract</Button> : undefined} />
      <div className="mb-4 max-w-xs"><FormField label="Show" htmlFor="pc-filter"><select id="pc-filter" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All contracts</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FormField></div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="No contracts" hint="Create one to agree prices with a supplier." /> : (
        <Card>
          <table className="w-full text-sm"><caption className="sr-only">Supplier contracts</caption>
            <thead><tr className="text-left text-slate-500"><th>Number</th><th>Supplier</th><th>Title</th><th>Period</th><th className="text-right">Limit</th><th>Status</th><th /></tr></thead>
            <tbody>{(q.data ?? []).map((c) => (
              <tr key={c.id} className="border-t border-slate-100"><td className="py-1"><button className="text-blue-700 underline" onClick={() => setView(c)}>{c.number}</button></td><td>{c.supplier.name}</td><td>{c.title}</td><td>{c.start_date} → {c.end_date}</td><td className="text-right">{c.value_limit ? `${formatMoney(c.value_limit)} ${c.currency}` : "—"}</td><td><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></td>
                <td className="space-x-1 text-right">
                  {c.status === "DRAFT" && approve && <Button variant="secondary" onClick={() => void activate(c.id)}>{`Approve ${c.number}`}</Button>}
                  {(c.status === "ACTIVE" || c.status === "EXPIRED") && manage && <Button variant="secondary" onClick={() => setDlg({ c, kind: "extend" })}>{`Extend ${c.number}`}</Button>}
                  {c.status === "ACTIVE" && manage && <Button variant="danger" onClick={() => setDlg({ c, kind: "terminate" })}>{`End ${c.number} early`}</Button>}
                </td></tr>
            ))}</tbody>
          </table>
        </Card>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {view && <Report row={view} onClose={() => setView(null)} />}
      {dlg?.kind === "terminate" && <ActionDialog title={`End ${dlg.c.number} early`} cta="End contract" open onClose={() => setDlg(null)} fields={[{ name: "reason", label: "Why is it ending?", required: true }]} submit={async (v) => { await act({ id: dlg.c.id, action: "terminate", body: { reason: v.reason } }).unwrap(); }} />}
      {dlg?.kind === "extend" && <ActionDialog title={`Extend ${dlg.c.number}`} cta="Extend" open onClose={() => setDlg(null)} fields={[{ name: "new_end_date", label: "New end date", type: "date", required: true }, { name: "value_limit", label: "New spending limit (optional)" }, { name: "reason", label: "Why is it being extended?", required: true }]}
        submit={async (v) => {
          if ((v.new_end_date ?? "") <= dlg.c.end_date) throw new Error(`The new end date must be after ${dlg.c.end_date}.`);
          const lim = (v.value_limit ?? "").trim();
          if (lim && (!DEC.test(lim) || Number(lim) <= 0)) throw new Error("The spending limit must be an amount above zero.");
          await act({ id: dlg.c.id, action: "extend", body: { new_end_date: v.new_end_date, reason: v.reason, ...(lim ? { value_limit: lim } : {}) } }).unwrap();
        }} />}
    </div>
  );
}

import { useState } from "react";
import { Link } from "react-router";

import { useCreateSalesContractMutation, useListCrmAccountsQuery, useListProductsQuery, useListSalesContractsQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { SalesContractRow } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const CONTRACT_STATUS: Record<SalesContractRow["status"], { label: string; tone: "green" | "red" | "amber" | "slate" }> = { DRAFT: { label: "Draft", tone: "slate" }, ACTIVE: { label: "In force", tone: "green" }, EXPIRED: { label: "Expired", tone: "amber" }, TERMINATED: { label: "Ended early", tone: "red" } };
const DEC = /^\d+(\.\d{1,4})?$/;
export interface ItemDraft { product: string; min_quantity: string; unit_price: string }

/** First problem with a contract form, or null. */
export function contractProblem(f: { account: string; title: string; start_date: string; end_date: string; committed_value: string; auto_renew: boolean; renewal_term_months: string }, items: ItemDraft[]): string | null {
  if (!f.account) return "Choose the customer.";
  if (!f.title.trim()) return "Give the contract a title.";
  if (!f.start_date || !f.end_date) return "Enter the start and end dates.";
  if (f.end_date <= f.start_date) return "The end date must be after the start date.";
  if (f.committed_value.trim() && !DEC.test(f.committed_value.trim())) return "The committed value must be an amount such as 50000 or 50000.50.";
  if (f.auto_renew && !/^[1-9]\d*$/.test(f.renewal_term_months.trim())) return "Say how many months each renewal lasts.";
  const seen = new Set<string>();
  for (const i of items) {
    if (!i.product) return "Choose a product for every price row (or remove the row).";
    if (seen.has(i.product)) return "A product is listed twice.";
    seen.add(i.product);
    if (!DEC.test(i.unit_price.trim()) || Number(i.unit_price) <= 0) return "Every agreed price must be above zero.";
    if (i.min_quantity.trim() && !DEC.test(i.min_quantity.trim())) return "A minimum quantity must be a number.";
  }
  return null;
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const accounts = useListCrmAccountsQuery({});
  const products = useListProductsQuery({});
  const [create, { isLoading }] = useCreateSalesContractMutation();
  const [f, setF] = useState({ account: "", title: "", start_date: "", end_date: "", currency: "", committed_value: "", auto_renew: false, renewal_term_months: "12", payment_terms: "" });
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = contractProblem(f, items);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { account: f.account, title: f.title.trim(), start_date: f.start_date, end_date: f.end_date, auto_renew: f.auto_renew, payment_terms: f.payment_terms.trim(), items: items.map((i) => ({ product: i.product, min_quantity: i.min_quantity.trim() || "0", unit_price: i.unit_price.trim() })) };
    if (f.currency.trim()) body.currency = f.currency.trim().toUpperCase();
    if (f.committed_value.trim()) body.committed_value = f.committed_value.trim();
    if (f.auto_renew) body.renewal_term_months = Number(f.renewal_term_months);
    try { await create(body).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  const set = (k: string, v: string | boolean) => setF({ ...f, [k]: v });
  return (
    <Modal title="New customer contract" open onClose={onClose}>
      <FormField label="Customer" htmlFor="ct-acct"><select id="ct-acct" className={inputClass} value={f.account} onChange={(e) => set("account", e.target.value)}><option value="">Choose…</option>{(accounts.data?.results ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></FormField>
      <FormField label="Title" htmlFor="ct-title"><input id="ct-title" className={inputClass} value={f.title} onChange={(e) => set("title", e.target.value)} /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Starts" htmlFor="ct-start"><input id="ct-start" type="date" className={inputClass} value={f.start_date} onChange={(e) => set("start_date", e.target.value)} /></FormField>
        <FormField label="Ends" htmlFor="ct-end"><input id="ct-end" type="date" className={inputClass} value={f.end_date} onChange={(e) => set("end_date", e.target.value)} /></FormField>
        <FormField label="Currency (optional)" htmlFor="ct-cur"><input id="ct-cur" maxLength={3} className={inputClass} value={f.currency} onChange={(e) => set("currency", e.target.value)} /></FormField>
        <FormField label="Committed value (optional)" htmlFor="ct-val"><input id="ct-val" className={inputClass} value={f.committed_value} onChange={(e) => set("committed_value", e.target.value)} /></FormField>
      </div>
      <FormField label="Payment terms (optional)" htmlFor="ct-pay"><input id="ct-pay" className={inputClass} value={f.payment_terms} onChange={(e) => set("payment_terms", e.target.value)} /></FormField>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.auto_renew} onChange={(e) => set("auto_renew", e.target.checked)} />Renew automatically</label>
      {f.auto_renew && <FormField label="Months per renewal" htmlFor="ct-term"><input id="ct-term" className={inputClass} value={f.renewal_term_months} onChange={(e) => set("renewal_term_months", e.target.value)} /></FormField>}
      <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Agreed prices</legend>
        {items.map((it, n) => (
          <div key={n} className="mb-2 flex items-center gap-2">
            <select aria-label={`Product ${n + 1}`} className={inputClass} value={it.product} onChange={(e) => setItems(items.map((x, j) => (j === n ? { ...x, product: e.target.value } : x)))}><option value="">Product…</option>{(products.data?.results ?? []).map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select>
            <input aria-label={`Minimum quantity ${n + 1}`} placeholder="Min qty" className={`${inputClass} w-24`} value={it.min_quantity} onChange={(e) => setItems(items.map((x, j) => (j === n ? { ...x, min_quantity: e.target.value } : x)))} />
            <input aria-label={`Price ${n + 1}`} placeholder="Price" className={`${inputClass} w-24`} value={it.unit_price} onChange={(e) => setItems(items.map((x, j) => (j === n ? { ...x, unit_price: e.target.value } : x)))} />
            <Button variant="secondary" onClick={() => setItems(items.filter((_, j) => j !== n))}>Remove</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setItems([...items, { product: "", min_quantity: "", unit_price: "" }])}>Add a price</Button>
      </fieldset>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Create contract</Button></div>
    </Modal>
  );
}

export function ContractsPage() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const q = useListSalesContractsQuery(status ? { status } : undefined);
  const accounts = useListCrmAccountsQuery({});
  const name = (id: string) => accounts.data?.results.find((a) => a.id === id)?.name ?? "Customer";
  const rows = q.data?.results ?? [];
  return (
    <div>
      <PageHeader title="Customer contracts" description="Agreed prices and terms with customers." actions={can("sales.quote.create") ? <Button onClick={() => setCreating(true)}>New contract</Button> : undefined} />
      <div className="mb-4 max-w-xs"><FormField label="Show" htmlFor="ct-filter"><select id="ct-filter" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All contracts</option>{Object.entries(CONTRACT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FormField></div>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={new Error("Contracts could not be loaded.")} onRetry={() => void q.refetch()} /> : rows.length === 0 ? <EmptyState title="No contracts" hint="Create one to agree prices and terms with a customer." /> : (
        <Card>
          <table className="w-full text-sm"><caption className="sr-only">Customer contracts</caption>
            <thead><tr className="text-left text-slate-500"><th>Number</th><th>Customer</th><th>Title</th><th>Period</th><th className="text-right">Committed</th><th>Status</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className="border-t border-slate-100"><td className="py-1"><Link className="text-blue-700 underline" to={`/app/sales/contracts/${c.id}`}>{c.number || "Draft"}</Link></td><td>{name(c.account)}</td><td>{c.title}</td><td>{c.start_date} → {c.end_date}</td><td className="text-right">{c.committed_value ? `${formatMoney(c.committed_value)} ${c.currency}` : "—"}</td><td><Badge tone={CONTRACT_STATUS[c.status].tone}>{CONTRACT_STATUS[c.status].label}</Badge></td></tr>
            ))}</tbody>
          </table>
        </Card>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

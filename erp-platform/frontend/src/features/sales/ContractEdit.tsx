import { useState } from "react";

import { useListProductsQuery, useUpdateSalesContractMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { SalesContractRow } from "../../shared/api/types";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";
import { contractProblem, type ItemDraft } from "./ContractsPage";

const DAYS = /^\d+$/;

/** Wording and renewal settings, which can change even while a contract is in force. */
export function wordingProblem(f: { auto_renew: boolean; renewal_term_months: string; renewal_notice_days: string }): string | null {
  if (f.auto_renew && !/^[1-9]\d*$/.test(f.renewal_term_months.trim())) return "Say how many months each renewal lasts.";
  if (f.renewal_notice_days.trim() && !DAYS.test(f.renewal_notice_days.trim())) return "The notice period must be a whole number of days.";
  return null;
}

/** Draft contracts can change everything; a contract in force only its wording and renewal settings (a new version is kept). */
export function ContractEditDialog({ contract: c, onClose }: { contract: SalesContractRow; onClose: () => void }) {
  const draft = c.status === "DRAFT";
  const [update, { isLoading }] = useUpdateSalesContractMutation();
  const products = useListProductsQuery({});
  const [f, setF] = useState({ title: c.title, start_date: c.start_date, end_date: c.end_date, committed_value: c.committed_value ? String(Number(c.committed_value)) : "", payment_terms: c.payment_terms, delivery_terms: c.delivery_terms, terms: c.terms, auto_renew: c.auto_renew, renewal_term_months: c.renewal_term_months ? String(c.renewal_term_months) : "12", renewal_notice_days: c.renewal_notice_days !== null && c.renewal_notice_days !== undefined ? String(c.renewal_notice_days) : "" });
  const [items, setItems] = useState<ItemDraft[]>((c.items ?? []).map((i) => ({ product: i.product, min_quantity: String(Number(i.min_quantity)), unit_price: String(Number(i.unit_price)) })));
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string | boolean) => setF({ ...f, [k]: v });
  const go = async () => {
    const p = draft ? contractProblem({ account: c.account, ...f }, items) ?? wordingProblem(f) : wordingProblem(f);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { payment_terms: f.payment_terms.trim(), delivery_terms: f.delivery_terms.trim(), terms: f.terms.trim(), auto_renew: f.auto_renew };
    if (f.auto_renew) body.renewal_term_months = Number(f.renewal_term_months);
    if (f.renewal_notice_days.trim()) body.renewal_notice_days = Number(f.renewal_notice_days);
    if (draft) {
      Object.assign(body, { title: f.title.trim(), start_date: f.start_date, end_date: f.end_date, items: items.map((i) => ({ product: i.product, min_quantity: i.min_quantity.trim() || "1", unit_price: i.unit_price.trim() })) });
      if (f.committed_value.trim()) body.committed_value = f.committed_value.trim();
    }
    try { await update({ id: c.id, body }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={draft ? "Edit draft contract" : "Change contract wording"} open onClose={onClose}>
      {!draft && <p className="mb-3 text-sm text-slate-600">This contract is in force. Prices, dates and value are fixed; wording and renewal settings can change and a new version is kept.</p>}
      {draft && (
        <>
          <FormField label="Title" htmlFor="ce-title"><input id="ce-title" className={inputClass} value={f.title} onChange={(e) => set("title", e.target.value)} /></FormField>
          <div className="grid grid-cols-3 gap-3">
            <FormField label="Starts" htmlFor="ce-start"><input id="ce-start" type="date" className={inputClass} value={f.start_date} onChange={(e) => set("start_date", e.target.value)} /></FormField>
            <FormField label="Ends" htmlFor="ce-end"><input id="ce-end" type="date" className={inputClass} value={f.end_date} onChange={(e) => set("end_date", e.target.value)} /></FormField>
            <FormField label="Committed value" htmlFor="ce-val"><input id="ce-val" className={inputClass} value={f.committed_value} onChange={(e) => set("committed_value", e.target.value)} /></FormField>
          </div>
        </>
      )}
      <FormField label="Payment terms" htmlFor="ce-pay"><input id="ce-pay" className={inputClass} value={f.payment_terms} onChange={(e) => set("payment_terms", e.target.value)} /></FormField>
      <FormField label="Delivery terms" htmlFor="ce-del"><input id="ce-del" className={inputClass} value={f.delivery_terms} onChange={(e) => set("delivery_terms", e.target.value)} /></FormField>
      <FormField label="Other terms" htmlFor="ce-terms"><textarea id="ce-terms" rows={3} className={inputClass} value={f.terms} onChange={(e) => set("terms", e.target.value)} /></FormField>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.auto_renew} onChange={(e) => set("auto_renew", e.target.checked)} />Renew automatically</label>
      {f.auto_renew && <FormField label="Months per renewal" htmlFor="ce-term"><input id="ce-term" className={inputClass} value={f.renewal_term_months} onChange={(e) => set("renewal_term_months", e.target.value)} /></FormField>}
      <FormField label="Renewal notice (days)" htmlFor="ce-notice"><input id="ce-notice" className={inputClass} value={f.renewal_notice_days} onChange={(e) => set("renewal_notice_days", e.target.value)} /></FormField>
      {draft && (
        <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Agreed prices</legend>
          {items.map((it, n) => (
            <div key={n} className="mb-2 flex items-center gap-2">
              <select aria-label={`Product ${n + 1}`} className={inputClass} value={it.product} onChange={(e) => setItems(items.map((x, j) => (j === n ? { ...x, product: e.target.value } : x)))}><option value="">Product…</option>{(products.data?.results ?? []).map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select>
              <input aria-label={`Minimum quantity ${n + 1}`} className={`${inputClass} w-24`} value={it.min_quantity} onChange={(e) => setItems(items.map((x, j) => (j === n ? { ...x, min_quantity: e.target.value } : x)))} />
              <input aria-label={`Price ${n + 1}`} className={`${inputClass} w-24`} value={it.unit_price} onChange={(e) => setItems(items.map((x, j) => (j === n ? { ...x, unit_price: e.target.value } : x)))} />
              <Button variant="secondary" aria-label={`Remove price ${n + 1}`} onClick={() => setItems(items.filter((_, j) => j !== n))}>Remove</Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setItems([...items, { product: "", min_quantity: "", unit_price: "" }])}>Add a price</Button>
        </fieldset>
      )}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Save changes</Button></div>
    </Modal>
  );
}

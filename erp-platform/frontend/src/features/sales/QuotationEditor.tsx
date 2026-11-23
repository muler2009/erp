import { useState } from "react";

import { useCreateQuotationMutation, useListCrmAccountsQuery, useListCurrenciesQuery, useUpdateQuotationMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Quotation, QuotationInput } from "../../shared/api/types";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";

export interface QLine { key: number; product: string | null; description: string; quantity: string; unit_price: string; discount_percent: string; fixed?: boolean }
const DEC = /^\d+(\.\d{1,4})?$/;

export function quotationProblem(account: string, currency: string, lines: QLine[], terms: { payment_terms: string; delivery_terms: string; terms: string }, creating: boolean): string | null {
  if (creating && !account) return "Choose a customer.";
  if (creating && !currency) return "Choose a currency.";
  if (lines.length === 0) return "Add at least one line.";
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    if (!l.product && !l.description.trim()) return `Line ${n}: pick a product or describe the item.`;
    if (!DEC.test(l.quantity.trim()) || Number(l.quantity) <= 0) return `Line ${n}: the quantity must be above 0.`;
    if (l.unit_price.trim() !== "" && !DEC.test(l.unit_price.trim())) return `Line ${n}: the price must be a number.`;
    if (!l.product && l.unit_price.trim() === "") return `Line ${n}: an item without a product needs a price.`;
    if (l.discount_percent.trim() !== "" && (!DEC.test(l.discount_percent.trim()) || Number(l.discount_percent) > 100)) return `Line ${n}: the discount must be between 0 and 100.`;
  }
  if (terms.payment_terms.length > 200 || terms.delivery_terms.length > 200) return "Payment and delivery terms can be at most 200 characters.";
  if (terms.terms.length > 5000) return "The terms can be at most 5000 characters.";
  return null;
}

export const toLines = (lines: QLine[]): QuotationInput["lines"] => lines.map((l) => ({
  ...(l.product ? { product: l.product } : { description: l.description.trim() }),
  quantity: l.quantity.trim(),
  ...(l.unit_price.trim() ? { unit_price: l.unit_price.trim() } : {}),
  ...(l.discount_percent.trim() ? { discount_percent: l.discount_percent.trim() } : {}),
}));

let nextKey = 1;
export function QuotationDialog({ existing, onClose, onSaved }: { existing?: Quotation; onClose: () => void; onSaved?: (q: Quotation) => void }) {
  const creating = !existing;
  const accounts = useListCrmAccountsQuery({});
  const currencies = useListCurrenciesQuery({ cursor: null, active: true });
  const [create, c] = useCreateQuotationMutation();
  const [update, u] = useUpdateQuotationMutation();
  const [account, setAccount] = useState("");
  const [currency, setCurrency] = useState("");
  const [validUntil, setValidUntil] = useState(existing?.valid_until ?? "");
  const [terms, setTerms] = useState({ payment_terms: existing?.payment_terms ?? "", delivery_terms: existing?.delivery_terms ?? "", terms: existing?.terms ?? "" });
  const [lines, setLines] = useState<QLine[]>((existing?.lines ?? []).map((l) => ({ key: nextKey++, product: l.product, description: l.description, quantity: String(Number(l.quantity)), unit_price: String(Number(l.unit_price)), discount_percent: Number(l.discount_percent) ? String(Number(l.discount_percent)) : "", fixed: true })));
  const [err, setErr] = useState<string | null>(null);
  const setLine = (key: number, patch: Partial<QLine>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const save = async () => {
    const p = quotationProblem(account, currency, lines, terms, creating);
    if (p) { setErr(p); return; }
    setErr(null);
    const common = { lines: toLines(lines), valid_until: validUntil || null, ...terms };
    try {
      const q = existing ? await update({ id: existing.id, body: { ...common, expected_version: existing.version } }).unwrap() : await create({ account, currency, ...common }).unwrap();
      onSaved?.(q);
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={creating ? "New quotation" : `Edit quotation ${existing.number}`} open onClose={onClose}>
      {creating && (
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Customer" htmlFor="qe-acct"><select id="qe-acct" className={inputClass} value={account} onChange={(e) => setAccount(e.target.value)}><option value="">Choose…</option>{(accounts.data?.results ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></FormField>
          <FormField label="Currency" htmlFor="qe-cur"><select id="qe-cur" className={inputClass} value={currency} onChange={(e) => setCurrency(e.target.value)}><option value="">Choose…</option>{(currencies.data?.results ?? []).map((x) => <option key={x.id} value={x.code}>{x.code}</option>)}</select></FormField>
        </div>
      )}
      <FormField label="Valid until" htmlFor="qe-valid"><input id="qe-valid" type="date" className={inputClass} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></FormField>
      <h3 className="mb-2 text-sm font-semibold">Lines</h3>
      {lines.map((l, i) => (
        <fieldset key={l.key} className="mb-3 rounded-md border border-slate-200 p-2">
          <legend className="px-1 text-xs text-slate-500">Line {i + 1}{l.fixed ? `: ${l.description}` : ""}</legend>
          {!l.fixed && (
            <>
              <ProductPicker label={`Product for line ${i + 1}`} onChange={(p) => setLine(l.key, { product: p?.id ?? null, description: p ? p.name : l.description })} />
              {!l.product && <FormField label={`Description for line ${i + 1}`} htmlFor={`qe-d-${l.key}`}><input id={`qe-d-${l.key}`} className={inputClass} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} /></FormField>}
            </>
          )}
          <div className="grid grid-cols-3 gap-2">
            <FormField label={`Quantity ${i + 1}`} htmlFor={`qe-q-${l.key}`}><input id={`qe-q-${l.key}`} inputMode="decimal" className={inputClass} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} /></FormField>
            <FormField label={`Price ${i + 1} (blank = price list)`} htmlFor={`qe-p-${l.key}`}><input id={`qe-p-${l.key}`} inputMode="decimal" className={inputClass} value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} /></FormField>
            <FormField label={`Discount % ${i + 1}`} htmlFor={`qe-x-${l.key}`}><input id={`qe-x-${l.key}`} inputMode="decimal" className={inputClass} value={l.discount_percent} onChange={(e) => setLine(l.key, { discount_percent: e.target.value })} /></FormField>
          </div>
          <Button variant="secondary" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>Remove</Button>
        </fieldset>
      ))}
      <Button variant="secondary" onClick={() => setLines([...lines, { key: nextKey++, product: null, description: "", quantity: "1", unit_price: "", discount_percent: "" }])}>Add line</Button>
      <div className="mt-4">
        <FormField label="Payment terms" htmlFor="qe-pt"><input id="qe-pt" className={inputClass} value={terms.payment_terms} onChange={(e) => setTerms({ ...terms, payment_terms: e.target.value })} /></FormField>
        <FormField label="Delivery terms" htmlFor="qe-dt"><input id="qe-dt" className={inputClass} value={terms.delivery_terms} onChange={(e) => setTerms({ ...terms, delivery_terms: e.target.value })} /></FormField>
        <FormField label="Other terms" htmlFor="qe-tt"><textarea id="qe-tt" rows={3} className={inputClass} value={terms.terms} onChange={(e) => setTerms({ ...terms, terms: e.target.value })} /></FormField>
      </div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={c.isLoading || u.isLoading} onClick={() => void save()}>{creating ? "Create quotation" : "Save changes"}</Button></div>
    </Modal>
  );
}

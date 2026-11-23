import { useState } from "react";

import { useCreateSingleSourceMutation, useListCurrenciesQuery, useListSingleSourceQuery, useListSuppliersQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { SingleSourceInput } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const DEC = /^\d+(\.\d{1,4})?$/;
export interface SsDraft { supplier: string; currency: string; order_date: string; justification: string; lines: { description: string; quantity: string; unit_price: string }[] }

export function singleSourceProblem(d: SsDraft): string | null {
  if (!d.supplier) return "Choose the supplier.";
  if (!d.currency) return "Choose the currency.";
  if (!d.order_date) return "Choose the order date.";
  if (d.justification.trim().length < 20) return "Explain why competition was skipped (at least 20 characters).";
  if (d.lines.length === 0) return "Add at least one line.";
  for (const [i, l] of d.lines.entries()) {
    if (!l.description.trim()) return `Line ${i + 1}: describe the item.`;
    if (!DEC.test(l.quantity.trim()) || Number(l.quantity) <= 0) return `Line ${i + 1}: quantity must be more than 0.`;
    if (!DEC.test(l.unit_price.trim())) return `Line ${i + 1}: enter the unit price.`;
  }
  return null;
}

export const singleSourceInput = (d: SsDraft): SingleSourceInput => ({ ...d, justification: d.justification.trim(), lines: d.lines.map((l) => ({ description: l.description.trim(), quantity: l.quantity.trim(), unit_price: l.unit_price.trim() })) });
const blank = (): SsDraft => ({ supplier: "", currency: "", order_date: new Date().toISOString().slice(0, 10), justification: "", lines: [{ description: "", quantity: "1", unit_price: "" }] });

function NewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sup = useListSuppliersQuery({ status: "QUALIFIED" }, { skip: !open });
  const cur = useListCurrenciesQuery({ active: true }, { skip: !open });
  const [create, st] = useCreateSingleSourceMutation();
  const [d, setD] = useState<SsDraft>(blank);
  const [err, setErr] = useState<string | null>(null);
  const upd = (n: number, k: "description" | "quantity" | "unit_price", v: string) => setD({ ...d, lines: d.lines.map((l, j) => (j === n ? { ...l, [k]: v } : l)) });
  const go = async () => {
    const p = singleSourceProblem(d);
    if (p) return setErr(p);
    try { await create(singleSourceInput(d)).unwrap(); setD(blank()); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New single-source order" open={open} onClose={onClose}>
      <FormField label="Supplier" htmlFor="ss-sup"><select id="ss-sup" className={inputClass} value={d.supplier} onChange={(e) => setD({ ...d, supplier: e.target.value })}><option value="">Choose…</option>{(sup.data?.results ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></FormField>
      <FormField label="Currency" htmlFor="ss-cur"><select id="ss-cur" className={inputClass} value={d.currency} onChange={(e) => setD({ ...d, currency: e.target.value })}><option value="">Choose…</option>{(cur.data?.results ?? []).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></FormField>
      <FormField label="Order date" htmlFor="ss-date"><input id="ss-date" type="date" className={inputClass} value={d.order_date} onChange={(e) => setD({ ...d, order_date: e.target.value })} /></FormField>
      {d.lines.map((l, n) => (
        <div key={n} className="mb-2 flex gap-2">
          <input aria-label={`Item ${n + 1}`} placeholder="Item" className={inputClass} value={l.description} onChange={(e) => upd(n, "description", e.target.value)} />
          <input aria-label={`Quantity ${n + 1}`} className={`${inputClass} w-20`} value={l.quantity} onChange={(e) => upd(n, "quantity", e.target.value)} />
          <input aria-label={`Unit price ${n + 1}`} placeholder="Price" className={`${inputClass} w-28`} value={l.unit_price} onChange={(e) => upd(n, "unit_price", e.target.value)} />
          {d.lines.length > 1 && <Button variant="secondary" onClick={() => setD({ ...d, lines: d.lines.filter((_, j) => j !== n) })}>Remove</Button>}
        </div>
      ))}
      <Button variant="secondary" onClick={() => setD({ ...d, lines: [...d.lines, { description: "", quantity: "1", unit_price: "" }] })}>Add an item</Button>
      <FormField label="Justification" htmlFor="ss-why"><textarea id="ss-why" rows={3} maxLength={500} className={inputClass} value={d.justification} onChange={(e) => setD({ ...d, justification: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Create order</Button></div>
    </Modal>
  );
}

export function SingleSourcePage() {
  const { can } = useAccess();
  const q = useListSingleSourceQuery();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Single-source orders" description="Purchases made without competition. Each one needs a written justification and is flagged for audit." actions={can("procurement.single_source") ? <Button onClick={() => setCreating(true)}>New single-source order</Button> : undefined} />
      <Card>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.length === 0 && <EmptyState title="No single-source orders" hint="Orders placed without competition will be listed here." />}
        {q.data && q.data.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Order</th><th>Supplier</th><th className="text-right">Total</th><th>Justification</th><th>Status</th></tr></thead>
            <tbody>{q.data.map((r) => <tr key={r.po} className="border-t border-slate-100"><td>{r.po}</td><td>{r.supplier}</td><td className="text-right">{r.currency} {formatMoney(r.total)}</td><td>{r.justification}</td><td>{r.status}</td></tr>)}</tbody></table>
        )}
      </Card>
      <NewDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

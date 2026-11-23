import { useState } from "react";

import { useCreateLandedCostMutation, useListLandedCostsQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { LandedCostInput } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export interface LcDraft { ref_type: string; ref_id: string; amount: string; description: string; basis: "VALUE" | "QUANTITY"; date: string }
export function landedCostProblem(d: LcDraft): string | null {
  if (!d.ref_type.trim() || !d.ref_id.trim()) return "Enter the type and number of the receipt the cost belongs to.";
  if (!/^\d+(\.\d{1,4})?$/.test(d.amount.trim()) || Number(d.amount) <= 0) return "The amount must be more than 0.";
  if (!d.description.trim()) return "Describe the cost, for example freight or customs duty.";
  return null;
}
export const landedCostInput = (d: LcDraft): LandedCostInput => ({ ref_type: d.ref_type.trim(), ref_id: d.ref_id.trim(), amount: d.amount.trim(), description: d.description.trim(), basis: d.basis, ...(d.date ? { date: d.date } : {}) });

function NewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, st] = useCreateLandedCostMutation();
  const blank: LcDraft = { ref_type: "GoodsReceipt", ref_id: "", amount: "", description: "", basis: "VALUE", date: "" };
  const [d, setD] = useState<LcDraft>(blank);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { const p = landedCostProblem(d); if (p) return setErr(p); try { await create(landedCostInput(d)).unwrap(); setD(blank); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title="Add a landed cost" open={open} onClose={onClose}>
      <FormField label="Receipt type" htmlFor="lc-type"><input id="lc-type" className={inputClass} value={d.ref_type} onChange={(e) => setD({ ...d, ref_type: e.target.value })} /></FormField>
      <FormField label="Receipt number" htmlFor="lc-ref"><input id="lc-ref" className={inputClass} value={d.ref_id} onChange={(e) => setD({ ...d, ref_id: e.target.value })} /></FormField>
      <FormField label="Amount" htmlFor="lc-amt"><input id="lc-amt" className={inputClass} value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} /></FormField>
      <FormField label="What is it" htmlFor="lc-desc"><input id="lc-desc" className={inputClass} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></FormField>
      <FormField label="Share it across items by" htmlFor="lc-basis"><select id="lc-basis" className={inputClass} value={d.basis} onChange={(e) => setD({ ...d, basis: e.target.value as "VALUE" | "QUANTITY" })}><option value="VALUE">Value</option><option value="QUANTITY">Quantity</option></select></FormField>
      <FormField label="Date (optional)" htmlFor="lc-date"><input id="lc-date" type="date" className={inputClass} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Add cost</Button></div>
    </Modal>
  );
}

export function LandedCostsPage() {
  const { can } = useAccess();
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListLandedCostsQuery({ cursor });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Landed costs" description="Freight, duty and other costs added to received stock. They are shared across the items on the receipt." actions={can("inventory.landed_cost.manage") ? <Button onClick={() => setCreating(true)}>Add landed cost</Button> : undefined} />
      <Card>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No landed costs" hint="Added costs will be listed here." />}
        {q.data?.results.map((c) => (
          <div key={c.id} className="mb-4 border-b border-slate-100 pb-3 text-sm">
            <p className="font-medium">{c.number} · {c.description} · {formatMoney(c.amount)} <span className="font-normal text-slate-500">on {c.ref_type} {c.ref_id}, by {c.basis === "VALUE" ? "value" : "quantity"}</span></p>
            <table className="mt-1 w-full"><thead><tr className="text-left"><th>Item</th><th className="text-right">Share</th><th className="text-right">To stock</th><th className="text-right">To cost of sales</th></tr></thead>
              <tbody>{c.allocations.map((a) => <tr key={a.sku}><td>{a.sku}</td><td className="text-right">{formatMoney(a.share)}</td><td className="text-right">{formatMoney(a.to_inventory)}</td><td className="text-right">{formatMoney(a.to_cogs)}</td></tr>)}</tbody></table>
          </div>
        ))}
        {q.data?.next && <div className="text-right"><Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button></div>}
      </Card>
      <NewDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

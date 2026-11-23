import { useState } from "react";

import { useAdjustmentActionMutation, useCreateAdjustmentRequestMutation, useGetAdjustmentPolicyQuery, useListAdjustmentRequestsQuery, useListWarehousesQuery, useSetAdjustmentPolicyMutation, useUploadAdjustmentEvidenceMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { AdjustmentInput, Product } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export const REASONS: [string, string][] = [["DAMAGE", "Damaged"], ["LOSS", "Lost"], ["THEFT", "Theft"], ["FOUND", "Found"], ["EXPIRY", "Expired"], ["COUNT", "Count correction"], ["OTHER", "Other"]];
export const ADJ_STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" }> = { PENDING: { label: "Waiting for approval", tone: "amber" }, POSTED: { label: "Posted", tone: "green" }, REJECTED: { label: "Rejected", tone: "red" } };
const NUM = /^-?\d+(\.\d{1,4})?$/;

export interface AdjDraft { product: Product | null; location: string; mode: "delta" | "counted"; amount: string; lot: string; unit_cost: string; reason_code: string; reason: string }
export function adjustmentProblem(d: AdjDraft): string | null {
  if (!d.product) return "Choose the product.";
  if (!d.location) return "Choose the location.";
  if (!NUM.test(d.amount.trim())) return d.mode === "delta" ? "Enter the change, such as -3 or 5." : "Enter the counted quantity.";
  if (d.mode === "counted" && d.amount.trim().startsWith("-")) return "A counted quantity cannot be negative.";
  if (d.unit_cost.trim() && !/^\d+(\.\d{1,4})?$/.test(d.unit_cost.trim())) return "The unit cost must be a number.";
  if (!d.reason.trim()) return "A reason is required for every adjustment.";
  return null;
}
export function adjustmentInput(d: AdjDraft): AdjustmentInput {
  return { product: d.product!.id, location: d.location, ...(d.mode === "delta" ? { delta: d.amount.trim() } : { counted_quantity: d.amount.trim() }), ...(d.lot.trim() ? { lot_code: d.lot.trim() } : {}), ...(d.unit_cost.trim() ? { unit_cost: d.unit_cost.trim() } : {}), reason_code: d.reason_code, reason: d.reason.trim() };
}
export const thresholdProblem = (v: string): string | null => (v.trim() && !/^\d+(\.\d{1,4})?$/.test(v.trim()) ? "The limit must be a number such as 500, or empty for no limit." : null);

function NewRequest({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wh = useListWarehousesQuery(undefined, { skip: !open });
  const [create, st] = useCreateAdjustmentRequestMutation();
  const blank: AdjDraft = { product: null, location: "", mode: "delta", amount: "", lot: "", unit_cost: "", reason_code: "COUNT", reason: "" };
  const [d, setD] = useState<AdjDraft>(blank);
  const [err, setErr] = useState<string | null>(null);
  const locs = (wh.data?.results ?? []).flatMap((w) => w.locations.filter((l) => !l.is_blocked).map((l) => [l.id, `${w.code} / ${l.code}`] as [string, string]));
  const go = async () => {
    const p = adjustmentProblem(d);
    if (p) return setErr(p);
    try { await create(adjustmentInput(d)).unwrap(); setD(blank); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Request a stock adjustment" open={open} onClose={onClose}>
      <ProductPicker label="Product" onChange={(p) => setD((x) => ({ ...x, product: p }))} />
      <FormField label="Location" htmlFor="ad-loc"><select id="ad-loc" className={inputClass} value={d.location} onChange={(e) => setD({ ...d, location: e.target.value })}><option value="">Choose…</option>{locs.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
      <FormField label="I know the" htmlFor="ad-mode"><select id="ad-mode" className={inputClass} value={d.mode} onChange={(e) => setD({ ...d, mode: e.target.value as "delta" | "counted" })}><option value="delta">Change (+ or −)</option><option value="counted">Counted quantity</option></select></FormField>
      <FormField label={d.mode === "delta" ? "Change" : "Counted quantity"} htmlFor="ad-amt"><input id="ad-amt" className={inputClass} value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} /></FormField>
      <FormField label="Lot code (if tracked)" htmlFor="ad-lot"><input id="ad-lot" className={inputClass} value={d.lot} onChange={(e) => setD({ ...d, lot: e.target.value })} /></FormField>
      <FormField label="Unit cost (only for stock found)" htmlFor="ad-cost"><input id="ad-cost" className={inputClass} value={d.unit_cost} onChange={(e) => setD({ ...d, unit_cost: e.target.value })} /></FormField>
      <FormField label="Reason type" htmlFor="ad-rc"><select id="ad-rc" className={inputClass} value={d.reason_code} onChange={(e) => setD({ ...d, reason_code: e.target.value })}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
      <FormField label="Explanation" htmlFor="ad-why"><textarea id="ad-why" rows={2} className={inputClass} value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Send request</Button></div>
    </Modal>
  );
}

function Policy() {
  const { can } = useAccess();
  const q = useGetAdjustmentPolicyQuery();
  const [save, st] = useSetAdjustmentPolicyMutation();
  const [v, setV] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const val = v ?? q.data?.threshold ?? "";
  const go = async () => { const p = thresholdProblem(val); if (p) return setErr(p); try { await save({ threshold: val.trim() || null }).unwrap(); setErr(null); setV(null); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Card title="Approval limit">
      <p className="mb-2 text-sm text-slate-600">{q.data?.threshold ? `Adjustments worth up to ${formatMoney(q.data.threshold)} post straight away; larger ones wait for approval.` : "No limit is set, so every adjustment waits for approval."}</p>
      {can("inventory.adjustment.approve") && (
        <div className="flex items-end gap-2">
          <FormField label="Limit (empty for none)" htmlFor="ad-limit"><input id="ad-limit" className={inputClass} value={val} onChange={(e) => setV(e.target.value)} /></FormField>
          <Button loading={st.isLoading} onClick={() => void go()}>Save limit</Button>
        </div>
      )}
      {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
    </Card>
  );
}

export function AdjustmentsPage() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListAdjustmentRequestsQuery({ cursor, status });
  const [act] = useAdjustmentActionMutation();
  const [upload] = useUploadAdjustmentEvidenceMutation();
  const [creating, setCreating] = useState(false);
  const [decide, setDecide] = useState<{ id: string; action: "approve" | "reject" } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const attach = async (id: string, f: File | undefined) => {
    if (!f) return;
    setErr(null);
    const form = new FormData(); form.append("file", f);
    try { await upload({ id, form }).unwrap(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Stock adjustments" description="Every correction needs a reason. Large ones wait for a second person to approve." actions={can("inventory.stock.adjust") ? <Button onClick={() => setCreating(true)}>Request adjustment</Button> : undefined} />
      <Policy />
      <FormField label="Show" htmlFor="ad-status"><select id="ad-status" className={`${inputClass} w-56`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option><option value="PENDING">Waiting for approval</option><option value="POSTED">Posted</option><option value="REJECTED">Rejected</option></select></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <Card>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No adjustments" hint="Adjustment requests will appear here." />}
        {q.data && q.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Item</th><th>Location</th><th className="text-right">Change</th><th className="text-right">Value</th><th>Reason</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.results.map((r) => { const s = ADJ_STATUS[r.status] ?? { label: r.status, tone: "amber" as const }; return (
              <tr key={r.id} className="border-t border-slate-100"><td>{r.number}</td><td>{r.sku}</td><td>{r.location}</td><td className="text-right">{formatMoney(r.delta)}</td><td className="text-right">{formatMoney(r.estimated_value)}</td><td>{REASONS.find(([v]) => v === r.reason_code)?.[1] ?? r.reason_code}: {r.reason}</td><td><Badge tone={s.tone}>{s.label}</Badge></td>
                <td className="flex gap-1">{r.status === "PENDING" && can("inventory.adjustment.approve") && <><Button onClick={() => setDecide({ id: r.id, action: "approve" })}>Approve {r.number}</Button><Button variant="danger" onClick={() => setDecide({ id: r.id, action: "reject" })}>Reject {r.number}</Button></>}
                  {r.status === "PENDING" && can("inventory.stock.adjust") && <label className="cursor-pointer text-indigo-700 underline">Attach evidence<input aria-label={`Evidence for ${r.number}`} type="file" className="sr-only" onChange={(e) => void attach(r.id, e.target.files?.[0])} /></label>}</td></tr>); })}</tbody></table>
        )}
        {q.data?.next && <div className="mt-3 text-right"><Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button></div>}
      </Card>
      <NewRequest open={creating} onClose={() => setCreating(false)} />
      <ActionDialog title={decide?.action === "approve" ? "Approve adjustment" : "Reject adjustment"} open={!!decide} onClose={() => setDecide(null)} cta={decide?.action === "approve" ? "Approve" : "Reject"}
        fields={[{ name: "note", label: decide?.action === "reject" ? "Reason (required)" : "Note" }]}
        submit={async (v) => { if (decide!.action === "reject" && !(v.note ?? "").trim()) throw new Error("Give a reason for rejecting."); await act({ id: decide!.id, action: decide!.action, note: (v.note ?? "").trim() }).unwrap(); }} />
    </>
  );
}

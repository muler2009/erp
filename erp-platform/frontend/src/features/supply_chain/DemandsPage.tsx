import { useState } from "react";

import { useCreateDemandMutation, useDemandActionMutation, useGetConsolidatedDemandQuery, useGetDemandImpactQuery, useGetDemandQuery, useListDemandsQuery, useReviseDemandMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { ActionDialog } from "../hr/ActionDialog";
import { rangeProblem } from "../manufacturing/PlanningPage";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const SOURCE: Record<string, string> = { CUSTOMER_FORECAST: "Customer forecast", PROJECT: "Project", MANUFACTURING: "Manufacturing", DEPARTMENT: "Department", MANUAL: "Entered by hand" };
export const DEMAND_KIND: Record<string, string> = { CONFIRMED: "Confirmed", FORECAST: "Forecast" };
export const DEMAND_STATUS: Record<string, { label: string; tone: "green" | "amber" | "slate" }> = { DRAFT: { label: "Waiting for approval", tone: "amber" }, APPROVED: { label: "Approved", tone: "green" }, CANCELLED: { label: "Cancelled", tone: "slate" } };
const NUM = /^\d+(\.\d{1,4})?$/;
export function demandProblem(p: Product | null, qty: string, date: string, source: string, priority: string): string | null {
  if (!p) return "Choose the product.";
  if (!NUM.test(qty.trim()) || Number(qty) <= 0) return "The quantity must be more than 0.";
  if (!date) return "Choose the date it is needed.";
  if (!SOURCE[source]) return "Choose where the demand comes from.";
  if (!/^[1-5]$/.test(priority.trim())) return "Priority must be a number from 1 to 5.";
  return null;
}
export function reviseDemandProblem(qty: string, date: string, priority: string, reason: string, cur: { quantity: string; required_date: string; priority: number }): string | null {
  if (qty.trim() && (!NUM.test(qty.trim()) || Number(qty) <= 0)) return "The quantity must be more than 0.";
  if (priority.trim() && !/^[1-5]$/.test(priority.trim())) return "Priority must be a number from 1 to 5.";
  const same = (!qty.trim() || Number(qty) === Number(cur.quantity)) && (!date || date === cur.required_date) && (!priority.trim() || Number(priority) === cur.priority);
  if (same) return "Nothing has changed.";
  return !reason.trim() ? "Give a reason for the change." : null;
}

function NewDemand({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, st] = useCreateDemandMutation();
  const blank = { qty: "", date: "", source: "MANUAL", ref: "", customer: "", kind: "CONFIRMED", priority: "3" };
  const [f, setF] = useState(blank);
  const [product, setProduct] = useState<Product | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    const p = demandProblem(product, f.qty, f.date, f.source, f.priority); if (p) return setErr(p);
    try { await create({ product: product!.id, quantity: f.qty.trim(), required_date: f.date, source: f.source, kind: f.kind, priority: Number(f.priority), ...(f.ref.trim() ? { source_ref: f.ref.trim() } : {}), ...(f.customer.trim() ? { customer: f.customer.trim() } : {}) }).unwrap(); setF(blank); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Add demand" open={open} onClose={onClose}>
      <ProductPicker label="Product" onChange={setProduct} />
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Quantity" htmlFor="dm-qty"><input id="dm-qty" className={inputClass} value={f.qty} onChange={set("qty")} /></FormField>
        <FormField label="Needed by" htmlFor="dm-date"><input id="dm-date" type="date" className={inputClass} value={f.date} onChange={set("date")} /></FormField>
        <FormField label="Comes from" htmlFor="dm-src"><select id="dm-src" className={inputClass} value={f.source} onChange={set("source")}>{Object.entries(SOURCE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
        <FormField label="Kind" htmlFor="dm-kind"><select id="dm-kind" className={inputClass} value={f.kind} onChange={set("kind")}>{Object.entries(DEMAND_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
        <FormField label="Reference" htmlFor="dm-ref"><input id="dm-ref" className={inputClass} value={f.ref} onChange={set("ref")} /></FormField>
        <FormField label="Priority (1 urgent – 5 low)" htmlFor="dm-prio"><input id="dm-prio" className={inputClass} value={f.priority} onChange={set("priority")} /></FormField>
      </div>
      <FormField label="Customer" htmlFor="dm-cust"><input id="dm-cust" className={inputClass} value={f.customer} onChange={set("customer")} /></FormField>
      <p className="mb-2 text-xs text-slate-600">Sales orders count automatically — do not enter them here.</p>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Add demand</Button></div>
    </Modal>
  );
}

function Impact({ id }: { id: string }) {
  const q = useGetDemandImpactQuery(id);
  if (q.isFetching) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (!q.data || q.data.length === 0) return <p className="text-sm text-slate-600">This demand does not change what planning suggests.</p>;
  return (
    <table className="w-full text-sm"><thead><tr className="text-left"><th>Item</th><th>Action</th><th className="text-right">Without</th><th className="text-right">With</th><th className="text-right">Change</th></tr></thead>
      <tbody>{q.data.map((r, i) => <tr key={i} className="border-t border-slate-100"><td>{r.product}</td><td>{r.action === "BUY" ? "Buy" : "Make"}</td><td className="text-right">{Number(r.quantity_without)}</td><td className="text-right">{Number(r.quantity_with)}</td><td className="text-right">{Number(r.change) > 0 ? "+" : ""}{Number(r.change)}</td></tr>)}</tbody></table>
  );
}

type Dlg = "revise" | "cancel" | null;
function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAccess();
  const q = useGetDemandQuery(id);
  const [revise] = useReviseDemandMutation();
  const [act] = useDemandActionMutation();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [impact, setImpact] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = q.data;
  const manage = can("supply_chain.demand.manage");
  return (
    <Modal title={d ? `Demand for ${d.sku}` : "Demand"} open onClose={onClose}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {d && (
        <>
          <p className="mb-2 text-sm"><Badge tone={DEMAND_STATUS[d.status]?.tone ?? "slate"}>{DEMAND_STATUS[d.status]?.label ?? d.status}</Badge> · {Number(d.quantity)} needed by {d.required_date} · {DEMAND_KIND[d.kind] ?? d.kind} · {SOURCE[d.source] ?? d.source}{d.source_ref ? ` ${d.source_ref}` : ""} · priority {d.priority}{d.customer ? ` · ${d.customer}` : ""}</p>
          {d.cancel_reason && <p className="mb-2 text-sm">Cancelled: {d.cancel_reason}</p>}
          {d.revisions.length > 0 && <><h3 className="text-sm font-semibold">Changes</h3><ul className="mb-2 text-sm">{d.revisions.map((r) => <li key={r.revision}>Revision {r.revision}: was {Number(r.old_quantity)} by {r.old_required_date}, priority {r.old_priority}. {r.reason}</li>)}</ul></>}
          <Button variant="secondary" onClick={() => setImpact(!impact)}>{impact ? "Hide planning impact" : "Show planning impact"}</Button>
          {impact && <div className="my-2"><Impact id={id} /></div>}
          {err && <p role="alert" className="my-2 text-sm text-red-700">{err}</p>}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {d.status === "DRAFT" && can("supply_chain.plan.approve") && <Button onClick={async () => { setErr(null); try { await act({ id, action: "approve" }).unwrap(); } catch (e) { setErr(errorMessage(e)); } }}>Approve demand</Button>}
            {manage && d.status !== "CANCELLED" && <Button variant="secondary" onClick={() => setDlg("revise")}>Change demand</Button>}
            {manage && d.status !== "CANCELLED" && <Button variant="danger" onClick={() => setDlg("cancel")}>Cancel demand</Button>}
          </div>
          <ActionDialog title="Change demand" open={dlg === "revise"} onClose={() => setDlg(null)} cta="Save change" fields={[{ name: "quantity", label: "New quantity" }, { name: "required_date", label: "New needed-by date", type: "date" }, { name: "priority", label: "New priority" }, { name: "reason", label: "Reason" }]}
            submit={async (v) => {
              const p = reviseDemandProblem(v.quantity ?? "", v.required_date ?? "", v.priority ?? "", v.reason ?? "", d); if (p) throw new Error(p);
              await revise({ id, reason: v.reason!.trim(), ...(v.quantity?.trim() ? { quantity: v.quantity.trim() } : {}), ...(v.required_date ? { required_date: v.required_date } : {}), ...(v.priority?.trim() ? { priority: Number(v.priority) } : {}) }).unwrap();
            }} />
          <ActionDialog title="Cancel demand" open={dlg === "cancel"} onClose={() => setDlg(null)} cta="Cancel demand" fields={[{ name: "reason", label: "Reason" }]}
            submit={async (v) => { if (!(v.reason ?? "").trim()) throw new Error("Give a reason for cancelling."); await act({ id, action: "cancel", body: { reason: v.reason!.trim() } }).unwrap(); }} />
        </>
      )}
    </Modal>
  );
}

function Consolidated() {
  const today = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(later);
  const [applied, setApplied] = useState({ from: today, to: later });
  const [err, setErr] = useState<string | null>(null);
  const q = useGetConsolidatedDemandQuery(applied);
  const run = () => { const p = rangeProblem(from, to); setErr(p); if (!p) setApplied({ from, to }); };
  return (
    <Card title="Approved demand, consolidated">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <FormField label="From" htmlFor="cd-from"><input id="cd-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
        <FormField label="To" htmlFor="cd-to"><input id="cd-to" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
        <Button onClick={run}>Show</Button>
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.isFetching && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {!q.isFetching && q.data && q.data.length === 0 && <EmptyState title="No approved demand" hint="Approved demand in this period is grouped here by product and month." />}
      {!q.isFetching && q.data && q.data.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Product</th><th>Warehouse</th><th>Month</th><th className="text-right">Confirmed</th><th className="text-right">Forecast</th></tr></thead>
          <tbody>{q.data.map((r, i) => <tr key={i} className="border-t border-slate-100"><td>{r.product}</td><td>{r.warehouse}</td><td>{r.month}</td><td className="text-right">{Number(r.confirmed)}</td><td className="text-right">{Number(r.forecast)}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

export function DemandsPage() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListDemandsQuery({ cursor, ...(status ? { status } : {}), ...(kind ? { kind } : {}) });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Demand" description="Demand from projects, departments and forecasts, added to what sales orders already require." actions={can("supply_chain.demand.manage") ? <Button onClick={() => setCreating(true)}>Add demand</Button> : undefined} />
      <Card>
        <div className="mb-3 flex gap-3">
          <FormField label="Status" htmlFor="dmf-status"><select id="dmf-status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{Object.entries(DEMAND_STATUS).map(([v, s]) => <option key={v} value={v}>{s.label}</option>)}</select></FormField>
          <FormField label="Kind" htmlFor="dmf-kind"><select id="dmf-kind" className={inputClass} value={kind} onChange={(e) => { setKind(e.target.value); setCursor(null); }}><option value="">All</option>{Object.entries(DEMAND_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
        </div>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No demand entries" hint="Add demand that sales orders do not already cover." />}
        {q.data && q.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Product</th><th className="text-right">Quantity</th><th>Needed by</th><th>Comes from</th><th>Kind</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.results.map((r) => { const s = DEMAND_STATUS[r.status] ?? { label: r.status, tone: "slate" as const }; return <tr key={r.id} className="border-t border-slate-100"><td>{r.sku}</td><td className="text-right">{Number(r.quantity)}</td><td>{r.required_date}</td><td>{SOURCE[r.source] ?? r.source}</td><td>{DEMAND_KIND[r.kind] ?? r.kind}</td><td><Badge tone={s.tone}>{s.label}</Badge></td><td><Button variant="secondary" onClick={() => setOpen(r.id)}>Open {r.sku} {r.required_date}</Button></td></tr>; })}</tbody></table>
        )}
        <div className="mt-3 flex justify-end gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button>}</div>
      </Card>
      <Consolidated />
      <NewDemand open={creating} onClose={() => setCreating(false)} />
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
export default DemandsPage;

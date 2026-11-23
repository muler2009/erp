import { useState } from "react";

import { useCreateProdOrderMutation, useDisposeReceiptMutation, useGetOrderCostQuery, useGetProdOrderQuery, useListProdOrdersQuery, useListWarehousesQuery, useListWorkCentersQuery, useProdOrderActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product, ProdOrderDetail } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export const PO_STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate" }> = {
  DRAFT: { label: "Draft", tone: "slate" }, APPROVED: { label: "Approved", tone: "amber" }, RELEASED: { label: "Released", tone: "amber" }, IN_PROGRESS: { label: "In progress", tone: "amber" }, ON_HOLD: { label: "On hold", tone: "red" },
  COMPLETED: { label: "Completed", tone: "green" }, CLOSED: { label: "Closed", tone: "green" }, CANCELLED: { label: "Cancelled", tone: "slate" },
};
const QTY = /^\d+(\.\d{1,4})?$/;
const pos = (v: string) => QTY.test(v.trim()) && Number(v) > 0;

export function orderProblem(p: Product | null, qty: string, location: string, start: string, end: string): string | null {
  if (!p) return "Choose the product to make.";
  if (!pos(qty)) return "The quantity must be more than 0.";
  if (!location) return "Choose the location where the finished goods will go.";
  if (start && end && end < start) return "The end date is before the start date.";
  return null;
}
export const issueProblem = (product: string, qty: string): string | null => (!product ? "Choose the material." : !pos(qty) ? "The quantity must be more than 0." : null);
export const completeOpProblem = (hours: string, good: string, defective: string, rework: string): string | null => {
  if (!QTY.test(hours.trim())) return "Enter the hours worked, or 0.";
  for (const [l, v] of [["good", good], ["defective", defective], ["rework", rework]] as const) if (v.trim() && !QTY.test(v.trim())) return `The ${l} quantity must be a number.`;
  return null;
};
export const scrapProblem = (kind: string, qty: string, reason: string, product: string): string | null =>
  !pos(qty) ? "The quantity must be more than 0." : !reason.trim() ? "A reason is required." : kind === "MATERIAL" && !product ? "Choose which material was scrapped." : null;
export const priorityProblem = (v: string): string | null => (/^[1-5]$/.test(v.trim()) ? null : "Priority is a number from 1 (urgent) to 5 (low).");
export const byproductProblem = (p: Product | null, qty: string, cost: string): string | null => (!p ? "Choose the product." : !pos(qty) ? "The quantity must be more than 0." : !QTY.test(cost.trim()) ? "The unit cost must be a number, or 0." : null);
export const dispositionProblem = (decision: string, note: string, location: string): string | null =>
  !decision ? "Choose what to do with the goods." : !note.trim() ? "A note is required." : decision === "RELEASE" && !location ? "Choose the storage location to release into." : null;
export const reworkHoursProblem = (wc: string, hours: string): string | null => (!wc ? "Choose the work centre." : !pos(hours) ? "Hours must be more than 0." : null);
export const receiveProblem = (qty: string): string | null => (!pos(qty) ? "The quantity received must be more than 0." : null);

function NewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wh = useListWarehousesQuery(undefined, { skip: !open });
  const [create, st] = useCreateProdOrderMutation();
  const [product, setProduct] = useState<Product | null>(null);
  const [f, setF] = useState({ qty: "1", location: "", start: "", end: "" });
  const [err, setErr] = useState<string | null>(null);
  const locs = (wh.data?.results ?? []).flatMap((w) => w.locations.filter((l) => !l.is_blocked).map((l) => [l.id, `${w.code} / ${l.code}`] as [string, string]));
  const go = async () => {
    const p = orderProblem(product, f.qty, f.location, f.start, f.end);
    if (p) return setErr(p);
    try { await create({ product: product!.id, quantity: f.qty.trim(), location: f.location, ...(f.start ? { planned_start: f.start } : {}), ...(f.end ? { planned_end: f.end } : {}) }).unwrap(); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New production order" open={open} onClose={onClose}>
      <ProductPicker label="Product to make" onChange={setProduct} />
      <FormField label="Quantity" htmlFor="po-qty"><input id="po-qty" className={inputClass} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></FormField>
      <FormField label="Finished goods go to" htmlFor="po-loc"><select id="po-loc" className={inputClass} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })}><option value="">Choose…</option>{locs.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
      <FormField label="Planned start" htmlFor="po-start"><input id="po-start" type="date" className={inputClass} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></FormField>
      <FormField label="Planned end" htmlFor="po-end"><input id="po-end" type="date" className={inputClass} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Create order</Button></div>
    </Modal>
  );
}

function CostCard({ id }: { id: string }) {
  const q = useGetOrderCostQuery(id);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const c = q.data;
  return (
    <Card title="Cost">
      <dl className="grid grid-cols-2 gap-1 text-sm">
        <dt>Materials</dt><dd className="text-right">{formatMoney(c.material_cost)}</dd>
        <dt>Labour, machine and overhead</dt><dd className="text-right">{formatMoney(c.conversion_cost)}</dd>
        <dt>Scrap</dt><dd className="text-right">{formatMoney(c.scrap_cost)}</dd>
        <dt>Actual total</dt><dd className="text-right font-medium">{formatMoney(c.actual_cost)}</dd>
        <dt>Standard cost of output</dt><dd className="text-right">{formatMoney(c.standard_cost_of_output)}</dd>
        <dt>Actual cost per unit</dt><dd className="text-right">{c.actual_unit_cost ? formatMoney(c.actual_unit_cost) : "—"}</dd>
        <dt>Variance</dt><dd className="text-right">{formatMoney(c.variance)}</dd>
      </dl>
    </Card>
  );
}

function ByproductDialog({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (b: Record<string, unknown>) => Promise<unknown> }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [f, setF] = useState({ qty: "", cost: "0", kind: "BYPRODUCT", decision: "REUSE", lot: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = byproductProblem(product, f.qty, f.cost);
    if (p) return setErr(p);
    try { await onSave({ product: product!.id, quantity: f.qty.trim(), unit_cost: f.cost.trim(), kind: f.kind, decision: f.decision, ...(f.lot.trim() ? { lot_code: f.lot.trim() } : {}) }); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Record by-product" open={open} onClose={onClose}>
      <ProductPicker label="By-product" onChange={setProduct} />
      <FormField label="Quantity" htmlFor="bp-qty"><input id="bp-qty" className={inputClass} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></FormField>
      <FormField label="Value per unit" htmlFor="bp-cost"><input id="bp-cost" className={inputClass} value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></FormField>
      <FormField label="What is it" htmlFor="bp-kind"><select id="bp-kind" className={inputClass} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="BYPRODUCT">By-product</option><option value="RECOVERED">Recovered material</option></select></FormField>
      <FormField label="What happens to it" htmlFor="bp-dec"><select id="bp-dec" className={inputClass} value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value })}><option value="REUSE">Reuse</option><option value="RECYCLE">Recycle</option><option value="DISPOSE">Dispose</option></select></FormField>
      <FormField label="Lot code (if tracked)" htmlFor="bp-lot"><input id="bp-lot" className={inputClass} value={f.lot} onChange={(e) => setF({ ...f, lot: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Save by-product</Button></div>
    </Modal>
  );
}

type Dlg = "issue" | "return" | "complete-op" | "check" | "scrap" | "receive" | "hold" | "pause" | "priority" | "reschedule" | "byproduct" | "dispose" | "rework-time" | null;

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAccess();
  const q = useGetProdOrderQuery(id);
  const [act, st] = useProdOrderActionMutation();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dispose] = useDisposeReceiptMutation();
  const wcs = useListWorkCentersQuery();
  const wh = useListWarehousesQuery();
  const o: ProdOrderDetail | undefined = q.data;
  const manage = can("manufacturing.order.manage");
  const call = (path: string, body?: Record<string, unknown>) => act({ id, path, body }).unwrap();
  const run = async (path: string) => { setErr(null); try { await call(path); } catch (e) { setErr(errorMessage(e)); } };
  const mats = (o?.components ?? []).map((c) => [c.product, c.sku] as [string, string]);
  const live = o && ["RELEASED", "IN_PROGRESS"].includes(o.status);
  const close = () => { setDlg(null); setTarget(null); };
  return (
    <Modal title={o ? `Production order ${o.number}` : "Production order"} open onClose={onClose}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {o && (
        <>
          <p className="mb-2 text-sm"><Badge tone={PO_STATUS[o.status]?.tone ?? "slate"}>{PO_STATUS[o.status]?.label ?? o.status}</Badge> · {o.sku} × {Number(o.quantity)} · made {Number(o.produced_quantity)}, scrapped {Number(o.scrapped_quantity)} · {o.planned_start} to {o.planned_end}{o.priority ? ` · priority ${o.priority}` : ""}{o.is_rework ? " · rework order" : ""}</p>
          {manage && !["COMPLETED", "CLOSED", "CANCELLED"].includes(o.status) && <div className="mb-2 flex gap-2"><Button variant="secondary" onClick={() => setDlg("priority")}>Change priority</Button><Button variant="secondary" onClick={() => setDlg("reschedule")}>Reschedule</Button></div>}
          <h3 className="text-sm font-semibold">Materials</h3>
          <table className="mb-2 w-full text-sm"><thead><tr className="text-left"><th>Material</th><th className="text-right">Needed</th><th className="text-right">Issued</th><th className="text-right">Returned</th><th className="text-right">Short</th></tr></thead>
            <tbody>{o.components.map((c) => { const a = o.availability?.find((x) => x.product === c.product); return <tr key={c.id} className="border-t border-slate-100"><td>{c.sku}</td><td className="text-right">{Number(c.required)}</td><td className="text-right">{Number(c.issued)}</td><td className="text-right">{Number(c.returned)}</td><td className="text-right">{a && Number(a.short) > 0 ? <span className="text-red-700">{Number(a.short)}</span> : "—"}</td></tr>; })}</tbody></table>
          {o.operations.length > 0 && <><h3 className="text-sm font-semibold">Operations</h3>
            <table className="mb-2 w-full text-sm"><thead><tr className="text-left"><th>#</th><th>Step</th><th>Work centre</th><th className="text-right">Planned h</th><th className="text-right">Actual h</th><th>Status</th><th /></tr></thead>
              <tbody>{o.operations.map((x) => <tr key={x.id} className="border-t border-slate-100"><td>{x.sequence}</td><td>{x.name}</td><td>{x.work_center}</td><td className="text-right">{Number(x.planned_hours)}</td><td className="text-right">{Number(x.actual_hours)}</td><td>{x.is_paused ? "Paused" : x.status === "DONE" ? (x.approved ? "Done and approved" : "Done") : x.status === "IN_PROGRESS" ? "Running" : x.status === "PENDING" ? "Waiting" : x.status}</td>
                <td className="flex gap-1">{manage && x.status === "PENDING" && live && <Button variant="secondary" onClick={async () => { setErr(null); try { await call(`operations/${x.id}/start`); } catch (e) { setErr(errorMessage(e)); } }}>Start {x.name}</Button>}{manage && x.status === "IN_PROGRESS" && !x.is_paused && <><Button onClick={() => { setTarget(x.id); setDlg("complete-op"); }}>Finish {x.name}</Button><Button variant="secondary" onClick={() => { setTarget(x.id); setDlg("pause"); }}>Pause {x.name}</Button></>}{manage && x.is_paused && <Button variant="secondary" onClick={async () => { setErr(null); try { await call(`operations/${x.id}/resume`); } catch (e) { setErr(errorMessage(e)); } }}>Resume {x.name}</Button>}{x.status === "DONE" && !x.approved && can("manufacturing.operation.approve") && <Button variant="secondary" onClick={async () => { setErr(null); try { await call(`operations/${x.id}/approve`); } catch (e) { setErr(errorMessage(e)); } }}>Approve {x.name}</Button>}</td></tr>)}</tbody></table></>}
          {o.checks.length > 0 && <><h3 className="text-sm font-semibold">Quality checks</h3>
            <ul className="mb-2 text-sm">{o.checks.map((c) => <li key={c.id}>{c.name}: {c.result === "PENDING" || !c.result ? "not recorded" : c.result === "PASS" ? "Passed" : c.result === "FAIL" ? "Failed" : c.result === "CONDITIONAL" ? "Passed with conditions" : c.result} {can("manufacturing.quality.check") && <Button variant="secondary" onClick={() => { setTarget(c.id); setDlg("check"); }}>Record {c.name}</Button>}</li>)}</ul></>}
          {o.receipts.length > 0 && <ul className="mb-2 text-sm">{o.receipts.map((r, i) => <li key={r.id ?? i}>Received {Number(r.quantity)}{r.lot_code ? ` (lot ${r.lot_code})` : ""}{r.status === "ON_HOLD" ? " — on quality hold" : r.status === "RELEASED" ? " — released" : r.status === "SCRAPPED" ? " — scrapped" : r.status === "REWORK" ? " — sent to rework" : ""} {r.status === "ON_HOLD" && r.id && can("manufacturing.disposition.approve") && <Button variant="secondary" onClick={() => { setTarget(r.id!); setDlg("dispose"); }}>Decide on {Number(r.quantity)}{r.lot_code ? ` lot ${r.lot_code}` : ""}</Button>}</li>)}</ul>}
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {o.status === "DRAFT" && can("manufacturing.order.approve") && <Button loading={st.isLoading} onClick={() => void run("approve")}>Approve</Button>}
            {["DRAFT", "APPROVED"].includes(o.status) && manage && <Button onClick={() => void run("release")}>Release</Button>}
            {live && manage && <><Button variant="secondary" onClick={() => void run("issue-all")}>Issue all materials</Button><Button variant="secondary" onClick={() => setDlg("issue")}>Issue a material</Button><Button variant="secondary" onClick={() => setDlg("return")}>Return a material</Button><Button variant="secondary" onClick={() => setDlg("receive")}>Receive output</Button><Button variant="secondary" onClick={() => setDlg("scrap")}>Report scrap</Button><Button variant="secondary" onClick={() => setDlg("byproduct")}>Record by-product</Button>{o.is_rework && <><Button variant="secondary" onClick={() => setDlg("rework-time")}>Book rework time</Button><Button variant="secondary" onClick={() => void run("rework/finish")}>Finish rework</Button></>}<Button variant="secondary" onClick={() => setDlg("hold")}>Put on hold</Button><Button variant="secondary" onClick={() => void run("complete")}>Complete with what was made</Button></>}
            {o.status === "ON_HOLD" && manage && <Button onClick={() => void run("resume")}>Resume</Button>}
            {o.status === "COMPLETED" && can("manufacturing.order.close") && <Button onClick={() => void run("close")}>Close order</Button>}
            {["DRAFT", "APPROVED", "RELEASED"].includes(o.status) && manage && <Button variant="danger" onClick={() => void run("cancel")}>Cancel order</Button>}
          </div>
          {["IN_PROGRESS", "COMPLETED", "CLOSED"].includes(o.status) && <CostCard id={id} />}
          <ActionDialog title="Issue a material" open={dlg === "issue"} onClose={close} cta="Issue" fields={[{ name: "product", label: "Material", type: "select", options: mats }, { name: "quantity", label: "Quantity" }, { name: "lot_code", label: "Lot code (if tracked)" }]}
            submit={async (v) => { const p = issueProblem(v.product ?? "", v.quantity ?? ""); if (p) throw new Error(p); await call("issue", { product: v.product, quantity: v.quantity!.trim(), ...(v.lot_code?.trim() ? { lot_code: v.lot_code.trim() } : {}) }); }} />
          <ActionDialog title="Return a material" open={dlg === "return"} onClose={close} cta="Return" fields={[{ name: "product", label: "Material", type: "select", options: mats }, { name: "quantity", label: "Quantity" }, { name: "lot_code", label: "Lot code (if tracked)" }]}
            submit={async (v) => { const p = issueProblem(v.product ?? "", v.quantity ?? ""); if (p) throw new Error(p); await call("return", { product: v.product, quantity: v.quantity!.trim(), ...(v.lot_code?.trim() ? { lot_code: v.lot_code.trim() } : {}) }); }} />
          <ActionDialog title="Finish operation" open={dlg === "complete-op"} onClose={close} cta="Finish" fields={[{ name: "hours", label: "Hours worked" }, { name: "good", label: "Good quantity" }, { name: "defective", label: "Defective" }, { name: "rework", label: "To rework" }, { name: "notes", label: "Notes" }]}
            submit={async (v) => { const p = completeOpProblem(v.hours ?? "", v.good ?? "", v.defective ?? "", v.rework ?? ""); if (p) throw new Error(p); await call(`operations/${target}/complete`, { hours: v.hours!.trim(), defective: (v.defective ?? "").trim() || "0", rework: (v.rework ?? "").trim() || "0", ...(v.good?.trim() ? { good: v.good.trim() } : {}), notes: (v.notes ?? "").trim() }); }} />
          <ActionDialog title="Record quality check" open={dlg === "check"} onClose={close} cta="Save result" fields={[{ name: "result", label: "Result", type: "select", options: [["PASS", "Passed"], ["FAIL", "Failed"], ["CONDITIONAL", "Passed with conditions"]] }, { name: "measured", label: "Measured value" }, { name: "note", label: "Note" }]}
            submit={async (v) => { if (!v.result) throw new Error("Choose the result."); await call(`checks/${target}`, { result: v.result, measured: (v.measured ?? "").trim(), note: (v.note ?? "").trim() }); }} />
          <ActionDialog title="Report scrap" open={dlg === "scrap"} onClose={close} cta="Report" fields={[{ name: "kind", label: "What was lost", type: "select", options: [["OUTPUT", "Finished output"], ["MATERIAL", "Material"]] }, { name: "product", label: "Material (if material)", type: "select", options: mats }, { name: "quantity", label: "Quantity" }, { name: "reason", label: "Reason" }]}
            submit={async (v) => { const kind = v.kind || "OUTPUT"; const p = scrapProblem(kind, v.quantity ?? "", v.reason ?? "", v.product ?? ""); if (p) throw new Error(p); await call("scrap", { kind, quantity: v.quantity!.trim(), reason: v.reason!.trim(), ...(kind === "MATERIAL" ? { product: v.product } : {}) }); }} />
          <ActionDialog title="Receive output into stock" open={dlg === "receive"} onClose={close} cta="Receive" fields={[{ name: "quantity", label: "Quantity made" }, { name: "lot_code", label: "Lot code (if tracked)" }, { name: "expiry_date", label: "Expiry date", type: "date" }]}
            submit={async (v) => { const p = receiveProblem(v.quantity ?? ""); if (p) throw new Error(p); await call("receive", { quantity: v.quantity!.trim(), ...(v.lot_code?.trim() ? { lot_code: v.lot_code.trim() } : {}), ...(v.expiry_date ? { expiry_date: v.expiry_date } : {}) }); }} />
          <ActionDialog title="Pause operation" open={dlg === "pause"} onClose={close} cta="Pause" fields={[{ name: "reason", label: "Reason" }]}
            submit={async (v) => { if (!(v.reason ?? "").trim()) throw new Error("Give a reason for the pause."); await call(`operations/${target}/pause`, { reason: v.reason!.trim() }); }} />
          <ActionDialog title="Change priority" open={dlg === "priority"} onClose={close} cta="Save" fields={[{ name: "priority", label: "Priority (1 urgent – 5 low)" }]} initial={{ priority: String(o.priority ?? 3) }}
            submit={async (v) => { const p = priorityProblem(v.priority ?? ""); if (p) throw new Error(p); await call("priority", { priority: Number(v.priority) }); }} />
          <ActionDialog title="Reschedule order" open={dlg === "reschedule"} onClose={close} cta="Reschedule" fields={[{ name: "start", label: "New start date", type: "date" }]}
            submit={async (v) => { if (!v.start) throw new Error("Choose the new start date."); await call("reschedule", { start: v.start }); }} />
          <ByproductDialog open={dlg === "byproduct"} onClose={close} onSave={(b) => call("byproducts", b)} />
          <ActionDialog title="Decide on goods on hold" open={dlg === "dispose"} onClose={close} cta="Save decision"
            fields={[{ name: "decision", label: "Decision", type: "select", options: [["RELEASE", "Release to stock"], ["SCRAP", "Scrap"], ["REWORK", "Send to rework"]] }, { name: "release_location", label: "Release into (if releasing)", type: "select", options: (wh.data?.results ?? []).flatMap((w) => w.locations.filter((l) => !l.is_blocked).map((l) => [l.id, `${w.code} / ${l.code}`] as [string, string])) }, { name: "note", label: "Note" }]}
            submit={async (v) => { const p = dispositionProblem(v.decision ?? "", v.note ?? "", v.release_location ?? ""); if (p) throw new Error(p); await dispose({ id: target!, decision: v.decision!, note: v.note!.trim(), ...(v.decision === "RELEASE" ? { release_location: v.release_location } : {}) }).unwrap(); }} />
          <ActionDialog title="Book rework time" open={dlg === "rework-time"} onClose={close} cta="Book" fields={[{ name: "work_center", label: "Work centre", type: "select", options: (wcs.data?.results ?? []).filter((w) => w.is_active).map((w) => [w.id, `${w.code} — ${w.name}`] as [string, string]) }, { name: "hours", label: "Hours" }]}
            submit={async (v) => { const p = reworkHoursProblem(v.work_center ?? "", v.hours ?? ""); if (p) throw new Error(p); await call("rework/time", { work_center: v.work_center, hours: v.hours!.trim() }); }} />
          <ActionDialog title="Put on hold" open={dlg === "hold"} onClose={close} cta="Hold" fields={[{ name: "reason", label: "Reason" }]}
            submit={async (v) => { if (!(v.reason ?? "").trim()) throw new Error("Give a reason for the hold."); await call("hold", { reason: v.reason!.trim() }); }} />
        </>
      )}
    </Modal>
  );
}

export function ProductionOrdersPage() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListProdOrdersQuery({ cursor, status });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Production orders" description="Make a product: issue materials, run each operation, check quality, and receive the finished goods." actions={can("manufacturing.order.manage") ? <Button onClick={() => setCreating(true)}>New production order</Button> : undefined} />
      <FormField label="Show" htmlFor="po-status"><select id="po-status" className={`${inputClass} w-48`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{Object.entries(PO_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FormField>
      <Card>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No production orders" hint="Create an order to start making a product." />}
        {q.data && q.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Product</th><th className="text-right">Quantity</th><th className="text-right">Made</th><th>Planned</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.results.map((r) => { const s = PO_STATUS[r.status] ?? { label: r.status, tone: "slate" as const }; return <tr key={r.id} className="border-t border-slate-100"><td>{r.number}</td><td>{r.sku}</td><td className="text-right">{Number(r.quantity)}</td><td className="text-right">{Number(r.produced_quantity)}</td><td>{r.planned_start} to {r.planned_end}</td><td><Badge tone={s.tone}>{s.label}</Badge></td><td><Button variant="secondary" onClick={() => setOpen(r.id)}>Open {r.number}</Button></td></tr>; })}</tbody></table>
        )}
        {q.data?.next && <div className="mt-3 text-right"><Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button></div>}
      </Card>
      <NewDialog open={creating} onClose={() => setCreating(false)} />
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

import { useState } from "react";

import { useBreakdownActionMutation, useCreateWorkOrderMutation, useListBreakdownsQuery, useListEmployeesQuery, useListFixedAssetsQuery, useListProductsQuery, useListSuppliersQuery, useListWarehousesQuery, useListWorkOrdersQuery, useReportBreakdownMutation, useWorkOrderActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Breakdown, WorkOrder } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { MaintenancePlans, MaintenanceReports } from "./MaintenanceReports";

export const WO_KINDS = ["CORRECTIVE", "PREVENTIVE", "INSPECTION", "REPAIR"];
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const DEC = /^\d+(\.\d{1,4})?$/;
const woTone = (s: string) => (s === "VERIFIED" || s === "COMPLETED" ? "green" : s === "CANCELLED" ? "red" : s === "IN_PROGRESS" ? "slate" : "amber") as "green" | "red" | "slate" | "amber";

export function validateWorkOrder(f: { asset: string; kind: string; description: string; estimated_cost: string }): string | null {
  if (!f.asset) return "Choose the asset.";
  if (!WO_KINDS.includes(f.kind)) return "Choose the kind of work.";
  if (!f.description.trim()) return "Describe the work.";
  if (f.estimated_cost.trim() && !DEC.test(f.estimated_cost.trim())) return "Enter the estimated cost as a number.";
  return null;
}
export function validateLabor(hours: string, rate: string): string | null {
  if (!DEC.test(hours.trim()) || Number(hours) <= 0) return "Hours must be a positive number.";
  if (!DEC.test(rate.trim())) return "The hourly rate must be zero or more.";
  return null;
}
export function validateMaterial(f: { product: string; location: string; quantity: string }): string | null {
  if (!f.product) return "Choose the spare part.";
  if (!f.location) return "Choose the stock location to take it from.";
  if (!DEC.test(f.quantity.trim()) || Number(f.quantity) <= 0) return "Quantity must be a positive number.";
  return null;
}
export function validateBreakdown(f: { asset: string; symptoms: string; severity: string }): string | null {
  if (!f.asset) return "Choose the asset.";
  if (!f.symptoms.trim()) return "Describe the symptoms.";
  if (!SEVERITIES.includes(f.severity)) return "Choose the severity.";
  return null;
}

function NewWorkOrder({ open, onClose }: { open: boolean; onClose: () => void }) {
  const assets = useListFixedAssetsQuery({}, { skip: !open });
  const [create] = useCreateWorkOrderMutation();
  const [f, setF] = useState({ asset: "", kind: "CORRECTIVE", priority: "MEDIUM", description: "", due_on: "", estimated_cost: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateWorkOrder(f);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await create({ asset: f.asset, kind: f.kind, priority: f.priority, description: f.description.trim(), ...(f.due_on ? { due_on: f.due_on } : {}), ...(f.estimated_cost.trim() ? { estimated_cost: f.estimated_cost.trim() } : {}) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New work order" open={open} onClose={onClose}>
      <FormField label="Asset" htmlFor="wo-asset"><select id="wo-asset" className={inputClass} value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}><option value="">Choose…</option>{assets.data?.results.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Kind" htmlFor="wo-kind"><select id="wo-kind" className={inputClass} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{WO_KINDS.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}</select></FormField>
        <FormField label="Priority" htmlFor="wo-prio"><select id="wo-prio" className={inputClass} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{PRIORITIES.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}</select></FormField>
      </div>
      <FormField label="Description" htmlFor="wo-desc"><textarea id="wo-desc" className={inputClass} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Due on" htmlFor="wo-due"><input id="wo-due" type="date" className={inputClass} value={f.due_on} onChange={(e) => setF({ ...f, due_on: e.target.value })} /></FormField>
        <FormField label="Estimated cost" htmlFor="wo-est"><input id="wo-est" className={inputClass} value={f.estimated_cost} onChange={(e) => setF({ ...f, estimated_cost: e.target.value })} /></FormField>
      </div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Create work order</Button></div>
    </Modal>
  );
}

function MaterialDialog({ wo, onClose }: { wo: WorkOrder | null; onClose: () => void }) {
  const products = useListProductsQuery(undefined, { skip: !wo });
  const warehouses = useListWarehousesQuery(undefined, { skip: !wo });
  const [act] = useWorkOrderActionMutation();
  const [f, setF] = useState({ product: "", location: "", quantity: "", lot_code: "" });
  const [err, setErr] = useState<string | null>(null);
  const locations = (warehouses.data?.results ?? []).flatMap((w) => w.locations.map((l) => [l.id, `${w.code} / ${l.code}`] as [string, string]));
  const go = async () => {
    const p = validateMaterial(f);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await act({ id: wo!.id, action: "material", body: { product_id: f.product, location_id: f.location, quantity: f.quantity.trim(), ...(f.lot_code.trim() ? { lot_code: f.lot_code.trim() } : {}) } }).unwrap(); setF({ product: "", location: "", quantity: "", lot_code: "" }); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Use a spare part" open={!!wo} onClose={onClose}>
      <FormField label="Spare part" htmlFor="mt-prod"><select id="mt-prod" className={inputClass} value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })}><option value="">Choose…</option>{products.data?.results.map((p) => <option key={p.id} value={p.id}>{p.sku} {p.name}</option>)}</select></FormField>
      <FormField label="Take from" htmlFor="mt-loc"><select id="mt-loc" className={inputClass} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })}><option value="">Choose…</option>{locations.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Quantity" htmlFor="mt-qty"><input id="mt-qty" className={inputClass} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></FormField>
        <FormField label="Lot code" htmlFor="mt-lot"><input id="mt-lot" className={inputClass} value={f.lot_code} onChange={(e) => setF({ ...f, lot_code: e.target.value })} /></FormField>
      </div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Issue from stock</Button></div>
    </Modal>
  );
}

type Act = { wo: WorkOrder; action: "reject" | "assign" | "labor" | "external-cost" | "complete" | "verify" | "cancel" | "material" };

function WorkOrderDialogs({ dlg, onClose }: { dlg: Act | null; onClose: () => void }) {
  const [act] = useWorkOrderActionMutation();
  const employees = useListEmployeesQuery({ status: "ACTIVE" }, { skip: dlg?.action !== "assign" });
  const suppliers = useListSuppliersQuery(undefined, { skip: dlg?.action !== "assign" });
  const wo = dlg?.wo;
  const a = dlg?.action;
  const send = (action: Parameters<typeof act>[0]["action"], body: Record<string, unknown>) => act({ id: wo!.id, action, body }).unwrap();
  const techs = (employees.data?.results ?? []).filter((e) => e.user_id).map((e) => [e.user_id as string, `${e.employee_no} ${e.name}`] as [string, string]);
  const provs = (suppliers.data?.results ?? []).map((s) => [s.id, s.name] as [string, string]);
  return (
    <>
      <ActionDialog key={`rej${wo?.id}`} title="Reject repair" open={a === "reject"} onClose={onClose} cta="Reject" fields={[{ name: "note", label: "Reason", required: true }]} submit={(v) => send("reject", { note: (v.note ?? "").trim() })} />
      <ActionDialog key={`asg${wo?.id}`} title="Assign work order" open={a === "assign"} onClose={onClose} cta="Assign" fields={[{ name: "assigned_to_id", label: "Technician", options: techs }, { name: "provider_supplier_id", label: "Service provider", options: provs }, { name: "scheduled_on", label: "Scheduled on", type: "date" }]}
        submit={(v) => { if (!v.assigned_to_id && !v.provider_supplier_id) throw new Error("Assign a technician or a service provider."); return send("assign", { ...(v.assigned_to_id ? { assigned_to_id: v.assigned_to_id } : {}), ...(v.provider_supplier_id ? { provider_supplier_id: v.provider_supplier_id } : {}), ...(v.scheduled_on ? { scheduled_on: v.scheduled_on } : {}) }); }} />
      <ActionDialog key={`lab${wo?.id}`} title="Record labour" open={a === "labor"} onClose={onClose} cta="Record" fields={[{ name: "hours", label: "Hours", required: true }, { name: "rate", label: "Hourly rate", required: true }]}
        submit={(v) => { const p = validateLabor(v.hours ?? "", v.rate ?? ""); if (p) throw new Error(p); return send("labor", { hours: (v.hours ?? "").trim(), rate: (v.rate ?? "").trim() }); }} />
      <ActionDialog key={`ext${wo?.id}`} title="Record external cost" open={a === "external-cost"} onClose={onClose} cta="Record" fields={[{ name: "amount", label: "Amount", required: true }, { name: "description", label: "What for" }]}
        submit={(v) => { if (!DEC.test((v.amount ?? "").trim()) || Number(v.amount) <= 0) throw new Error("The amount must be a positive number."); return send("external-cost", { amount: (v.amount ?? "").trim(), description: (v.description ?? "").trim() }); }} />
      <ActionDialog key={`cmp${wo?.id}`} title="Complete work order" open={a === "complete"} onClose={onClose} cta="Complete" fields={[{ name: "notes", label: "What was done", required: true }, { name: "completed_on", label: "Completed on", type: "date" }]}
        submit={(v) => send("complete", { notes: (v.notes ?? "").trim(), ...(v.completed_on ? { completed_on: v.completed_on } : {}) })} />
      <ActionDialog key={`ver${wo?.id}`} title="Verify repair" open={a === "verify"} onClose={onClose} cta="Record verification" fields={[{ name: "result", label: "Result", required: true, options: [["pass", "Passed — return to service"], ["fail", "Failed — send back"]] }, { name: "notes", label: "Verification notes", required: true }]}
        submit={(v) => send("verify", { passed: v.result === "pass", notes: (v.notes ?? "").trim() })} />
      <ActionDialog key={`can${wo?.id}`} title="Cancel work order" open={a === "cancel"} onClose={onClose} cta="Cancel work order" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => send("cancel", { reason: (v.reason ?? "").trim() })} />
    </>
  );
}

function WorkOrders() {
  const { can } = useAccess();
  const manage = can("assets.maintenance.manage");
  const approve = can("assets.maintenance.approve");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListWorkOrdersQuery({ status: status || undefined, cursor });
  const [act] = useWorkOrderActionMutation();
  const [creating, setCreating] = useState(false);
  const [dlg, setDlg] = useState<Act | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const quick = async (id: string, action: "approve" | "start") => { setErr(null); try { await act({ id, action }).unwrap(); } catch (e) { setErr(failure(e)); } };
  const open = (wo: WorkOrder, action: Act["action"]) => setDlg({ wo, action });
  return (
    <Card title="Work orders">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <label className="text-sm">Status <select aria-label="Work order status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{["AWAITING_APPROVAL", "OPEN", "IN_PROGRESS", "COMPLETED", "VERIFIED", "CANCELLED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        {manage && <Button onClick={() => setCreating(true)}>New work order</Button>}
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No work orders" /> : (
        <ul>{data.results.map((w) => (
          <li key={w.id} className="border-b border-slate-200 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono">{w.number}</span><span className="font-medium">{w.asset.number}</span><Badge tone={woTone(w.status)}>{pretty(w.status)}</Badge><Badge tone="slate">{pretty(w.kind)}</Badge><span className="text-slate-500">{pretty(w.priority)} priority{w.due_on ? ` · due ${w.due_on}` : ""}</span></div>
            <p className="mt-1">{w.description}</p>
            <p className="text-slate-600">Estimated {formatMoney(w.estimated_cost)} · labour {formatMoney(w.labor_cost)} ({w.labor_hours} h) · parts {formatMoney(w.material_cost)} · external {formatMoney(w.external_cost)} · <strong>total {formatMoney(w.total_cost)}</strong></p>
            {w.materials.length > 0 && <p className="text-slate-500">Parts: {w.materials.map((x) => `${x.description} × ${x.quantity}`).join(", ")}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {w.status === "AWAITING_APPROVAL" && approve && <><Button onClick={() => void quick(w.id, "approve")}>{`Approve ${w.number}`}</Button><Button variant="secondary" onClick={() => open(w, "reject")}>{`Reject ${w.number}`}</Button></>}
              {manage && w.status === "OPEN" && <><Button variant="secondary" onClick={() => open(w, "assign")}>{`Assign ${w.number}`}</Button><Button onClick={() => void quick(w.id, "start")}>{`Start ${w.number}`}</Button></>}
              {manage && w.status === "IN_PROGRESS" && <><Button variant="secondary" onClick={() => open(w, "labor")}>{`Add labour ${w.number}`}</Button><Button variant="secondary" onClick={() => open(w, "material")}>{`Add part ${w.number}`}</Button><Button variant="secondary" onClick={() => open(w, "external-cost")}>{`Add external cost ${w.number}`}</Button><Button onClick={() => open(w, "complete")}>{`Complete ${w.number}`}</Button></>}
              {manage && w.status === "COMPLETED" && <Button onClick={() => open(w, "verify")}>{`Verify ${w.number}`}</Button>}
              {manage && ["AWAITING_APPROVAL", "OPEN", "IN_PROGRESS"].includes(w.status) && <Button variant="secondary" onClick={() => open(w, "cancel")}>{`Cancel ${w.number}`}</Button>}
            </div>
          </li>))}</ul>
      )}
      {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      <NewWorkOrder open={creating} onClose={() => setCreating(false)} />
      <WorkOrderDialogs dlg={dlg && dlg.action !== "material" ? dlg : null} onClose={() => setDlg(null)} />
      <MaterialDialog wo={dlg?.action === "material" ? dlg.wo : null} onClose={() => setDlg(null)} />
    </Card>
  );
}

function Breakdowns() {
  const { can } = useAccess();
  const report = can("assets.breakdown.report");
  const manage = can("assets.maintenance.manage");
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useListBreakdownsQuery({ status: status || undefined });
  const assets = useListFixedAssetsQuery({}, { skip: !report });
  const [raise] = useReportBreakdownMutation();
  const [act] = useBreakdownActionMutation();
  const [form, setForm] = useState(false);
  const [f, setF] = useState({ asset: "", symptoms: "", severity: "MEDIUM" });
  const [ferr, setFerr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<{ b: Breakdown; action: "diagnose" | "repair" } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const b = dlg?.b;
  const submit = async () => {
    const p = validateBreakdown(f);
    if (p) { setFerr(p); return; }
    setFerr(null);
    try { await raise({ asset: f.asset, symptoms: f.symptoms.trim(), severity: f.severity }).unwrap(); setF({ asset: "", symptoms: "", severity: "MEDIUM" }); setForm(false); } catch (e) { setFerr(errorMessage(e)); }
  };
  return (
    <Card title="Breakdowns">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <label className="text-sm">Status <select aria-label="Breakdown status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["REPORTED", "DIAGNOSED", "IN_REPAIR", "RESTORED", "CLOSED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        {report && <Button onClick={() => setForm(true)}>Report a breakdown</Button>}
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No breakdowns" /> : (
        <ul>{data.results.map((x) => (
          <li key={x.id} className="border-b border-slate-200 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono">{x.number}</span><span className="font-medium">{x.asset.number}</span><Badge tone={x.status === "CLOSED" || x.status === "RESTORED" ? "green" : "amber"}>{pretty(x.status)}</Badge><Badge tone={x.severity === "CRITICAL" || x.severity === "HIGH" ? "red" : "slate"}>{pretty(x.severity)}</Badge><span className="text-slate-500">{new Date(x.reported_at).toLocaleString()}</span></div>
            <p className="mt-1">{x.symptoms}</p>
            {x.cause && <p className="text-slate-600">Cause: {x.cause}{x.failure_code ? ` (${x.failure_code})` : ""}</p>}
            {x.downtime_hours && <p className="text-slate-600">Downtime {x.downtime_hours} h</p>}
            {manage && <div className="mt-2 flex flex-wrap gap-2">
              {x.status === "REPORTED" && <Button variant="secondary" onClick={() => setDlg({ b: x, action: "diagnose" })}>{`Diagnose ${x.number}`}</Button>}
              {["REPORTED", "DIAGNOSED"].includes(x.status) && <Button onClick={() => setDlg({ b: x, action: "repair" })}>{`Open repair ${x.number}`}</Button>}
              {x.status === "RESTORED" && <Button variant="secondary" onClick={async () => { setErr(null); try { await act({ id: x.id, action: "close" }).unwrap(); } catch (e) { setErr(failure(e)); } }}>{`Close ${x.number}`}</Button>}
            </div>}
          </li>))}</ul>
      )}
      <Modal title="Report a breakdown" open={form} onClose={() => setForm(false)}>
        <FormField label="Asset" htmlFor="bd-asset"><select id="bd-asset" className={inputClass} value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}><option value="">Choose…</option>{assets.data?.results.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></FormField>
        <FormField label="Severity" htmlFor="bd-sev"><select id="bd-sev" className={inputClass} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{SEVERITIES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></FormField>
        <FormField label="Symptoms" htmlFor="bd-sym"><textarea id="bd-sym" className={inputClass} value={f.symptoms} onChange={(e) => setF({ ...f, symptoms: e.target.value })} /></FormField>
        {ferr && <p role="alert" className="mb-3 text-sm text-red-700">{ferr}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setForm(false)}>Cancel</Button><Button onClick={() => void submit()}>Report</Button></div>
      </Modal>
      <ActionDialog key={`dg${b?.id}`} title="Diagnose breakdown" open={dlg?.action === "diagnose"} onClose={() => setDlg(null)} cta="Record diagnosis" fields={[{ name: "cause", label: "Cause", required: true }, { name: "failure_code", label: "Failure code" }]} submit={(v) => act({ id: b!.id, action: "diagnose", body: { cause: (v.cause ?? "").trim(), failure_code: (v.failure_code ?? "").trim() } }).unwrap()} />
      <ActionDialog key={`rp${b?.id}`} title="Open repair" open={dlg?.action === "repair"} onClose={() => setDlg(null)} cta="Open repair" fields={[{ name: "description", label: "Repair work", required: true }, { name: "estimated_cost", label: "Estimated cost" }]}
        submit={(v) => { const c = (v.estimated_cost ?? "").trim(); if (c && !DEC.test(c)) throw new Error("Enter the estimated cost as a number."); return act({ id: b!.id, action: "repair", body: { description: (v.description ?? "").trim(), ...(c ? { estimated_cost: c } : {}) } }).unwrap(); }} />
    </Card>
  );
}

const TABS = [["orders", "Work orders"], ["breakdowns", "Breakdowns"], ["plans", "Plans and meters"], ["reports", "Reports"]] as const;

export function MaintenancePage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("orders");
  return (
    <>
      <PageHeader title="Maintenance" description="Work orders, breakdowns, preventive plans and maintenance reports." />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2 border-b border-slate-200">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-slate-900 font-semibold" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "orders" && <WorkOrders />}
      {tab === "breakdowns" && <Breakdowns />}
      {tab === "plans" && <MaintenancePlans />}
      {tab === "reports" && <MaintenanceReports />}
    </>
  );
}

import { useState } from "react";

import { useCreateShipmentMutation, useGetShipmentQuery, useListCarriersQuery, useListRoutesQuery, useListScVehiclesQuery, useListShipmentsQuery, useShipmentActionMutation, useShipmentGroupingMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { ShipmentDetail, ShipmentInput } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { formatMoney } from "../../shared/lib/money";
import { ActionDialog } from "../hr/ActionDialog";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const SHIP_STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate" }> = { PLANNED: { label: "Planned", tone: "slate" }, DISPATCHED: { label: "Dispatched", tone: "amber" }, IN_TRANSIT: { label: "In transit", tone: "amber" }, DELIVERED: { label: "Delivered", tone: "green" }, CANCELLED: { label: "Cancelled", tone: "red" } };
export const KIND: Record<string, string> = { OUTBOUND: "Outbound", INBOUND: "Inbound", TRANSFER: "Transfer" };
export const COST_TYPE: Record<string, string> = { FREIGHT: "Freight", FUEL: "Fuel", HANDLING: "Handling", CUSTOMS: "Customs", INSURANCE: "Insurance", OTHER: "Other" };
export const EXC_KIND: Record<string, string> = { DELAY: "Delay", DAMAGE: "Damage", LOSS: "Loss", WRONG_ITEM: "Wrong item", REFUSED: "Refused", SHORTAGE: "Shortage", OTHER: "Other" };
export const SEVERITY: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" };
const NUM = /^\d+(\.\d{1,4})?$/;

export interface ShipDraft { kind: string; origin: string; destination: string; dispatch: string; arrival: string; carrier: string; route: string; weight: string; tracking: string; lines: { description: string; quantity: string }[] }
export function shipmentProblem(d: ShipDraft, routeKnown: boolean): string | null {
  if (!d.origin.trim() || !d.destination.trim()) return "Say where it is going from and to.";
  if (!d.dispatch) return "Choose the dispatch date.";
  if (!d.arrival && !routeKnown) return "Choose the arrival date, or pick a route that has a transit time.";
  if (d.arrival && d.arrival < d.dispatch) return "The arrival date is before the dispatch date.";
  if (d.weight.trim() && !NUM.test(d.weight.trim())) return "Weight must be a number.";
  if (d.lines.length === 0) return "Add at least one item to ship.";
  for (const [i, l] of d.lines.entries()) {
    if (!l.description.trim()) return `Item ${i + 1}: describe what is shipped.`;
    if (!NUM.test(l.quantity.trim()) || Number(l.quantity) <= 0) return `Item ${i + 1}: quantity must be more than 0.`;
  }
  return null;
}
export const shipmentInput = (d: ShipDraft): ShipmentInput => ({
  kind: d.kind, origin: d.origin.trim(), destination: d.destination.trim(), planned_dispatch: d.dispatch,
  ...(d.arrival ? { planned_arrival: d.arrival } : {}), ...(d.carrier ? { carrier: d.carrier } : {}), ...(d.route ? { route: d.route } : {}),
  ...(d.weight.trim() ? { weight_kg: d.weight.trim() } : {}), ...(d.tracking.trim() ? { tracking_ref: d.tracking.trim() } : {}),
  lines: d.lines.map((l) => ({ description: l.description.trim(), quantity: l.quantity.trim() })),
});
export const costProblem = (type: string, amount: string): string | null => (!COST_TYPE[type] ? "Choose the kind of cost." : !NUM.test(amount.trim()) || Number(amount) <= 0 ? "The amount must be more than 0." : null);
export const exceptionProblem = (kind: string, description: string): string | null => (!EXC_KIND[kind] ? "Choose what went wrong." : !description.trim() ? "Describe the problem." : null);
export interface ReceiptDraft { id: string; shipped: number; received: string; damaged: string; note: string }
export function receiptProblem(rows: ReceiptDraft[]): string | null {
  for (const r of rows) {
    if (!NUM.test(r.received.trim()) || !NUM.test(r.damaged.trim())) return "Received and damaged quantities must be numbers, or 0.";
    if (Number(r.received) > r.shipped) return "Received cannot be more than was shipped.";
    if (Number(r.damaged) > Number(r.received)) return "Damaged cannot be more than received.";
  }
  return null;
}

function NewShipment({ open, onClose }: { open: boolean; onClose: () => void }) {
  const carriers = useListCarriersQuery(undefined, { skip: !open });
  const routes = useListRoutesQuery(undefined, { skip: !open });
  const [create, st] = useCreateShipmentMutation();
  const blank: ShipDraft = { kind: "OUTBOUND", origin: "", destination: "", dispatch: "", arrival: "", carrier: "", route: "", weight: "", tracking: "", lines: [{ description: "", quantity: "1" }] };
  const [d, setD] = useState<ShipDraft>(blank);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof ShipDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const route = (routes.data?.results ?? []).find((r) => r.id === d.route);
  const pickRoute = (id: string) => { const r = (routes.data?.results ?? []).find((x) => x.id === id); setD({ ...d, route: id, ...(r ? { origin: d.origin || r.origin, destination: d.destination || r.destination, carrier: d.carrier || (r.carrier ?? "") } : {}) }); };
  const go = async () => {
    const p = shipmentProblem(d, !!route);
    if (p) return setErr(p);
    try { await create(shipmentInput(d)).unwrap(); setD(blank); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New shipment" open={open} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Kind" htmlFor="sh-kind"><select id="sh-kind" className={inputClass} value={d.kind} onChange={set("kind")}>{Object.entries(KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
        <FormField label="Route (optional)" htmlFor="sh-route"><select id="sh-route" className={inputClass} value={d.route} onChange={(e) => pickRoute(e.target.value)}><option value="">No route</option>{(routes.data?.results ?? []).filter((r) => r.is_active).map((r) => <option key={r.id} value={r.id}>{r.code} — {r.origin} to {r.destination}</option>)}</select></FormField>
        <FormField label="From" htmlFor="sh-from"><input id="sh-from" className={inputClass} value={d.origin} onChange={set("origin")} /></FormField>
        <FormField label="To" htmlFor="sh-to"><input id="sh-to" className={inputClass} value={d.destination} onChange={set("destination")} /></FormField>
        <FormField label="Dispatch date" htmlFor="sh-disp"><input id="sh-disp" type="date" className={inputClass} value={d.dispatch} onChange={set("dispatch")} /></FormField>
        <FormField label="Arrival date" htmlFor="sh-arr"><input id="sh-arr" type="date" className={inputClass} value={d.arrival} onChange={set("arrival")} /></FormField>
        <FormField label="Carrier (optional)" htmlFor="sh-car"><select id="sh-car" className={inputClass} value={d.carrier} onChange={set("carrier")}><option value="">No carrier</option>{(carriers.data?.results ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></FormField>
        <FormField label="Weight in kg" htmlFor="sh-w"><input id="sh-w" className={inputClass} value={d.weight} onChange={set("weight")} /></FormField>
      </div>
      <FormField label="Tracking reference" htmlFor="sh-trk"><input id="sh-trk" className={inputClass} value={d.tracking} onChange={set("tracking")} /></FormField>
      <h3 className="text-sm font-semibold">What is shipped</h3>
      {d.lines.map((l, i) => (
        <div key={i} className="mb-1 flex items-center gap-2 text-sm">
          <input aria-label={`Item ${i + 1} description`} placeholder="Description" className={`${inputClass} flex-1`} value={l.description} onChange={(e) => setD({ ...d, lines: d.lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} />
          <input aria-label={`Item ${i + 1} quantity`} className={`${inputClass} w-24`} value={l.quantity} onChange={(e) => setD({ ...d, lines: d.lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} />
          <Button variant="secondary" onClick={() => setD({ ...d, lines: d.lines.filter((_, j) => j !== i) })}>Remove item {i + 1}</Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => setD({ ...d, lines: [...d.lines, { description: "", quantity: "1" }] })}>Add an item</Button>
      {err && <p role="alert" className="my-2 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Create shipment</Button></div>
    </Modal>
  );
}

type Dlg = "vehicle" | "consolidate" | "dispatch" | "track" | "deliver" | "cancel" | "cost" | "exception" | null;

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAccess();
  const q = useGetShipmentQuery(id);
  const [act] = useShipmentActionMutation();
  const [group] = useShipmentGroupingMutation();
  const vehicles = useListScVehiclesQuery(undefined, { skip: !can("supply_chain.logistics.manage") });
  const [dlg, setDlg] = useState<Dlg>(null);
  const planned = useListShipmentsQuery({ status: "PLANNED" }, { skip: dlg !== "consolidate" });
  const [rows, setRows] = useState<ReceiptDraft[] | null>(null);
  const [groupErr, setGroupErr] = useState<string | null>(null);
  const s: ShipmentDetail | undefined = q.data;
  const manage = can("supply_chain.logistics.manage");
  const call = (action: string, body?: Record<string, unknown>) => act({ id, action, body }).unwrap();
  const close = () => { setDlg(null); setRows(null); };
  const live = s && ["DISPATCHED", "IN_TRANSIT"].includes(s.status);
  const openDeliver = () => { setRows((s?.lines ?? []).map((l) => ({ id: l.id, shipped: Number(l.quantity), received: String(Number(l.quantity)), damaged: "0", note: "" }))); setDlg("deliver"); };
  return (
    <Modal title={s ? `Shipment ${s.number}` : "Shipment"} open onClose={onClose}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {s && (
        <>
          <p className="mb-2 text-sm"><Badge tone={SHIP_STATUS[s.status]?.tone ?? "slate"}>{SHIP_STATUS[s.status]?.label ?? s.status}</Badge> · {KIND[s.kind] ?? s.kind} · {s.origin} to {s.destination} · due {s.planned_arrival}{s.tracking_ref ? ` · tracking ${s.tracking_ref}` : ""}</p>
          {s.pod_received_by && <p className="mb-2 text-sm">Received by {s.pod_received_by}{s.pod_at ? ` on ${s.pod_at.slice(0, 10)}` : ""}.</p>}
          <h3 className="text-sm font-semibold">Items</h3>
          <table className="mb-2 w-full text-sm"><thead><tr className="text-left"><th>Item</th><th className="text-right">Shipped</th><th className="text-right">Received</th><th className="text-right">Damaged</th></tr></thead>
            <tbody>{s.lines.map((l) => <tr key={l.id} className="border-t border-slate-100"><td>{l.description}</td><td className="text-right">{Number(l.quantity)}</td><td className="text-right">{l.received === null ? "—" : Number(l.received)}</td><td className="text-right">{Number(l.damaged)}</td></tr>)}</tbody></table>
          <h3 className="text-sm font-semibold">Tracking</h3>
          <ul className="mb-2 text-sm">{s.events.map((e, i) => <li key={i}>{e.at.slice(0, 16).replace("T", " ")} — {SHIP_STATUS[e.status]?.label ?? e.status}{e.location ? ` at ${e.location}` : ""}{e.note ? `: ${e.note}` : ""}</li>)}</ul>
          {s.costs.length > 0 && <><h3 className="text-sm font-semibold">Costs</h3><ul className="mb-2 text-sm">{s.costs.map((c, i) => <li key={i}>{COST_TYPE[c.type] ?? c.type}: {formatMoney(c.amount)}{c.description ? ` — ${c.description}` : ""}</li>)}</ul></>}
          {s.exceptions.length > 0 && <><h3 className="text-sm font-semibold">Problems</h3><ul className="mb-2 text-sm">{s.exceptions.map((x) => <li key={x.id}>{EXC_KIND[x.kind] ?? x.kind} ({SEVERITY[x.severity] ?? x.severity}) — {x.description} {x.status === "RESOLVED" ? `Resolved: ${x.resolution}` : "Open"}</li>)}</ul></>}
          {groupErr && <p role="alert" className="mb-2 text-sm text-red-700">{groupErr}</p>}
          {s.vehicle_ref && <p className="mb-2 text-sm">Vehicle: {(vehicles.data?.results ?? []).find((v) => v.id === s.vehicle_ref)?.code ?? "assigned"}</p>}
          {s.consolidated_into && <p className="mb-2 text-sm">Travels together with another shipment.</p>}
          {manage && s.status !== "CANCELLED" && (
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              {s.status === "PLANNED" && <Button onClick={() => setDlg("dispatch")}>Dispatch</Button>}
              {s.status === "PLANNED" && <Button variant="secondary" onClick={() => setDlg("vehicle")}>Assign vehicle</Button>}
              {s.status === "PLANNED" && !s.consolidated_into && <Button variant="secondary" onClick={() => setDlg("consolidate")}>Add shipment to this load</Button>}
              {s.status === "PLANNED" && s.consolidated_into && <Button variant="secondary" onClick={async () => { try { await group({ id, action: "unconsolidate", body: {} }).unwrap(); } catch (e) { setGroupErr(errorMessage(e)); } }}>Separate from its load</Button>}
              {live && <Button variant="secondary" onClick={() => setDlg("track")}>Add tracking update</Button>}
              {live && <Button onClick={openDeliver}>Confirm delivery</Button>}
              <Button variant="secondary" onClick={() => setDlg("cost")}>Add cost</Button>
              <Button variant="secondary" onClick={() => setDlg("exception")}>Report a problem</Button>
              {["PLANNED", "DISPATCHED", "IN_TRANSIT"].includes(s.status) && <Button variant="danger" onClick={() => setDlg("cancel")}>Cancel shipment</Button>}
            </div>
          )}
          <ActionDialog title="Assign vehicle" open={dlg === "vehicle"} onClose={close} cta="Assign" fields={[{ name: "vehicle", label: "Vehicle", type: "select", options: (vehicles.data?.results ?? []).filter((v) => v.is_active).map((v) => [v.id, `${v.code}${v.plate ? ` (${v.plate})` : ""}`] as [string, string]) }]}
            submit={async (v) => { if (!v.vehicle) throw new Error("Choose a vehicle."); await group({ id, action: "vehicle", body: { vehicle: v.vehicle } }).unwrap(); }} />
          <ActionDialog title="Add shipment to this load" open={dlg === "consolidate"} onClose={close} cta="Combine" fields={[{ name: "other", label: "Shipment to add", type: "select", options: (planned.data?.results ?? []).filter((x) => x.id !== id && !x.consolidated_into).map((x) => [x.id, `${x.number} — ${x.origin} to ${x.destination}`] as [string, string]) }]}
            submit={async (v) => { if (!v.other) throw new Error("Choose the shipment to add."); await group({ id, action: "consolidate", body: { shipments: [v.other] } }).unwrap(); }} />
          <ActionDialog title="Dispatch shipment" open={dlg === "dispatch"} onClose={close} cta="Dispatch" fields={[{ name: "location", label: "Leaving from" }, { name: "note", label: "Note" }]}
            submit={async (v) => { await call("dispatch", { location: v.location ?? "", note: v.note ?? "" }); }} />
          <ActionDialog title="Add tracking update" open={dlg === "track"} onClose={close} cta="Add update" fields={[{ name: "location", label: "Where is it now" }, { name: "note", label: "Note" }]}
            submit={async (v) => { if (!(v.location ?? "").trim()) throw new Error("Say where the shipment is."); await call("track", { location: v.location!.trim(), note: v.note ?? "" }); }} />
          <ActionDialog title="Cancel shipment" open={dlg === "cancel"} onClose={close} cta="Cancel shipment" fields={[{ name: "reason", label: "Reason" }]}
            submit={async (v) => { if (!(v.reason ?? "").trim()) throw new Error("Give a reason for cancelling."); await call("cancel", { reason: v.reason!.trim() }); }} />
          <ActionDialog title="Add cost" open={dlg === "cost"} onClose={close} cta="Add cost" fields={[{ name: "cost_type", label: "Kind of cost", type: "select", options: Object.entries(COST_TYPE) }, { name: "amount", label: "Amount" }, { name: "description", label: "Description" }]}
            submit={async (v) => { const p = costProblem(v.cost_type ?? "", v.amount ?? ""); if (p) throw new Error(p); await call("costs", { cost_type: v.cost_type, amount: v.amount!.trim(), description: v.description ?? "" }); }} />
          <ActionDialog title="Report a problem" open={dlg === "exception"} onClose={close} cta="Report" fields={[{ name: "kind", label: "What went wrong", type: "select", options: Object.entries(EXC_KIND) }, { name: "severity", label: "How serious", type: "select", options: Object.entries(SEVERITY) }, { name: "description", label: "Description" }]}
            submit={async (v) => { const p = exceptionProblem(v.kind ?? "", v.description ?? ""); if (p) throw new Error(p); await call("exceptions", { kind: v.kind, severity: v.severity || "MEDIUM", description: v.description!.trim() }); }} />
          <Modal title="Confirm delivery" open={dlg === "deliver"} onClose={close}>
            <DeliverForm s={s} rows={rows ?? []} setRows={setRows} onSave={(body) => call("deliver", body)} onClose={close} />
          </Modal>
        </>
      )}
    </Modal>
  );
}

function DeliverForm({ s, rows, setRows, onSave, onClose }: { s: ShipmentDetail; rows: ReceiptDraft[]; setRows: (r: ReceiptDraft[]) => void; onSave: (b: Record<string, unknown>) => Promise<unknown>; onClose: () => void }) {
  const [by, setBy] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const up = (i: number, k: "received" | "damaged" | "note", v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const go = async () => {
    const p = receiptProblem(rows); if (p) return setErr(p);
    try { await onSave({ received_by: by.trim(), note: note.trim(), lines: rows.map((r) => ({ line: r.id, received: r.received.trim(), damaged: r.damaged.trim(), note: r.note.trim() })) }); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <FormField label="Received by" htmlFor="dl-by"><input id="dl-by" className={inputClass} value={by} onChange={(e) => setBy(e.target.value)} /></FormField>
      {rows.map((r, i) => {
        const name = s.lines[i]?.description ?? `Item ${i + 1}`;
        return (
          <div key={r.id} className="mb-1 flex items-center gap-2 text-sm">
            <span className="w-32 truncate">{name} (shipped {r.shipped})</span>
            <input aria-label={`Received of ${name}`} className={`${inputClass} w-20`} value={r.received} onChange={(e) => up(i, "received", e.target.value)} />
            <input aria-label={`Damaged of ${name}`} className={`${inputClass} w-20`} value={r.damaged} onChange={(e) => up(i, "damaged", e.target.value)} />
            <input aria-label={`Note for ${name}`} placeholder="Note" className={`${inputClass} flex-1`} value={r.note} onChange={(e) => up(i, "note", e.target.value)} />
          </div>
        );
      })}
      <FormField label="Delivery note" htmlFor="dl-note"><input id="dl-note" className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
      <p className="mb-2 text-xs text-slate-600">A shortfall or damaged goods raise a problem automatically.</p>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Confirm delivery</Button></div>
    </>
  );
}

export function ShipmentsPage() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListShipmentsQuery({ cursor, ...(status ? { status } : {}), ...(kind ? { kind } : {}) });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Shipments" description="Plan, dispatch, track and confirm deliveries." actions={can("supply_chain.logistics.manage") ? <Button onClick={() => setCreating(true)}>New shipment</Button> : undefined} />
      <Card>
        <div className="mb-3 flex gap-3">
          <FormField label="Status" htmlFor="shf-status"><select id="shf-status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{Object.entries(SHIP_STATUS).map(([v, s]) => <option key={v} value={v}>{s.label}</option>)}</select></FormField>
          <FormField label="Kind" htmlFor="shf-kind"><select id="shf-kind" className={inputClass} value={kind} onChange={(e) => { setKind(e.target.value); setCursor(null); }}><option value="">All</option>{Object.entries(KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
        </div>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No shipments" hint="Shipments you plan will appear here." />}
        {q.data && q.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Kind</th><th>From → To</th><th>Due</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.results.map((r) => { const st = SHIP_STATUS[r.status] ?? { label: r.status, tone: "slate" as const }; return <tr key={r.id} className="border-t border-slate-100"><td>{r.number}</td><td>{KIND[r.kind] ?? r.kind}</td><td>{r.origin} → {r.destination}</td><td>{r.planned_arrival}</td><td><Badge tone={st.tone}>{st.label}</Badge></td><td><Button variant="secondary" onClick={() => setOpen(r.id)}>Open {r.number}</Button></td></tr>; })}</tbody></table>
        )}
        <div className="mt-3 flex justify-end gap-2">
          {cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}
          {q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button>}
        </div>
      </Card>
      <NewShipment open={creating} onClose={() => setCreating(false)} />
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
export default ShipmentsPage;

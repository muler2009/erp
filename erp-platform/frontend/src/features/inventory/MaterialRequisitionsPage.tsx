import { useState } from "react";

import { useCreateMatReqMutation, useGetMatReqQuery, useListMatReqsQuery, useListWarehousesQuery, useMatReqActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { MatReqDetail, MatReqInput, Product } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export const MR_STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate" }> = {
  DRAFT: { label: "Draft", tone: "slate" }, SUBMITTED: { label: "Waiting for approval", tone: "amber" }, APPROVED: { label: "Approved", tone: "green" }, REJECTED: { label: "Rejected", tone: "red" },
  PARTIALLY_ISSUED: { label: "Partly issued", tone: "amber" }, ISSUED: { label: "Issued", tone: "green" }, CANCELLED: { label: "Cancelled", tone: "slate" }, CLOSED: { label: "Closed", tone: "slate" },
};
export const DESTINATIONS: [string, string][] = [["DEPARTMENT", "Department"], ["PROJECT", "Project"], ["COST_CENTER", "Cost centre"], ["EQUIPMENT", "Equipment"], ["PRODUCTION", "Production"]];
const QTY = /^\d+(\.\d{1,4})?$/;

export interface MrDraft { warehouse: string; destination_type: string; destination_ref: string; purpose: string; needed_by: string; lines: { product: Product | null; quantity: string }[] }
export function requisitionProblem(d: MrDraft): string | null {
  if (!d.warehouse) return "Choose the warehouse to take the items from.";
  if (d.destination_type !== "DEPARTMENT" && !d.destination_ref.trim()) return "Say which project, cost centre, equipment or production order the items are for.";
  if (d.lines.length === 0) return "Add at least one item.";
  for (const [i, l] of d.lines.entries()) {
    if (!l.product) return `Line ${i + 1}: choose the item.`;
    if (!QTY.test(l.quantity.trim()) || Number(l.quantity) <= 0) return `Line ${i + 1}: quantity must be more than 0.`;
  }
  if (new Set(d.lines.map((l) => l.product!.id)).size !== d.lines.length) return "Each item can appear only once.";
  return null;
}
export const requisitionInput = (d: MrDraft): MatReqInput => ({ warehouse: d.warehouse, destination_type: d.destination_type, destination_ref: d.destination_ref.trim(), purpose: d.purpose.trim(), ...(d.needed_by ? { needed_by: d.needed_by } : {}), lines: d.lines.map((l) => ({ product: l.product!.id, quantity: l.quantity.trim() })) });
export const returnProblem = (qty: string, location: string, reason: string, max: number): string | null =>
  !QTY.test(qty.trim()) || Number(qty) <= 0 ? "Enter the quantity coming back." : Number(qty) > max ? `Only ${max} can still be returned.` : !location ? "Choose the location it goes back to." : !reason.trim() ? "A reason is required." : null;

function NewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wh = useListWarehousesQuery(undefined, { skip: !open });
  const [create, st] = useCreateMatReqMutation();
  const blank: MrDraft = { warehouse: "", destination_type: "DEPARTMENT", destination_ref: "", purpose: "", needed_by: "", lines: [{ product: null, quantity: "1" }] };
  const [d, setD] = useState<MrDraft>(blank);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { const p = requisitionProblem(d); if (p) return setErr(p); try { await create(requisitionInput(d)).unwrap(); setD(blank); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title="New material requisition" open={open} onClose={onClose}>
      <FormField label="Take from warehouse" htmlFor="mr-wh"><select id="mr-wh" className={inputClass} value={d.warehouse} onChange={(e) => setD({ ...d, warehouse: e.target.value })}><option value="">Choose…</option>{(wh.data?.results ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></FormField>
      <FormField label="Needed for" htmlFor="mr-dt"><select id="mr-dt" className={inputClass} value={d.destination_type} onChange={(e) => setD({ ...d, destination_type: e.target.value })}>{DESTINATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
      <FormField label="Reference (project, cost centre, equipment…)" htmlFor="mr-ref"><input id="mr-ref" className={inputClass} value={d.destination_ref} onChange={(e) => setD({ ...d, destination_ref: e.target.value })} /></FormField>
      <FormField label="Purpose" htmlFor="mr-purpose"><input id="mr-purpose" className={inputClass} value={d.purpose} onChange={(e) => setD({ ...d, purpose: e.target.value })} /></FormField>
      <FormField label="Needed by" htmlFor="mr-by"><input id="mr-by" type="date" className={inputClass} value={d.needed_by} onChange={(e) => setD({ ...d, needed_by: e.target.value })} /></FormField>
      {d.lines.map((l, n) => (
        <div key={n} className="mb-1 flex items-end gap-2">
          <div className="flex-1"><ProductPicker label={`Item ${n + 1}`} onChange={(p) => setD((x) => ({ ...x, lines: x.lines.map((y, j) => (j === n ? { ...y, product: p } : y)) }))} /></div>
          <input aria-label={`Quantity ${n + 1}`} className={`${inputClass} mb-4 w-24`} value={l.quantity} onChange={(e) => setD({ ...d, lines: d.lines.map((y, j) => (j === n ? { ...y, quantity: e.target.value } : y)) })} />
          {d.lines.length > 1 && <Button variant="secondary" onClick={() => setD({ ...d, lines: d.lines.filter((_, j) => j !== n) })}>Remove</Button>}
        </div>
      ))}
      <Button variant="secondary" onClick={() => setD({ ...d, lines: [...d.lines, { product: null, quantity: "1" }] })}>Add an item</Button>
      {err && <p role="alert" className="my-2 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Create requisition</Button></div>
    </Modal>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAccess();
  const q = useGetMatReqQuery(id);
  const wh = useListWarehousesQuery();
  const [act, st] = useMatReqActionMutation();
  const [dlg, setDlg] = useState<"reject" | "issue" | "return" | null>(null);
  const [retLine, setRetLine] = useState<{ id: string; sku: string; max: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const d: MatReqDetail | undefined = q.data;
  const locations = (wh.data?.results ?? []).filter((w) => w.code === d?.warehouse).flatMap((w) => w.locations.filter((l) => !l.is_blocked).map((l) => [l.id, l.code] as [string, string]));
  const run = async (action: "submit" | "cancel" | "approve" | "close") => { setErr(null); try { await act({ id, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const stock = can("inventory.stock.issue");
  return (
    <Modal title={d ? `Requisition ${d.number}` : "Requisition"} open onClose={onClose}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {d && (
        <>
          <p className="mb-2 text-sm"><Badge tone={(MR_STATUS[d.status] ?? { tone: "slate" as const }).tone}>{(MR_STATUS[d.status] ?? { label: d.status }).label}</Badge> · from {d.warehouse} · for {DESTINATIONS.find(([v]) => v === d.destination_type)?.[1] ?? d.destination_type}{d.destination_ref ? ` ${d.destination_ref}` : ""}{d.needed_by ? ` · needed by ${d.needed_by}` : ""}</p>
          {d.purpose && <p className="mb-2 text-sm text-slate-600">{d.purpose}</p>}
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Item</th><th className="text-right">Asked</th><th className="text-right">Issued</th><th className="text-right">Returned</th><th className="text-right">In stock</th></tr></thead>
            <tbody>{d.lines.map((l) => <tr key={l.id} className="border-t border-slate-100"><td>{l.sku}</td><td className="text-right">{formatMoney(l.quantity)}</td><td className="text-right">{formatMoney(l.issued)}</td><td className="text-right">{formatMoney(l.returned)}</td><td className="text-right">{d.availability?.find((a) => a.line === l.id)?.available ? formatMoney(d.availability!.find((a) => a.line === l.id)!.available) : "—"}</td></tr>)}</tbody></table>
          {d.vouchers.length > 0 && <Card title="Issue vouchers">{d.vouchers.map((v) => <div key={v.id} className="mb-2 text-sm"><p className="font-medium">{v.number}</p>{v.lines.map((x) => { const left = Number(x.quantity) - Number(x.returned); return <p key={x.id}>{x.sku}: {formatMoney(x.quantity)} issued, {formatMoney(x.returned)} returned {stock && left > 0 && <Button variant="secondary" onClick={() => { setRetLine({ id: x.id, sku: x.sku, max: left }); setDlg("return"); }}>Return {x.sku}</Button>}</p>; })}</div>)}</Card>}
          {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {d.status === "DRAFT" && can("inventory.requisition.create") && <><Button loading={st.isLoading} onClick={() => void run("submit")}>Submit for approval</Button><Button variant="danger" onClick={() => void run("cancel")}>Cancel requisition</Button></>}
            {d.status === "SUBMITTED" && can("inventory.requisition.approve") && <><Button loading={st.isLoading} onClick={() => void run("approve")}>Approve</Button><Button variant="danger" onClick={() => setDlg("reject")}>Reject</Button></>}
            {(d.status === "APPROVED" || d.status === "PARTIALLY_ISSUED") && stock && <><Button onClick={() => setDlg("issue")}>Issue items</Button>{d.status === "PARTIALLY_ISSUED" && <Button variant="secondary" onClick={() => void run("close")}>Close with what was issued</Button>}</>}
          </div>
          <ActionDialog title="Reject requisition" open={dlg === "reject"} onClose={() => setDlg(null)} cta="Reject" fields={[{ name: "note", label: "Reason" }]}
            submit={async (v) => { if (!(v.note ?? "").trim()) throw new Error("Give a reason for rejecting."); await act({ id, action: "reject", body: { note: (v.note ?? "").trim() } }).unwrap(); }} />
          <ActionDialog title="Issue items" open={dlg === "issue"} onClose={() => setDlg(null)} cta="Issue everything available"
            fields={[{ name: "location", label: "Issue from location", type: "select", options: locations }, { name: "received_by", label: "Received by" }, { name: "notes", label: "Notes" }]}
            submit={async (v) => { if (!v.location) throw new Error("Choose the location to issue from."); await act({ id, action: "issue", body: { location: v.location, received_by: (v.received_by ?? "").trim(), notes: (v.notes ?? "").trim() } }).unwrap(); }} />
          <ActionDialog title={`Return ${retLine?.sku ?? ""}`} open={dlg === "return"} onClose={() => { setDlg(null); setRetLine(null); }} cta="Return to stock"
            fields={[{ name: "quantity", label: "Quantity" }, { name: "location", label: "Return to location", type: "select", options: locations }, { name: "reason", label: "Reason" }]}
            submit={async (v) => { const p = returnProblem(v.quantity ?? "", v.location ?? "", v.reason ?? "", retLine?.max ?? 0); if (p) throw new Error(p); await act({ id, action: "return", body: { voucher_line: retLine!.id, quantity: (v.quantity ?? "").trim(), location: v.location, reason: (v.reason ?? "").trim() } }).unwrap(); }} />
        </>
      )}
    </Modal>
  );
}

export function MaterialRequisitionsPage() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListMatReqsQuery({ cursor, status });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Material requisitions" description="Ask the warehouse for items. Approved requests are issued, and unused items can be returned." actions={can("inventory.requisition.create") ? <Button onClick={() => setCreating(true)}>New requisition</Button> : undefined} />
      <FormField label="Show" htmlFor="mr-status"><select id="mr-status" className={`${inputClass} w-56`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{Object.entries(MR_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FormField>
      <Card>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No requisitions" hint="Requests for materials will appear here." />}
        {q.data && q.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Warehouse</th><th>For</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.results.map((r) => { const s = MR_STATUS[r.status] ?? { label: r.status, tone: "slate" as const }; return <tr key={r.id} className="border-t border-slate-100"><td>{r.number}</td><td>{r.warehouse}</td><td>{DESTINATIONS.find(([v]) => v === r.destination_type)?.[1] ?? r.destination_type}</td><td><Badge tone={s.tone}>{s.label}</Badge></td><td><Button variant="secondary" onClick={() => setOpen(r.id)}>Open {r.number}</Button></td></tr>; })}</tbody></table>
        )}
        {q.data?.next && <div className="mt-3 text-right"><Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button></div>}
      </Card>
      <NewDialog open={creating} onClose={() => setCreating(false)} />
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

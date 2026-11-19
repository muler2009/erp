import { useState } from "react";

import { useAcknowledgePoMutation, useClosePurchaseOrderMutation, useDecidePoAmendmentMutation, useListPoAmendmentsQuery, useRequestPoAmendmentMutation, useSetPoScheduleMutation, useSetPoTermsMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { PoAmendmentRow, PurchaseOrder, PurchaseOrderLine } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

const DEC = /^\d+(\.\d{1,4})?$/;
export const AMENDMENT_STATUS: Record<PoAmendmentRow["status"], { label: string; tone: "green" | "red" | "amber" }> = { PENDING: { label: "Waiting for approval", tone: "amber" }, APPROVED: { label: "Approved", tone: "green" }, REJECTED: { label: "Rejected", tone: "red" } };
const OPEN = ["APPROVED", "PARTIALLY_RECEIVED"];

/** Checks an amendment form. Returns the lines that really changed, or a problem. */
export function amendmentLines(lines: PurchaseOrderLine[], edits: Record<string, { quantity: string; unit_price: string }>): { lines: { line: string; quantity: string; unit_price: string }[] } | { problem: string } {
  const out: { line: string; quantity: string; unit_price: string }[] = [];
  for (const l of lines) {
    const e = edits[l.id];
    if (!e) continue;
    const q = e.quantity.trim() || Number(l.quantity).toString(), p = e.unit_price.trim() || Number(l.unit_price).toString();
    if (!DEC.test(q) || !DEC.test(p)) return { problem: `${l.description}: quantity and price must be numbers.` };
    if (Number(q) <= 0) return { problem: `${l.description}: the quantity must be above zero.` };
    if (Number(q) < Number(l.received_quantity)) return { problem: `${l.description}: the quantity cannot go below the ${Number(l.received_quantity)} already received.` };
    if (Number(p) !== Number(l.unit_price) && Number(l.received_quantity) > 0) return { problem: `${l.description}: the price cannot change once goods were received.` };
    if (Number(q) !== Number(l.quantity) || Number(p) !== Number(l.unit_price)) out.push({ line: l.id, quantity: q, unit_price: p });
  }
  return { lines: out };
}

/** First problem with a delivery schedule for a line, or null. */
export function scheduleProblem(ordered: string, rows: { due_date: string; quantity: string }[]): string | null {
  let total = 0;
  for (const r of rows) {
    if (!r.due_date) return "Every delivery needs a date.";
    if (!DEC.test(r.quantity.trim()) || Number(r.quantity) <= 0) return "Every delivery needs a quantity above zero.";
    total += Number(r.quantity);
  }
  return total > Number(ordered) ? `The deliveries add up to ${total}, more than the ${Number(ordered)} ordered.` : null;
}

function AmendDialog({ order, onClose }: { order: PurchaseOrder; onClose: () => void }) {
  const [request, { isLoading }] = useRequestPoAmendmentMutation();
  const [edits, setEdits] = useState<Record<string, { quantity: string; unit_price: string }>>({});
  const [f, setF] = useState({ reason: "", expected_date: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const r = amendmentLines(order.lines ?? [], edits);
    if ("problem" in r) { setErr(r.problem); return; }
    if (!f.reason.trim()) { setErr("Say why the order is being changed."); return; }
    if (r.lines.length === 0 && !f.expected_date) { setErr("Change a quantity, a price or the expected date."); return; }
    setErr(null);
    try { await request({ id: order.id, reason: f.reason.trim(), ...(r.lines.length ? { lines: r.lines } : {}), ...(f.expected_date ? { expected_date: f.expected_date } : {}) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Amend ${order.number}`} open onClose={onClose}>
      <table className="mb-3 w-full text-sm"><caption className="sr-only">Order lines</caption><thead><tr className="text-left text-slate-500"><th>Item</th><th className="text-right">Received</th><th className="text-right">Quantity</th><th className="text-right">Price</th></tr></thead>
        <tbody>{(order.lines ?? []).map((l) => (
          <tr key={l.id} className="border-t border-slate-100"><td className="py-1">{l.description}</td><td className="text-right">{Number(l.received_quantity)}</td>
            <td className="text-right"><input aria-label={`Quantity of ${l.description}`} className={`${inputClass} w-20 text-right`} placeholder={String(Number(l.quantity))} value={edits[l.id]?.quantity ?? ""} onChange={(e) => setEdits({ ...edits, [l.id]: { quantity: e.target.value, unit_price: edits[l.id]?.unit_price ?? "" } })} /></td>
            <td className="text-right"><input aria-label={`Price of ${l.description}`} className={`${inputClass} w-24 text-right`} placeholder={String(Number(l.unit_price))} value={edits[l.id]?.unit_price ?? ""} onChange={(e) => setEdits({ ...edits, [l.id]: { quantity: edits[l.id]?.quantity ?? "", unit_price: e.target.value } })} /></td></tr>
        ))}</tbody></table>
      <FormField label="New expected date (optional)" htmlFor="am-date"><input id="am-date" type="date" className={inputClass} value={f.expected_date} onChange={(e) => setF({ ...f, expected_date: e.target.value })} /></FormField>
      <FormField label="Reason" htmlFor="am-reason"><input id="am-reason" className={inputClass} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Request amendment</Button></div>
    </Modal>
  );
}

function ScheduleDialog({ line, onClose }: { line: PurchaseOrderLine; onClose: () => void }) {
  const [save, { isLoading }] = useSetPoScheduleMutation();
  const [rows, setRows] = useState<{ due_date: string; quantity: string }[]>((line.schedule ?? []).length ? (line.schedule ?? []).map((r) => ({ due_date: r.due_date, quantity: String(Number(r.quantity)) })) : [{ due_date: "", quantity: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = scheduleProblem(line.quantity, rows);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await save({ line: line.id, rows: rows.map((r) => ({ due_date: r.due_date, quantity: r.quantity.trim() })) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Delivery dates for ${line.description}`} open onClose={onClose}>
      <p className="mb-2 text-sm text-slate-600">{Number(line.quantity)} ordered. Split them into dated deliveries.</p>
      {rows.map((r, n) => (
        <div key={n} className="mb-2 flex items-center gap-2">
          <input type="date" aria-label={`Date ${n + 1}`} className={inputClass} value={r.due_date} onChange={(e) => setRows(rows.map((x, j) => (j === n ? { ...x, due_date: e.target.value } : x)))} />
          <input aria-label={`Quantity ${n + 1}`} className={`${inputClass} w-24`} value={r.quantity} onChange={(e) => setRows(rows.map((x, j) => (j === n ? { ...x, quantity: e.target.value } : x)))} />
          {rows.length > 1 && <Button variant="secondary" onClick={() => setRows(rows.filter((_, j) => j !== n))}>Remove</Button>}
        </div>
      ))}
      <Button variant="secondary" onClick={() => setRows([...rows, { due_date: "", quantity: "" }])}>Add a delivery</Button>
      {err && <p role="alert" className="my-3 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Save dates</Button></div>
    </Modal>
  );
}

/** Terms, supplier acknowledgement, delivery dates, amendments and closing for one purchase order. */
export function PoExtras({ order }: { order: PurchaseOrder }) {
  const { can } = useAccess();
  const create = can("procurement.purchase_order.create"), approve = can("procurement.purchase_order.approve");
  const isOpen = OPEN.includes(order.status);
  const showAmendments = isOpen || order.status === "RECEIVED" || order.status === "CLOSED";
  const amendments = useListPoAmendmentsQuery(order.id, { skip: !showAmendments });
  const [setTerms] = useSetPoTermsMutation();
  const [ack] = useAcknowledgePoMutation();
  const [decide] = useDecidePoAmendmentMutation();
  const [close] = useClosePurchaseOrderMutation();
  const [dlg, setDlg] = useState<"terms" | "ack" | "amend" | "close" | null>(null);
  const [sched, setSched] = useState<PurchaseOrderLine | null>(null);
  const [reject, setReject] = useState<PoAmendmentRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pending = (amendments.data ?? []).some((a) => a.status === "PENDING");
  const decideNow = async (id: string) => { setErr(null); try { await decide({ id, decision: "approve" }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <section className="mt-4 space-y-3 border-t border-slate-200 pt-3 text-sm" aria-label="Order details">
      <div>
        <div className="flex items-center justify-between"><h3 className="font-medium">Terms</h3>{order.status === "DRAFT" && create && <Button variant="secondary" onClick={() => setDlg("terms")}>Edit terms</Button>}</div>
        <p className="text-slate-600">Payment: {order.payment_terms || "—"} · Delivery: {order.delivery_terms || "—"} · Deliver to: {order.delivery_address || "—"}</p>
      </div>
      {isOpen && (
        <div>
          <div className="flex items-center justify-between"><h3 className="font-medium">Supplier acknowledgement</h3>{!order.acknowledged_at && create && <Button variant="secondary" onClick={() => setDlg("ack")}>Record acknowledgement</Button>}</div>
          <p className="text-slate-600">{order.acknowledged_at ? `Acknowledged as ${order.acknowledgment_ref}${order.promised_date ? `, promised for ${order.promised_date}` : ""}.` : "The supplier has not confirmed this order yet."}</p>
        </div>
      )}
      {(order.status === "DRAFT" || isOpen) && create && (order.lines ?? []).length > 0 && order.kind !== "BLANKET" && (
        <div><h3 className="font-medium">Delivery dates</h3>
          <ul>{(order.lines ?? []).map((l) => <li key={l.id} className="flex items-center justify-between border-t border-slate-100 py-1"><span>{l.description}: {(l.schedule ?? []).length ? (l.schedule ?? []).map((r) => `${Number(r.quantity)} on ${r.due_date}`).join(", ") : "not scheduled"}</span><Button variant="secondary" onClick={() => setSched(l)}>{`Set dates for ${l.description}`}</Button></li>)}</ul>
        </div>
      )}
      {showAmendments && order.kind !== "BLANKET" && (
        <div>
          <div className="flex items-center justify-between"><h3 className="font-medium">Changes to this order</h3>{isOpen && create && !pending && <Button variant="secondary" onClick={() => setDlg("amend")}>Request a change</Button>}</div>
          {(amendments.data ?? []).length === 0 ? <p className="text-slate-600">No changes requested.</p> : (
            <ul>{(amendments.data ?? []).map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-1"><span>#{a.number}: {a.reason} — {formatMoney(a.old_total)} → {formatMoney(a.new_total)} <Badge tone={AMENDMENT_STATUS[a.status].tone}>{AMENDMENT_STATUS[a.status].label}</Badge></span>
                {a.status === "PENDING" && approve && <span className="space-x-1"><Button variant="secondary" onClick={() => void decideNow(a.id)}>{`Approve change #${a.number}`}</Button><Button variant="danger" onClick={() => setReject(a)}>{`Reject change #${a.number}`}</Button></span>}</li>
            ))}</ul>
          )}
        </div>
      )}
      {(isOpen || order.status === "RECEIVED") && approve && <div className="flex justify-end"><Button variant="danger" onClick={() => setDlg("close")}>Close order</Button></div>}
      {order.status === "CLOSED" && order.closed_reason && <p className="text-slate-600">Closed: {order.closed_reason}</p>}
      {err && <p role="alert" className="text-red-700">{err}</p>}
      {dlg === "terms" && <ActionDialog title="Order terms" cta="Save terms" open onClose={() => setDlg(null)} initial={{ payment_terms: order.payment_terms ?? "", delivery_terms: order.delivery_terms ?? "", delivery_address: order.delivery_address ?? "" }} fields={[{ name: "payment_terms", label: "Payment terms" }, { name: "delivery_terms", label: "Delivery terms" }, { name: "delivery_address", label: "Deliver to" }]} submit={async (v) => { await setTerms({ id: order.id, body: { payment_terms: v.payment_terms ?? "", delivery_terms: v.delivery_terms ?? "", delivery_address: v.delivery_address ?? "" } }).unwrap(); }} />}
      {dlg === "ack" && <ActionDialog title="Supplier acknowledgement" cta="Record" open onClose={() => setDlg(null)} fields={[{ name: "reference", label: "Supplier's reference", required: true }, { name: "promised_date", label: "Date the supplier promised (optional)", type: "date" }, { name: "note", label: "Note (optional)" }]} submit={async (v) => { await ack({ id: order.id, reference: v.reference!.trim(), ...(v.promised_date ? { promised_date: v.promised_date } : {}), ...(v.note ? { note: v.note } : {}) }).unwrap(); }} />}
      {dlg === "close" && <ActionDialog title={`Close ${order.number}`} cta="Close order" open onClose={() => setDlg(null)} fields={[{ name: "reason", label: "Why is it being closed? Anything not yet received is abandoned.", required: true }]} submit={async (v) => { await close({ id: order.id, reason: v.reason! }).unwrap(); }} />}
      {dlg === "amend" && <AmendDialog order={order} onClose={() => setDlg(null)} />}
      {sched && <ScheduleDialog line={sched} onClose={() => setSched(null)} />}
      {reject && <ActionDialog title={`Reject change #${reject.number}`} cta="Reject change" open onClose={() => setReject(null)} fields={[{ name: "note", label: "Reason", required: true }]} submit={async (v) => { await decide({ id: reject.id, decision: "reject", note: v.note }).unwrap(); }} />}
    </section>
  );
}

import { useState } from "react";

import {
  useDecideOrderAmendmentMutation, useGetOrderOutstandingQuery, useInvoiceOrderLinesMutation, useInvoiceOrderMilestoneMutation, useListOrderAmendmentsQuery, useListOrderMilestonesQuery,
  useRequestOrderAmendmentMutation, useSetOrderMilestonesMutation,
} from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { OrderOutstandingRow, SalesOrder } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, EmptyState, FormField, Modal, Spinner, inputClass } from "../../shared/ui/primitives";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames } from "../quality/names";

const num = (v: string): number => (v.trim() === "" ? NaN : Number(v));

/** Quantities to invoice per line: each must be above 0 and no more than what can still be invoiced. */
export function invoiceLinesProblem(rows: OrderOutstandingRow[], values: Record<string, string>): string | null {
  let any = false;
  for (const r of rows) {
    const v = (values[r.line] ?? "").trim();
    if (v === "") continue;
    const n = num(v);
    if (Number.isNaN(n) || n < 0) return `Line ${r.line_no}: enter a number.`;
    if (n === 0) continue;
    if (n > Number(r.to_invoice)) return `Line ${r.line_no}: only ${formatMoney(r.to_invoice)} can still be invoiced.`;
    any = true;
  }
  return any ? null : "Enter a quantity for at least one line.";
}

/** New quantities (blank = unchanged), an optional extra item and a reason. Cannot go below what was delivered or invoiced. */
export function amendmentProblem(rows: OrderOutstandingRow[], values: Record<string, string>, addProduct: string | null, addQty: string, reason: string): string | null {
  let changed = 0;
  for (const r of rows) {
    const v = (values[r.line] ?? "").trim();
    if (v === "" || Number(v) === Number(r.ordered)) continue;
    const n = num(v);
    const floor = Math.max(Number(r.delivered), Number(r.invoiced));
    if (Number.isNaN(n) || n < 0) return `Line ${r.line_no}: enter a number.`;
    if (n < floor || (n === 0 && floor > 0)) return `Line ${r.line_no}: cannot go below what was already delivered or invoiced (${formatMoney(String(floor))}).`;
    changed++;
  }
  if (addProduct) {
    if (!(num(addQty) > 0)) return "The extra item needs a quantity above 0.";
    changed++;
  }
  if (changed === 0) return "Change at least one quantity or add an item.";
  return reason.trim() ? null : "Give a reason for the change.";
}

export function milestonesProblem(rows: { description: string; percent: string }[]): string | null {
  if (rows.length === 0) return "Add at least one step.";
  let total = 0;
  for (const [i, r] of rows.entries()) {
    const p = num(r.percent);
    if (!r.description.trim()) return `Step ${i + 1}: describe it.`;
    if (!(p > 0 && p <= 100)) return `Step ${i + 1}: the percentage must be above 0 and at most 100.`;
    total += Math.round(p * 10000);
  }
  return total === 1000000 ? null : "The percentages must add up to exactly 100.";
}

function InvoiceDialog({ order, rows, onClose }: { order: SalesOrder; rows: OrderOutstandingRow[]; onClose: () => void }) {
  const [invoice, { isLoading }] = useInvoiceOrderLinesMutation();
  const open = rows.filter((r) => Number(r.to_invoice) > 0);
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(open.map((r) => [r.line, r.to_invoice])));
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = invoiceLinesProblem(open, vals);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await invoice({ id: order.id, lines: open.filter((r) => num(vals[r.line] ?? "") > 0).map((r) => ({ order_line: r.line, quantity: (vals[r.line] ?? "").trim() })) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Invoice part of this order" open onClose={onClose}>
      {open.length === 0 && <p className="text-sm text-slate-600">Nothing is left to invoice.</p>}
      {open.map((r) => <FormField key={r.line} label={`Line ${r.line_no}: ${r.description} (up to ${formatMoney(r.to_invoice)})`} htmlFor={`inv-${r.line}`}><input id={`inv-${r.line}`} inputMode="decimal" className={inputClass} value={vals[r.line] ?? ""} onChange={(e) => setVals({ ...vals, [r.line]: e.target.value })} /></FormField>)}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} disabled={open.length === 0} onClick={() => void go()}>Create invoice</Button></div>
    </Modal>
  );
}

function AmendDialog({ order, rows, onClose }: { order: SalesOrder; rows: OrderOutstandingRow[]; onClose: () => void }) {
  const [request, { isLoading }] = useRequestOrderAmendmentMutation();
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(rows.map((r) => [r.line, r.ordered])));
  const [prod, setProd] = useState<string | null>(null);
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = amendmentProblem(rows, vals, prod, qty, reason);
    if (p) { setErr(p); return; }
    setErr(null);
    const quantities = Object.fromEntries(rows.filter((r) => (vals[r.line] ?? "").trim() !== "" && Number(vals[r.line]) !== Number(r.ordered)).map((r) => [r.line, (vals[r.line] ?? "").trim()]));
    try { await request({ id: order.id, quantities, add: prod ? [{ product: prod, quantity: qty.trim() }] : [], reason: reason.trim() }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Request a change to this order" open onClose={onClose}>
      {rows.map((r) => <FormField key={r.line} label={`Line ${r.line_no}: ${r.description} (delivered ${formatMoney(r.delivered)}, invoiced ${formatMoney(r.invoiced)})`} htmlFor={`am-${r.line}`}><input id={`am-${r.line}`} inputMode="decimal" className={inputClass} value={vals[r.line] ?? ""} onChange={(e) => setVals({ ...vals, [r.line]: e.target.value })} /></FormField>)}
      <ProductPicker label="Add another item (optional)" onChange={(p) => setProd(p?.id ?? null)} />
      {prod && <FormField label="Quantity of the extra item" htmlFor="am-addqty"><input id="am-addqty" inputMode="decimal" className={inputClass} value={qty} onChange={(e) => setQty(e.target.value)} /></FormField>}
      <FormField label="Reason" htmlFor="am-reason"><input id="am-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Send for approval</Button></div>
    </Modal>
  );
}

function PlanDialog({ order, current, onClose }: { order: SalesOrder; current: { description: string; percent: string; due_date: string | null }[]; onClose: () => void }) {
  const [set, { isLoading }] = useSetOrderMilestonesMutation();
  const [rows, setRows] = useState(current.length ? current.map((c) => ({ description: c.description, percent: String(Number(c.percent)), due_date: c.due_date ?? "" })) : [{ description: "", percent: "", due_date: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const up = (i: number, k: string, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const go = async () => {
    const p = milestonesProblem(rows);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await set({ id: order.id, milestones: rows.map((r) => ({ description: r.description.trim(), percent: r.percent.trim(), ...(r.due_date ? { due_date: r.due_date } : {}) })) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Billing plan" open onClose={onClose}>
      {rows.map((r, i) => (
        <div key={i} className="mb-2 grid grid-cols-[1fr_5rem_8rem_auto] items-end gap-2">
          <FormField label={`Step ${i + 1}`} htmlFor={`pl-d-${i}`}><input id={`pl-d-${i}`} className={inputClass} value={r.description} onChange={(e) => up(i, "description", e.target.value)} /></FormField>
          <FormField label="Percent" htmlFor={`pl-p-${i}`}><input id={`pl-p-${i}`} inputMode="decimal" className={inputClass} value={r.percent} onChange={(e) => up(i, "percent", e.target.value)} /></FormField>
          <FormField label="Due" htmlFor={`pl-u-${i}`}><input id={`pl-u-${i}`} type="date" className={inputClass} value={r.due_date} onChange={(e) => up(i, "due_date", e.target.value)} /></FormField>
          <Button variant="secondary" className="mb-4" aria-label={`Remove step ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => setRows([...rows, { description: "", percent: "", due_date: "" }])}>Add step</Button>
      {err && <p role="alert" className="my-3 text-sm text-red-700">{err}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Save plan</Button></div>
    </Modal>
  );
}

export function OrderTools({ order }: { order: SalesOrder }) {
  const { can } = useAccess();
  const active = ["CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED"].includes(order.status);
  const [tab, setTab] = useState("outstanding");
  const out = useGetOrderOutstandingQuery(order.id, { skip: !active });
  const amends = useListOrderAmendmentsQuery(order.id, { skip: !active });
  const plan = useListOrderMilestonesQuery(order.id, { skip: !active });
  const [decide] = useDecideOrderAmendmentMutation();
  const [invMs] = useInvoiceOrderMilestoneMutation();
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"invoice" | "amend" | "plan" | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!active) return null;
  const fail = (e: unknown) => setErr(errorMessage(e));
  const tabs: [string, string][] = [["outstanding", "What is left"], ["amendments", "Changes"], ["plan", "Billing plan"]];
  const rows = out.data ?? [];
  const canInvoice = can("sales.invoice.create") && order.status !== "CONFIRMED";
  const billed = (plan.data ?? []).some((m) => m.invoice);
  return (
    <div className="mt-4 border-t border-slate-200 pt-3">
      <div role="tablist" aria-label="Order tools" className="mb-3 flex gap-2">{tabs.map(([k, l]) => <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-2 py-1 text-sm ${tab === k ? "bg-brand-600 text-white" : "bg-white ring-1 ring-slate-300"}`}>{l}</button>)}</div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {note && <p role="status" className="mb-2 text-sm text-green-700">{note}</p>}

      {tab === "outstanding" && (
        <>
          {out.isLoading && <Spinner />}
          <table className="w-full text-sm"><caption className="sr-only">Quantities still to deliver and invoice</caption>
            <thead><tr><th className="text-left">Line</th><th className="text-right">Ordered</th><th className="text-right">To deliver</th><th className="text-right">Backordered</th><th className="text-right">To invoice</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.line} className="border-t border-slate-100"><td>{r.line_no}. {r.description}</td><td className="text-right">{formatMoney(r.ordered)}</td><td className="text-right">{formatMoney(r.to_deliver)}</td><td className="text-right">{formatMoney(r.backordered)}</td><td className="text-right">{formatMoney(r.to_invoice)}</td></tr>)}</tbody></table>
          {canInvoice && !billed && (plan.data?.length ?? 0) === 0 && <div className="mt-3"><Button variant="secondary" onClick={() => setDlg("invoice")}>Invoice part of the order</Button></div>}
        </>
      )}

      {tab === "amendments" && (
        <>
          {can("sales.order.create") && order.status !== "DELIVERED" && <div className="mb-3"><Button variant="secondary" onClick={() => setDlg("amend")}>Request a change</Button></div>}
          {amends.data?.length === 0 && <EmptyState title="No changes requested" />}
          <ul className="divide-y divide-slate-100 text-sm">{amends.data?.map((a) => (
            <li key={a.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2"><Badge tone={a.status === "APPROVED" ? "green" : a.status === "REJECTED" ? "red" : "amber"}>{a.status === "PENDING" ? "Waiting for approval" : a.status === "APPROVED" ? "Approved" : "Rejected"}</Badge><span>{a.reason}</span></div>
              <p className="text-slate-600">{Object.keys(a.changes.quantities).length} quantity change(s), {a.changes.add.length} item(s) added. Total {formatMoney(a.total_before)}{a.total_after ? ` → ${formatMoney(a.total_after)}` : ""}. Asked by {nameOf(a.requested_by)}.</p>
              {a.decision_note && <p className="text-slate-600">Note: {a.decision_note}</p>}
              {a.status === "PENDING" && can("sales.order.approve") && (
                <div className="mt-1 flex gap-2">
                  <Button aria-label="Approve change" onClick={() => { setErr(null); setNote(null); decide({ id: a.id, action: "approve" }).unwrap().then(() => setNote("Change approved.")).catch(fail); }}>Approve</Button>
                  <Button variant="danger" aria-label="Reject change" onClick={() => setRejecting(a.id)}>Reject</Button>
                </div>
              )}
            </li>
          ))}</ul>
        </>
      )}

      {tab === "plan" && (
        <>
          {can("sales.invoice.create") && !billed && <div className="mb-3"><Button variant="secondary" onClick={() => setDlg("plan")}>{plan.data?.length ? "Change billing plan" : "Set billing plan"}</Button></div>}
          {plan.data?.length === 0 && <EmptyState title="No billing plan" hint="Without a plan the order is invoiced by what was delivered." />}
          <ul className="divide-y divide-slate-100 text-sm">{plan.data?.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 py-2"><span>{m.description}</span><span className="text-slate-500">{Number(m.percent)}%{m.due_date ? `, due ${m.due_date}` : ""}</span>
              {m.invoice ? <Badge tone="green">Invoiced</Badge> : can("sales.invoice.create") && <Button variant="secondary" aria-label={`Invoice step ${m.description}`} onClick={() => { setErr(null); setNote(null); invMs({ id: m.id }).unwrap().then(() => setNote("Invoice created.")).catch(fail); }}>Invoice this step</Button>}</li>
          ))}</ul>
        </>
      )}

      {dlg === "invoice" && <InvoiceDialog order={order} rows={rows} onClose={() => setDlg(null)} />}
      {dlg === "amend" && <AmendDialog order={order} rows={rows} onClose={() => setDlg(null)} />}
      {dlg === "plan" && <PlanDialog order={order} current={plan.data ?? []} onClose={() => setDlg(null)} />}
      {rejecting && <ActionDialog title="Reject change" cta="Reject" open onClose={() => setRejecting(null)} fields={[{ name: "note", label: "Why", required: true }]} submit={async (v) => { await decide({ id: rejecting, action: "reject", note: (v.note ?? "").trim() }).unwrap(); }} />}
    </div>
  );
}

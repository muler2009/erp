import { useState } from "react";

import { useCreateSupplierClaimMutation, useCreateSupplierReturnMutation, useGetPurchaseOrderQuery, useListInvoicesQuery, useListPurchaseOrdersQuery, useListSupplierClaimsQuery, useListSupplierReturnsQuery, useListSuppliersQuery, useListWarehousesQuery, useSupplierClaimActionMutation, useSupplierReturnActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { SupplierClaimRow, SupplierReturnRow } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { ReturnsSummary } from "./ProcurementTools";

type Tone = "green" | "red" | "amber" | "slate";
export const RETURN_STATUS: Record<SupplierReturnRow["status"], { label: string; tone: Tone }> = { DRAFT: { label: "Waiting for approval", tone: "amber" }, APPROVED: { label: "Approved — not yet sent", tone: "amber" }, DISPATCHED: { label: "Sent back", tone: "amber" }, CREDITED: { label: "Credited", tone: "green" }, CLOSED: { label: "Closed", tone: "green" }, CANCELLED: { label: "Cancelled", tone: "slate" } };
export const CLAIM_STATUS: Record<SupplierClaimRow["status"], { label: string; tone: Tone }> = { OPEN: { label: "Not sent yet", tone: "slate" }, SUBMITTED: { label: "Waiting for the supplier", tone: "amber" }, ACCEPTED: { label: "Accepted", tone: "amber" }, REJECTED: { label: "Rejected", tone: "red" }, SETTLED: { label: "Settled", tone: "green" } };
export const CLAIM_KIND: Record<string, string> = { DAMAGE: "Damaged goods", SHORTAGE: "Shortage", QUALITY: "Quality problem", LATE: "Late delivery", PRICE: "Price dispute", OTHER: "Other" };
const DEC = /^\d+(\.\d{1,4})?$/;
const RETURNABLE = ["APPROVED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED"];

/** What the next step for a return is, given its state. `creditDue` is the value invoiced for the goods. */
export function returnNext(r: Pick<SupplierReturnRow, "status" | "credit_due">): "approve" | "dispatch" | "credit" | "close" | null {
  if (r.status === "DRAFT") return "approve";
  if (r.status === "APPROVED") return "dispatch";
  if (r.status === "DISPATCHED") return Number(r.credit_due) > 0 ? "credit" : "close";
  return null;
}

export function returnLinesProblem(rows: { po_line: string; max: number; quantity: string }[]): string | null {
  const chosen = rows.filter((r) => r.quantity.trim() && Number(r.quantity) !== 0);
  if (!chosen.length) return "Enter a quantity for at least one item.";
  for (const r of chosen) {
    if (!DEC.test(r.quantity.trim())) return "Quantities must be numbers such as 2 or 2.5.";
    if (Number(r.quantity) > r.max) return `Only ${r.max} of an item can still go back.`;
  }
  return null;
}

function NewReturn({ onClose }: { onClose: () => void }) {
  const orders = useListPurchaseOrdersQuery({});
  const whs = useListWarehousesQuery({});
  const [orderId, setOrderId] = useState("");
  const order = useGetPurchaseOrderQuery(orderId, { skip: !orderId });
  const [create, { isLoading }] = useCreateSupplierReturnMutation();
  const [f, setF] = useState({ location: "", reason: "" });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const lines = (order.data?.lines ?? []).filter((l) => Number(l.received_quantity) > 0);
  const go = async () => {
    const rows = lines.map((l) => ({ po_line: l.id, max: Number(l.received_quantity), quantity: qty[l.id] ?? "" }));
    const p = (!orderId && "Choose the order.") || (!f.location && "Choose where the goods leave from.") || (!f.reason.trim() && "Say why the goods are going back.") || returnLinesProblem(rows);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await create({ order: orderId, location: f.location, reason: f.reason.trim(), lines: rows.filter((r) => r.quantity.trim() && Number(r.quantity) > 0).map((r) => ({ po_line: r.po_line, quantity: r.quantity.trim() })) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Return goods to a supplier" open onClose={onClose}>
      <FormField label="Order" htmlFor="rt-order"><select id="rt-order" className={inputClass} value={orderId} onChange={(e) => { setOrderId(e.target.value); setQty({}); }}><option value="">Choose…</option>{(orders.data?.results ?? []).filter((o) => RETURNABLE.includes(o.status) || o.status === "PARTIALLY_RECEIVED").map((o) => <option key={o.id} value={o.id}>{o.number} — {o.supplier.name}</option>)}</select></FormField>
      <FormField label="Goods leave from" htmlFor="rt-loc"><select id="rt-loc" className={inputClass} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })}><option value="">Choose…</option>{(whs.data?.results ?? []).flatMap((w) => w.locations.map((l) => <option key={l.id} value={l.id}>{w.name} / {l.code}</option>))}</select></FormField>
      <FormField label="Reason" htmlFor="rt-reason"><input id="rt-reason" className={inputClass} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></FormField>
      {orderId && (order.isFetching && !order.data ? <Spinner /> : lines.length === 0 ? <p className="mb-3 text-sm text-slate-600">Nothing has been received on this order.</p> : (
        <table className="mb-3 w-full text-sm"><caption className="sr-only">Items to return</caption><thead><tr className="text-left text-slate-500"><th>Item</th><th className="text-right">Received</th><th className="text-right">Send back</th></tr></thead>
          <tbody>{lines.map((l) => <tr key={l.id} className="border-t border-slate-100"><td className="py-1">{l.description}</td><td className="text-right">{Number(l.received_quantity)}</td><td className="text-right"><input aria-label={`Send back ${l.description}`} className={`${inputClass} w-20 text-right`} value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /></td></tr>)}</tbody></table>
      ))}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Create return</Button></div>
    </Modal>
  );
}

function CreditNoteSelect({ supplier, id, value, onChange }: { supplier: string; id: string; value: string; onChange: (v: string) => void }) {
  const q = useListInvoicesQuery({ kind: "SUPPLIER_CREDIT_NOTE", status: "POSTED" });
  const rows = (q.data?.results ?? []).filter((i) => i.partner.name === supplier);
  return <select id={id} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{rows.map((i) => <option key={i.id} value={i.id}>{i.number} — {formatMoney(i.total)} {i.currency}</option>)}</select>;
}

function Returns() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [dlg, setDlg] = useState<{ r: SupplierReturnRow; kind: "dispatch" | "credit" | "cancel" } | null>(null);
  const q = useListSupplierReturnsQuery(status ? { status } : undefined);
  const [act] = useSupplierReturnActionMutation();
  const [err, setErr] = useState<string | null>(null);
  const run = async (id: string, action: "approve" | "close") => { setErr(null); try { await act({ id, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Card title="Returns to suppliers" actions={can("procurement.return.manage") ? <Button onClick={() => setCreating(true)}>New return</Button> : undefined}>
      <div className="mb-3 max-w-xs"><FormField label="Show" htmlFor="rt-filter"><select id="rt-filter" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All returns</option>{Object.entries(RETURN_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FormField></div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="No returns" /> : (
        <table className="w-full text-sm"><caption className="sr-only">Returns to suppliers</caption>
          <thead><tr className="text-left text-slate-500"><th>Number</th><th>Order</th><th>Supplier</th><th>Reason</th><th className="text-right">Value</th><th className="text-right">Credit due</th><th>Status</th><th /></tr></thead>
          <tbody>{(q.data ?? []).map((r) => {
            const next = returnNext(r);
            return <tr key={r.id} className="border-t border-slate-100"><td className="py-1">{r.number}</td><td>{r.po}</td><td>{r.supplier}</td><td>{r.reason}</td><td className="text-right">{formatMoney(r.return_value)}</td><td className="text-right">{Number(r.credit_due) > 0 ? formatMoney(r.credit_due) : "—"}</td><td><Badge tone={RETURN_STATUS[r.status].tone}>{RETURN_STATUS[r.status].label}</Badge></td>
              <td className="space-x-1 text-right">
                {next === "approve" && can("procurement.return.approve") && <Button variant="secondary" onClick={() => void run(r.id, "approve")}>{`Approve ${r.number}`}</Button>}
                {next === "dispatch" && can("procurement.return.manage") && <Button variant="secondary" onClick={() => setDlg({ r, kind: "dispatch" })}>{`Send back ${r.number}`}</Button>}
                {next === "credit" && can("procurement.return.manage") && <Button variant="secondary" onClick={() => setDlg({ r, kind: "credit" })}>{`Record credit note for ${r.number}`}</Button>}
                {next === "close" && can("procurement.return.manage") && <Button variant="secondary" onClick={() => void run(r.id, "close")}>{`Close ${r.number}`}</Button>}
                {(r.status === "DRAFT" || r.status === "APPROVED") && can("procurement.return.manage") && <Button variant="danger" onClick={() => setDlg({ r, kind: "cancel" })}>{`Cancel ${r.number}`}</Button>}
              </td></tr>;
          })}</tbody>
        </table>
      )}
      {creating && <NewReturn onClose={() => setCreating(false)} />}
      {dlg?.kind === "dispatch" && <ActionDialog title={`Send back ${dlg.r.number}`} cta="Send back" open onClose={() => setDlg(null)} fields={[{ name: "serials", label: "Serial numbers, one per line (serial-tracked goods only)", type: "textarea" }]} submit={async (v) => { const serials = (v.serials ?? "").split("\n").map((x) => x.trim()).filter(Boolean); await act({ id: dlg.r.id, action: "dispatch", body: serials.length ? { serials } : {} }).unwrap(); }} />}
      {dlg?.kind === "cancel" && <ActionDialog title={`Cancel ${dlg.r.number}`} cta="Cancel return" open onClose={() => setDlg(null)} fields={[]} submit={async () => { await act({ id: dlg.r.id, action: "cancel" }).unwrap(); }} />}
      {dlg?.kind === "credit" && <CreditDialog title={`Credit note for ${dlg.r.number}`} supplier={dlg.r.supplier} due={dlg.r.credit_due} onClose={() => setDlg(null)} submit={async (credit_note) => { await act({ id: dlg.r.id, action: "credit", body: { credit_note } }).unwrap(); }} />}
    </Card>
  );
}

function CreditDialog({ title, supplier, due, onClose, submit }: { title: string; supplier: string; due: string; onClose: () => void; submit: (id: string) => Promise<unknown> }) {
  const [id, setId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { if (!id) { setErr("Choose the supplier's credit note."); return; } try { await submit(id); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title={title} open onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">The credit note must be posted, from {supplier}, and cover at least {formatMoney(due)}.</p>
      <FormField label="Credit note" htmlFor="cn-sel"><CreditNoteSelect supplier={supplier} id="cn-sel" value={id} onChange={setId} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Record credit note</Button></div>
    </Modal>
  );
}

function NewClaim({ onClose }: { onClose: () => void }) {
  const suppliers = useListSuppliersQuery({});
  const [create] = useCreateSupplierClaimMutation();
  return (
    <ActionDialog title="New claim against a supplier" cta="Create claim" open onClose={onClose}
      fields={[{ name: "supplier", label: "Supplier", required: true, options: (suppliers.data?.results ?? []).map((s) => [s.id, s.name]) }, { name: "kind", label: "What kind of claim", required: true, options: Object.entries(CLAIM_KIND) }, { name: "amount", label: "Amount claimed", required: true }, { name: "description", label: "What happened", type: "textarea", required: true }]}
      submit={async (v) => { if (!DEC.test((v.amount ?? "").trim()) || Number(v.amount) <= 0) throw new Error("The amount must be above zero, such as 250 or 250.50."); await create({ supplier: v.supplier, kind: v.kind, amount: v.amount!.trim(), description: v.description }).unwrap(); }} />
  );
}

function Claims() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [dlg, setDlg] = useState<{ c: SupplierClaimRow; kind: "accept" | "reject" | "settle" } | null>(null);
  const q = useListSupplierClaimsQuery(status ? { status } : undefined);
  const [act] = useSupplierClaimActionMutation();
  const [err, setErr] = useState<string | null>(null);
  const manage = can("procurement.return.manage"), decide = can("procurement.return.approve");
  const submit = async (id: string) => { setErr(null); try { await act({ id, action: "submit" }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Card title="Claims against suppliers" actions={manage ? <Button onClick={() => setCreating(true)}>New claim</Button> : undefined}>
      <div className="mb-3 max-w-xs"><FormField label="Show" htmlFor="cl-filter"><select id="cl-filter" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All claims</option>{Object.entries(CLAIM_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FormField></div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="No claims" /> : (
        <table className="w-full text-sm"><caption className="sr-only">Claims against suppliers</caption>
          <thead><tr className="text-left text-slate-500"><th>Number</th><th>Supplier</th><th>Kind</th><th className="text-right">Claimed</th><th className="text-right">Accepted</th><th>Status</th><th /></tr></thead>
          <tbody>{(q.data ?? []).map((c) => <tr key={c.id} className="border-t border-slate-100"><td className="py-1">{c.number}</td><td>{c.supplier}</td><td>{CLAIM_KIND[c.kind] ?? c.kind}</td><td className="text-right">{formatMoney(c.amount_claimed)} {c.currency}</td><td className="text-right">{c.amount_accepted === null ? "—" : formatMoney(c.amount_accepted)}</td><td><Badge tone={CLAIM_STATUS[c.status].tone}>{CLAIM_STATUS[c.status].label}</Badge></td>
            <td className="space-x-1 text-right">
              {c.status === "OPEN" && manage && <Button variant="secondary" onClick={() => void submit(c.id)}>{`Send ${c.number}`}</Button>}
              {c.status === "SUBMITTED" && decide && <><Button variant="secondary" onClick={() => setDlg({ c, kind: "accept" })}>{`Supplier accepted ${c.number}`}</Button><Button variant="danger" onClick={() => setDlg({ c, kind: "reject" })}>{`Supplier rejected ${c.number}`}</Button></>}
              {c.status === "ACCEPTED" && manage && <Button variant="secondary" onClick={() => setDlg({ c, kind: "settle" })}>{`Settle ${c.number}`}</Button>}
            </td></tr>)}</tbody>
        </table>
      )}
      {creating && <NewClaim onClose={() => setCreating(false)} />}
      {dlg?.kind === "accept" && <ActionDialog title={`Supplier accepted ${dlg.c.number}`} cta="Record acceptance" open onClose={() => setDlg(null)} initial={{ amount: dlg.c.amount_claimed }} fields={[{ name: "amount", label: "Amount the supplier accepted", required: true }, { name: "note", label: "Note (optional)" }]} submit={async (v) => { const a = (v.amount ?? "").trim(); if (!DEC.test(a) || Number(a) <= 0 || Number(a) > Number(dlg.c.amount_claimed)) throw new Error("The accepted amount must be above zero and not more than the claim."); await act({ id: dlg.c.id, action: "accept", body: { amount: a, note: v.note ?? "" } }).unwrap(); }} />}
      {dlg?.kind === "reject" && <ActionDialog title={`Supplier rejected ${dlg.c.number}`} cta="Record rejection" open onClose={() => setDlg(null)} fields={[{ name: "note", label: "Reason given", required: true }]} submit={async (v) => { await act({ id: dlg.c.id, action: "reject", body: { note: v.note } }).unwrap(); }} />}
      {dlg?.kind === "settle" && <CreditDialog title={`Settle ${dlg.c.number}`} supplier={dlg.c.supplier} due={dlg.c.amount_accepted ?? "0"} onClose={() => setDlg(null)} submit={async (credit_note) => { await act({ id: dlg.c.id, action: "settle", body: { credit_note } }).unwrap(); }} />}
    </Card>
  );
}

export function ReturnsClaimsPage() {
  const [tab, setTab] = useState<"returns" | "claims" | "summary">("returns");
  const tabs: ["returns" | "claims" | "summary", string][] = [["returns", "Returns"], ["claims", "Claims"], ["summary", "Summary"]];
  return (
    <div>
      <PageHeader title="Returns and claims" description="Sending goods back to suppliers and claiming what they owe." />
      <div role="tablist" className="mb-4 flex flex-wrap border-b border-slate-200">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={k === tab} onClick={() => setTab(k)} className={`px-3 py-2 text-sm ${k === tab ? "border-b-2 border-indigo-600 font-medium text-indigo-700" : "text-slate-600 hover:text-slate-900"}`}>{l}</button>)}</div>
      {tab === "returns" ? <Returns /> : tab === "claims" ? <Claims /> : <ReturnsSummary />}
    </div>
  );
}

import { useRef, useState } from "react";

import { useAttachReceiptEvidenceMutation, useInspectReceiptLineMutation, useListGoodsReceiptsQuery, useListPendingInspectionsQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { PendingInspection } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const DEC = /^\d+(\.\d{1,4})?$/;
export const INSPECTION: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate" }> = { NOT_REQUIRED: { label: "No inspection needed", tone: "slate" }, PENDING: { label: "Waiting for inspection", tone: "amber" }, PARTIAL: { label: "Partly inspected", tone: "amber" }, ACCEPTED: { label: "Accepted", tone: "green" }, REJECTED: { label: "Rejected", tone: "red" }, COMPLETE: { label: "Inspected", tone: "green" } };

/** First problem with an inspection entry, or null. `open` is the quantity still awaiting inspection. */
export function inspectionProblem(open: string, accept: string, reject: string, note: string): string | null {
  const a = accept.trim() || "0", r = reject.trim() || "0";
  if (!DEC.test(a) || !DEC.test(r)) return "Quantities must be numbers such as 5 or 2.5.";
  if (Number(a) + Number(r) <= 0) return "Accept or reject at least some of the goods.";
  if (Number(a) + Number(r) > Number(open)) return `Only ${Number(open)} is still waiting for inspection.`;
  if (Number(r) > 0 && !note.trim()) return "Say why the goods are rejected.";
  return null;
}

function InspectDialog({ row, onClose }: { row: PendingInspection; onClose: () => void }) {
  const [inspect, { isLoading }] = useInspectReceiptLineMutation();
  const [f, setF] = useState({ accept: row.open, reject: "", note: "", serials: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = inspectionProblem(row.open, f.accept, f.reject, f.note);
    const serials = f.serials.split("\n").map((x) => x.trim()).filter(Boolean);
    const both = Number(f.accept || "0") > 0 && Number(f.reject || "0") > 0;
    if (p || (serials.length && both)) { setErr(p ?? "Inspect serial-numbered goods in separate accept and reject steps."); return; }
    setErr(null);
    try { await inspect({ line: row.line, accept: f.accept.trim() || "0", reject: f.reject.trim() || "0", note: f.note.trim(), ...(serials.length ? { serials } : {}) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Inspect ${row.product} from ${row.receipt}`} open onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">{Number(row.open)} of {Number(row.quantity)} still waiting, held in {row.quarantine || "quarantine"}.</p>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Accept" htmlFor="in-acc"><input id="in-acc" className={inputClass} value={f.accept} onChange={(e) => setF({ ...f, accept: e.target.value })} /></FormField>
        <FormField label="Reject" htmlFor="in-rej"><input id="in-rej" className={inputClass} value={f.reject} onChange={(e) => setF({ ...f, reject: e.target.value })} /></FormField>
      </div>
      <FormField label="Note (required when rejecting)" htmlFor="in-note"><input id="in-note" className={inputClass} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></FormField>
      <FormField label="Serial numbers, one per line (serial-tracked goods only)" htmlFor="in-ser"><textarea id="in-ser" rows={3} className={inputClass} value={f.serials} onChange={(e) => setF({ ...f, serials: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Record inspection</Button></div>
    </Modal>
  );
}

function Inspections() {
  const { can } = useAccess();
  const q = useListPendingInspectionsQuery(undefined, { skip: !can("procurement.receipt.inspect") });
  const [row, setRow] = useState<PendingInspection | null>(null);
  if (!can("procurement.receipt.inspect")) return <p className="text-sm text-slate-600">You do not have permission to inspect goods.</p>;
  return (
    <Card title="Waiting for inspection">
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="Nothing to inspect" hint="Goods that need checking appear here after they are received." /> : (
        <table className="w-full text-sm"><caption className="sr-only">Goods waiting for inspection</caption>
          <thead><tr className="text-left text-slate-500"><th>Receipt</th><th>Order</th><th>Product</th><th className="text-right">Received</th><th className="text-right">Waiting</th><th>Held in</th><th /></tr></thead>
          <tbody>{(q.data ?? []).map((r) => <tr key={r.line} className="border-t border-slate-100"><td className="py-1">{r.receipt}</td><td>{r.po}</td><td>{r.product}</td><td className="text-right">{Number(r.quantity)}</td><td className="text-right">{Number(r.open)}</td><td>{r.quarantine}</td><td className="text-right"><Button variant="secondary" onClick={() => setRow(r)}>{`Inspect ${r.receipt} ${r.product}`}</Button></td></tr>)}</tbody>
        </table>
      )}
      {row && <InspectDialog row={row} onClose={() => setRow(null)} />}
    </Card>
  );
}

function Receipts() {
  const { can } = useAccess();
  const q = useListGoodsReceiptsQuery();
  const [attach] = useAttachReceiptEvidenceMutation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file || !target) return;
    setMsg(null);
    try { const r = await attach({ id: target, file }).unwrap(); setMsg({ ok: true, text: `Attached ${r.name}.` }); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); }
    if (fileRef.current) fileRef.current.value = "";
  };
  return (
    <Card title="Goods received">
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mb-2 text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</p>}
      <input ref={fileRef} type="file" className="sr-only" aria-label="Evidence file" onChange={(e) => void pick(e.target.files?.[0])} />
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="No goods received yet" /> : (
        <ul className="space-y-3 text-sm">{(q.data ?? []).map((r) => (
          <li key={r.id} className="rounded border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><span><strong>{r.number}</strong> for {r.po} · {r.receipt_date}{r.delivery_note ? ` · delivery note ${r.delivery_note}` : ""}</span>
              {can("inventory.goods.receive") && <Button variant="secondary" onClick={() => { setTarget(r.id); fileRef.current?.click(); }}>{`Attach evidence to ${r.number}`}</Button>}</div>
            <ul className="mt-2">{r.lines.map((l) => { const st = INSPECTION[l.inspection_status] ?? { label: l.inspection_status, tone: "slate" as const }; return <li key={l.id} className="flex flex-wrap items-center gap-2 border-t border-slate-100 py-1"><span>{Number(l.quantity)} received{l.lot_code ? ` (lot ${l.lot_code})` : ""}{Number(l.over_quantity) > 0 ? `, ${Number(l.over_quantity)} over the order` : ""}</span><Badge tone={st.tone}>{st.label}</Badge>{Number(l.rejected) > 0 && <span className="text-red-700">{Number(l.rejected)} rejected</span>}</li>; })}</ul>
          </li>
        ))}</ul>
      )}
    </Card>
  );
}

export function ReceivingPage() {
  const [tab, setTab] = useState<"inspections" | "receipts">("inspections");
  const tabs: ["inspections" | "receipts", string][] = [["inspections", "Inspections"], ["receipts", "Receipts"]];
  return (
    <div>
      <PageHeader title="Receiving" description="Goods that arrived from suppliers, and checking them." />
      <div role="tablist" className="mb-4 flex flex-wrap border-b border-slate-200">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={k === tab} onClick={() => setTab(k)} className={`px-3 py-2 text-sm ${k === tab ? "border-b-2 border-indigo-600 font-medium text-indigo-700" : "text-slate-600 hover:text-slate-900"}`}>{l}</button>)}</div>
      {tab === "inspections" ? <Inspections /> : <Receipts />}
    </div>
  );
}

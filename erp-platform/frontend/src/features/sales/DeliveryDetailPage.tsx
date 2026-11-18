import { useRef, useState } from "react";
import { Link, useParams } from "react-router";

import { useAttachDeliveryPodMutation, useConfirmDeliveryMutation, useFailDeliveryMutation, useGetDeliveryQuery, useGetSalesOrderQuery, useListDeliveryPodQuery, useSetDeliveryExpectedMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Delivery } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { fileToBase64 } from "../crm/ServiceCaseDetailPage";
import { ActionDialog } from "../hr/ActionDialog";
import { DELIVERY_STATUS, isLate } from "./DeliveriesPage";

export const KIND_TEXT: Record<string, string> = { SHORT: "Short (fewer than expected)", DAMAGED: "Damaged", WRONG: "Wrong item" };
export interface DiscrepancyDraft { order_line: string; kind: string; quantity: string; note: string }

/** First problem with the discrepancies entered at hand-over, or null. */
export function discrepancyProblem(rows: DiscrepancyDraft[], lines: Delivery["lines"]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const line = lines.find((l) => l.order_line === r.order_line);
    if (!line) return "Choose the item each problem is about.";
    if (!r.kind) return "Say what kind of problem it is.";
    if (!/^\d+(\.\d{1,4})?$/.test(r.quantity.trim()) || Number(r.quantity) <= 0) return "A problem needs a quantity above zero.";
    if (Number(r.quantity) > Number(line.quantity)) return `Only ${Number(line.quantity)} were delivered on that line.`;
    const key = `${r.order_line}-${r.kind}`;
    if (seen.has(key)) return "The same problem is listed twice for one item.";
    seen.add(key);
  }
  return null;
}

function ConfirmDialog({ d, itemName, onClose }: { d: Delivery; itemName: (id: string) => string; onClose: () => void }) {
  const [confirm, { isLoading }] = useConfirmDeliveryMutation();
  const [by, setBy] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<DiscrepancyDraft[]>([]);
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const problem = (!by.trim() && "Who received the goods is required.") || discrepancyProblem(rows, d.lines);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      const f = file.current?.files?.[0];
      await confirm({ id: d.id, body: { received_by: by.trim(), note: note.trim(), discrepancies: rows.map((r) => ({ ...r, quantity: r.quantity.trim() })), ...(f ? { pod_filename: f.name, pod_content_base64: await fileToBase64(f) } : {}) } }).unwrap();
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  const upd = (i: number, patch: Partial<DiscrepancyDraft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Modal title="Confirm delivery" open onClose={onClose}>
      <FormField label="Received by" htmlFor="cf-by"><input id="cf-by" className={inputClass} value={by} onChange={(e) => setBy(e.target.value)} /></FormField>
      <FormField label="Note" htmlFor="cf-note"><input id="cf-note" className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
      <FormField label="Proof of delivery (optional)" htmlFor="cf-pod"><input id="cf-pod" ref={file} type="file" className={inputClass} /></FormField>
      {rows.map((r, i) => (
        <div key={i} className="mb-2 grid grid-cols-2 gap-2 rounded border border-slate-200 p-2">
          <select aria-label={`Item for problem ${i + 1}`} className={inputClass} value={r.order_line} onChange={(e) => upd(i, { order_line: e.target.value })}><option value="">Item…</option>{d.lines.map((l) => <option key={l.order_line} value={l.order_line}>{itemName(l.order_line)}</option>)}</select>
          <select aria-label={`Kind of problem ${i + 1}`} className={inputClass} value={r.kind} onChange={(e) => upd(i, { kind: e.target.value })}><option value="">Kind…</option>{Object.entries(KIND_TEXT).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
          <input aria-label={`Quantity of problem ${i + 1}`} className={inputClass} placeholder="Quantity" value={r.quantity} onChange={(e) => upd(i, { quantity: e.target.value })} />
          <input aria-label={`Note for problem ${i + 1}`} className={inputClass} placeholder="What happened" value={r.note} onChange={(e) => upd(i, { note: e.target.value })} />
          <button type="button" className="col-span-2 text-left text-xs text-red-700 hover:underline" onClick={() => setRows(rows.filter((_, j) => j !== i))}>{`Remove problem ${i + 1}`}</button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => setRows([...rows, { order_line: "", kind: "", quantity: "", note: "" }])}>Report a problem with the goods</Button>
      {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Confirm delivered</Button></div>
    </Modal>
  );
}

function Proof({ id, canWrite }: { id: string; canWrite: boolean }) {
  const { data, isLoading, error, refetch } = useListDeliveryPodQuery(id);
  const [attach, { isLoading: busy }] = useAttachDeliveryPodMutation();
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const f = input.current?.files?.[0];
    if (!f) { setErr("Choose a file to attach."); return; }
    setErr(null);
    try { await attach({ id, filename: f.name, content_base64: await fileToBase64(f) }).unwrap(); if (input.current) input.current.value = ""; } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="Proof of delivery">
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No documents attached" /> : <ul className="mb-3 text-sm">{data.map((f) => <li key={f.id}>{f.name} <span className="text-slate-500">({Math.max(1, Math.round(f.size / 1024))} KB)</span></li>)}</ul>}
      {canWrite && <div className="flex items-center gap-2"><input ref={input} type="file" aria-label="Proof of delivery file" className="text-sm" /><Button variant="secondary" loading={busy} onClick={() => void submit()}>Attach</Button></div>}
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
    </Card>
  );
}

export function DeliveryDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("sales.delivery.manage");
  const { data, isLoading, error, refetch } = useGetDeliveryQuery(id);
  const order = useGetSalesOrderQuery(data?.order ?? "", { skip: !data });
  const [fail] = useFailDeliveryMutation();
  const [expected] = useSetDeliveryExpectedMutation();
  const [dlg, setDlg] = useState<"confirm" | "fail" | "expected" | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const itemName = (lineId: string) => order.data?.lines?.find((l) => l.id === lineId)?.description ?? `Item ${lineId.slice(0, 8)}`;
  const st = DELIVERY_STATUS[data.status];
  return (
    <>
      <PageHeader title={`Delivery ${data.number}`} description={order.data ? `For sales order ${order.data.number}` : undefined}
        actions={manage && data.status === "DISPATCHED" ? <div className="flex gap-2"><Button onClick={() => setDlg("confirm")}>Confirm delivery</Button><Button variant="secondary" onClick={() => setDlg("expected")}>Set expected date</Button><Button variant="danger" onClick={() => setDlg("fail")}>Mark as failed</Button></div> : undefined} />
      <p className="mb-3 text-sm"><Link className="text-indigo-700 underline" to="/app/sales/deliveries">← All deliveries</Link></p>
      <Card title="Status">
        <p className="mb-2"><Badge tone={st.tone}>{st.label}</Badge>{isLate(data) && <Badge tone="red">Late</Badge>}</p>
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div><dt className="text-xs text-slate-500">Dispatched</dt><dd>{data.delivery_date}</dd></div>
          <div><dt className="text-xs text-slate-500">Expected</dt><dd>{data.expected_date ?? "–"}</dd></div>
          <div><dt className="text-xs text-slate-500">Carrier</dt><dd>{data.carrier || "–"}</dd></div>
          <div><dt className="text-xs text-slate-500">Tracking</dt><dd>{data.tracking_ref || "–"}</dd></div>
          {data.delivered_at && <div><dt className="text-xs text-slate-500">Delivered</dt><dd>{new Date(data.delivered_at).toLocaleString()}</dd></div>}
          {data.received_by && <div><dt className="text-xs text-slate-500">Received by</dt><dd>{data.received_by}</dd></div>}
          {data.pod_note && <div><dt className="text-xs text-slate-500">Note</dt><dd>{data.pod_note}</dd></div>}
          {data.failure_reason && <div><dt className="text-xs text-slate-500">Why it failed</dt><dd>{data.failure_reason}</dd></div>}
        </dl>
      </Card>
      <Card title="Goods"><table className="min-w-full text-sm"><caption className="sr-only">Goods</caption><thead><tr className="text-left text-slate-500"><th className="py-1">Item</th><th className="text-right">Quantity</th><th>Lot</th></tr></thead>
        <tbody>{data.lines.map((l) => <tr key={l.order_line} className="border-t border-slate-100"><td className="py-1">{itemName(l.order_line)}</td><td className="text-right">{Number(l.quantity)}</td><td>{l.lot_code || "–"}</td></tr>)}</tbody></table></Card>
      {data.discrepancies.length > 0 && (
        <Card title="Problems reported on arrival"><ul className="text-sm">{data.discrepancies.map((x, i) => <li key={i}>{KIND_TEXT[x.kind]}: {itemName(x.order_line)} × {Number(x.quantity)}{x.note && ` — ${x.note}`}{x.case && <> · <Link className="text-indigo-700 underline" to={`/app/crm/cases/${x.case}`}>service case</Link></>}</li>)}</ul></Card>
      )}
      <Proof id={id} canWrite={manage} />
      {dlg === "confirm" && <ConfirmDialog d={data} itemName={itemName} onClose={() => setDlg(null)} />}
      {dlg === "fail" && <ActionDialog title="Mark delivery as failed" cta="Mark as failed" open onClose={() => setDlg(null)} fields={[{ name: "reason", label: "What went wrong", required: true }]} submit={async (v) => { await fail({ id, reason: v.reason!.trim() }).unwrap(); }} />}
      {dlg === "expected" && <ActionDialog title="Set expected date" cta="Save date" open onClose={() => setDlg(null)} initial={{ expected_date: data.expected_date ?? "" }} fields={[{ name: "expected_date", label: "Expected delivery date", type: "date", required: true }]}
        submit={async (v) => { if (v.expected_date! < data.delivery_date) throw new Error("The expected date cannot be before the dispatch date."); await expected({ id, expected_date: v.expected_date! }).unwrap(); }} />}
    </>
  );
}

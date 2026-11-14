import { useState } from "react";
import { Link, useParams } from "react-router";

import { useGetQualityHoldQuery, useListProductsQuery, useListQualityHoldsQuery, usePlaceQualityHoldMutation, useQualityHoldActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QHold } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames } from "./names";
import { HistoryPanel } from "./panels";

export const DISPOSITIONS = ["ACCEPT", "REJECT", "REWORK", "REPAIR", "SCRAP", "CONDITIONAL"];
const RELEASING = ["ACCEPT", "CONDITIONAL", "REWORK", "REPAIR"];

export function holdTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "ACTIVE") return "red";
  if (s === "RELEASED") return "green";
  return "slate";
}

export function validateHold(f: { product_id: string; reason: string; quantity: string }): string | null {
  if (!f.product_id) return "Choose the product.";
  if (!f.reason.trim()) return "Give the reason for the hold.";
  if (f.quantity.trim() && !/^\d+(\.\d+)?$/.test(f.quantity.trim())) return "The quantity must be zero or more.";
  return null;
}

/** What blocks a release, from the recorded disposition. The server decides; this names the gap first. */
export function releaseBlock(h: Pick<QHold, "disposition">): string | null {
  return RELEASING.includes(h.disposition) ? null : "Record an accepting disposition (accept, conditional, rework or repair) before releasing.";
}

export function rejectBlock(h: Pick<QHold, "disposition">): string | null {
  return ["REJECT", "SCRAP"].includes(h.disposition) ? null : "Record a reject or scrap disposition first.";
}

export function HoldsPage() {
  const { can } = useAccess();
  const inspect = can("quality.inspect");
  const [status, setStatus] = useState("ACTIVE");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityHoldsQuery({ status: status || undefined, cursor });
  const products = useListProductsQuery(undefined);
  const [place] = usePlaceQualityHoldMutation();
  const productName = (id: string) => { const p = products.data?.results.find((x) => x.id === id); return p ? `${p.sku} ${p.name}` : id.slice(0, 8); };
  const empty = { product_id: "", lot_number: "", quantity: "", reason: "" };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateHold(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { product_id: n.product_id, reason: n.reason.trim() };
    if (n.lot_number.trim()) body.lot_number = n.lot_number.trim();
    if (n.quantity.trim()) body.quantity = n.quantity.trim();
    try { await place(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Quality holds" description="Held stock cannot be issued or transferred until the hold is released." actions={inspect ? <Button onClick={() => setOpen(true)}>Place a hold</Button> : undefined} />
      <Card>
        <div className="mb-3"><label className="text-sm">Status <select aria-label="Hold status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option><option value="ACTIVE">Active</option><option value="RELEASED">Released</option><option value="REJECTED">Rejected</option></select></label></div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No holds" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Product</th><th>Lot</th><th>Quantity</th><th>Reason</th><th>Status</th></tr></thead>
            <tbody>{data.results.map((h) => (
              <tr key={h.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/holds/${h.id}`}>{h.number}</Link></td><td>{productName(h.product_id)}</td><td>{h.lot_number || "All lots"}</td><td>{h.quantity}</td><td>{h.reason}</td><td><Badge tone={holdTone(h.status)}>{pretty(h.status)}</Badge></td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="Place a hold" open={open} onClose={() => setOpen(false)}>
        <FormField label="Product" htmlFor="ph-prod"><select id="ph-prod" className={inputClass} value={n.product_id} onChange={(e) => setN({ ...n, product_id: e.target.value })}><option value="">Choose…</option>{products.data?.results.map((p) => <option key={p.id} value={p.id}>{p.sku} {p.name}</option>)}</select></FormField>
        <FormField label="Lot number (blank holds every lot)" htmlFor="ph-lot"><input id="ph-lot" className={inputClass} value={n.lot_number} onChange={(e) => setN({ ...n, lot_number: e.target.value })} /></FormField>
        <FormField label="Quantity" htmlFor="ph-qty"><input id="ph-qty" className={inputClass} value={n.quantity} onChange={(e) => setN({ ...n, quantity: e.target.value })} /></FormField>
        <FormField label="Reason" htmlFor="ph-why"><textarea id="ph-why" className={inputClass} value={n.reason} onChange={(e) => setN({ ...n, reason: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Place hold</Button></div>
      </Modal>
    </>
  );
}

export function HoldPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const releaser = can("quality.hold.release");
  const { data: h, isLoading, error, refetch } = useGetQualityHoldQuery(id);
  const [act] = useQualityHoldActionMutation();
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"disposition" | "release" | "reject" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !h) return <ErrorState error={error} onRetry={refetch} />;
  const active = h.status === "ACTIVE";
  const gate = (block: string | null, next: "release" | "reject") => { if (block) { setErr(block); return; } setErr(null); setDlg(next); };
  return (
    <>
      <PageHeader title={`Hold ${h.number}`} description={h.reason} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/holds">All holds</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={holdTone(h.status)}>{pretty(h.status)}</Badge>{h.lot_number ? <Badge tone="slate">{`Lot ${h.lot_number}`}</Badge> : <Badge tone="slate">All lots</Badge>}{h.disposition && <Badge tone="amber">{`Disposition: ${pretty(h.disposition)}`}</Badge>}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Details">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <dt className="font-medium">Quantity</dt><dd>{h.quantity}</dd>
            <dt className="font-medium">Placed by</dt><dd>{nameOf(h.placed_by)}</dd>
            <dt className="font-medium">Source</dt><dd>{h.source_type ? pretty(h.source_type) : "Placed manually"}</dd>
            {h.disposition_note && <><dt className="font-medium">Disposition note</dt><dd>{h.disposition_note}</dd></>}
            {h.released_at && <><dt className="font-medium">Released</dt><dd>{h.released_at.slice(0, 10)} by {nameOf(h.released_by)}</dd></>}
            {h.source_type === "inspection" && h.source_id && <><dt className="font-medium">Inspection</dt><dd><Link className="text-blue-700 underline" to={`/app/quality/inspections/${h.source_id}`}>Open the inspection</Link></dd></>}
            {h.reinspection_id && <><dt className="font-medium">Re-inspection</dt><dd><Link className="text-blue-700 underline" to={`/app/quality/inspections/${h.reinspection_id}`}>Open the re-inspection</Link></dd></>}
          </dl>
          {releaser && active && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setDlg("disposition")}>Decide disposition</Button>
              <Button onClick={() => gate(releaseBlock(h), "release")}>Release the stock</Button>
              <Button variant="secondary" onClick={() => gate(rejectBlock(h), "reject")}>Reject the goods</Button>
            </div>
          )}
          {!releaser && active && <p className="mt-2 text-sm text-slate-600">Only people with the release permission can decide this hold.</p>}
        </Card>
        <HistoryPanel history={h.history} />
      </div>
      <ActionDialog title="Decide disposition" open={dlg === "disposition"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "disposition", label: "Disposition", required: true, options: DISPOSITIONS.map((d) => [d, pretty(d)] as [string, string]) }, { name: "note", label: "Justification", required: true }]}
        submit={(v) => act({ id: h.id, action: "disposition", body: { disposition: v.disposition, note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Release the stock" open={dlg === "release"} onClose={() => setDlg(null)} cta="Release" fields={[{ name: "note", label: "Reason for releasing", required: true }]} submit={(v) => act({ id: h.id, action: "release", body: { note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Reject the goods" open={dlg === "reject"} onClose={() => setDlg(null)} cta="Reject" fields={[{ name: "note", label: "Note" }]} submit={(v) => act({ id: h.id, action: "reject", body: { note: (v.note ?? "").trim() } }).unwrap()} />
    </>
  );
}

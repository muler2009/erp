import { useState } from "react";

import { useGetLotTraceQuery, useGetSerialQuery, useSetLotStatusMutation } from "../../shared/api/endpoints";
import type { Product } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export const LOT_STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate" }> = {
  AVAILABLE: { label: "Available", tone: "green" }, QUARANTINED: { label: "Quarantined", tone: "amber" }, BLOCKED: { label: "Blocked", tone: "red" }, RECALLED: { label: "Recalled", tone: "red" },
};
export const lookupProblem = (p: Product | null, code: string, what: string): string | null => (!p ? "Choose the product." : !code.trim() ? `Enter the ${what}.` : null);
export const statusNoteProblem = (status: string, note: string): string | null => (!status ? "Choose the new status." : status !== "AVAILABLE" && !note.trim() ? "A note is required when a lot is not available." : null);

function LotView({ product, lot }: { product: string; lot: string }) {
  const { can } = useAccess();
  const q = useGetLotTraceQuery({ product, lot });
  const [setStatus] = useSetLotStatusMutation();
  const [changing, setChanging] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const d = q.data;
  const s = LOT_STATUS[d.status] ?? { label: d.status, tone: "slate" as const };
  return (
    <Card title={`Lot ${d.lot}`} actions={can("inventory.stock.adjust") ? <Button variant="secondary" onClick={() => setChanging(true)}>Change status</Button> : undefined}>
      <p className="mb-3 text-sm"><Badge tone={s.tone}>{s.label}</Badge> · Expires {d.expiry_date ?? "—"}</p>
      <h3 className="text-sm font-semibold">Where it is now</h3>
      {d.on_hand.length === 0 ? <p className="mb-2 text-sm text-slate-600">None on hand.</p> : <ul className="mb-2 text-sm">{d.on_hand.map((x, i) => <li key={i}>{x.location}: {formatMoney(x.quantity)}</li>)}</ul>}
      <h3 className="text-sm font-semibold">Received</h3>
      <ul className="mb-2 text-sm">{d.received.map((x, i) => <li key={i}>{formatMoney(x.quantity)} at {x.location} ({x.ref_type} {x.ref_id})</li>)}{d.received.length === 0 && <li className="text-slate-600">No receipts.</li>}</ul>
      <h3 className="text-sm font-semibold">Issued to</h3>
      <ul className="text-sm">{d.issued.map((x, i) => <li key={i}>{formatMoney(x.quantity)} on {new Date(x.at).toLocaleDateString()} ({x.ref_type} {x.ref_id})</li>)}{d.issued.length === 0 && <li className="text-slate-600">Not issued yet.</li>}</ul>
      <ActionDialog title="Change lot status" open={changing} onClose={() => setChanging(false)} cta="Save status"
        fields={[{ name: "status", label: "New status", type: "select", options: Object.entries(LOT_STATUS).map(([k, v]) => [k, v.label] as [string, string]) }, { name: "note", label: "Note" }]}
        submit={async (v) => { const p = statusNoteProblem(v.status ?? "", v.note ?? ""); if (p) throw new Error(p); await setStatus({ product, lot, status: v.status ?? "", note: (v.note ?? "").trim() }).unwrap(); }} />
    </Card>
  );
}

function SerialView({ product, serial }: { product: string; serial: string }) {
  const q = useGetSerialQuery({ product, serial });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const d = q.data;
  return (
    <Card title={`Serial ${d.serial}`}>
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between"><dt>Status</dt><dd>{d.status === "IN_STOCK" ? "In stock" : d.status === "ISSUED" ? "Issued" : d.status}</dd></div>
        <div className="flex justify-between"><dt>Location</dt><dd>{d.location ?? "—"}</dd></div>
        <div className="flex justify-between"><dt>Received on</dt><dd>{d.received_ref || "—"}</dd></div>
        <div className="flex justify-between"><dt>Issued on</dt><dd>{d.issued_ref || "—"}</dd></div>
        <div className="flex justify-between"><dt>Warranty until</dt><dd>{d.warranty_until ?? "—"}</dd></div>
      </dl>
    </Card>
  );
}

export function TraceabilityPage() {
  const [product, setProduct] = useState<Product | null>(null);
  const [kind, setKind] = useState<"lot" | "serial">("lot");
  const [code, setCode] = useState("");
  const [shown, setShown] = useState<{ product: string; kind: "lot" | "serial"; code: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const find = () => {
    const p = lookupProblem(product, code, kind === "lot" ? "lot code" : "serial number");
    if (p) { setErr(p); return; }
    setErr(null);
    setShown({ product: product!.id, kind, code: code.trim() });
  };
  return (
    <>
      <PageHeader title="Lots and serial numbers" description="Trace where a lot came from and went, change its status for quarantine or recall, or look up a serial number." />
      <Card>
        <ProductPicker label="Product" onChange={(p) => { setProduct(p); setShown(null); }} />
        <FormField label="Look up a" htmlFor="tr-kind"><select id="tr-kind" className={inputClass} value={kind} onChange={(e) => { setKind(e.target.value as "lot" | "serial"); setShown(null); }}><option value="lot">Lot</option><option value="serial">Serial number</option></select></FormField>
        <FormField label={kind === "lot" ? "Lot code" : "Serial number"} htmlFor="tr-code"><input id="tr-code" className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} /></FormField>
        {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
        <Button onClick={find}>Find</Button>
      </Card>
      {shown?.kind === "lot" && <LotView key={`${shown.product}-${shown.code}`} product={shown.product} lot={shown.code} />}
      {shown?.kind === "serial" && <SerialView key={`${shown.product}-${shown.code}`} product={shown.product} serial={shown.code} />}
    </>
  );
}

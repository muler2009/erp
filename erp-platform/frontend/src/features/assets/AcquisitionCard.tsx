import { useState } from "react";

import { useAssetAcquisitionActionMutation, useGetAssetAcquisitionQuery, useRecordAssetAcquisitionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export const SOURCES = ["PURCHASE", "DONATION", "CONSTRUCTION", "TRANSFER", "OPENING"];
export const COST_KINDS = ["FREIGHT", "INSTALLATION", "DUTY", "TESTING", "OTHER"];

export function validateAcquisition(f: { source: string; cost: string }): string | null {
  if (!SOURCES.includes(f.source)) return "Choose how the asset was acquired.";
  const c = parseMoney(f.cost);
  return c === null || c <= 0n ? "The acquisition cost must be greater than zero." : null;
}
export function validateExtraCost(f: { kind: string; amount: string }): string | null {
  if (!COST_KINDS.includes(f.kind)) return "Choose the kind of cost.";
  const c = parseMoney(f.amount);
  return c === null || c <= 0n ? "Enter an amount greater than zero." : null;
}

export function AcquisitionCard({ id }: { id: string }) {
  const { can } = useAccess();
  const manage = can("assets.acquisition.manage");
  const { data, isLoading, error } = useGetAssetAcquisitionQuery(id);
  const [record] = useRecordAssetAcquisitionMutation();
  const [act] = useAssetAcquisitionActionMutation();
  const [dlg, setDlg] = useState<"record" | "cost" | "accept" | "commission" | "capitalize" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const missing = !!error && (error as { status?: number }).status === 409;
  return (
    <Card title="Acquisition">
      {isLoading ? <Spinner /> : error && !missing ? <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p> : (
        <>
          {msg && <p role="status" className="mb-2 text-sm text-green-700">{msg}</p>}
          {missing || !data ? <p className="text-sm text-slate-600">No acquisition has been recorded for this asset.</p> : (
            <>
              <p className="text-sm">{pretty(data.source)} · cost {formatMoney(data.cost)} · total with extras <strong>{formatMoney(data.total_cost)}</strong></p>
              {data.extra_costs.length > 0 && <ul className="mt-1 text-sm">{data.extra_costs.map((c, i) => <li key={i}>{pretty(c.kind)} {formatMoney(c.amount)}{c.description ? ` — ${c.description}` : ""}</li>)}</ul>}
              <p className="mt-1 text-sm text-slate-600">{data.accepted_on ? `Delivery accepted ${data.accepted_on}` : "Delivery not yet accepted"}{data.commissioned_on ? ` · commissioning ${data.commissioning_passed ? "passed" : "failed"} ${data.commissioned_on}` : ""}</p>
              {data.accepted_on && data.commissioning_passed && <Badge tone="green">Ready to capitalise</Badge>}
            </>
          )}
          {manage && (
            <div className="mt-3 flex flex-wrap gap-2">
              {(missing || !data) && <Button variant="secondary" onClick={() => setDlg("record")}>Record acquisition</Button>}
              {data && <Button variant="secondary" onClick={() => setDlg("cost")}>Add cost</Button>}
              {data && !data.accepted_on && <Button variant="secondary" onClick={() => setDlg("accept")}>Accept delivery</Button>}
              {data && data.accepted_on && !data.commissioned_on && <Button variant="secondary" onClick={() => setDlg("commission")}>Record commissioning</Button>}
              {data && data.accepted_on && <Button onClick={() => setDlg("capitalize")}>Request capitalisation</Button>}
            </div>
          )}
        </>
      )}
      <ActionDialog title="Record acquisition" open={dlg === "record"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "source", label: "Source", required: true, options: SOURCES.map((s) => [s, pretty(s)] as [string, string]) }, { name: "cost", label: "Cost", required: true }, { name: "delivered_on", label: "Delivered on", type: "date" }, { name: "reference_note", label: "Reference" }]}
        submit={async (v) => { const f = { source: v.source ?? "", cost: (v.cost ?? "").trim() }; const p = validateAcquisition(f); if (p) throw new Error(p); await record({ id, ...f, ...(v.delivered_on ? { delivered_on: v.delivered_on } : {}), ...(v.reference_note ? { reference_note: v.reference_note } : {}) }).unwrap(); }} />
      <ActionDialog title="Add acquisition cost" open={dlg === "cost"} onClose={() => setDlg(null)} cta="Add cost" fields={[{ name: "kind", label: "Kind", required: true, options: COST_KINDS.map((s) => [s, pretty(s)] as [string, string]) }, { name: "amount", label: "Amount", required: true }, { name: "description", label: "Description" }]}
        submit={async (v) => { const f = { kind: v.kind ?? "", amount: (v.amount ?? "").trim() }; const p = validateExtraCost(f); if (p) throw new Error(p); await act({ id, action: "cost", body: { ...f, description: v.description ?? "" } }).unwrap(); }} />
      <ActionDialog title="Accept delivery" open={dlg === "accept"} onClose={() => setDlg(null)} cta="Accept" fields={[{ name: "delivered_on", label: "Delivered on", type: "date" }, { name: "notes", label: "Notes" }]}
        submit={(v) => act({ id, action: "accept", body: { delivered_on: v.delivered_on || today, notes: v.notes ?? "" } }).unwrap()} />
      <ActionDialog title="Record commissioning" open={dlg === "commission"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "passed", label: "Result", required: true, options: [["yes", "Passed"], ["no", "Failed"]] }, { name: "notes", label: "Notes" }]}
        submit={(v) => act({ id, action: "commission", body: { passed: v.passed === "yes", date: today, notes: v.notes ?? "" } }).unwrap()} />
      <ActionDialog title="Request capitalisation" open={dlg === "capitalize"} onClose={() => setDlg(null)} cta="Request" fields={[{ name: "date", label: "Capitalisation date", type: "date", required: true }]}
        submit={async (v) => { await act({ id, action: "capitalize", body: { date: v.date } }).unwrap(); setMsg("Capitalisation requested; an approver must now approve it."); }} />
    </Card>
  );
}

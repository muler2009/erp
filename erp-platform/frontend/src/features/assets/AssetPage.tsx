import { useState } from "react";
import { Link, useParams } from "react-router";

import { useChangeDepPolicyMutation, useGetFixedAssetHistoryQuery, useRequestValueAdjustmentMutation, useGetFixedAssetQuery, useGetFixedAssetScheduleQuery, useListAssetLocationsQuery, useSetFixedAssetStatusMutation, useUpdateFixedAssetMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { AcquisitionCard } from "./AcquisitionCard";
import { AssetDocumentsCard } from "./AssetDocuments";
import { WarrantyCard } from "./WarrantyCard";
import { assetTone } from "./AssetsPage";

/** The moves an asset manager may make by hand; every other move happens through custody, maintenance or disposal. */
export const MANUAL_NEXT: Record<string, string[]> = { REQUESTED: ["ORDERED", "RECEIVED"], ORDERED: ["RECEIVED"], RECEIVED: ["AVAILABLE"], AVAILABLE: ["RETIRED"] };

export function validateStatusChange(to: string, reason: string): string | null {
  return to === "RETIRED" && !reason.trim() ? "A reason is required to retire an asset." : null;
}

export const ADJUSTMENT_KINDS = ["IMPROVEMENT", "REVALUATION", "IMPAIRMENT"];

export function validateAdjustment(f: { kind: string; amount: string; effective_date: string; reason: string; extend: string }): string | null {
  if (!ADJUSTMENT_KINDS.includes(f.kind)) return "Choose the kind of adjustment.";
  if (!/^\d+(\.\d{1,4})?$/.test(f.amount.trim())) return "Enter the amount as a number, for example 250.00.";
  if (Number(f.amount) === 0 && f.kind !== "REVALUATION") return "The amount must be greater than zero.";
  if (!f.effective_date) return "Enter the effective date.";
  if (!f.reason.trim()) return "Say why the value is changing.";
  if (f.extend && !/^\d+$/.test(f.extend.trim())) return "Extra life must be a whole number of months.";
  return null;
}

export function validatePolicy(f: { reason: string; life: string; residual: string }): string | null {
  if (!f.reason.trim()) return "Say why the policy is changing.";
  if (f.life && (!/^\d+$/.test(f.life.trim()) || Number(f.life) < 1)) return "Useful life must be a whole number of months, at least 1.";
  if (f.residual && !/^\d+(\.\d{1,4})?$/.test(f.residual.trim())) return "Residual value must be a number.";
  if (!f.life && !f.residual) return "Change at least the useful life or the residual value.";
  return null;
}

export function AssetPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("assets.asset.manage");
  const asset = useGetFixedAssetQuery(id);
  const history = useGetFixedAssetHistoryQuery(id);
  const schedule = useGetFixedAssetScheduleQuery(id);
  const locations = useListAssetLocationsQuery(undefined, { skip: !manage });
  const [setStatus] = useSetFixedAssetStatusMutation();
  const [update] = useUpdateFixedAssetMutation();
  const [requestAdj] = useRequestValueAdjustmentMutation();
  const [changePolicy] = useChangeDepPolicyMutation();
  const valuation = can("assets.valuation.manage");
  const [dlg, setDlg] = useState<{ kind: "status"; to: string } | { kind: "edit" } | { kind: "adjust" } | { kind: "policy" } | null>(null);
  const a = asset.data;
  if (asset.isLoading) return <Spinner />;
  if (asset.error || !a) return <ErrorState error={asset.error} onRetry={asset.refetch} />;
  return (
    <>
      <PageHeader title={`${a.number} — ${a.name}`} description="Asset record, depreciation and history." actions={<><Link className="mr-3 text-sm underline" to="/app/assets/register">Back to the register</Link>{manage && <Button variant="secondary" onClick={() => setDlg({ kind: "edit" })}>Edit</Button>}{valuation && <><Button variant="secondary" onClick={() => setDlg({ kind: "adjust" })}>Adjust value</Button><Button variant="secondary" onClick={() => setDlg({ kind: "policy" })}>Change depreciation policy</Button></>}</>} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Details">
          <p className="mb-2"><Badge tone={assetTone(a.status)}>{pretty(a.status)}</Badge></p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-500">Category</dt><dd>{a.category.code}</dd>
            <dt className="text-slate-500">Class</dt><dd>{pretty(a.asset_class)}</dd>
            <dt className="text-slate-500">Location</dt><dd>{a.location?.code ?? "–"}</dd>
            <dt className="text-slate-500">Purchase cost</dt><dd>{formatMoney(a.purchase_cost)} {a.currency}</dd>
            <dt className="text-slate-500">Acquired</dt><dd>{a.acquisition_date ?? "–"}</dd>
            <dt className="text-slate-500">Maker / model</dt><dd>{[a.manufacturer, a.model].filter(Boolean).join(" ") || "–"}</dd>
            <dt className="text-slate-500">Serial</dt><dd>{a.serial_number || "–"}</dd>
          </dl>
          {manage && (MANUAL_NEXT[a.status] ?? []).length > 0 && <div className="mt-3 flex flex-wrap gap-2">{MANUAL_NEXT[a.status]!.map((s) => <Button key={s} variant="secondary" onClick={() => setDlg({ kind: "status", to: s })}>{`Mark ${pretty(s)}`}</Button>)}</div>}
        </Card>
        <Card title="Depreciation schedule">
          {schedule.isLoading ? <Spinner /> : schedule.error ? <p className="text-sm text-slate-600">{errorMessage(schedule.error)}</p> : !schedule.data?.results.length ? <EmptyState title="Nothing left to depreciate" /> : (
            <table className="w-full text-sm"><caption className="sr-only">Depreciation schedule</caption><thead><tr className="text-left"><th>Period</th><th className="text-right">Charge</th><th className="text-right">Net book value</th></tr></thead>
              <tbody>{schedule.data.results.slice(0, 12).map((r) => <tr key={r.period} className="border-t border-slate-100"><td>{r.period}</td><td className="text-right">{formatMoney(r.charge)}</td><td className="text-right">{formatMoney(r.nbv)}</td></tr>)}</tbody></table>
          )}
          {schedule.data && schedule.data.results.length > 12 && <p className="mt-1 text-xs text-slate-500">Showing the next 12 of {schedule.data.results.length} periods.</p>}
        </Card>
      </div>
      <div className="mt-4"><AcquisitionCard id={id} /></div>
      <div className="mt-4"><WarrantyCard id={id} /></div>
      <div className="mt-4"><AssetDocumentsCard id={id} /></div>
      <div className="mt-4"><Card title="History">
        {history.isLoading ? <Spinner /> : history.error ? <ErrorState error={history.error} onRetry={history.refetch} /> : !history.data?.results.length ? <EmptyState title="No history yet" /> : (
          <ul className="text-sm">{history.data.results.map((h, i) => <li key={i} className="border-b border-slate-100 py-1"><span className="text-slate-500">{new Date(h.at).toLocaleString()}</span> — {pretty(h.event)}{h.note ? `: ${h.note}` : ""}</li>)}</ul>
        )}
      </Card></div>
      <ActionDialog key={dlg?.kind === "status" ? dlg.to : "none"} title={dlg?.kind === "status" ? `Mark ${pretty(dlg.to)}` : "Change status"} open={dlg?.kind === "status"} onClose={() => setDlg(null)} cta="Confirm" fields={[{ name: "reason", label: "Reason" }]}
        submit={async (v) => { const to = (dlg as { to: string }).to; const p = validateStatusChange(to, v.reason ?? ""); if (p) throw new Error(p); await setStatus({ id, status: to, reason: (v.reason ?? "").trim() }).unwrap(); }} />
      <ActionDialog key={a.version} title="Edit asset" open={dlg?.kind === "edit"} onClose={() => setDlg(null)} cta="Save"
        fields={[{ name: "name", label: "Name", required: true }, { name: "description", label: "Description" }, { name: "manufacturer", label: "Manufacturer" }, { name: "model", label: "Model" }, { name: "serial_number", label: "Serial number" }, { name: "location_id", label: "Location", options: [["", "No location"], ...(locations.data?.results ?? []).map((l) => [l.id, `${l.code} — ${l.name}`] as [string, string])] }]}
        submit={async (v) => { const body: Record<string, unknown> = { id, version: a.version }; for (const k of ["name", "description", "manufacturer", "model", "serial_number"]) if ((v[k] ?? "").trim()) body[k] = (v[k] ?? "").trim(); if (v.location_id) body.location_id = v.location_id; await update(body as { id: string; version: number }).unwrap(); }} />
      <ActionDialog title="Adjust value" open={dlg?.kind === "adjust"} onClose={() => setDlg(null)} cta="Submit for approval"
        fields={[{ name: "kind", label: "Kind", required: true, options: ADJUSTMENT_KINDS.map((k) => [k, pretty(k)] as [string, string]) }, { name: "amount", label: "Amount", required: true }, { name: "effective_date", label: "Effective date", type: "date", required: true }, { name: "reason", label: "Reason", required: true }, { name: "extend", label: "Extra life (months, improvements)" }]}
        submit={async (v) => { const f = { kind: v.kind ?? "", amount: v.amount ?? "", effective_date: v.effective_date ?? "", reason: v.reason ?? "", extend: (v.extend ?? "").trim() }; const p = validateAdjustment(f); if (p) throw new Error(p); await requestAdj({ id, kind: f.kind, amount: f.amount.trim(), effective_date: f.effective_date, reason: f.reason.trim(), ...(f.extend ? { extend_life_months: Number(f.extend) } : {}) }).unwrap(); }} />
      <ActionDialog title="Change depreciation policy" open={dlg?.kind === "policy"} onClose={() => setDlg(null)} cta="Apply"
        fields={[{ name: "reason", label: "Reason", required: true }, { name: "life", label: "Useful life (months)" }, { name: "residual", label: "Residual value" }]}
        submit={async (v) => { const f = { reason: v.reason ?? "", life: (v.life ?? "").trim(), residual: (v.residual ?? "").trim() }; const p = validatePolicy(f); if (p) throw new Error(p); await changePolicy({ id, reason: f.reason.trim(), ...(f.life ? { useful_life_months: Number(f.life) } : {}), ...(f.residual ? { residual_value: f.residual } : {}) }).unwrap(); }} />
    </>
  );
}

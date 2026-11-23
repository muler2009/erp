import { useState } from "react";
import { Link } from "react-router";

import { useGetAcquisitionsReportQuery, useLazyFindAssetByCodeQuery, useUpdateAssetCategoryMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { AssetCategory } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { ASSET_CLASSES, METHODS, validateCategory } from "./AssetSetupPage";

export function CategoryEditDialog({ category: c, onClose }: { category: AssetCategory; onClose: () => void }) {
  const [update] = useUpdateAssetCategoryMutation();
  return (
    <ActionDialog title={`Edit category ${c.code}`} open onClose={onClose} cta="Save changes"
      initial={{ name: c.name, asset_class: c.asset_class, depreciation_method: c.depreciation_method, useful_life_months: String(c.useful_life_months ?? ""), residual_percent: c.residual_percent ? String(Number(c.residual_percent)) : "", reducing_rate_percent: c.reducing_rate_percent ? String(Number(c.reducing_rate_percent)) : "", capitalization_threshold: c.capitalization_threshold ? String(Number(c.capitalization_threshold)) : "", requires_serial: c.requires_serial ? "yes" : "no", is_active: c.is_active ? "yes" : "no" }}
      fields={[{ name: "name", label: "Name", required: true }, { name: "asset_class", label: "Class", required: true, options: ASSET_CLASSES.map((x) => [x, pretty(x)] as [string, string]) }, { name: "depreciation_method", label: "Depreciation", required: true, options: METHODS }, { name: "useful_life_months", label: "Useful life (months)" }, { name: "residual_percent", label: "Residual %" }, { name: "reducing_rate_percent", label: "Annual rate % (reducing balance)" }, { name: "capitalization_threshold", label: "Capitalisation threshold" }, { name: "requires_serial", label: "Serial number required", options: [["no", "No"], ["yes", "Yes"]] }, { name: "is_active", label: "Active", options: [["yes", "Yes"], ["no", "No"]] }]}
      submit={async (v) => {
        const f = { code: c.code, name: (v.name ?? "").trim(), method: v.depreciation_method ?? "", life: (v.useful_life_months ?? "").trim(), residual: (v.residual_percent ?? "").trim(), rate: (v.reducing_rate_percent ?? "").trim(), threshold: (v.capitalization_threshold ?? "").trim() };
        const p = validateCategory(f); if (p) throw new Error(p);
        await update({ id: c.id, body: { name: f.name, asset_class: v.asset_class ?? c.asset_class, depreciation_method: f.method, ...(f.life ? { useful_life_months: Number(f.life) } : {}), ...(f.residual ? { residual_percent: f.residual } : {}), ...(f.method === "RB" ? { reducing_rate_percent: f.rate } : {}), ...(f.threshold ? { capitalization_threshold: f.threshold } : {}), requires_serial: v.requires_serial === "yes", is_active: v.is_active !== "no" } }).unwrap();
      }} />
  );
}

export function AssetLookupPage() {
  const [code, setCode] = useState("");
  const [find, r] = useLazyFindAssetByCodeQuery();
  const [problem, setProblem] = useState<string | null>(null);
  const go = () => { if (!code.trim()) { setProblem("Scan or type a code."); return; } setProblem(null); void find(code.trim()); };
  return (
    <>
      <PageHeader title="Find an asset by code" description="Type or scan an asset number, barcode, QR code or RFID tag." />
      <Card>
        <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); go(); }}>
          <FormField label="Code" htmlFor="al-code"><input id="al-code" autoFocus className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} /></FormField>
          <Button type="submit" className="mb-3" loading={r.isFetching}>Find asset</Button>
        </form>
        {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
      </Card>
      {r.isFetching ? <Spinner /> : r.isError ? <p role="alert" className="mt-3 text-sm text-red-700">{errorMessage(r.error)}</p> : r.data && (
        <div className="mt-3"><Card title={r.data.name}>
          <p className="text-sm"><Link className="text-indigo-700 underline" to={`/app/assets/register/${r.data.id}`}>{r.data.number}</Link> · {r.data.category.code} · {r.data.location?.code ?? "no location"} · <Badge tone="slate">{pretty(r.data.status)}</Badge></p>
        </Card></div>
      )}
    </>
  );
}

export function AcquisitionsReportPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const bad = from && to && from > to ? "The start date is after the end date." : null;
  const q = useGetAcquisitionsReportQuery({ from, to }, { skip: !!bad });
  const rows = q.data?.results ?? [];
  const total = rows.reduce((t, x) => t + Number(x.base_amount), 0);
  return (
    <>
      <PageHeader title="Acquisitions report" description="Approved capitalisations in a period." />
      <Card>
        <div className="flex flex-wrap gap-3">
          <FormField label="From (optional)" htmlFor="ar-from"><input id="ar-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label="To (optional)" htmlFor="ar-to"><input id="ar-to" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
        </div>
        {bad && <p role="alert" className="text-sm text-red-700">{bad}</p>}
      </Card>
      {!bad && (q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : rows.length === 0 ? <EmptyState title="No acquisitions in this period" /> : (
        <div className="mt-3"><Card title={`${rows.length} acquisitions · capitalised value ${formatMoney(total.toFixed(2))}`}>
          <table className="w-full text-sm"><caption className="sr-only">Acquisitions</caption>
            <thead><tr className="text-left text-slate-500"><th>Request</th><th>Asset</th><th>Category</th><th>Date</th><th>Treatment</th><th className="text-right">Total cost</th><th className="text-right">Capitalised</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.number} className="border-t border-slate-100"><td>{r.number}</td><td>{r.asset} — {r.name}</td><td>{r.category}</td><td>{r.date}</td><td>{r.capitalized ? "Capitalised" : "Expensed"}</td><td className="text-right">{formatMoney(r.total_cost)}</td><td className="text-right">{formatMoney(r.base_amount)}</td></tr>)}</tbody></table>
        </Card></div>
      ))}
    </>
  );
}

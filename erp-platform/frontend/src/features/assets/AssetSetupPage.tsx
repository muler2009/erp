import { useState } from "react";

import { useCreateAssetCategoryMutation, useCreateAssetLocationMutation, useListAssetCategoriesQuery, useListAssetLocationsQuery } from "../../shared/api/endpoints";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { Can } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import type { AssetCategory } from "../../shared/api/types";
import { CategoryEditDialog } from "./AssetTools";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export const ASSET_CLASSES = ["FIXED", "MOVABLE", "EQUIPMENT", "VEHICLE", "FURNITURE", "IT", "TOOL", "MACHINERY"];
export const METHODS: [string, string][] = [["SL", "Straight line"], ["RB", "Reducing balance"], ["NON", "Not depreciated"]];

export function validateCategory(f: { code: string; name: string; method: string; life: string; residual: string; rate: string; threshold: string }): string | null {
  if (!/^[A-Z0-9_-]{1,20}$/.test(f.code)) return "The code must be capital letters, digits, - or _ (up to 20).";
  if (!f.name.trim()) return "Enter the category name.";
  if (!METHODS.some(([m]) => m === f.method)) return "Choose a depreciation method.";
  if (f.method !== "NON" && (!/^\d+$/.test(f.life) || Number(f.life) < 1)) return "Useful life must be a whole number of months.";
  if (f.residual && (!/^\d{1,3}(\.\d{1,2})?$/.test(f.residual) || Number(f.residual) > 100)) return "Residual must be a percentage from 0 to 100.";
  if (f.method === "RB" && (!/^\d{1,3}(\.\d{1,2})?$/.test(f.rate) || Number(f.rate) <= 0 || Number(f.rate) > 100)) return "Reducing balance needs an annual rate above 0 and up to 100.";
  if (f.threshold) { const t = parseMoney(f.threshold); if (t === null || t < 0n) return "The capitalisation threshold must be zero or more."; }
  return null;
}

export function AssetSetupPage() {
  const cats = useListAssetCategoriesQuery();
  const locs = useListAssetLocationsQuery();
  const [createCat] = useCreateAssetCategoryMutation();
  const [createLoc] = useCreateAssetLocationMutation();
  const [dlg, setDlg] = useState<"cat" | "loc" | null>(null);
  const [editing, setEditing] = useState<AssetCategory | null>(null);
  return (
    <>
      <PageHeader title="Asset setup" description="Categories drive depreciation and tracking rules; locations say where assets are." />
      <Card title="Categories">
        <Can permission="assets.category.manage"><div className="mb-2"><Button variant="secondary" onClick={() => setDlg("cat")}>New category</Button></div></Can>
        {cats.isLoading ? <Spinner /> : cats.error ? <ErrorState error={cats.error} onRetry={cats.refetch} /> : !cats.data?.results.length ? <EmptyState title="No categories yet" /> : (
          <ul className="text-sm">{cats.data.results.map((c) => <li key={c.id} className="border-b border-slate-100 py-1">{c.code} — {c.name} · {pretty(c.asset_class)} · {c.depreciation_method === "NON" ? "not depreciated" : `${pretty(c.depreciation_method === "SL" ? "straight_line" : "reducing_balance")} over ${c.useful_life_months} months`} · threshold {formatMoney(c.capitalization_threshold)} {!c.is_active && <Badge tone="slate">Inactive</Badge>} <Can permission="assets.category.manage"><Button variant="secondary" aria-label={`Edit category ${c.code}`} onClick={() => setEditing(c)}>Edit</Button></Can></li>)}</ul>
        )}
      </Card>
      <div className="mt-4"><Card title="Locations">
        <Can permission="assets.location.manage"><div className="mb-2"><Button variant="secondary" onClick={() => setDlg("loc")}>New location</Button></div></Can>
        {locs.isLoading ? <Spinner /> : locs.error ? <ErrorState error={locs.error} onRetry={locs.refetch} /> : !locs.data?.results.length ? <EmptyState title="No locations yet" /> : <ul className="text-sm">{locs.data.results.map((l) => <li key={l.id} className="border-b border-slate-100 py-1">{l.code} — {l.name}</li>)}</ul>}
      </Card></div>
      {editing && <CategoryEditDialog key={editing.id} category={editing} onClose={() => setEditing(null)} />}
      <ActionDialog title="New asset category" open={dlg === "cat"} onClose={() => setDlg(null)} cta="Create category"
        fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "asset_class", label: "Class", required: true, options: ASSET_CLASSES.map((c) => [c, pretty(c)] as [string, string]) }, { name: "depreciation_method", label: "Depreciation", required: true, options: METHODS }, { name: "useful_life_months", label: "Useful life (months)" }, { name: "residual_percent", label: "Residual %" }, { name: "reducing_rate_percent", label: "Annual rate % (reducing balance)" }, { name: "capitalization_threshold", label: "Capitalisation threshold" }, { name: "requires_serial", label: "Serial number required", options: [["no", "No"], ["yes", "Yes"]] }]}
        submit={async (v) => {
          const f = { code: (v.code ?? "").trim(), name: (v.name ?? "").trim(), method: v.depreciation_method ?? "", life: (v.useful_life_months ?? "").trim(), residual: (v.residual_percent ?? "").trim(), rate: (v.reducing_rate_percent ?? "").trim(), threshold: (v.capitalization_threshold ?? "").trim() };
          const p = validateCategory(f); if (p) throw new Error(p);
          await createCat({ code: f.code, name: f.name, asset_class: v.asset_class ?? "FIXED", depreciation_method: f.method, ...(f.life ? { useful_life_months: Number(f.life) } : {}), ...(f.residual ? { residual_percent: f.residual } : {}), ...(f.method === "RB" ? { reducing_rate_percent: f.rate } : {}), ...(f.threshold ? { capitalization_threshold: f.threshold } : {}), requires_serial: v.requires_serial === "yes" }).unwrap();
        }} />
      <ActionDialog title="New asset location" open={dlg === "loc"} onClose={() => setDlg(null)} cta="Create location" fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "parent", label: "Inside", options: [["", "Top level"], ...(locs.data?.results ?? []).map((l) => [l.id, `${l.code} — ${l.name}`] as [string, string])] }]}
        submit={(v) => createLoc({ code: (v.code ?? "").trim(), name: (v.name ?? "").trim(), ...(v.parent ? { parent: v.parent } : {}) }).unwrap()} />
    </>
  );
}

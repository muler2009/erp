import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "react-router";

import { useCreateFixedAssetMutation, useListAssetCategoriesQuery, useListFixedAssetsQuery } from "../../shared/api/endpoints";
import type { FixedAsset } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { Can } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, PageHeader, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export const ASSET_STATUSES = ["REQUESTED", "ORDERED", "RECEIVED", "AVAILABLE", "ASSIGNED", "IN_USE", "UNDER_MAINTENANCE", "TRANSFERRED", "DISPOSED", "RETIRED"];
export const assetTone = (s: string) => (s === "AVAILABLE" || s === "IN_USE" || s === "ASSIGNED" ? "green" : s === "DISPOSED" || s === "RETIRED" ? "slate" : "amber") as "green" | "slate" | "amber";

export function validateAsset(f: { category: string; name: string; purchase_cost: string; acquisition_date: string }): string | null {
  if (!f.category) return "Choose a category.";
  if (!f.name.trim()) return "Enter the asset name.";
  if (f.purchase_cost) { const c = parseMoney(f.purchase_cost); if (c === null || c < 0n) return "The purchase cost must be zero or more."; }
  if (f.acquisition_date && !/^\d{4}-\d{2}-\d{2}$/.test(f.acquisition_date)) return "Enter the acquisition date as a valid date.";
  return null;
}

const columns: ColumnDef<FixedAsset>[] = [
  { header: "Number", cell: ({ row }) => <Link className="text-indigo-700 underline" to={`/app/assets/register/${row.original.id}`}>{row.original.number}</Link> },
  { header: "Name", accessorKey: "name" },
  { header: "Category", cell: ({ row }) => row.original.category.code },
  { header: "Location", cell: ({ row }) => row.original.location?.code ?? "–" },
  { header: "Status", cell: ({ row }) => <Badge tone={assetTone(row.original.status)}>{pretty(row.original.status)}</Badge> },
  { header: "Cost", cell: ({ row }) => formatMoney(row.original.purchase_cost) },
];

export function AssetsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const cats = useListAssetCategoriesQuery();
  const { data, isLoading, error, refetch } = useListFixedAssetsQuery({ q: q.trim() || undefined, status: status || undefined, cursor });
  const [create] = useCreateFixedAssetMutation();
  return (
    <>
      <PageHeader title="Asset register" description="Every fixed asset, its status and where it is." actions={<Can permission="assets.asset.manage"><Button onClick={() => setOpen(true)}>New asset</Button></Can>} />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <FormField label="Search" htmlFor="as-q"><input id="as-q" className={inputClass} value={q} onChange={(e) => { setQ(e.target.value); setCursor(null); }} placeholder="Number, name or serial" /></FormField>
        <FormField label="Status" htmlFor="as-st"><select id="as-st" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{ASSET_STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></FormField>
      </div>
      <DataTable caption="Assets" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No assets found" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <ActionDialog title="New asset" open={open} onClose={() => setOpen(false)} cta="Create asset"
        fields={[{ name: "category", label: "Category", required: true, options: (cats.data?.results ?? []).filter((c) => c.is_active).map((c) => [c.id, `${c.code} — ${c.name}`] as [string, string]) }, { name: "name", label: "Name", required: true }, { name: "purchase_cost", label: "Purchase cost" }, { name: "acquisition_date", label: "Acquisition date", type: "date" }, { name: "manufacturer", label: "Manufacturer" }, { name: "model", label: "Model" }, { name: "serial_number", label: "Serial number" }]}
        submit={async (v) => {
          const f = { category: v.category ?? "", name: (v.name ?? "").trim(), purchase_cost: (v.purchase_cost ?? "").trim(), acquisition_date: v.acquisition_date ?? "" };
          const p = validateAsset(f); if (p) throw new Error(p);
          const body: Record<string, string> = { category: f.category, name: f.name };
          for (const k of ["purchase_cost", "acquisition_date", "manufacturer", "model", "serial_number"] as const) { const val = (k in f ? f[k as keyof typeof f] : v[k]) ?? ""; if (val.trim()) body[k] = val.trim(); }
          await create(body).unwrap();
        }} />
    </>
  );
}

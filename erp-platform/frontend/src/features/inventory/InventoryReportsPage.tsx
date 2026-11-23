import { useState } from "react";

import { useGetInventoryReportQuery, useLazyGetPickSuggestionQuery, useListLocationUtilisationQuery, useListWarehousesQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product } from "../../shared/api/types";
import { downloadCsv } from "../../shared/lib/csvDownload";
import { formatMoney } from "../../shared/lib/money";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const REPORTS: { code: string; label: string; needs?: "product" }[] = [
  { code: "summary", label: "Stock summary" }, { code: "movements", label: "Movements" }, { code: "stock-card", label: "Stock card (one product)", needs: "product" },
  { code: "abc", label: "ABC analysis" }, { code: "turnover", label: "Turnover" }, { code: "adjustments", label: "Adjustments" }, { code: "transfers", label: "Transfers" },
];

const LABELS: Record<string, string> = { sku: "Item", name: "Name", group: "Group", quantity: "Quantity", value: "Value", date: "Date", type: "Type", location: "Location", unit_cost: "Unit cost", ref: "Reference", reason: "Reason", balance: "Balance", consumption_value: "Consumption value", cumulative_pct: "Cumulative %", class: "Class", period_days: "Period (days)", issued_value: "Issued value", inventory_value: "Inventory value", turnover: "Turnover", days_of_inventory: "Days of inventory", number: "Number", delta: "Change", reason_code: "Reason type", status: "Status" };
export const headerFor = (k: string) => LABELS[k] ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const NUMERIC = /^-?\d+(\.\d+)?$/;
export const cell = (v: string | number | null): string => (v === null || v === "" ? "—" : typeof v === "string" && NUMERIC.test(v) && v.includes(".") ? formatMoney(v) : String(v));

export function reportParams(f: { code: string; group_by: string; from: string; to: string; days: string; warehouse: string }): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.code === "summary") p.group_by = f.group_by;
  if (["movements", "stock-card", "adjustments"].includes(f.code)) { if (f.from) p.from = f.from; if (f.to) p.to = f.to; }
  if (["movements", "stock-card"].includes(f.code) && f.warehouse) p.warehouse = f.warehouse;
  if (["abc", "turnover"].includes(f.code)) p.days = /^\d+$/.test(f.days) && Number(f.days) > 0 ? f.days : "365";
  return p;
}
export const pickProblem = (p: Product | null, wh: string, qty: string): string | null => (!p ? "Choose the product." : !wh ? "Choose the warehouse." : !/^\d+(\.\d{1,4})?$/.test(qty.trim()) || Number(qty) <= 0 ? "Quantity must be more than 0." : null);

function ReportTable() {
  const wh = useListWarehousesQuery();
  const [f, setF] = useState({ code: "summary", group_by: "warehouse", from: "", to: "", days: "365", warehouse: "" });
  const [product, setProduct] = useState<Product | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const meta = REPORTS.find((r) => r.code === f.code)!;
  const params = { ...reportParams(f), ...(meta.needs && product ? { product: product.id } : {}) };
  const q = useGetInventoryReportQuery({ name: f.code, params }, { skip: !!meta.needs && !product });
  const cols = q.data?.rows[0] ? Object.keys(q.data.rows[0]) : [];
  const exp = async () => { setErr(null); try { await downloadCsv(`/api/v1/inventory/reports/${f.code}`, { ...params, export: "csv" }, `inventory-${f.code}.csv`); } catch (e) { setErr(e instanceof Error ? e.message : "The export failed."); } };
  const byReason = (q.data?.extra.by_reason ?? null) as Record<string, { count: number; net_value: string }> | null;
  return (
    <Card title="Reports" actions={<Button variant="secondary" onClick={() => void exp()} disabled={!!meta.needs && !product}>Download CSV</Button>}>
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <FormField label="Report" htmlFor="ir-code"><select id="ir-code" className={inputClass} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })}>{REPORTS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</select></FormField>
        {f.code === "summary" && <FormField label="Group by" htmlFor="ir-group"><select id="ir-group" className={inputClass} value={f.group_by} onChange={(e) => setF({ ...f, group_by: e.target.value })}><option value="warehouse">Warehouse</option><option value="location">Location</option><option value="category">Category</option></select></FormField>}
        {["movements", "stock-card", "adjustments"].includes(f.code) && <><FormField label="From" htmlFor="ir-from"><input id="ir-from" type="date" className={inputClass} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></FormField><FormField label="To" htmlFor="ir-to"><input id="ir-to" type="date" className={inputClass} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></FormField></>}
        {["movements", "stock-card"].includes(f.code) && <FormField label="Warehouse" htmlFor="ir-wh"><select id="ir-wh" className={inputClass} value={f.warehouse} onChange={(e) => setF({ ...f, warehouse: e.target.value })}><option value="">All</option>{(wh.data?.results ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></FormField>}
        {["abc", "turnover"].includes(f.code) && <FormField label="Look back (days)" htmlFor="ir-days"><input id="ir-days" className={inputClass} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></FormField>}
      </div>
      {meta.needs && <ProductPicker label="Product" onChange={setProduct} />}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {meta.needs && !product && <p className="text-sm text-slate-600">Choose a product to see its stock card.</p>}
      {q.isFetching && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && !q.isFetching && q.data.rows.length === 0 && <EmptyState title="Nothing to show" hint="No records match these filters." />}
      {q.data && !q.isFetching && q.data.rows.length > 0 && (
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left">{cols.map((c) => <th key={c}>{headerFor(c)}</th>)}</tr></thead>
          <tbody>{q.data.rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{cols.map((c) => <td key={c} className={NUMERIC.test(String(r[c])) ? "text-right" : ""}>{cell(r[c] ?? null)}</td>)}</tr>)}</tbody></table></div>
      )}
      {byReason && <p className="mt-2 text-sm text-slate-600">By reason: {Object.entries(byReason).map(([k, v]) => `${headerFor(k)} ${v.count} (${formatMoney(v.net_value)})`).join("; ")}</p>}
    </Card>
  );
}

function Utilisation() {
  const q = useListLocationUtilisationQuery();
  return (
    <Card title="Location utilisation">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.length === 0 && <EmptyState title="No locations" hint="Add warehouse locations first." />}
      {q.data && q.data.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Warehouse</th><th>Location</th><th className="text-right">Used</th><th className="text-right">Capacity</th><th className="text-right">Full</th></tr></thead>
          <tbody>{q.data.map((r) => <tr key={`${r.warehouse}-${r.location}`} className="border-t border-slate-100"><td>{r.warehouse}</td><td>{r.location}</td><td className="text-right">{formatMoney(r.used)}</td><td className="text-right">{r.capacity ? formatMoney(r.capacity) : "No limit"}</td><td className="text-right">{r.utilisation_pct ? `${formatMoney(r.utilisation_pct)}%` : "—"}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

function Pick() {
  const wh = useListWarehousesQuery();
  const [run, st] = useLazyGetPickSuggestionQuery();
  const [product, setProduct] = useState<Product | null>(null);
  const [f, setF] = useState({ warehouse: "", quantity: "", policy: "FEFO" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = pickProblem(product, f.warehouse, f.quantity);
    if (p) return setErr(p);
    setErr(null);
    const r = await run({ product: product!.id, warehouse: f.warehouse, quantity: f.quantity.trim(), policy: f.policy });
    if (r.error) setErr(errorMessage(r.error));
  };
  return (
    <Card title="Which lots to pick">
      <p className="mb-2 text-sm text-slate-600">Suggests lots for an issue. Oldest expiry first (FEFO) or oldest received first (FIFO). Nothing is issued.</p>
      <ProductPicker label="Lot-tracked product" onChange={setProduct} />
      <FormField label="Warehouse" htmlFor="pk-wh"><select id="pk-wh" className={inputClass} value={f.warehouse} onChange={(e) => setF({ ...f, warehouse: e.target.value })}><option value="">Choose…</option>{(wh.data?.results ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></FormField>
      <FormField label="Quantity needed" htmlFor="pk-qty"><input id="pk-qty" className={inputClass} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></FormField>
      <FormField label="Rule" htmlFor="pk-policy"><select id="pk-policy" className={inputClass} value={f.policy} onChange={(e) => setF({ ...f, policy: e.target.value })}><option value="FEFO">Oldest expiry first</option><option value="FIFO">Oldest received first</option></select></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <Button loading={st.isFetching} onClick={() => void go()}>Suggest lots</Button>
      {st.data && st.data.length === 0 && <p className="mt-2 text-sm">No available lots.</p>}
      {st.data && st.data.length > 0 && <table className="mt-3 w-full text-sm"><thead><tr className="text-left"><th>Lot</th><th>Location</th><th className="text-right">Take</th><th>Expires</th></tr></thead><tbody>{st.data.map((l, i) => <tr key={i}><td>{l.lot_code}</td><td>{l.location}</td><td className="text-right">{formatMoney(l.quantity)}</td><td>{l.expiry_date ?? "—"}</td></tr>)}</tbody></table>}
    </Card>
  );
}

export function InventoryReportsPage() {
  return (<><PageHeader title="Inventory reports" description="Stock summaries, movements, analysis and exports." /><ReportTable /><Utilisation /><Pick /></>);
}

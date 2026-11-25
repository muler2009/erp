import { useState } from "react";

import { useGetSlowMovingQuery, useListExpiredStockQuery, useListReorderNeedsQuery, useListStockAgeingQuery, useListStockAlertRowsQuery, useListWarehousesQuery, useSetReorderRuleMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const ALERT: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate" }> = {
  OUT_OF_STOCK: { label: "Out of stock", tone: "red" }, BELOW_SAFETY: { label: "Below safety stock", tone: "red" }, BELOW_MINIMUM: { label: "Below minimum", tone: "amber" },
  REORDER: { label: "Time to reorder", tone: "amber" }, ABOVE_MAXIMUM: { label: "Above maximum", tone: "slate" }, DISCONTINUED_STOCK: { label: "Discontinued item still in stock", tone: "slate" },
  EXPIRED: { label: "Expired", tone: "red" }, EXPIRING_SOON: { label: "Expiring soon", tone: "amber" },
};
const POS = /^\d+(\.\d{1,4})?$/;

export function reorderProblem(f: { product: Product | null; warehouse: string; min: string; qty: string }): string | null {
  if (!f.product) return "Choose the product.";
  if (!f.warehouse) return "Choose the warehouse.";
  if (!POS.test(f.min.trim())) return "The minimum must be a number such as 10.";
  if (!POS.test(f.qty.trim()) || Number(f.qty) <= 0) return "The order quantity must be more than 0.";
  return null;
}

function Wait({ q }: { q: { isLoading: boolean; error?: unknown; refetch: () => void } }) {
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  return null;
}

function Alerts() {
  const q = useListStockAlertRowsQuery();
  return (
    <Card title="Stock alerts"><Wait q={q} />
      {q.data && q.data.length === 0 && <EmptyState title="No alerts" hint="Every item is within its limits." />}
      {q.data && q.data.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Item</th><th>Alert</th><th className="text-right">On hand</th><th>Detail</th></tr></thead>
          <tbody>{q.data.map((a, i) => { const t = ALERT[a.alert] ?? { label: a.alert, tone: "slate" as const }; return (
            <tr key={i} className="border-t border-slate-100"><td>{a.sku} · {a.name}</td><td><Badge tone={t.tone}>{t.label}</Badge></td><td className="text-right">{formatMoney(a.on_hand ?? a.quantity ?? "0")}</td><td>{a.lot ? `Lot ${a.lot} at ${a.location}, expires ${a.expiry_date}` : a.threshold ? `Limit ${formatMoney(a.threshold)}` : ""}</td></tr>); })}</tbody></table>
      )}
    </Card>
  );
}

function Reorder() {
  const { can } = useAccess();
  const q = useListReorderNeedsQuery();
  const wh = useListWarehousesQuery();
  const [save, st] = useSetReorderRuleMutation();
  const [product, setProduct] = useState<Product | null>(null);
  const [f, setF] = useState({ warehouse: "", min: "", qty: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = reorderProblem({ product, ...f });
    if (p) return setErr(p);
    try { await save({ product: product!.id, warehouse: f.warehouse, min_quantity: f.min.trim(), reorder_quantity: f.qty.trim() }).unwrap(); setErr(null); setF({ warehouse: "", min: "", qty: "" }); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <Card title="Needs reordering"><Wait q={q} />
        {q.data && q.data.length === 0 && <EmptyState title="Nothing to reorder" hint="No item is below its reorder rule." />}
        {q.data && q.data.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Item</th><th>Warehouse</th><th className="text-right">On hand</th><th className="text-right">Minimum</th><th className="text-right">Suggested order</th></tr></thead>
            <tbody>{q.data.map((r) => <tr key={`${r.sku}-${r.warehouse}`} className="border-t border-slate-100"><td>{r.sku}</td><td>{r.warehouse}</td><td className="text-right">{formatMoney(r.on_hand)}</td><td className="text-right">{formatMoney(r.min_quantity)}</td><td className="text-right">{formatMoney(r.suggested_order_quantity)}</td></tr>)}</tbody></table>
        )}
      </Card>
      {can("inventory.product.manage") && (
        <Card title="Set a reorder rule">
          <ProductPicker label="Product" onChange={setProduct} />
          <FormField label="Warehouse" htmlFor="ro-wh"><select id="ro-wh" className={inputClass} value={f.warehouse} onChange={(e) => setF({ ...f, warehouse: e.target.value })}><option value="">Choose…</option>{(wh.data?.results ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></FormField>
          <FormField label="Minimum quantity" htmlFor="ro-min"><input id="ro-min" className={inputClass} value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></FormField>
          <FormField label="Order quantity" htmlFor="ro-qty"><input id="ro-qty" className={inputClass} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></FormField>
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          <Button loading={st.isLoading} onClick={() => void go()}>Save rule</Button>
        </Card>
      )}
    </>
  );
}

function Ageing() {
  const q = useListStockAgeingQuery();
  const cols = q.data?.[0] ? Object.keys(q.data[0].buckets) : [];
  return (
    <Card title="Stock ageing (days in stock)"><Wait q={q} />
      {q.data && q.data.length === 0 && <EmptyState title="No stock" hint="Nothing is in stock to age." />}
      {q.data && q.data.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Item</th>{cols.map((c) => <th key={c} className="text-right">{c}</th>)}<th className="text-right">Oldest (days)</th></tr></thead>
          <tbody>{q.data.map((r) => <tr key={r.sku} className="border-t border-slate-100"><td>{r.sku} · {r.name}</td>{cols.map((c) => <td key={c} className="text-right">{formatMoney(r.buckets[c] ?? "0")}</td>)}<td className="text-right">{r.oldest_days ?? "—"}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

function Slow() {
  const [days, setDays] = useState("90");
  const n = /^\d+$/.test(days) && Number(days) > 0 ? Number(days) : 90;
  const q = useGetSlowMovingQuery(n);
  return (
    <>
      <FormField label="No issues in the last (days)" htmlFor="sm-days"><input id="sm-days" className={`${inputClass} w-28`} value={days} onChange={(e) => setDays(e.target.value)} /></FormField>
      <Card title="Slow-moving and obsolete"><Wait q={q} />
        {q.data && q.data.slow_moving.length === 0 && <EmptyState title="No slow-moving stock" hint="Everything moved recently." />}
        {q.data && q.data.slow_moving.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Item</th><th className="text-right">On hand</th><th>Last issue</th><th className="text-right">Value</th><th>Class</th></tr></thead>
            <tbody>{q.data.slow_moving.map((r) => <tr key={r.sku} className="border-t border-slate-100"><td>{r.sku} · {r.name}</td><td className="text-right">{formatMoney(r.on_hand)}</td><td>{r.last_issue ?? "Never"}</td><td className="text-right">{formatMoney(r.value)}</td><td><Badge tone={r.classification === "OBSOLETE_CANDIDATE" ? "red" : "amber"}>{r.classification === "OBSOLETE_CANDIDATE" ? "Possibly obsolete" : "Slow-moving"}</Badge></td></tr>)}</tbody></table>
        )}
      </Card>
      <Card title="Excess stock">
        {q.data && q.data.excess.length === 0 && <EmptyState title="No excess stock" hint="Stock levels match demand." />}
        {q.data && q.data.excess.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Item</th><th className="text-right">On hand</th><th className="text-right">Excess</th><th>Why</th></tr></thead>
            <tbody>{q.data.excess.map((r) => <tr key={r.sku} className="border-t border-slate-100"><td>{r.sku} · {r.name}</td><td className="text-right">{formatMoney(r.on_hand)}</td><td className="text-right">{formatMoney(r.excess_quantity)}</td><td>{r.reason}</td></tr>)}</tbody></table>
        )}
      </Card>
    </>
  );
}

function Expired() {
  const q = useListExpiredStockQuery();
  return (
    <Card title="Expired stock still on hand"><Wait q={q} />
      {q.data && q.data.length === 0 && <EmptyState title="No expired stock" hint="No lot past its expiry date is on hand." />}
      {q.data && q.data.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Item</th><th>Lot</th><th>Location</th><th className="text-right">Quantity</th><th>Expired on</th></tr></thead>
          <tbody>{q.data.map((r, i) => <tr key={i} className="border-t border-slate-100"><td>{r.sku}</td><td>{r.lot}</td><td>{r.location}</td><td className="text-right">{formatMoney(r.quantity)}</td><td>{r.expiry_date}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

const TABS = [["alerts", "Alerts", Alerts], ["reorder", "Reorder", Reorder], ["ageing", "Ageing", Ageing], ["slow", "Slow-moving", Slow], ["expired", "Expired", Expired]] as const;

export function StockControlPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("alerts");
  const Body = TABS.find((t) => t[0] === tab)![2];
  return (
    <>
      <PageHeader title="Stock control" description="What needs attention: shortages, reordering, ageing, slow movers and expired lots." />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2">{TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 text-sm ${tab === k ? "bg-indigo-600 text-white" : "border border-slate-300 bg-white"}`}>{label}</button>)}</div>
      <Body />
    </>
  );
}

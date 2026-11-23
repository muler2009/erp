import { useState } from "react";

import { useGetMfgConflictsQuery, useGetMfgLoadQuery, useGetMfgScheduleQuery, useGetMfgWipAgingQuery, useGetMfgWipQuery, usePreviewMrpMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const rangeProblem = (from: string, to: string): string | null => (!from || !to ? "Choose both dates." : to < from ? "The end date is before the start date." : null);
export const demandProblem = (rows: { product: Product | null; quantity: string }[]): string | null => {
  if (rows.length === 0) return "Add at least one demand.";
  for (const [i, r] of rows.entries()) {
    if (!r.product) return `Demand ${i + 1}: choose the product.`;
    if (!/^\d+(\.\d{1,4})?$/.test(r.quantity.trim()) || Number(r.quantity) <= 0) return `Demand ${i + 1}: quantity must be more than 0.`;
  }
  return null;
};
const ACTION: Record<string, string> = { MAKE: "Make", BUY: "Buy", SUBCONTRACT: "Subcontract" };

function Wait({ q }: { q: { isLoading?: boolean; isFetching?: boolean; error?: unknown; refetch: () => void } }) {
  if (q.isFetching) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  return null;
}

function Mrp() {
  const [run, st] = usePreviewMrpMutation();
  const [rows, setRows] = useState<{ product: Product | null; quantity: string; date: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = demandProblem(rows);
    if (p) return setErr(p);
    setErr(null);
    try { await run({ demands: rows.map((r) => ({ product: r.product!.id, quantity: r.quantity.trim(), ...(r.date ? { date: r.date } : {}) })) }).unwrap(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="What do I need to make or buy?">
      <p className="mb-2 text-sm text-slate-600">Enter expected demand. Nothing is created: this only shows what stock, bills of materials and lead times imply.</p>
      {rows.map((r, i) => (
        <div key={i} className="mb-1 flex items-center gap-2 text-sm">
          <span className="w-28 truncate">{r.product?.sku}</span>
          <input aria-label={`Demand quantity ${i + 1}`} className={`${inputClass} w-24`} value={r.quantity} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
          <input aria-label={`Demand date ${i + 1}`} type="date" className={`${inputClass} w-40`} value={r.date} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
          <Button variant="secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove demand {i + 1}</Button>
        </div>
      ))}
      <ProductPicker label="Add demand for" onChange={(p) => { if (p) setRows((x) => [...x, { product: p, quantity: "1", date: "" }]); }} />
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <Button loading={st.isLoading} onClick={() => void go()}>Calculate</Button>
      {st.data && st.data.length === 0 && <p className="mt-2 text-sm">Nothing needs to be made or bought. Stock covers the demand.</p>}
      {st.data && st.data.length > 0 && (
        <table className="mt-3 w-full text-sm"><thead><tr className="text-left"><th>Item</th><th>Action</th><th className="text-right">Quantity</th><th>Start by</th><th>Needed by</th></tr></thead>
          <tbody>{st.data.map((s, i) => <tr key={i} className="border-t border-slate-100"><td>{s.sku}</td><td>{ACTION[s.action] ?? s.action}</td><td className="text-right">{formatMoney(s.quantity)}</td><td>{s.start_by}</td><td>{s.need_by}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

function useRange() {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(iso(today));
  const [to, setTo] = useState(iso(new Date(today.getTime() + 14 * 86400000)));
  const problem = rangeProblem(from, to);
  const ui = (
    <div className="mb-3 flex gap-3">
      <FormField label="From" htmlFor="rg-from"><input id="rg-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
      <FormField label="To" htmlFor="rg-to"><input id="rg-to" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
    </div>
  );
  return { from, to, problem, ui };
}

function Load() {
  const r = useRange();
  const q = useGetMfgLoadQuery({ from: r.from, to: r.to }, { skip: !!r.problem });
  const c = useGetMfgConflictsQuery({ from: r.from, to: r.to }, { skip: !!r.problem });
  return (
    <>
      {r.ui}
      {r.problem && <p role="alert" className="mb-2 text-sm text-red-700">{r.problem}</p>}
      <Card title="Work centre load"><Wait q={q} />
        {q.data && q.data.length === 0 && <EmptyState title="No work centres" hint="Add work centres first." />}
        {q.data && q.data.length > 0 && <table className="w-full text-sm"><thead><tr className="text-left"><th>Work centre</th><th className="text-right">Planned h</th><th className="text-right">Capacity h</th><th className="text-right">Used</th><th /></tr></thead>
          <tbody>{q.data.map((x) => <tr key={x.work_center} className="border-t border-slate-100"><td>{x.work_center}</td><td className="text-right">{Number(x.planned_hours)}</td><td className="text-right">{Number(x.capacity_hours)}</td><td className="text-right">{Number(x.utilization_percent)}%</td><td>{x.overloaded && <Badge tone="red">Overloaded</Badge>}</td></tr>)}</tbody></table>}
      </Card>
      <Card title="Days over capacity"><Wait q={c} />
        {c.data && c.data.length === 0 && <EmptyState title="No conflicts" hint="No work centre is booked beyond its daily capacity." />}
        {c.data && c.data.length > 0 && <ul className="text-sm">{c.data.map((x, i) => <li key={i}>{x.date}: {x.work_center} has {Number(x.planned_hours)} h booked, capacity {Number(x.capacity_hours)} h.</li>)}</ul>}
      </Card>
    </>
  );
}

function Schedule() {
  const q = useGetMfgScheduleQuery();
  return (
    <Card title="Production schedule"><Wait q={{ ...q, isFetching: q.isLoading }} />
      {q.data && q.data.length === 0 && <EmptyState title="Nothing scheduled" hint="Released production orders appear here." />}
      {q.data?.map((o) => (
        <div key={o.order} className="mb-3 text-sm"><p className="font-medium">{o.order} · {o.product} · {o.start} to {o.end}</p>
          <ul className="ml-4 list-disc">{o.operations.map((x) => <li key={x.sequence}>{x.sequence}: {x.work_center}{x.start ? `, ${x.start.slice(0, 10)} to ${(x.end ?? "").slice(0, 10)}` : ""}</li>)}</ul></div>
      ))}
    </Card>
  );
}

function Wip() {
  const w = useGetMfgWipQuery();
  const a = useGetMfgWipAgingQuery();
  return (
    <>
      <Card title="Work in progress value"><Wait q={{ ...w, isFetching: w.isLoading }} />
        {w.data && <p className="mb-2 text-sm font-medium">Total: {formatMoney(w.data.total)}</p>}
        {w.data && w.data.orders.length === 0 && <EmptyState title="No work in progress" hint="Nothing is currently being made." />}
        {w.data && w.data.orders.length > 0 && <table className="w-full text-sm"><thead><tr className="text-left"><th>Order</th><th>Product</th><th>Status</th><th className="text-right">Value</th></tr></thead><tbody>{w.data.orders.map((o) => <tr key={o.order} className="border-t border-slate-100"><td>{o.order}</td><td>{o.product}</td><td>{o.status}</td><td className="text-right">{formatMoney(o.wip_value)}</td></tr>)}</tbody></table>}
      </Card>
      <Card title="How long orders have been open"><Wait q={{ ...a, isFetching: a.isLoading }} />
        {a.data && a.data.length === 0 && <EmptyState title="Nothing open" hint="No order is in progress." />}
        {a.data && a.data.length > 0 && <table className="w-full text-sm"><thead><tr className="text-left"><th>Order</th><th>Product</th><th>Now at</th><th className="text-right">Days open</th></tr></thead><tbody>{a.data.map((o) => <tr key={o.order} className="border-t border-slate-100"><td>{o.order}</td><td>{o.product}</td><td>{o.current_operation ? `${o.current_operation} (${o.work_center})` : "—"}</td><td className="text-right">{o.age_days}</td></tr>)}</tbody></table>}
      </Card>
    </>
  );
}

const TABS = [["mrp", "Needs (MRP)", Mrp], ["load", "Capacity", Load], ["schedule", "Schedule", Schedule], ["wip", "Work in progress", Wip]] as const;

export function PlanningPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("mrp");
  const Body = TABS.find((t) => t[0] === tab)![2];
  return (
    <>
      <PageHeader title="Planning and capacity" description="What to make or buy, how busy the work centres are, the schedule, and work in progress." />
      <div role="tablist" className="mb-4 flex gap-2">{TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 text-sm ${tab === k ? "bg-indigo-600 text-white" : "border border-slate-300 bg-white"}`}>{label}</button>)}</div>
      <Body />
    </>
  );
}

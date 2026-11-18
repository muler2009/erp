import { useState } from "react";

import { useGetSalesBacklogQuery, useGetSalesForecastQuery, useGetSalesPerformanceQuery } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const iso = (d: Date) => d.toISOString().slice(0, 10);
export const defaultRange = (today = new Date()): { from: string; to: string } => { const f = new Date(today); f.setDate(f.getDate() - 89); return { from: iso(f), to: iso(today) }; };
export const pct = (v: number | null): string => (v === null ? "–" : `${v}%`);
/** Plain-words reading of the Herfindahl index: how much revenue depends on a few customers. */
export function concentration(hhi: number): string { return hhi >= 2500 ? "Very concentrated: a few customers dominate" : hhi >= 1500 ? "Moderately concentrated" : "Well spread across customers"; }
export const monthLabel = (ym: string): string => { const [y = 0, m = 1] = ym.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" }); };
const Stat = ({ k, v }: { k: string; v: string | number }) => <div><dt className="text-xs text-slate-500">{k}</dt><dd className="text-lg">{v}</dd></div>;

function Performance() {
  const [range, setRange] = useState(defaultRange());
  const bad = !range.from || !range.to || range.to < range.from;
  const { data, isFetching, error, refetch } = useGetSalesPerformanceQuery(range, { skip: bad });
  const trend = Object.entries(data?.trend ?? {});
  const max = Math.max(1, ...trend.map(([, v]) => Number(v)));
  return (
    <Card title="Sales performance">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <FormField label="From" htmlFor="sa-from"><input id="sa-from" type="date" className={inputClass} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></FormField>
        <FormField label="To" htmlFor="sa-to"><input id="sa-to" type="date" className={inputClass} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></FormField>
      </div>
      {bad ? <p role="alert" className="text-sm text-red-700">Choose a start date and an end date that is not before it.</p> : isFetching && !data ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
        <>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat k="Orders" v={data.orders} /><Stat k="Revenue" v={formatMoney(data.revenue)} /><Stat k="Average order" v={formatMoney(data.average_order_value)} /><Stat k="Average discount" v={pct(data.average_discount_percent)} />
            <Stat k="Deals won" v={pct(data.win_rate_percent)} /><Stat k="Days to close a deal" v={data.avg_sales_cycle_days ?? "–"} /><Stat k="Quotes that became orders" v={pct(data.quote_to_order_percent)} /><Stat k="Top 5 customers' share" v={pct(data.top5_share_percent)} />
          </dl>
          <p className="mt-2 text-sm text-slate-600">{data.revenue === "0.00" ? "" : concentration(data.concentration_hhi)}</p>
          <h3 className="mt-4 text-sm font-medium">Revenue by month</h3>
          {trend.length ? (
            <ul className="mt-2 space-y-1 text-sm">{trend.map(([m, v]) => (
              <li key={m} className="flex items-center gap-2"><span className="w-20 shrink-0">{monthLabel(m)}</span><span aria-hidden className="h-3 rounded bg-indigo-500" style={{ width: `${Math.round((Number(v) / max) * 100)}%`, minWidth: "2px" }} /><span>{formatMoney(v)}</span></li>))}</ul>
          ) : <EmptyState title="No orders in this period" />}
          <h3 className="mt-4 text-sm font-medium">Top customers</h3>
          {data.top_customers.length ? <ul className="mt-2 text-sm">{data.top_customers.map((c) => <li key={c.account}>{c.name} · {formatMoney(c.revenue)} ({c.share_percent}%)</li>)}</ul> : <p className="mt-2 text-sm text-slate-500">None yet.</p>}
        </>
      )}
    </Card>
  );
}

function Backlog() {
  const { data, isLoading, error, refetch } = useGetSalesBacklogQuery();
  return (
    <Card title="Order backlog">
      {isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
        <>
          <dl className="mb-3 grid grid-cols-3 gap-3"><Stat k="Open orders" v={data.orders} /><Stat k="Still to deliver" v={formatMoney(data.to_deliver)} /><Stat k="Still to invoice" v={formatMoney(data.to_invoice)} /></dl>
          {data.oldest.length ? (
            <table className="min-w-full text-sm"><caption className="sr-only">Oldest open orders</caption><thead><tr className="text-left text-slate-500"><th className="py-1">Order</th><th>Customer</th><th className="text-right">Days open</th><th className="text-right">To deliver</th><th className="text-right">To invoice</th></tr></thead>
              <tbody>{data.oldest.map((o) => <tr key={o.order} className="border-t border-slate-100"><td className="py-1">{o.order}</td><td>{o.customer}</td><td className="text-right">{o.age_days}</td><td className="text-right">{formatMoney(o.to_deliver)}</td><td className="text-right">{formatMoney(o.to_invoice)}</td></tr>)}</tbody></table>
          ) : <EmptyState title="No open orders" />}
        </>
      )}
    </Card>
  );
}

function Forecast() {
  const [months, setMonths] = useState(3);
  const { data, isLoading, error, refetch } = useGetSalesForecastQuery({ months });
  return (
    <Card title="What we expect to sell">
      <FormField label="Months ahead" htmlFor="sf-months"><select id="sf-months" className={`${inputClass} w-auto`} value={months} onChange={(e) => setMonths(Number(e.target.value))}>{[1, 2, 3, 6, 12].map((n) => <option key={n} value={n}>{n}</option>)}</select></FormField>
      {isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
        <>
          <p className="mb-3 text-sm text-slate-600">Orders already received plus the open pipeline, in three cases. The usual monthly pace is {formatMoney(data.monthly_run_rate)}, or {formatMoney(data.run_rate_over_horizon)} over the period.</p>
          <dl className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4"><Stat k="Already ordered" v={formatMoney(data.backlog)} /><Stat k="Cautious" v={formatMoney(data.worst)} /><Stat k="Most likely" v={formatMoney(data.likely)} /><Stat k="Optimistic" v={formatMoney(data.best)} /></dl>
          {Object.keys(data.pipeline_by_month).length > 0 && (
            <table className="min-w-full text-sm"><caption className="sr-only">Pipeline by month</caption><thead><tr className="text-left text-slate-500"><th className="py-1">Month</th><th className="text-right">Cautious</th><th className="text-right">Most likely</th><th className="text-right">Optimistic</th></tr></thead>
              <tbody>{Object.entries(data.pipeline_by_month).map(([m, v]) => <tr key={m} className="border-t border-slate-100"><td className="py-1">{monthLabel(m)}</td><td className="text-right">{formatMoney(v.worst)}</td><td className="text-right">{formatMoney(v.likely)}</td><td className="text-right">{formatMoney(v.best)}</td></tr>)}</tbody></table>
          )}
        </>
      )}
    </Card>
  );
}

export function SalesAnalyticsPage() {
  return (
    <>
      <PageHeader title="Sales analytics" description="How sales are going, what is waiting to ship, and what to expect." />
      <Performance /><Backlog /><Forecast />
    </>
  );
}

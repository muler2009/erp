import { useState } from "react";
import { Link } from "react-router";

import { useGetDeliveryPerformanceQuery, useListDeliveriesQuery, useListSalesOrdersQuery } from "../../shared/api/endpoints";
import type { Delivery } from "../../shared/api/types";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const DELIVERY_STATUS: Record<Delivery["status"], { label: string; tone: "green" | "red" | "amber" }> = { DISPATCHED: { label: "In transit", tone: "amber" }, DELIVERED: { label: "Delivered", tone: "green" }, FAILED: { label: "Failed", tone: "red" } };

/** Late when still in transit and the promised date has passed. */
export const isLate = (d: Pick<Delivery, "status" | "expected_date">, today = new Date().toISOString().slice(0, 10)): boolean => d.status === "DISPATCHED" && !!d.expected_date && d.expected_date < today;

function Performance() {
  const [range, setRange] = useState({ from: "", to: "" });
  const bad = range.from && range.to && range.to < range.from;
  const { data, isLoading, error, refetch } = useGetDeliveryPerformanceQuery(bad ? { from: "", to: "" } : range);
  return (
    <Card title="How deliveries are going">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <FormField label="From" htmlFor="dl-from"><input id="dl-from" type="date" className={inputClass} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></FormField>
        <FormField label="To" htmlFor="dl-to"><input id="dl-to" type="date" className={inputClass} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></FormField>
      </div>
      {bad && <p role="alert" className="mb-2 text-sm text-red-700">The end date is before the start date.</p>}
      {isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
        <>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <div><dt className="text-xs text-slate-500">Deliveries</dt><dd className="text-lg">{data.total}</dd></div>
            <div><dt className="text-xs text-slate-500">On time</dt><dd className="text-lg">{data.on_time_percent === null ? "–" : `${data.on_time_percent}%`}</dd></div>
            <div><dt className="text-xs text-slate-500">Average days in transit</dt><dd className="text-lg">{data.avg_transit_days ?? "–"}</dd></div>
            <div><dt className="text-xs text-slate-500">Late right now</dt><dd className="text-lg">{data.late_now}</dd></div>
            <div><dt className="text-xs text-slate-500">Problems on arrival</dt><dd className="text-lg">{data.discrepancies}</dd></div>
          </dl>
          {Object.keys(data.by_carrier).length > 0 && (
            <ul className="mt-3 text-sm">{Object.entries(data.by_carrier).map(([c, v]) => <li key={c}>{c}: {v.deliveries} deliveries, {v.failed} failed</li>)}</ul>
          )}
        </>
      )}
    </Card>
  );
}

export function DeliveriesPage() {
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListDeliveriesQuery({ cursor, status });
  const orders = useListSalesOrdersQuery({});
  const orderNo = (id: string) => orders.data?.results.find((o) => o.id === id)?.number ?? `Order ${id.slice(0, 8)}`;
  return (
    <>
      <PageHeader title="Deliveries" description="Goods that have left the warehouse and where they are now." />
      <Performance />
      <Card title="Deliveries">
        <FormField label="Status" htmlFor="dl-status">
          <select id="dl-status" className={`${inputClass} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}>
            <option value="">All</option>{Object.entries(DELIVERY_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </FormField>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No deliveries" hint="Dispatch goods from a confirmed sales order." /> : (
          <>
            <table className="min-w-full text-sm"><caption className="sr-only">Deliveries</caption>
              <thead><tr className="text-left text-slate-500"><th className="py-1">Delivery</th><th>Order</th><th>Status</th><th>Dispatched</th><th>Expected</th><th>Carrier</th><th>Tracking</th></tr></thead>
              <tbody>{data.results.map((d) => (
                <tr key={d.id} className="border-t border-slate-100"><td className="py-1"><Link className="text-indigo-700 underline" to={`/app/sales/deliveries/${d.id}`}>{d.number}</Link></td><td>{orderNo(d.order)}</td>
                  <td><Badge tone={DELIVERY_STATUS[d.status].tone}>{DELIVERY_STATUS[d.status].label}</Badge>{isLate(d) && <Badge tone="red">Late</Badge>}{d.discrepancies.length > 0 && <Badge tone="amber">Problem reported</Badge>}</td>
                  <td>{d.delivery_date}</td><td>{d.expected_date ?? "–"}</td><td>{d.carrier || "–"}</td><td>{d.tracking_ref || "–"}</td></tr>))}</tbody></table>
            <div className="mt-2 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{data.next && <Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button>}</div>
          </>
        )}
      </Card>
    </>
  );
}

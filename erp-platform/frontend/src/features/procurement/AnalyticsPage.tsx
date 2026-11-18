import { useState } from "react";

import { useGetPriceVarianceQuery, useGetProcCycleTimesQuery, useGetProcSpendQuery, useGetSupplierPerformanceQuery } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { defaultRange } from "../sales/AnalyticsPage";

export const pct = (v: string | null): string => (v === null ? "–" : `${v}%`);
export const GROUPS: [string, string][] = [["supplier", "Supplier"], ["category", "Supplier category"], ["month", "Month"]];

function Perf({ range }: { range: { from: string; to: string } }) {
  const q = useGetSupplierPerformanceQuery(range);
  return (
    <Card title="Supplier performance">
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="No supplier activity in this period" /> : (
        <table className="w-full text-sm"><caption className="sr-only">Supplier performance</caption>
          <thead><tr className="text-left text-slate-500"><th>Supplier</th><th className="text-right">Orders</th><th className="text-right">On time</th><th className="text-right">Rejected</th><th className="text-right">Rejected or returned</th><th className="text-right">Claims</th><th className="text-right">Claimed</th></tr></thead>
          <tbody>{(q.data ?? []).map((r) => <tr key={r.supplier} className="border-t border-slate-100"><td className="py-1">{r.supplier}</td><td className="text-right">{r.orders}</td><td className="text-right">{pct(r.on_time_pct)}</td><td className="text-right">{pct(r.rejection_pct)}</td><td className="text-right">{pct(r.defect_pct)}</td><td className="text-right">{r.claims}</td><td className="text-right">{formatMoney(r.claimed)}</td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

function Spend({ range }: { range: { from: string; to: string } }) {
  const [group, setGroup] = useState("supplier");
  const q = useGetProcSpendQuery({ ...range, group_by: group });
  return (
    <Card title="Spending">
      <div className="mb-3 max-w-xs"><FormField label="Group by" htmlFor="pa-group"><select id="pa-group" className={inputClass} value={group} onChange={(e) => setGroup(e.target.value)}>{GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField></div>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="No orders in this period" /> : (
        <table className="w-full text-sm"><caption className="sr-only">Spending</caption>
          <thead><tr className="text-left text-slate-500"><th>{GROUPS.find(([k]) => k === group)?.[1]}</th><th>Currency</th><th className="text-right">Orders</th><th className="text-right">Ordered</th></tr></thead>
          <tbody>{(q.data ?? []).map((r) => <tr key={`${r.key}-${r.currency}`} className="border-t border-slate-100"><td className="py-1">{r.key}</td><td>{r.currency}</td><td className="text-right">{r.orders}</td><td className="text-right">{formatMoney(r.ordered)}</td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

function Cycle({ range }: { range: { from: string; to: string } }) {
  const q = useGetProcCycleTimesQuery(range);
  const d = q.data;
  return (
    <Card title="How long things take">
      {q.isLoading ? <Spinner /> : q.isError || !d ? <ErrorState error={q.error ?? new Error("Could not load.")} onRetry={() => void q.refetch()} /> : (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-slate-500">Request approved to order placed</dt><dd className="text-lg">{d.requisition_to_po_days === null ? "–" : `${d.requisition_to_po_days} days`}</dd><dd className="text-xs text-slate-500">{d.samples.requisition_to_po} orders measured</dd></div>
          <div><dt className="text-xs text-slate-500">Order placed to goods received</dt><dd className="text-lg">{d.po_to_receipt_days === null ? "–" : `${d.po_to_receipt_days} days`}</dd><dd className="text-xs text-slate-500">{d.samples.po_to_receipt} receipts measured</dd></div>
        </dl>
      )}
    </Card>
  );
}

function Variance({ range }: { range: { from: string; to: string } }) {
  const q = useGetPriceVarianceQuery(range);
  return (
    <Card title="Price against estimate">
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="Nothing to compare" hint="Only order lines raised from a request with an estimated price appear here." /> : (
        <table className="w-full text-sm"><caption className="sr-only">Price against estimate</caption>
          <thead><tr className="text-left text-slate-500"><th>Order</th><th>Line</th><th className="text-right">Estimated</th><th className="text-right">Paid</th><th className="text-right">Difference</th></tr></thead>
          <tbody>{(q.data ?? []).map((r) => { const v = r.variance_pct === null ? null : Number(r.variance_pct); return <tr key={`${r.po}-${r.line}`} className="border-t border-slate-100"><td className="py-1">{r.po}</td><td>{r.line}</td><td className="text-right">{formatMoney(r.estimated)}</td><td className="text-right">{formatMoney(r.actual)}</td><td className={`text-right ${v !== null && v > 0 ? "text-red-700" : v !== null && v < 0 ? "text-green-700" : ""}`}>{v === null ? "–" : `${v > 0 ? "+" : ""}${r.variance_pct}%`}</td></tr>; })}</tbody>
        </table>
      )}
    </Card>
  );
}

export function ProcurementAnalyticsPage() {
  const [range, setRange] = useState(defaultRange());
  const bad = !range.from || !range.to || range.to < range.from;
  return (
    <div>
      <PageHeader title="Procurement analytics" description="How suppliers perform and where the money goes." />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <FormField label="From" htmlFor="pa-from"><input id="pa-from" type="date" className={inputClass} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></FormField>
        <FormField label="To" htmlFor="pa-to"><input id="pa-to" type="date" className={inputClass} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></FormField>
      </div>
      {bad ? <p role="alert" className="text-sm text-red-700">Choose a start date and an end date that is not before it.</p> : <><Cycle range={range} /><Perf range={range} /><Spend range={range} /><Variance range={range} /></>}
    </div>
  );
}

import { useState, type ReactNode } from "react";

import { useGetSalesSummaryQuery, useGetSpendReportQuery, useListCrmSegmentsQuery } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export function periodProblem(from: string, to: string): string | null {
  if (!from || !to) return "Choose both dates.";
  return from > to ? "The start date is after the end date." : null;
}

const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1, 12).toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

function Period({ from, to, setFrom, setTo, problem }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; problem: string | null }) {
  return (
    <Card>
      <div className="flex flex-wrap gap-3">
        <FormField label="From" htmlFor="rp-from"><input id="rp-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
        <FormField label="To" htmlFor="rp-to"><input id="rp-to" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
      </div>
      {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
    </Card>
  );
}

function Table({ caption, head, children }: { caption: string; head: [string, boolean?][]; children: ReactNode }) {
  return (
    <table className="w-full text-sm"><caption className="sr-only">{caption}</caption>
      <thead><tr className="text-left text-slate-500">{head.map(([h, right]) => <th key={h} className={right ? "text-right" : ""}>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody></table>
  );
}

export function CrmSegmentsPage() {
  const q = useListCrmSegmentsQuery();
  const total = (q.data ?? []).reduce((t, r) => t + r.accounts, 0);
  return (
    <>
      <PageHeader title="Customer segments" description="How many customer accounts sit in each segment." />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data?.length ? <EmptyState title="No segments yet" hint="Give accounts a segment and they are counted here." /> : (
        <Card title={`${q.data.length} segments · ${total} accounts`}>
          <Table caption="Segments" head={[["Segment"], ["Accounts", true]]}>{q.data.map((r) => <tr key={r.segment} className="border-t border-slate-100"><td>{r.segment}</td><td className="text-right">{r.accounts}</td></tr>)}</Table>
        </Card>
      )}
    </>
  );
}

export function SalesSummaryPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const problem = periodProblem(from, to);
  const q = useGetSalesSummaryQuery({ from, to }, { skip: !!problem });
  return (
    <>
      <PageHeader title="Sales summary" description="Confirmed, delivered and invoiced orders in the period, by customer and by product." />
      <Period from={from} to={to} setFrom={setFrom} setTo={setTo} problem={problem} />
      {!problem && (q.isFetching ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : q.data && (q.data.by_customer.length === 0 ? <EmptyState title="No orders in this period" /> : (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <Card title="By customer"><Table caption="Sales by customer" head={[["Customer"], ["Orders", true], ["Total", true]]}>{q.data.by_customer.map((r) => <tr key={`${r.customer}-${r.currency}`} className="border-t border-slate-100"><td>{r.customer}</td><td className="text-right">{r.orders}</td><td className="text-right">{formatMoney(r.total)} {r.currency}</td></tr>)}</Table></Card>
          <Card title="By product"><Table caption="Sales by product" head={[["Product"], ["Quantity", true], ["Revenue", true]]}>{q.data.by_product.map((r) => <tr key={`${r.sku}-${r.currency}`} className="border-t border-slate-100"><td>{r.sku}</td><td className="text-right">{Number(r.quantity)}</td><td className="text-right">{formatMoney(r.revenue)} {r.currency}</td></tr>)}</Table></Card>
        </div>
      )))}
    </>
  );
}

export function SpendReportPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const problem = periodProblem(from, to);
  const q = useGetSpendReportQuery({ from, to }, { skip: !!problem });
  return (
    <>
      <PageHeader title="Spend by supplier" description="Purchase orders placed in the period (drafts, pending approval and cancelled are left out)." />
      <Period from={from} to={to} setFrom={setFrom} setTo={setTo} problem={problem} />
      {!problem && (q.isFetching ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : q.data && (q.data.length === 0 ? <EmptyState title="No purchases in this period" /> : (
        <div className="mt-3"><Card><Table caption="Spend by supplier" head={[["Supplier"], ["Ordered", true], ["Invoiced", true]]}>{q.data.map((r) => <tr key={`${r.supplier}-${r.currency}`} className="border-t border-slate-100"><td>{r.supplier}</td><td className="text-right">{formatMoney(r.ordered)} {r.currency}</td><td className="text-right">{formatMoney(r.invoiced)} {r.currency}</td></tr>)}</Table></Card></div>
      )))}
    </>
  );
}

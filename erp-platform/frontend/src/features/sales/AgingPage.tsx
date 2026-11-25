import { useState } from "react";

import { useGetReceivablesAgingQuery } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const BUCKETS: [string, string][] = [["current", "Not yet due"], ["1-30", "1–30 days late"], ["31-60", "31–60 days"], ["61-90", "61–90 days"], ["90+", "Over 90 days"]];

export function AgingPage() {
  const [asOf, setAsOf] = useState("");
  const q = useGetReceivablesAgingQuery(asOf ? { as_of: asOf } : undefined);
  const d = q.data;
  return (
    <div>
      <PageHeader title="Receivables aging" description="What customers owe, grouped by how late it is." />
      <div className="mb-4 max-w-xs"><FormField label="As of" htmlFor="ag-date"><input id="ag-date" type="date" className={inputClass} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></FormField></div>
      {q.isLoading ? <Spinner /> : q.isError || !d ? <ErrorState error={q.error ?? new Error("The aging report could not be loaded.")} onRetry={() => void q.refetch()} /> : d.customers.length === 0 ? <EmptyState title="Nothing outstanding" hint={`No customer owed money on ${d?.as_of}.`} /> : (
        <Card title={`Outstanding on ${d.as_of} (${d.currency})`}>
          <table className="w-full text-sm"><caption className="sr-only">Receivables by customer and lateness</caption>
            <thead><tr className="text-left text-slate-500"><th>Customer</th>{BUCKETS.map(([, l]) => <th key={l} className="text-right">{l}</th>)}<th className="text-right">Total</th></tr></thead>
            <tbody>{d.customers.map((c) => (
              <tr key={c.account} className="border-t border-slate-100"><td className="py-1">{c.customer}</td>{BUCKETS.map(([k]) => <td key={k} className="text-right">{formatMoney(c[k])}</td>)}<td className="text-right font-medium">{formatMoney(c.total)}</td></tr>
            ))}</tbody>
            <tfoot><tr className="border-t-2 border-slate-300 font-semibold"><td className="py-1">All customers</td>{BUCKETS.map(([k]) => <td key={k} className="text-right">{formatMoney(d.totals[k])}</td>)}<td className="text-right">{formatMoney(d.total)}</td></tr></tfoot>
          </table>
        </Card>
      )}
    </div>
  );
}

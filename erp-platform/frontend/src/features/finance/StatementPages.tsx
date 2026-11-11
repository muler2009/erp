import { useState } from "react";

import { useGetBalanceSheetQuery, useGetProfitLossQuery } from "../../shared/api/endpoints";
import type { ReportRow } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { Badge, Card, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const today = () => new Date().toISOString().slice(0, 10);
const yearStart = () => `${new Date().getFullYear()}-01-01`;

function Section({ title, rows, total, totalLabel }: { title: string; rows: ReportRow[]; total: string; totalLabel: string }) {
  return (
    <tbody>
      <tr><th scope="rowgroup" colSpan={2} className="bg-slate-50 px-2 py-1 text-left">{title}</th></tr>
      {rows.map((r) => <tr key={r.code} className="border-t border-slate-100"><td className="px-2 py-1">{r.code} {r.name}</td><td className="px-2 py-1 text-right">{formatMoney(r.amount)}</td></tr>)}
      <tr className="border-t border-slate-300 font-semibold"><td className="px-2 py-1">{totalLabel}</td><td className="px-2 py-1 text-right">{formatMoney(total)}</td></tr>
    </tbody>
  );
}

export function ProfitLossPage() {
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(today);
  const invalid = !from || !to || from > to;
  const { data, isFetching, error, refetch } = useGetProfitLossQuery({ from, to }, { skip: invalid });
  return (
    <>
      <PageHeader title="Profit and loss" description="Revenue less expenses from posted entries in the period." />
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">From <input type="date" className={`${inputClass} w-auto`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="flex items-center gap-2">To <input type="date" className={`${inputClass} w-auto`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {invalid && <p role="alert" className="text-sm text-red-700">Choose a start date that is on or before the end date.</p>}
      {isFetching && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && !isFetching && !invalid && (
        <Card>
          <table className="min-w-full text-sm">
            <caption className="sr-only">Profit and loss {data.from} to {data.to}</caption>
            <Section title="Revenue" rows={data.revenue} total={data.total_revenue} totalLabel="Total revenue" />
            <Section title="Expenses" rows={data.expenses} total={data.total_expenses} totalLabel="Total expenses" />
            <tfoot><tr className="border-t-2 border-slate-300 font-semibold"><td className="px-2 py-1">Net profit</td><td className="px-2 py-1 text-right">{formatMoney(data.net_profit)}</td></tr></tfoot>
          </table>
        </Card>
      )}
    </>
  );
}

export function BalanceSheetPage() {
  const [asOf, setAsOf] = useState(today);
  const { data, isFetching, error, refetch } = useGetBalanceSheetQuery({ asOf }, { skip: !asOf });
  return (
    <>
      <PageHeader title="Balance sheet" description="Assets, liabilities and equity from posted entries." />
      <label className="mb-4 flex items-center gap-2 text-sm">As of <input type="date" className={`${inputClass} w-auto`} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
      {isFetching && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && !isFetching && (
        <Card>
          <table className="min-w-full text-sm">
            <caption className="sr-only">Balance sheet as of {data.as_of}</caption>
            <Section title="Assets" rows={data.assets} total={data.total_assets} totalLabel="Total assets" />
            <Section title="Liabilities" rows={data.liabilities} total={data.total_liabilities} totalLabel="Total liabilities" />
            <Section title="Equity" rows={[...data.equity, { code: "", name: "Current earnings (unclosed)", amount: data.current_earnings }]} total={data.total_equity} totalLabel="Total equity" />
            <tfoot><tr className="border-t-2 border-slate-300 font-semibold"><td className="px-2 py-1">Liabilities + equity vs assets <Badge tone={data.balanced ? "green" : "red"}>{data.balanced ? "Balanced" : "Out of balance"}</Badge></td><td /></tr></tfoot>
          </table>
        </Card>
      )}
    </>
  );
}

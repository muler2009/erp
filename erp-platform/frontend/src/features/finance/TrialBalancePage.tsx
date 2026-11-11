import { useState } from "react";

import { useGetTrialBalanceQuery } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export function TrialBalancePage() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const { data, isFetching, error, refetch } = useGetTrialBalanceQuery({ asOf }, { skip: !asOf });
  return (
    <>
      <PageHeader title="Trial balance" description="Posted entries up to the chosen date." />
      <label className="mb-4 flex items-center gap-2 text-sm">As of
        <input type="date" className={`${inputClass} w-auto`} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </label>
      {isFetching && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && !isFetching && (
        <Card>
          {data.rows.length === 0 ? <EmptyState title="No posted entries up to this date" /> : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Trial balance as of {data.as_of}</caption>
                <thead><tr><th scope="col" className="px-2 py-1 text-left">Account</th><th scope="col" className="px-2 py-1 text-right">Debit</th><th scope="col" className="px-2 py-1 text-right">Credit</th></tr></thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.code} className="border-t border-slate-100">
                      <td className="px-2 py-1">{r.code} {r.name}</td>
                      <td className="px-2 py-1 text-right">{r.balance_debit === "0.0000" || r.balance_debit === "0" ? "" : formatMoney(r.balance_debit)}</td>
                      <td className="px-2 py-1 text-right">{r.balance_credit === "0.0000" || r.balance_credit === "0" ? "" : formatMoney(r.balance_credit)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-semibold">
                    <td className="px-2 py-1">Total <Badge tone={data.balanced ? "green" : "red"}>{data.balanced ? "Balanced" : "Out of balance"}</Badge></td>
                    <td className="px-2 py-1 text-right">{formatMoney(data.total_debit)}</td>
                    <td className="px-2 py-1 text-right">{formatMoney(data.total_credit)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

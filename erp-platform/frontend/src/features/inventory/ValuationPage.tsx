import { useGetValuationQuery, useListStockAlertsQuery } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";

const alertTone = (a: string) => (a === "OUT_OF_STOCK" || a === "BELOW_SAFETY" ? "red" : a === "BELOW_MINIMUM" || a === "REORDER" ? "amber" : "slate");

export function ValuationPage() {
  const v = useGetValuationQuery();
  const a = useListStockAlertsQuery();
  return (
    <>
      <PageHeader title="Inventory valuation" description="Current value of stock on hand at average cost." />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Card title="Value by product">
            {v.isLoading && <Spinner />}
            {v.error && <ErrorState error={v.error} onRetry={v.refetch} />}
            {v.data && (v.data.rows.length === 0 ? <EmptyState title="No stock to value" /> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Inventory valuation</caption>
                  <thead><tr><th scope="col" className="px-2 py-1 text-left">Product</th><th scope="col" className="px-2 py-1 text-right">Quantity</th><th scope="col" className="px-2 py-1 text-right">Average cost</th><th scope="col" className="px-2 py-1 text-right">Value</th></tr></thead>
                  <tbody>{v.data.rows.map((r) => <tr key={r.sku} className="border-t border-slate-100"><td className="px-2 py-1">{r.sku} {r.name}</td><td className="px-2 py-1 text-right">{formatMoney(r.quantity)}</td><td className="px-2 py-1 text-right">{formatMoney(r.average_cost)}</td><td className="px-2 py-1 text-right">{formatMoney(r.value)}</td></tr>)}</tbody>
                  <tfoot><tr className="border-t-2 border-slate-300 font-semibold"><td className="px-2 py-1" colSpan={3}>Total</td><td className="px-2 py-1 text-right">{formatMoney(v.data.total_value)}</td></tr></tfoot>
                </table>
              </div>
            ))}
          </Card>
        </div>
        <Card title="Stock alerts">
          {a.isLoading && <Spinner />}
          {a.error && <ErrorState error={a.error} onRetry={a.refetch} />}
          {a.data && a.data.length === 0 && <EmptyState title="No alerts" hint="Stock levels are within their limits." />}
          <ul className="space-y-2 text-sm">
            {a.data?.map((x, i) => <li key={`${x.sku}-${x.alert}-${i}`} className="flex items-start justify-between gap-2"><span>{x.sku} {x.name}<br /><span className="text-xs text-slate-500">on hand {formatMoney(x.on_hand)}{x.threshold ? ` · limit ${formatMoney(x.threshold)}` : ""}</span></span><Badge tone={alertTone(x.alert)}>{x.alert.toLowerCase().replace(/_/g, " ")}</Badge></li>)}
          </ul>
        </Card>
      </div>
    </>
  );
}

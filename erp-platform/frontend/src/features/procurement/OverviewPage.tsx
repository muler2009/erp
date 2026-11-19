import { Link } from "react-router";

import { useGetProcWorkQueueQuery, useListOverdueDeliveriesQuery } from "../../shared/api/endpoints";
import type { ProcWorkQueue } from "../../shared/api/types";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";

/** Each work-queue count, in plain words, with the screen that handles it (if one exists yet). */
export const QUEUE: { key: keyof ProcWorkQueue; label: string; to?: string }[] = [
  { key: "open_requisitions", label: "Requests being processed", to: "/app/procurement/requisitions" },
  { key: "orders_awaiting_approval", label: "Orders waiting for approval", to: "/app/procurement/purchase-orders" },
  { key: "overdue_delivery_lines", label: "Late delivery lines" },
  { key: "pending_inspections", label: "Received goods waiting for inspection", to: "/app/procurement/receiving" },
  { key: "match_exceptions", label: "Invoices that do not match", to: "/app/procurement/match-exceptions" },
  { key: "contracts_expiring_60d", label: "Contracts ending within 60 days", to: "/app/procurement/contracts" },
  { key: "open_claims", label: "Open claims against suppliers", to: "/app/procurement/returns" },
  { key: "returns_awaiting_credit", label: "Returns waiting for a supplier credit", to: "/app/procurement/returns" },
  { key: "supplier_documents_expiring_30d", label: "Supplier documents expiring within 30 days", to: "/app/procurement/supplier-risk" },
];

export function ProcurementOverviewPage() {
  const q = useGetProcWorkQueueQuery();
  const late = useListOverdueDeliveriesQuery();
  return (
    <div>
      <PageHeader title="Procurement overview" description="What needs attention in purchasing today." actions={<Link className="text-sm text-blue-700 underline" to="/app/procurement/analytics">Analytics</Link>} />
      {q.isLoading ? <Spinner /> : q.isError || !q.data ? <ErrorState error={q.error ?? new Error("Could not load.")} onRetry={() => void q.refetch()} /> : (
        <ul className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3">
          {QUEUE.map((i) => {
            const n = q.data![i.key];
            const body = <><span className="text-2xl font-semibold">{n}</span><span className="block text-sm text-slate-600">{i.label}</span></>;
            return <li key={i.key} className={`rounded border p-3 ${n > 0 ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}>{i.to ? <Link to={i.to} className="block">{body}</Link> : body}</li>;
          })}
        </ul>
      )}
      <Card title="Late deliveries">
        {late.isLoading ? <Spinner /> : late.isError ? <ErrorState error={late.error} onRetry={() => void late.refetch()} /> : (late.data ?? []).length === 0 ? <EmptyState title="Nothing is late" hint="Every scheduled delivery has arrived or is not yet due." /> : (
          <table className="w-full text-sm"><caption className="sr-only">Late delivery lines</caption>
            <thead><tr className="text-left text-slate-500"><th>Order</th><th>Supplier</th><th>Line</th><th className="text-right">Still to arrive</th><th>Was due</th><th>Late by</th></tr></thead>
            <tbody>{(late.data ?? []).map((r) => (
              <tr key={`${r.po}-${r.line}`} className="border-t border-slate-100"><td className="py-1">{r.po}</td><td>{r.supplier}</td><td>{r.line}</td><td className="text-right">{Number(r.open_quantity)}</td><td>{r.due_date}</td><td><Badge tone={r.days_late > 14 ? "red" : "amber"}>{r.days_late} day{r.days_late === 1 ? "" : "s"}</Badge></td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

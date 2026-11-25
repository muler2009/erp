import { useState } from "react";
import { Link } from "react-router";

import { useListBackordersQuery, useRetryBackordersMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";

export function BackordersPage() {
  const { can } = useAccess();
  const q = useListBackordersQuery();
  const [retry, { isLoading }] = useRetryBackordersMutation();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setMsg(null);
    try {
      const r = await retry().unwrap();
      setMsg({ ok: true, text: r.lines_filled === 0 ? "Nothing could be filled yet — there is still no stock for these items." : `${r.lines_filled} order line${r.lines_filled === 1 ? "" : "s"} filled from new stock.` });
    } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); }
  };
  return (
    <div>
      <PageHeader title="Backorders" description="Items customers ordered that we could not ship yet." actions={can("sales.delivery.manage") ? <Button loading={isLoading} onClick={() => void run()}>Retry backorders</Button> : undefined} />
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mb-3 text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</p>}
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error ?? new Error("Backorders could not be loaded.")} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="No backorders" hint="Everything ordered has been covered by stock." /> : (
        <Card title="Waiting for stock">
          <table className="w-full text-sm"><caption className="sr-only">Backordered items</caption>
            <thead><tr className="text-left text-slate-500"><th>Order</th><th>Item</th><th className="text-right">Ordered</th><th className="text-right">Waiting</th><th>Since</th></tr></thead>
            <tbody>{(q.data ?? []).map((b) => (
              <tr key={b.line} className="border-t border-slate-100"><td className="py-1"><Link className="text-blue-700 underline" to="/app/sales/orders">{b.order}</Link></td><td>{b.product}</td><td className="text-right">{b.ordered}</td><td className="text-right font-medium">{b.backordered}</td><td>{b.since}</td></tr>
            ))}</tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

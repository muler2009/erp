import { useState } from "react";

import { useGetFulfilmentBoardQuery, useGetWarehouseAvailabilityQuery } from "../../shared/api/endpoints";
import type { Product } from "../../shared/api/types";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";

export const FULFILMENT: Record<string, { label: string; tone: "green" | "amber" | "red" }> = { READY: { label: "Ready to ship", tone: "green" }, PARTIAL: { label: "Partly covered", tone: "amber" }, SHORT: { label: "Short of stock", tone: "red" } };
const COLS: [string, string][] = [["on_hand", "On hand"], ["reserved", "Reserved"], ["quarantined", "On hold"], ["in_transit", "In transit"], ["available", "Available"]];

function Availability() {
  const [p, setP] = useState<Product | null>(null);
  const q = useGetWarehouseAvailabilityQuery(p?.id ?? "", { skip: !p });
  return (
    <Card title="Stock by warehouse">
      <ProductPicker label="Check a product" onChange={setP} />
      {p && q.isFetching && <Spinner />}
      {p && q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {p && !q.isFetching && q.data && q.data.length === 0 && <EmptyState title="No active warehouses" hint="Create a warehouse to see stock here." />}
      {p && !q.isFetching && q.data && q.data.length > 0 && (
        <table className="mt-2 w-full text-sm"><thead><tr className="text-left"><th>Warehouse</th>{COLS.map(([, l]) => <th key={l} className="text-right">{l}</th>)}</tr></thead>
          <tbody>{q.data.map((w) => <tr key={w.warehouse} className="border-t border-slate-100"><td>{w.warehouse}</td>{COLS.map(([k]) => <td key={k} className="text-right">{Number(w[k] ?? 0)}</td>)}</tr>)}</tbody></table>
      )}
    </Card>
  );
}

export function FulfilmentPage() {
  const q = useGetFulfilmentBoardQuery();
  return (
    <>
      <PageHeader title="Order fulfilment" description="Open customer orders: what is ready, what is short and which shipments carry them." />
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.length === 0 && <EmptyState title="Nothing waiting to be fulfilled" hint="Confirmed orders with goods still to deliver appear here." />}
      {q.data?.map((o) => {
        const f = FULFILMENT[o.fulfilment] ?? { label: o.fulfilment, tone: "amber" as const };
        return (
          <Card key={o.order_id} title={`${o.order} — ${o.customer}`}>
            <p className="mb-2 text-sm"><Badge tone={f.tone}>{f.label}</Badge> · {o.in_transit_deliveries} deliver{o.in_transit_deliveries === 1 ? "y" : "ies"} on the way{o.shipments.length ? ` · shipments: ${o.shipments.map((s) => `${s.number} (${s.status.toLowerCase().replace("_", " ")}, due ${s.planned_arrival})`).join(", ")}` : ""}</p>
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Line</th><th>Item</th><th className="text-right">Still to deliver</th><th className="text-right">Reserved</th><th className="text-right">Short</th></tr></thead>
              <tbody>{o.lines.map((l) => <tr key={l.line} className="border-t border-slate-100"><td>{l.line}</td><td>{l.sku}</td><td className="text-right">{Number(l.open)}</td><td className="text-right">{Number(l.reserved)}</td><td className="text-right">{Number(l.short) > 0 ? <Badge tone="red">{Number(l.short)}</Badge> : 0}</td></tr>)}</tbody></table>
          </Card>
        );
      })}
      <Availability />
    </>
  );
}
export default FulfilmentPage;

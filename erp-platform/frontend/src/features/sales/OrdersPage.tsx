import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { useGetSalesOrderQuery, useListSalesOrdersQuery, useSalesOrderActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { SalesOrder } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { useAccountNames } from "../../shared/ui/useAccountNames";
import { Badge, Button, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const STATUSES = ["DRAFT", "PENDING_APPROVAL", "CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED", "INVOICED", "CANCELLED"];
const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ");
const tone = (s: string) => (s === "CONFIRMED" || s === "DELIVERED" || s === "INVOICED" ? "green" : s === "CANCELLED" ? "red" : s === "DRAFT" ? "slate" : "amber");

type Action = "submit" | "approve" | "cancel" | "invoice";

export function orderActions(status: string, can: (p: string) => boolean): { action: Action; text: string; variant?: "danger" }[] {
  const out: { action: Action; text: string; variant?: "danger" }[] = [];
  if (status === "DRAFT" && can("sales.order.create")) out.push({ action: "submit", text: "Submit order" });
  if (status === "PENDING_APPROVAL" && can("sales.order.approve")) out.push({ action: "approve", text: "Approve" });
  if ((status === "DELIVERED" || status === "PARTIALLY_DELIVERED") && can("sales.invoice.create")) out.push({ action: "invoice", text: "Create invoice" });
  if ((status === "DRAFT" || status === "PENDING_APPROVAL" || status === "CONFIRMED") && can("sales.order.create")) out.push({ action: "cancel", text: "Cancel order", variant: "danger" });
  return out;
}

function Detail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isFetching, error } = useGetSalesOrderQuery(id ?? "", { skip: !id });
  const [act, state] = useSalesOrderActionMutation();
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const run = async (action: Action) => { setErr(null); try { await act({ id: id!, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title={data ? `Sales order ${data.number}` : "Sales order"} open={!!id} onClose={onClose}>
      {isFetching && !data && <Spinner />}
      {error && <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>}
      {data && (
        <>
          <p className="mb-2 text-sm text-slate-600"><Badge tone={tone(data.status)}>{pretty(data.status)}</Badge> · {data.order_date}{data.hold_reason && ` · on hold: ${data.hold_reason}`}</p>
          <table className="w-full text-sm">
            <thead><tr><th className="text-left">Item</th><th className="text-right">Ordered</th><th className="text-right">Delivered</th><th className="text-right">Invoiced</th><th className="text-right">Total</th></tr></thead>
            <tbody>{data.lines?.map((l) => <tr key={l.id} className="border-t border-slate-100"><td>{l.description}</td><td className="text-right">{formatMoney(l.quantity)}</td><td className="text-right">{formatMoney(l.delivered_quantity)}</td><td className="text-right">{formatMoney(l.invoiced_quantity)}</td><td className="text-right">{formatMoney(l.line_total)}</td></tr>)}</tbody>
          </table>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatMoney(data.subtotal)}</dd></div>
            <div className="flex justify-between"><dt>Tax</dt><dd>{formatMoney(data.tax_total)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>Total ({data.currency})</dt><dd>{formatMoney(data.total)}</dd></div>
          </dl>
          {data.status === "PENDING_APPROVAL" && data.workflow_instance_id && <p className="mt-2 text-sm text-slate-600">Waiting in the approvals workflow.</p>}
          {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {orderActions(data.status, can).map((a) => <Button key={a.action} variant={a.variant ?? "primary"} loading={state.isLoading} onClick={() => void run(a.action)}>{a.text}</Button>)}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function OrdersPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useListSalesOrdersQuery({ cursor, status });
  const name = useAccountNames();
  const [openId, setOpenId] = useState<string | null>(null);
  const columns = useMemo<ColumnDef<SalesOrder>[]>(() => [
    { header: "Number", cell: ({ row }) => <button type="button" className="text-brand-700 underline" onClick={() => setOpenId(row.original.id)}>{row.original.number}</button> },
    { header: "Customer", cell: ({ row }) => name(row.original.account) },
    { header: "Order date", accessorKey: "order_date" },
    { header: "Total", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.total)} {row.original.currency}</span> },
    { header: "Status", cell: ({ row }) => <Badge tone={tone(row.original.status)}>{pretty(row.original.status)}</Badge> },
  ], [name]);
  return (
    <>
      <PageHeader title="Sales orders" />
      <label className="mb-3 flex items-center gap-2 text-sm">Status
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}>
          <option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
        </select>
      </label>
      <DataTable caption="Sales orders" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No sales orders" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <Detail id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

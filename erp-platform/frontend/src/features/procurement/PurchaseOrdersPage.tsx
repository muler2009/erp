import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { useGetPurchaseOrderQuery, useListPurchaseOrdersQuery, useListWarehousesQuery, usePurchaseOrderActionMutation, useReceiveGoodsMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { PurchaseOrder } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import type { PurchaseOrder as PO } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { MatchInvoiceDialog } from "./MatchPages";
import { PoExtras } from "./PoExtras";
import { Badge, Button, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED", "CANCELLED"];
const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ");
const tone = (s: string) => (s === "APPROVED" || s === "RECEIVED" || s === "CLOSED" ? "green" : s === "CANCELLED" ? "red" : s === "DRAFT" ? "slate" : "amber");

/** Builds the receive request from the typed quantities; returns an error message instead when the input is not acceptable. */
export function buildReceipt(order: PO, location: string, qty: Record<string, string>, notes: string): { lines: { po_line: string; quantity: string }[] } | { error: string } {
  if (!location) return { error: "Choose the location the goods go to." };
  const lines: { po_line: string; quantity: string }[] = [];
  for (const l of order.lines ?? []) {
    const raw = (qty[l.id] ?? "").trim();
    if (raw === "") continue;
    const q = parseMoney(raw);
    if (q === null || q <= 0n) return { error: `Line ${l.line_no}: enter a quantity greater than 0.` };
    lines.push({ po_line: l.id, quantity: raw });
  }
  if (lines.length === 0) return { error: "Enter a received quantity on at least one line." };
  const allService = lines.every((r) => !order.lines!.find((l) => l.id === r.po_line)!.product);
  if (allService && notes.trim() === "") return { error: "A service receipt needs an acceptance note." };
  return { lines };
}

function ReceivePanel({ order, onDone }: { order: PO; onDone: () => void }) {
  const warehouses = useListWarehousesQuery();
  const [receive, state] = useReceiveGoodsMutation();
  const [location, setLocation] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const locations = warehouses.data?.results.flatMap((w) => w.locations.filter((l) => !l.is_blocked).map((l) => ({ id: l.id, label: `${w.code} / ${l.code}` }))) ?? [];
  const go = async () => {
    const built = buildReceipt(order, location, qty, notes);
    if ("error" in built) { setErr(built.error); return; }
    setErr(null);
    try { await receive({ id: order.id, location, delivery_note: note.trim(), notes: notes.trim(), lines: built.lines }).unwrap(); onDone(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <div className="mt-4 rounded-md border border-slate-200 p-3">
      <h3 className="mb-2 text-sm font-semibold">Receive goods</h3>
      <label htmlFor="rc-loc" className="mb-1 block text-sm font-medium text-slate-700">Receive into</label>
      <select id="rc-loc" className={`${inputClass} mb-3`} value={location} onChange={(e) => setLocation(e.target.value)}>
        <option value="">Choose…</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
      {order.lines?.map((l) => {
        const open = (parseMoney(l.quantity) ?? 0n) - (parseMoney(l.received_quantity) ?? 0n);
        return (
          <div key={l.id} className="mb-2 flex items-center justify-between gap-2 text-sm">
            <label htmlFor={`rc-${l.id}`}>{l.description} <span className="text-slate-500">(open {formatMoney(open)})</span></label>
            <input id={`rc-${l.id}`} inputMode="decimal" className={`${inputClass} w-28 text-right`} value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} />
          </div>
        );
      })}
      <label htmlFor="rc-note" className="mb-1 mt-2 block text-sm font-medium text-slate-700">Delivery note no.</label>
      <input id="rc-note" className={`${inputClass} mb-2`} maxLength={60} value={note} onChange={(e) => setNote(e.target.value)} />
      <label htmlFor="rc-notes" className="mb-1 block text-sm font-medium text-slate-700">Notes</label>
      <input id="rc-notes" className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end"><Button loading={state.isLoading} onClick={() => void go()}>Confirm receipt</Button></div>
    </div>
  );
}

function Detail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isFetching, error } = useGetPurchaseOrderQuery(id ?? "", { skip: !id });
  const [act, state] = usePurchaseOrderActionMutation();
  const [err, setErr] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [matching, setMatching] = useState(false);
  const { can } = useAccess();
  const run = async (action: "submit" | "approve" | "cancel") => { setErr(null); try { await act({ id: id!, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const create = can("procurement.purchase_order.create");
  return (
    <Modal title={data ? `Purchase order ${data.number}` : "Purchase order"} open={!!id} onClose={onClose}>
      {isFetching && !data && <Spinner />}
      {error && <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>}
      {data && (
        <>
          <p className="mb-2 text-sm text-slate-600">{data.supplier.name} · <Badge tone={tone(data.status)}>{pretty(data.status)}</Badge> · {data.currency}</p>
          <table className="w-full text-sm">
            <thead><tr><th className="text-left">Item</th><th className="text-right">Ordered</th><th className="text-right">Received</th><th className="text-right">Unit price</th></tr></thead>
            <tbody>{data.lines?.map((l) => <tr key={l.id} className="border-t border-slate-100"><td>{l.description}</td><td className="text-right">{formatMoney(l.quantity)}</td><td className="text-right">{formatMoney(l.received_quantity)}</td><td className="text-right">{formatMoney(l.unit_price)}</td></tr>)}</tbody>
          </table>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{formatMoney(data.total)}</dd></div>
            <div className="flex justify-between"><dt>Invoiced so far</dt><dd>{formatMoney(data.invoiced_value)}</dd></div>
          </dl>
          <PoExtras order={data} />
          {matching && <MatchInvoiceDialog order={data} open onClose={() => setMatching(false)} />}
          {receiving && <ReceivePanel order={data} onDone={() => setReceiving(false)} />}
          {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {(data.status === "APPROVED" || data.status === "PARTIALLY_RECEIVED") && can("inventory.goods.receive") && !receiving && <Button onClick={() => setReceiving(true)}>Receive goods</Button>}
            {!["DRAFT", "PENDING_APPROVAL", "CANCELLED"].includes(data.status) && can("procurement.invoice.match") && <Button variant="secondary" onClick={() => setMatching(true)}>Match invoice</Button>}
            {data.status === "DRAFT" && create && <Button loading={state.isLoading} onClick={() => void run("submit")}>Submit for approval</Button>}
            {data.status === "PENDING_APPROVAL" && can("procurement.purchase_order.approve") && <Button loading={state.isLoading} onClick={() => void run("approve")}>Approve</Button>}
            {(data.status === "DRAFT" || data.status === "PENDING_APPROVAL") && create && <Button variant="danger" loading={state.isLoading} onClick={() => void run("cancel")}>Cancel order</Button>}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function PurchaseOrdersPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useListPurchaseOrdersQuery({ cursor, status });
  const [openId, setOpenId] = useState<string | null>(null);
  const columns = useMemo<ColumnDef<PurchaseOrder>[]>(() => [
    { header: "Number", cell: ({ row }) => <button type="button" className="text-brand-700 underline" onClick={() => setOpenId(row.original.id)}>{row.original.number}</button> },
    { header: "Supplier", cell: ({ row }) => row.original.supplier.name },
    { header: "Order date", accessorKey: "order_date" },
    { header: "Expected", cell: ({ row }) => row.original.expected_date ?? "—" },
    { header: "Total", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.total)} {row.original.currency}</span> },
    { header: "Status", cell: ({ row }) => <Badge tone={tone(row.original.status)}>{pretty(row.original.status)}</Badge> },
  ], []);
  return (
    <>
      <PageHeader title="Purchase orders" />
      <label className="mb-3 flex items-center gap-2 text-sm">Status
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}>
          <option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
        </select>
      </label>
      <DataTable caption="Purchase orders" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No purchase orders" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <Detail id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

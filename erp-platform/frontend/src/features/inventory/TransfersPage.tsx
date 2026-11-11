import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useCreateTransferMutation, useGetTransferQuery, useListTransfersQuery, useListWarehousesQuery, useTransferActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product, TransferNote, TransferReceiptLine, TransferRow } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const transferTone = (s: string) => (s === "RECEIVED" ? "green" : s === "CANCELLED" || s === "REJECTED" ? "red" : s === "DRAFT" ? "slate" : "amber") as "green" | "red" | "amber" | "slate";
export const pretty = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

export interface DraftLine { product: Product | null; from_location: string; quantity: string; lot: string }

/** Returns an error message or null; the server repeats the checks. */
export function validateTransfer(f: { from: string; to: string; lines: DraftLine[] }): string | null {
  if (!f.from || !f.to) return "Choose the source and destination warehouses.";
  if (f.from === f.to) return "Source and destination warehouses must differ.";
  if (f.lines.length === 0) return "Add at least one line.";
  for (const [i, l] of f.lines.entries()) {
    if (!l.product) return `Line ${i + 1}: choose a product.`;
    if (!l.from_location) return `Line ${i + 1}: choose the source location.`;
    const q = parseMoney(l.quantity);
    if (q === null || q <= 0n) return `Line ${i + 1}: quantity must be more than 0.`;
  }
  return null;
}

/** Builds the receipt rows for the lines that still have goods in transit and where something was entered. Returns an error string on bad input. */
export function buildReceipt(lines: TransferNote["lines"], entry: Record<string, { accepted: string; rejected: string; damaged: string; to: string }>): { rows: TransferReceiptLine[] } | { error: string } {
  const rows: TransferReceiptLine[] = [];
  for (const l of lines) {
    const e = entry[l.id];
    if (!e) continue;
    const num = (v: string) => (v.trim() === "" ? 0n : parseMoney(v));
    const a = num(e.accepted), r = num(e.rejected), d = num(e.damaged);
    if (a === null || r === null || d === null || a < 0n || r < 0n || d < 0n) return { error: `${l.sku}: quantities must be numbers of 0 or more.` };
    if (a + r + d === 0n) continue;
    const outstanding = (parseMoney(l.dispatched) ?? 0n) - (parseMoney(l.received) ?? 0n) - (parseMoney(l.rejected) ?? 0n) - (parseMoney(l.damaged) ?? 0n);
    if (a + r + d > outstanding) return { error: `${l.sku}: only ${formatMoney(outstanding)} still in transit.` };
    if (a > 0n && !e.to) return { error: `${l.sku}: choose where the accepted stock goes.` };
    rows.push({ line: l.id, accepted: e.accepted.trim() || "0", rejected: e.rejected.trim() || "0", damaged: e.damaged.trim() || "0", ...(a > 0n ? { to_location: e.to } : {}) });
  }
  return rows.length === 0 ? { error: "Enter the quantities received for at least one line." } : { rows };
}

function NewTransferDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const warehouses = useListWarehousesQuery(undefined, { skip: !open });
  const [create, state] = useCreateTransferMutation();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [expected, setExpected] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ product: null, from_location: "", quantity: "1", lot: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const src = warehouses.data?.results.find((w) => w.id === from);
  const patch = (i: number, p: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    const problem = validateTransfer({ from, to, lines });
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      await create({ from_warehouse: from, to_warehouse: to, reason: reason.trim(), ...(expected ? { expected_date: expected } : {}), lines: lines.map((l) => ({ product: l.product!.id, from_location: l.from_location, quantity: l.quantity.trim(), ...(l.lot.trim() ? { lot_code: l.lot.trim() } : {}) })) }).unwrap();
      close();
    } catch (e) { setErr(errorMessage(e)); }
  };
  const options = warehouses.data?.results.filter((w) => w.is_active) ?? [];
  return (
    <Modal title="New transfer order" open={open} onClose={close}>
      <div className="max-h-[70vh] overflow-y-auto">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="From warehouse" htmlFor="tr-from"><select id="tr-from" className={inputClass} value={from} onChange={(e) => { setFrom(e.target.value); setLines((ls) => ls.map((l) => ({ ...l, from_location: "" }))); }}><option value="">Choose…</option>{options.map((w) => <option key={w.id} value={w.id}>{w.code} {w.name}</option>)}</select></FormField>
          <FormField label="To warehouse" htmlFor="tr-to"><select id="tr-to" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option>{options.map((w) => <option key={w.id} value={w.id}>{w.code} {w.name}</option>)}</select></FormField>
          <FormField label="Expected date (optional)" htmlFor="tr-date"><input id="tr-date" type="date" className={inputClass} value={expected} onChange={(e) => setExpected(e.target.value)} /></FormField>
          <FormField label="Reason (optional)" htmlFor="tr-reason"><input id="tr-reason" maxLength={300} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="mb-3 rounded border border-slate-200 p-2">
            <ProductPicker label={`Line ${i + 1} product`} onChange={(p) => patch(i, { product: p })} />
            <div className="grid grid-cols-[1fr_6rem_8rem_auto] gap-2">
              <select aria-label={`Line ${i + 1} source location`} className={inputClass} value={l.from_location} onChange={(e) => patch(i, { from_location: e.target.value })}><option value="">Source location…</option>{src?.locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.code}</option>)}</select>
              <input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className={`${inputClass} text-right`} value={l.quantity} onChange={(e) => patch(i, { quantity: e.target.value })} />
              <input aria-label={`Line ${i + 1} lot`} placeholder="Lot (optional)" className={inputClass} value={l.lot} onChange={(e) => patch(i, { lot: e.target.value })} />
              {lines.length > 1 && <Button variant="secondary" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</Button>}
            </div>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, { product: null, from_location: "", quantity: "1", lot: "" }])}>Add line</Button>
      </div>
      {err && <p role="alert" className="my-3 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Create transfer</Button></div>
    </Modal>
  );
}

function ReceivePanel({ order, onDone }: { order: TransferNote; onDone: () => void }) {
  const warehouses = useListWarehousesQuery();
  const [act, state] = useTransferActionMutation();
  const dest = warehouses.data?.results.find((w) => w.code === order.to);
  const [entry, setEntry] = useState<Record<string, { accepted: string; rejected: string; damaged: string; to: string }>>({});
  const [err, setErr] = useState<string | null>(null);
  const set = (id: string, p: Partial<{ accepted: string; rejected: string; damaged: string; to: string }>) => setEntry((e) => ({ ...e, [id]: { accepted: "", rejected: "", damaged: "", to: "", ...e[id], ...p } }));
  const go = async () => {
    const built = buildReceipt(order.lines, entry);
    if ("error" in built) { setErr(built.error); return; }
    setErr(null);
    try { await act({ id: order.id, action: "receive", body: { lines: built.rows } }).unwrap(); onDone(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <div className="mt-3 rounded border border-slate-200 p-3">
      <p className="mb-2 text-sm font-medium">Receive at {order.to}</p>
      {order.lines.map((l) => (
        <div key={l.id} className="mb-2 grid grid-cols-[1fr_5rem_5rem_5rem_8rem] items-center gap-2 text-sm">
          <span>{l.sku} <span className="text-slate-500">(in transit {formatMoney((parseMoney(l.dispatched) ?? 0n) - (parseMoney(l.received) ?? 0n) - (parseMoney(l.rejected) ?? 0n) - (parseMoney(l.damaged) ?? 0n))})</span></span>
          <input aria-label={`${l.sku} accepted`} placeholder="OK" inputMode="decimal" className={`${inputClass} text-right`} value={entry[l.id]?.accepted ?? ""} onChange={(e) => set(l.id, { accepted: e.target.value })} />
          <input aria-label={`${l.sku} rejected`} placeholder="Rejected" inputMode="decimal" className={`${inputClass} text-right`} value={entry[l.id]?.rejected ?? ""} onChange={(e) => set(l.id, { rejected: e.target.value })} />
          <input aria-label={`${l.sku} damaged`} placeholder="Damaged" inputMode="decimal" className={`${inputClass} text-right`} value={entry[l.id]?.damaged ?? ""} onChange={(e) => set(l.id, { damaged: e.target.value })} />
          <select aria-label={`${l.sku} put away to`} className={inputClass} value={entry[l.id]?.to ?? ""} onChange={(e) => set(l.id, { to: e.target.value })}><option value="">Put away to…</option>{dest?.locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.code}</option>)}</select>
        </div>
      ))}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end"><Button loading={state.isLoading} onClick={() => void go()}>Confirm receipt</Button></div>
    </div>
  );
}

function TransferDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isFetching, error } = useGetTransferQuery(id ?? "", { skip: !id });
  const [act, state] = useTransferActionMutation();
  const [note, setNote] = useState("");
  const [carrier, setCarrier] = useState("");
  const [receiving, setReceiving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const run = async (action: "submit" | "cancel" | "approve" | "reject" | "dispatch") => {
    if (action === "reject" && !note.trim()) { setErr("A reason is required to reject a transfer."); return; }
    setErr(null);
    try { await act({ id: id!, action, body: { note: note.trim(), carrier: carrier.trim() } }).unwrap(); setNote(""); } catch (e) { setErr(errorMessage(e)); }
  };
  const issue = can("inventory.stock.issue"), approve = can("inventory.transfer.approve");
  return (
    <Modal title={data ? `Transfer ${data.number}` : "Transfer"} open={!!id} onClose={onClose}>
      {isFetching && !data && <Spinner />}
      {error && <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>}
      {data && (
        <>
          <p className="mb-2 text-sm text-slate-600">{data.from} → {data.to} · <Badge tone={transferTone(data.status)}>{pretty(data.status)}</Badge>{data.carrier ? ` · carrier ${data.carrier}` : ""}</p>
          {data.reason && <p className="mb-2 text-sm">{data.reason}</p>}
          <table className="w-full text-sm">
            <thead><tr><th className="text-left">Item</th><th className="text-left">From</th><th className="text-right">Qty</th><th className="text-right">Received</th><th className="text-right">Rejected</th><th className="text-right">Damaged</th></tr></thead>
            <tbody>{data.lines.map((l) => <tr key={l.id} className="border-t border-slate-100"><td>{l.sku} {l.name}{l.lot ? ` · lot ${l.lot}` : ""}</td><td>{l.from_location}</td><td className="text-right">{formatMoney(l.quantity)}</td><td className="text-right">{formatMoney(l.received)}</td><td className="text-right">{formatMoney(l.rejected)}</td><td className="text-right">{formatMoney(l.damaged)}</td></tr>)}</tbody>
          </table>
          {receiving && <ReceivePanel order={data} onDone={() => setReceiving(false)} />}
          {(data.status === "REQUESTED" && approve) && <div className="mt-3"><FormField label="Decision note (required to reject)" htmlFor="tr-note"><input id="tr-note" maxLength={300} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></FormField></div>}
          {(data.status === "APPROVED" && issue) && <div className="mt-3"><FormField label="Carrier (optional)" htmlFor="tr-carrier"><input id="tr-carrier" maxLength={120} className={inputClass} value={carrier} onChange={(e) => setCarrier(e.target.value)} /></FormField></div>}
          {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {data.status === "DRAFT" && issue && <Button loading={state.isLoading} onClick={() => void run("submit")}>Submit for approval</Button>}
            {data.status === "REQUESTED" && approve && <Button loading={state.isLoading} onClick={() => void run("approve")}>Approve</Button>}
            {data.status === "REQUESTED" && approve && <Button variant="secondary" loading={state.isLoading} onClick={() => void run("reject")}>Reject</Button>}
            {data.status === "APPROVED" && issue && <Button loading={state.isLoading} onClick={() => void run("dispatch")}>Dispatch</Button>}
            {["IN_TRANSIT", "PARTIALLY_RECEIVED"].includes(data.status) && can("inventory.goods.receive") && !receiving && <Button onClick={() => setReceiving(true)}>Receive goods</Button>}
            {["DRAFT", "REQUESTED", "APPROVED"].includes(data.status) && issue && <Button variant="danger" loading={state.isLoading} onClick={() => void run("cancel")}>Cancel transfer</Button>}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function TransfersPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListTransfersQuery({ cursor });
  const columns: ColumnDef<TransferRow>[] = [
    { header: "Transfer", cell: ({ row }) => <button className="text-indigo-700 underline" onClick={() => setOpenId(row.original.id)}>{row.original.number}</button> },
    { header: "Route", cell: ({ row }) => `${row.original.from} → ${row.original.to}` },
    { header: "Status", cell: ({ row }) => <Badge tone={transferTone(row.original.status)}>{pretty(row.original.status)}</Badge> },
  ];
  return (
    <>
      <PageHeader title="Transfer orders" description="Move stock between warehouses: request, approve, dispatch, receive." actions={can("inventory.stock.issue") ? <Button onClick={() => setCreating(true)}>New transfer</Button> : undefined} />
      <DataTable caption="Transfer orders" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No transfers yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <TransferDetail id={openId} onClose={() => setOpenId(null)} />
      <NewTransferDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

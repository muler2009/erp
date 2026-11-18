import { useState } from "react";
import { Link } from "react-router";

import { useGetReturnReportQuery, useGetReturnRequestQuery, useGetSalesOrderQuery, useListReturnRequestsQuery, useListSalesOrdersQuery, useListWarehousesQuery, useRequestSalesReturnMutation, useSalesReturnActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Disposition, ReturnRequestRow, SalesOrder } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames } from "../quality/names";

export const STATUS: Record<ReturnRequestRow["status"], { label: string; tone: "green" | "red" | "amber" | "slate" }> = { PENDING: { label: "Waiting for a decision", tone: "amber" }, APPROVED: { label: "Approved — goods not yet received", tone: "amber" }, REJECTED: { label: "Rejected", tone: "red" }, CANCELLED: { label: "Cancelled", tone: "slate" }, RECEIVED: { label: "Received", tone: "green" } };
export const REASONS: Record<string, string> = { DEFECTIVE: "Defective", WRONG_ITEM: "Wrong item sent", DAMAGED: "Damaged", NOT_NEEDED: "No longer needed", OTHER: "Other" };
export const DISPOSITIONS: Record<Disposition, string> = { RESTOCK: "Put back in stock", QUARANTINE: "Hold for inspection", DISPOSE: "Scrap" };
const DEC = /^\d+(\.\d{1,4})?$/;

/** How many units of a line the customer may still send back (delivered, not yet returned). Pending requests are checked by the server. */
export const returnable = (l: { delivered_quantity?: string; returned_quantity?: string }): number => Math.max(0, Number(l.delivered_quantity ?? "0") - Number(l.returned_quantity ?? "0"));
export const needsQuarantine = (r: Pick<ReturnRequestRow, "lines">): boolean => r.lines.some((l) => l.disposition === "QUARANTINE");

export function returnLines(order: SalesOrder, qty: Record<string, string>, disp: Record<string, Disposition>): { lines: { order_line: string; quantity: string; disposition: Disposition }[] } | { problem: string } {
  const lines: { order_line: string; quantity: string; disposition: Disposition }[] = [];
  for (const l of order.lines ?? []) {
    const t = (qty[l.id] ?? "").trim();
    if (!t || Number(t) === 0) continue;
    if (!DEC.test(t)) return { problem: `${l.description}: the quantity must be a number such as 2 or 2.5.` };
    if (Number(t) > returnable(l)) return { problem: `${l.description}: only ${returnable(l)} can still be returned.` };
    lines.push({ order_line: l.id, quantity: t, disposition: disp[l.id] ?? "RESTOCK" });
  }
  return lines.length ? { lines } : { problem: "Enter a quantity for at least one item." };
}

function RequestDialog({ onClose }: { onClose: () => void }) {
  const orders = useListSalesOrdersQuery({});
  const [orderId, setOrderId] = useState("");
  const order = useGetSalesOrderQuery(orderId, { skip: !orderId });
  const [request, { isLoading }] = useRequestSalesReturnMutation();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [disp, setDisp] = useState<Record<string, Disposition>>({});
  const [f, setF] = useState({ reason_code: "", reason: "", replacement: false });
  const [err, setErr] = useState<string | null>(null);
  const eligible = (orders.data?.results ?? []).filter((o) => ["PARTIALLY_DELIVERED", "DELIVERED", "INVOICED"].includes(o.status));
  const lines = (order.data?.lines ?? []).filter((l) => returnable(l) > 0);
  const go = async () => {
    if (!order.data) { setErr("Choose the order the goods came from."); return; }
    const r = returnLines(order.data, qty, disp);
    const problem = ("problem" in r && r.problem) || (!f.reason_code && "Choose a reason.") || (!f.reason.trim() && "Describe what is wrong.");
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await request({ order: orderId, reason: f.reason.trim(), reason_code: f.reason_code, replacement: f.replacement, lines: (r as { lines: unknown[] }).lines }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Request a return" open onClose={onClose}>
      <FormField label="Order" htmlFor="rq-order"><select id="rq-order" className={inputClass} value={orderId} onChange={(e) => { setOrderId(e.target.value); setQty({}); setDisp({}); }}><option value="">Choose…</option>{eligible.map((o) => <option key={o.id} value={o.id}>{o.number}</option>)}</select></FormField>
      {orderId && (order.isFetching && !order.data ? <Spinner /> : lines.length === 0 ? <p className="mb-3 text-sm text-slate-600">Nothing on this order can still be returned.</p> : (
        <table className="mb-3 w-full text-sm"><caption className="sr-only">Items to return</caption>
          <thead><tr className="text-left text-slate-500"><th>Item</th><th className="text-right">Can return</th><th className="text-right">Return</th><th>What happens to it</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id} className="border-t border-slate-100"><td className="py-1">{l.description}</td><td className="text-right">{returnable(l)}</td>
              <td className="text-right"><input aria-label={`Return quantity of ${l.description}`} className={`${inputClass} w-20 text-right`} value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /></td>
              <td><select aria-label={`Disposition of ${l.description}`} className={inputClass} value={disp[l.id] ?? "RESTOCK"} onChange={(e) => setDisp({ ...disp, [l.id]: e.target.value as Disposition })}>{Object.entries(DISPOSITIONS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></td></tr>))}</tbody></table>
      ))}
      <FormField label="Reason" htmlFor="rq-code"><select id="rq-code" className={inputClass} value={f.reason_code} onChange={(e) => setF({ ...f, reason_code: e.target.value })}><option value="">Choose…</option>{Object.entries(REASONS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></FormField>
      <FormField label="What is wrong" htmlFor="rq-reason"><textarea id="rq-reason" rows={2} className={inputClass} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></FormField>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.replacement} onChange={(e) => setF({ ...f, replacement: e.target.checked })} />The customer wants a free replacement</label>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Send request</Button></div>
    </Modal>
  );
}

function ReceiveDialog({ r, onClose }: { r: ReturnRequestRow; onClose: () => void }) {
  const [act] = useSalesReturnActionMutation();
  const wh = useListWarehousesQuery();
  const locs = (wh.data?.results ?? []).flatMap((w) => w.locations.filter((x) => !x.is_blocked).map((x) => [x.id, `${w.code} / ${x.code}`] as [string, string]));
  const quarantine = needsQuarantine(r);
  return (
    <ActionDialog title={`Receive goods for ${r.number}`} cta="Receive goods" open onClose={onClose} initial={{ return_date: new Date().toISOString().slice(0, 10) }}
      fields={[{ name: "location", label: "Put back into", required: true, options: locs }, ...(quarantine ? [{ name: "quarantine_location", label: "Hold for inspection in", required: true, options: locs }] : []), { name: "return_date", label: "Date received", type: "date", required: true }]}
      submit={async (v) => { await act({ id: r.id, action: "receive", body: { location: v.location, return_date: v.return_date, ...(quarantine ? { quarantine_location: v.quarantine_location } : {}) } }).unwrap(); }} />
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error, refetch } = useGetReturnRequestQuery(id);
  const order = useGetSalesOrderQuery(data?.order ?? "", { skip: !data });
  const nameOf = useUserNames();
  const { can } = useAccess();
  const [act] = useSalesReturnActionMutation();
  const [dlg, setDlg] = useState<"approve" | "reject" | "receive" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const itemName = (lid: string) => order.data?.lines?.find((l) => l.id === lid)?.description ?? `Item ${lid.slice(0, 8)}`;
  return (
    <Modal title={data ? `Return ${data.number}` : "Return request"} open onClose={onClose}>
      {isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
        <>
          <p className="mb-2"><Badge tone={STATUS[data.status].tone}>{STATUS[data.status].label}</Badge></p>
          <dl className="mb-3 grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-xs text-slate-500">Order</dt><dd>{order.data?.number ?? "…"}</dd></div>
            <div><dt className="text-xs text-slate-500">Asked by</dt><dd>{nameOf(data.requested_by)}</dd></div>
            <div><dt className="text-xs text-slate-500">Reason</dt><dd>{REASONS[data.reason_code] ?? data.reason_code}: {data.reason}</dd></div>
            <div><dt className="text-xs text-slate-500">Replacement wanted</dt><dd>{data.wants_replacement ? "Yes" : "No"}</dd></div>
            {data.decided_by && <div><dt className="text-xs text-slate-500">Decided by</dt><dd>{nameOf(data.decided_by)}{data.decision_note && ` — ${data.decision_note}`}</dd></div>}
            {data.replacement_order && <div><dt className="text-xs text-slate-500">Replacement order</dt><dd><Link className="text-indigo-700 underline" to="/app/sales/orders">view in sales orders</Link></dd></div>}
          </dl>
          <table className="mb-3 w-full text-sm"><caption className="sr-only">Returned items</caption><thead><tr className="text-left text-slate-500"><th>Item</th><th className="text-right">Quantity</th><th>What happens to it</th></tr></thead>
            <tbody>{data.lines.map((l) => <tr key={l.order_line} className="border-t border-slate-100"><td className="py-1">{itemName(l.order_line)}</td><td className="text-right">{Number(l.quantity)}</td><td>{DISPOSITIONS[l.disposition]}</td></tr>)}</tbody></table>
          {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {data.status === "PENDING" && can("sales.order.approve") && <><Button onClick={() => setDlg("approve")}>Approve</Button><Button variant="danger" onClick={() => setDlg("reject")}>Reject</Button></>}
            {data.status === "APPROVED" && can("sales.delivery.manage") && <Button onClick={() => setDlg("receive")}>Receive goods</Button>}
            {(data.status === "PENDING" || data.status === "APPROVED") && can("sales.order.create") && <Button variant="secondary" onClick={() => { setErr(null); act({ id, action: "cancel" }).unwrap().catch((e) => setErr(errorMessage(e))); }}>Cancel request</Button>}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
          {dlg === "approve" && <ActionDialog title="Approve return" cta="Approve" open onClose={() => setDlg(null)} fields={[{ name: "note", label: "Note (optional)" }]} submit={async (v) => { await act({ id, action: "approve", body: { note: v.note ?? "" } }).unwrap(); }} />}
          {dlg === "reject" && <ActionDialog title="Reject return" cta="Reject" open onClose={() => setDlg(null)} fields={[{ name: "note", label: "Why is it rejected?", required: true }]} submit={async (v) => { await act({ id, action: "reject", body: { note: v.note!.trim() } }).unwrap(); }} />}
          {dlg === "receive" && <ReceiveDialog r={data} onClose={() => setDlg(null)} />}
        </>
      )}
    </Modal>
  );
}

function Report() {
  const [range, setRange] = useState({ from: "", to: "" });
  const bad = !!range.from && !!range.to && range.to < range.from;
  const { data, isLoading, error, refetch } = useGetReturnReportQuery(bad ? {} : range);
  return (
    <Card title="Returns at a glance">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <FormField label="From" htmlFor="rr-from"><input id="rr-from" type="date" className={inputClass} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></FormField>
        <FormField label="To" htmlFor="rr-to"><input id="rr-to" type="date" className={inputClass} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></FormField>
      </div>
      {bad && <p role="alert" className="mb-2 text-sm text-red-700">The end date is before the start date.</p>}
      {isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-4">
          <div><p className="text-xs text-slate-500">Requests</p><p className="text-lg">{data.total}</p></div>
          <div><p className="text-xs text-slate-500">By status</p><ul>{Object.entries(data.by_status).map(([k, n]) => <li key={k}>{STATUS[k as ReturnRequestRow["status"]]?.label ?? k}: {n}</li>)}</ul></div>
          <div><p className="text-xs text-slate-500">By reason</p><ul>{Object.entries(data.by_reason).map(([k, n]) => <li key={k}>{REASONS[k] ?? k}: {n}</li>)}</ul></div>
          <div><p className="text-xs text-slate-500">Goods received back</p><ul>{Object.entries(data.received_by_disposition).map(([k, n]) => <li key={k}>{DISPOSITIONS[k as Disposition] ?? k}: {Number(n)}</li>)}</ul></div>
        </div>
      )}
    </Card>
  );
}

export function ReturnsPage() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListReturnRequestsQuery({ cursor, status });
  const orders = useListSalesOrdersQuery({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const orderNo = (id: string) => orders.data?.results.find((o) => o.id === id)?.number ?? `Order ${id.slice(0, 8)}`;
  return (
    <>
      <PageHeader title="Returns" description="Customers sending goods back: ask, decide, receive." actions={can("sales.order.create") ? <Button onClick={() => setRequesting(true)}>Request a return</Button> : undefined} />
      <Report />
      <Card title="Return requests">
        <FormField label="Status" htmlFor="rt-status"><select id="rt-status" className={`${inputClass} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FormField>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No return requests" /> : (
          <>
            <table className="min-w-full text-sm"><caption className="sr-only">Return requests</caption>
              <thead><tr className="text-left text-slate-500"><th className="py-1">Request</th><th>Order</th><th>Reason</th><th>Status</th><th>Replacement</th></tr></thead>
              <tbody>{data.results.map((r) => (
                <tr key={r.id} className="border-t border-slate-100"><td className="py-1"><button type="button" className="text-indigo-700 underline" onClick={() => setOpenId(r.id)}>{r.number}</button></td><td>{orderNo(r.order)}</td><td>{REASONS[r.reason_code] ?? r.reason_code}</td>
                  <td><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></td><td>{r.wants_replacement ? "Yes" : "No"}</td></tr>))}</tbody></table>
            <div className="mt-2 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{data.next && <Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button>}</div>
          </>
        )}
      </Card>
      {openId && <Detail id={openId} onClose={() => setOpenId(null)} />}
      {requesting && <RequestDialog onClose={() => setRequesting(false)} />}
    </>
  );
}

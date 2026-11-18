import { useState } from "react";
import { Link } from "react-router";

import { useDispatchSalesOrderMutation, useListWarehousesQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { SalesOrder } from "../../shared/api/types";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";

const DEC = /^\d+(\.\d{1,4})?$/;

/** Quantity still to ship on a line (ordered minus already delivered), as a number. */
export const remaining = (l: { quantity: string; delivered_quantity?: string }): number => Math.max(0, Number(l.quantity) - Number(l.delivered_quantity ?? "0"));

/** Lines to send, or a problem message. Blank means nothing for that line. */
export function dispatchLines(order: SalesOrder, qty: Record<string, string>): { lines: { order_line: string; quantity: string }[] } | { problem: string } {
  const lines: { order_line: string; quantity: string }[] = [];
  for (const l of order.lines ?? []) {
    const t = (qty[l.id] ?? "").trim();
    if (!t || Number(t) === 0) continue;
    if (!DEC.test(t)) return { problem: `${l.description}: the quantity must be a number such as 2 or 2.5.` };
    if (Number(t) > remaining(l)) return { problem: `${l.description}: only ${remaining(l)} left to ship.` };
    lines.push({ order_line: l.id, quantity: t });
  }
  return lines.length ? { lines } : { problem: "Enter a quantity for at least one line." };
}

export function DispatchDialog({ order, onClose }: { order: SalesOrder; onClose: () => void }) {
  const warehouses = useListWarehousesQuery();
  const [dispatch, { isLoading }] = useDispatchSalesOrderMutation();
  const open = (order.lines ?? []).filter((l) => remaining(l) > 0);
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(open.map((l) => [l.id, String(remaining(l))])));
  const [f, setF] = useState({ location: "", delivery_date: new Date().toISOString().slice(0, 10), carrier: "", tracking_ref: "", expected_date: "" });
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; number: string } | null>(null);
  const locations = (warehouses.data?.results ?? []).flatMap((w) => w.locations.filter((x) => !x.is_blocked).map((x) => [x.id, `${w.code} / ${x.code}`] as [string, string]));
  const go = async () => {
    const r = dispatchLines(order, qty);
    const problem = (!f.location && "Choose where the goods leave from.") || ("problem" in r && r.problem) || (f.expected_date && f.expected_date < f.delivery_date && "The expected date cannot be before the dispatch date.");
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      const res = await dispatch({ id: order.id, body: { location: f.location, delivery_date: f.delivery_date, lines: (r as { lines: unknown[] }).lines, carrier: f.carrier.trim(), tracking_ref: f.tracking_ref.trim(), ...(f.expected_date ? { expected_date: f.expected_date } : {}) } }).unwrap();
      setDone(res);
    } catch (e) { setErr(errorMessage(e)); }
  };
  if (done) return (
    <Modal title="Goods dispatched" open onClose={onClose}>
      <p role="status" className="mb-4 text-sm">Delivery <Link className="text-indigo-700 underline" to={`/app/sales/deliveries/${done.id}`}>{done.number}</Link> was created and the stock has been issued.</p>
      <div className="flex justify-end"><Button onClick={onClose}>Close</Button></div>
    </Modal>
  );
  return (
    <Modal title={`Dispatch goods for ${order.number}`} open onClose={onClose}>
      {open.length === 0 ? <p className="text-sm text-slate-600">Everything on this order has already been delivered.</p> : (
        <>
          <FormField label="Dispatch from" htmlFor="dp-loc"><select id="dp-loc" className={inputClass} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })}><option value="">Choose…</option>{locations.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
          <div className="grid grid-cols-2 gap-2">
            <FormField label="Dispatch date" htmlFor="dp-date"><input id="dp-date" type="date" className={inputClass} value={f.delivery_date} onChange={(e) => setF({ ...f, delivery_date: e.target.value })} /></FormField>
            <FormField label="Expected delivery" htmlFor="dp-exp"><input id="dp-exp" type="date" className={inputClass} value={f.expected_date} onChange={(e) => setF({ ...f, expected_date: e.target.value })} /></FormField>
            <FormField label="Carrier" htmlFor="dp-car"><input id="dp-car" className={inputClass} value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} /></FormField>
            <FormField label="Tracking reference" htmlFor="dp-trk"><input id="dp-trk" className={inputClass} value={f.tracking_ref} onChange={(e) => setF({ ...f, tracking_ref: e.target.value })} /></FormField>
          </div>
          <table className="mb-3 w-full text-sm"><caption className="sr-only">Quantities to ship</caption>
            <thead><tr className="text-left text-slate-500"><th>Item</th><th className="text-right">Left to ship</th><th className="text-right">Ship now</th></tr></thead>
            <tbody>{open.map((l) => <tr key={l.id} className="border-t border-slate-100"><td className="py-1">{l.description}</td><td className="text-right">{remaining(l)}</td>
              <td className="text-right"><input aria-label={`Quantity of ${l.description}`} className={`${inputClass} w-24 text-right`} value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /></td></tr>)}</tbody></table>
        </>
      )}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button>{open.length > 0 && <Button loading={isLoading} onClick={() => void go()}>Dispatch</Button>}</div>
    </Modal>
  );
}

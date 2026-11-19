import { useState } from "react";

import { useCreateBlanketOrderMutation, useGetPurchaseOrderQuery, useListProductsQuery, useListPurchaseOrdersQuery, useListSuppliersQuery, usePurchaseOrderActionMutation, useReleaseBlanketOrderMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { PurchaseOrder } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const DEC = /^\d+(\.\d{1,4})?$/;
export const BLANKET_STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate" }> = { DRAFT: { label: "Draft", tone: "slate" }, PENDING_APPROVAL: { label: "Waiting for approval", tone: "amber" }, APPROVED: { label: "In force", tone: "green" }, CANCELLED: { label: "Cancelled", tone: "red" }, CLOSED: { label: "Closed", tone: "slate" } };
export interface BlanketLineDraft { product: string; quantity: string; unit_price: string }

export function blanketProblem(f: { supplier: string; currency: string; order_date: string; valid_to: string }, lines: BlanketLineDraft[]): string | null {
  if (!f.supplier) return "Choose the supplier.";
  if (!/^[A-Za-z]{3}$/.test(f.currency.trim())) return "Enter the three-letter currency code, such as USD.";
  if (!f.order_date || !f.valid_to) return "Enter the start and end dates.";
  if (f.valid_to < f.order_date) return "The blanket order cannot end before it starts.";
  if (lines.length === 0) return "Add at least one item.";
  const seen = new Set<string>();
  for (const l of lines) {
    if (!l.product) return "Choose a product for every item.";
    if (seen.has(l.product)) return "A product is listed twice.";
    seen.add(l.product);
    if (!DEC.test(l.quantity.trim()) || Number(l.quantity) <= 0) return "Every ceiling quantity must be above zero.";
    if (!DEC.test(l.unit_price.trim())) return "Every price must be a number such as 4.50.";
  }
  return null;
}

/** Checks the release quantities against what is left on each blanket line. */
export function releaseLines(order: PurchaseOrder, qty: Record<string, string>): { lines: { blanket_line: string; quantity: string }[] } | { problem: string } {
  const lines: { blanket_line: string; quantity: string }[] = [];
  for (const l of order.lines ?? []) {
    const t = (qty[l.id] ?? "").trim();
    if (!t || Number(t) === 0) continue;
    const left = Number(l.quantity) - Number(l.released_quantity ?? "0");
    if (!DEC.test(t)) return { problem: `${l.description}: the quantity must be a number.` };
    if (Number(t) > left) return { problem: `${l.description}: only ${left} is left on the blanket order.` };
    lines.push({ blanket_line: l.id, quantity: t });
  }
  return lines.length ? { lines } : { problem: "Enter a quantity for at least one item." };
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const suppliers = useListSuppliersQuery({});
  const products = useListProductsQuery({});
  const [create, { isLoading }] = useCreateBlanketOrderMutation();
  const [f, setF] = useState({ supplier: "", currency: "", order_date: new Date().toISOString().slice(0, 10), valid_to: "" });
  const [lines, setLines] = useState<BlanketLineDraft[]>([{ product: "", quantity: "", unit_price: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const upd = (n: number, k: keyof BlanketLineDraft, v: string) => setLines(lines.map((x, j) => (j === n ? { ...x, [k]: v } : x)));
  const go = async () => {
    const p = blanketProblem(f, lines);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await create({ supplier: f.supplier, currency: f.currency.trim().toUpperCase(), order_date: f.order_date, valid_to: f.valid_to, lines: lines.map((l) => ({ product: l.product, quantity: l.quantity.trim(), unit_price: l.unit_price.trim() })) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New blanket order" open onClose={onClose}>
      <FormField label="Supplier" htmlFor="bo-sup"><select id="bo-sup" className={inputClass} value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })}><option value="">Choose…</option>{(suppliers.data?.results ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></FormField>
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Currency" htmlFor="bo-cur"><input id="bo-cur" maxLength={3} className={inputClass} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} /></FormField>
        <FormField label="Starts" htmlFor="bo-start"><input id="bo-start" type="date" className={inputClass} value={f.order_date} onChange={(e) => setF({ ...f, order_date: e.target.value })} /></FormField>
        <FormField label="Valid until" htmlFor="bo-end"><input id="bo-end" type="date" className={inputClass} value={f.valid_to} onChange={(e) => setF({ ...f, valid_to: e.target.value })} /></FormField>
      </div>
      <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Items and ceilings</legend>
        {lines.map((l, n) => (
          <div key={n} className="mb-2 flex items-center gap-2">
            <select aria-label={`Product ${n + 1}`} className={inputClass} value={l.product} onChange={(e) => upd(n, "product", e.target.value)}><option value="">Product…</option>{(products.data?.results ?? []).map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select>
            <input aria-label={`Ceiling quantity ${n + 1}`} placeholder="Quantity" className={`${inputClass} w-24`} value={l.quantity} onChange={(e) => upd(n, "quantity", e.target.value)} />
            <input aria-label={`Price ${n + 1}`} placeholder="Price" className={`${inputClass} w-24`} value={l.unit_price} onChange={(e) => upd(n, "unit_price", e.target.value)} />
            {lines.length > 1 && <Button variant="secondary" onClick={() => setLines(lines.filter((_, j) => j !== n))}>Remove</Button>}
          </div>
        ))}
        <Button variant="secondary" onClick={() => setLines([...lines, { product: "", quantity: "", unit_price: "" }])}>Add an item</Button>
      </fieldset>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Create blanket order</Button></div>
    </Modal>
  );
}

function ReleaseDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useGetPurchaseOrderQuery(id);
  const [release, { isLoading }] = useReleaseBlanketOrderMutation();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [date, setDate] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (!q.data) return;
    const r = releaseLines(q.data, qty);
    if ("problem" in r) { setErr(r.problem); return; }
    setErr(null);
    try { await release({ id, lines: r.lines, ...(date ? { expected_date: date } : {}) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={q.data ? `Order against ${q.data.number}` : "Order against blanket order"} open onClose={onClose}>
      {q.isLoading ? <Spinner /> : q.isError || !q.data ? <ErrorState error={q.error ?? new Error("Could not load.")} /> : (
        <>
          <table className="mb-3 w-full text-sm"><caption className="sr-only">Items</caption><thead><tr className="text-left text-slate-500"><th>Item</th><th className="text-right">Left</th><th className="text-right">Order now</th></tr></thead>
            <tbody>{(q.data.lines ?? []).map((l) => <tr key={l.id} className="border-t border-slate-100"><td className="py-1">{l.description}</td><td className="text-right">{Number(l.quantity) - Number(l.released_quantity ?? "0")}</td><td className="text-right"><input aria-label={`Order ${l.description}`} className={`${inputClass} w-20 text-right`} value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /></td></tr>)}</tbody></table>
          <FormField label="Expected delivery (optional)" htmlFor="rl-date"><input id="rl-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
          {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Place order</Button></div>
        </>
      )}
    </Modal>
  );
}

export function BlanketOrdersPage() {
  const { can } = useAccess();
  const q = useListPurchaseOrdersQuery({ kind: "BLANKET" });
  const [act] = usePurchaseOrderActionMutation();
  const [creating, setCreating] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = can("procurement.purchase_order.create"), approve = can("procurement.purchase_order.approve");
  const run = async (id: string, action: "submit" | "approve") => { setErr(null); try { await act({ id, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const rows = q.data?.results ?? [];
  return (
    <div>
      <PageHeader title="Blanket orders" description="Framework agreements: agreed prices and ceilings, ordered against in releases." actions={create ? <Button onClick={() => setCreating(true)}>New blanket order</Button> : undefined} />
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : rows.length === 0 ? <EmptyState title="No blanket orders" /> : (
        <Card>
          <table className="w-full text-sm"><caption className="sr-only">Blanket orders</caption>
            <thead><tr className="text-left text-slate-500"><th>Number</th><th>Supplier</th><th>Valid until</th><th className="text-right">Value</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((o) => { const st = BLANKET_STATUS[o.status] ?? { label: o.status, tone: "slate" as const }; return (
              <tr key={o.id} className="border-t border-slate-100"><td className="py-1">{o.number}</td><td>{o.supplier.name}</td><td>{o.valid_to ?? "—"}</td><td className="text-right">{formatMoney(o.total)} {o.currency}</td><td><Badge tone={st.tone}>{st.label}</Badge></td>
                <td className="space-x-1 text-right">
                  {o.status === "DRAFT" && create && <Button variant="secondary" onClick={() => void run(o.id, "submit")}>{`Submit ${o.number}`}</Button>}
                  {o.status === "PENDING_APPROVAL" && approve && <Button variant="secondary" onClick={() => void run(o.id, "approve")}>{`Approve ${o.number}`}</Button>}
                  {o.status === "APPROVED" && create && <Button variant="secondary" onClick={() => setReleasing(o.id)}>{`Order against ${o.number}`}</Button>}
                </td></tr>); })}</tbody>
          </table>
        </Card>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {releasing && <ReleaseDialog id={releasing} onClose={() => setReleasing(null)} />}
    </div>
  );
}

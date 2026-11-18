import { useState } from "react";
import { Link, useParams } from "react-router";

import { useAssignCrmOwnerMutation, useGetCrmOppHistoryQuery, useGetCrmOppLinesQuery, useGetCrmOpportunityQuery, useListProductsQuery, useSetCrmOppLinesMutation, useUpdateCrmOpportunityMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { OppLine, OpportunityDetail } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { useAccountNames } from "../../shared/ui/useAccountNames";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames, useUserOptions } from "../quality/names";

const moneyOk = (s: string) => /^\d+(\.\d{1,2})?$/.test(s.trim());
const qtyOk = (s: string) => /^\d+(\.\d{1,3})?$/.test(s.trim()) && Number(s) > 0;

/** Whole-list validation for the product lines; returns the first problem, or null. */
export function validateLines(rows: { product: string; quantity: string; expected_price: string }[]): string | null {
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    if (!r.product) return `Line ${i + 1}: choose a product.`;
    if (seen.has(r.product)) return `Line ${i + 1}: that product is already on this opportunity.`;
    seen.add(r.product);
    if (!qtyOk(r.quantity)) return `Line ${i + 1}: the quantity must be greater than zero.`;
    if (!moneyOk(r.expected_price)) return `Line ${i + 1}: the expected price must be an amount with at most 2 decimals.`;
  }
  return null;
}

function LinesCard({ id, editable }: { id: string; editable: boolean }) {
  const { data, isLoading, error, refetch } = useGetCrmOppLinesQuery(id);
  const [editing, setEditing] = useState(false);
  return (
    <Card title="Products considered" actions={editable ? <Button variant="secondary" onClick={() => setEditing(true)}>Edit products</Button> : undefined}>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No products listed yet" /> : (
        <table className="min-w-full text-sm">
          <caption className="sr-only">Products considered</caption>
          <thead><tr className="text-left text-slate-500"><th className="py-1">Product</th><th className="text-right">Quantity</th><th className="text-right">Expected price</th></tr></thead>
          <tbody>{data.map((l) => <tr key={l.product} className="border-t border-slate-100"><td className="py-1">{l.sku}</td><td className="text-right">{l.quantity}</td><td className="text-right">{formatMoney(l.expected_price)}</td></tr>)}</tbody>
        </table>
      )}
      {editing && <LinesEditor id={id} current={data ?? []} onClose={() => setEditing(false)} />}
    </Card>
  );
}

function LinesEditor({ id, current, onClose }: { id: string; current: OppLine[]; onClose: () => void }) {
  const products = useListProductsQuery();
  const [save, { isLoading }] = useSetCrmOppLinesMutation();
  const [rows, setRows] = useState(current.map((l) => ({ product: l.product, quantity: l.quantity, expected_price: l.expected_price })));
  const [err, setErr] = useState<string | null>(null);
  const set = (i: number, k: "product" | "quantity" | "expected_price", v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const submit = async () => {
    const problem = validateLines(rows);
    if (problem) { setErr(problem); return; }
    try { await save({ id, lines: rows.map((r) => ({ product: r.product, quantity: r.quantity.trim(), expected_price: r.expected_price.trim() })) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <div role="dialog" aria-label="Edit products" className="mt-3 rounded border border-slate-200 p-3">
      {rows.map((r, i) => (
        <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
          <select aria-label={`Product ${i + 1}`} className={`${inputClass} w-56`} value={r.product} onChange={(e) => set(i, "product", e.target.value)}>
            <option value="">Choose a product…</option>{(products.data?.results ?? []).filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.sku} {p.name}</option>)}
          </select>
          <input aria-label={`Quantity ${i + 1}`} inputMode="decimal" className={`${inputClass} w-24`} value={r.quantity} onChange={(e) => set(i, "quantity", e.target.value)} />
          <input aria-label={`Expected price ${i + 1}`} inputMode="decimal" className={`${inputClass} w-28`} value={r.expected_price} onChange={(e) => set(i, "expected_price", e.target.value)} />
          <Button variant="secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))}>{`Remove line ${i + 1}`}</Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => setRows([...rows, { product: "", quantity: "1", expected_price: "0" }])}>Add line</Button>
      {err && <p role="alert" className="my-2 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void submit()}>Save products</Button></div>
    </div>
  );
}

function HistoryCard({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useGetCrmOppHistoryQuery(id);
  const nameOf = useUserNames();
  return (
    <Card title="Stage history">
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No stage changes yet" /> : (
        <ol className="space-y-1 text-sm">{data.map((c, i) => (
          <li key={i}><time className="text-slate-500" dateTime={c.at}>{new Date(c.at).toLocaleString()}</time> · {c.from ? `${c.from} → ${c.to}` : `Opened at ${c.to}`}{c.actor ? ` by ${nameOf(c.actor)}` : ""}{c.note ? ` — ${c.note}` : ""}</li>))}</ol>
      )}
    </Card>
  );
}

function Fact({ k, v }: { k: string; v: string | null | undefined }) {
  return <div><dt className="text-xs text-slate-500">{k}</dt><dd className="text-sm">{v || "–"}</dd></div>;
}

function DetailsCard({ o, canEdit }: { o: OpportunityDetail; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [update] = useUpdateCrmOpportunityMutation();
  return (
    <Card title="Details" actions={canEdit ? <Button variant="secondary" onClick={() => setOpen(true)}>Edit details</Button> : undefined}>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Fact k="Amount" v={`${formatMoney(o.amount)} ${o.currency}`} /><Fact k="Expected close" v={o.expected_close} /><Fact k="Next action" v={o.next_action} /><Fact k="Next action date" v={o.next_action_date} />
        <Fact k="Competitors" v={o.competitors} /><Fact k="Requirements" v={o.requirements} /><Fact k="Decision makers" v={o.decision_makers} /><Fact k="Risks" v={o.risks} />
        {o.status === "LOST" && <Fact k="Lost because" v={o.lost_reason} />}
      </dl>
      {open && (
        <ActionDialog title="Edit details" cta="Save details" open onClose={() => setOpen(false)}
          initial={{ name: o.name, amount: o.amount, expected_close: o.expected_close ?? "", next_action: o.next_action, next_action_date: o.next_action_date ?? "", competitors: o.competitors, requirements: o.requirements, decision_makers: o.decision_makers, risks: o.risks }}
          fields={[{ name: "name", label: "Name", required: true }, { name: "amount", label: "Amount", required: true }, { name: "expected_close", label: "Expected close", type: "date" }, { name: "next_action", label: "Next action" },
            { name: "next_action_date", label: "Next action date", type: "date" }, { name: "competitors", label: "Competitors" }, { name: "requirements", label: "Requirements" }, { name: "decision_makers", label: "Decision makers" }, { name: "risks", label: "Risks" }]}
          submit={async (v) => {
            if (!moneyOk(v.amount!)) throw new Error("The amount must be a number with at most 2 decimals.");
            await update({ id: o.id, body: { ...v, name: v.name!.trim(), amount: v.amount!.trim(), expected_close: v.expected_close || null, next_action_date: v.next_action_date || null } }).unwrap();
          }} />
      )}
    </Card>
  );
}

function OwnerCard({ o }: { o: OpportunityDetail }) {
  const nameOf = useUserNames();
  const [assign] = useAssignCrmOwnerMutation();
  const [open, setOpen] = useState(false);
  const people = useUserOptions(!open);
  return (
    <Card title="Owner" actions={<Button variant="secondary" onClick={() => setOpen(true)}>Change owner</Button>}>
      <p className="text-sm">{nameOf(o.owner_id)}</p>
      {open && <ActionDialog title="Change owner" cta="Change owner" open onClose={() => setOpen(false)} initial={{ owner_id: o.owner_id }} fields={[{ name: "owner_id", label: "New owner", required: true, options: people, searchUsers: true }]} submit={async (v) => { await assign({ kind: "opportunity", id: o.id, owner_id: v.owner_id! }).unwrap(); }} />}
    </Card>
  );
}

export function OpportunityDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useGetCrmOpportunityQuery(id);
  const accountName = useAccountNames();
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const open = data.status === "OPEN";
  const manage = can("crm.manage") && open;
  return (
    <>
      <PageHeader title={data.name} description={`${data.stage.toLowerCase()} (${data.probability}%)`}
        actions={<div className="flex items-center gap-3"><Badge tone={data.status === "WON" ? "green" : data.status === "LOST" ? "red" : "amber"}>{data.status.toLowerCase()}</Badge><Link className="text-sm text-indigo-700 hover:underline" to={`/app/crm/accounts/${data.account}`}>{accountName(data.account)}</Link></div>} />
      <DetailsCard o={data} canEdit={manage} />
      {can("crm.assign") && open ? <OwnerCard o={data} /> : null}
      <LinesCard id={id} editable={manage} />
      <HistoryCard id={id} />
    </>
  );
}

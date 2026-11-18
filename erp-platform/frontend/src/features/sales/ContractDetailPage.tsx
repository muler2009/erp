import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { useAddContractObligationMutation, useCompleteContractObligationMutation, useGetContractHistoryQuery, useGetContractUtilisationQuery, useGetSalesContractQuery, useListProductsQuery, useSalesContractActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { CONTRACT_STATUS } from "./ContractsPage";

export const PARTY: Record<string, string> = { US: "Us", CUSTOMER: "The customer" };
export const EVENT_TEXT: Record<string, string> = { CREATED: "Created", UPDATED: "Changed", ACTIVATED: "Put in force", TERMINATED: "Ended early", RENEWED: "Renewed" };

export function ContractDetailPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { can } = useAccess();
  const q = useGetSalesContractQuery(id);
  const util = useGetContractUtilisationQuery(id);
  const hist = useGetContractHistoryQuery(id);
  const products = useListProductsQuery({});
  const [act] = useSalesContractActionMutation();
  const [addOb] = useAddContractObligationMutation();
  const [doneOb] = useCompleteContractObligationMutation();
  const [dlg, setDlg] = useState<"terminate" | "obligation" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (q.isLoading) return <Spinner />;
  const c = q.data;
  if (q.isError || !c) return <ErrorState error={new Error("This contract could not be loaded.")} onRetry={() => void q.refetch()} />;
  const prod = (pid: string) => { const p = products.data?.results.find((x) => x.id === pid); return p ? `${p.sku} — ${p.name}` : "Product"; };
  const run = async (action: "activate" | "renew") => {
    setErr(null);
    try { const r = await act({ id, action }).unwrap(); if (action === "renew") nav(`/app/sales/contracts/${r.id}`); } catch (e) { setErr(errorMessage(e)); }
  };
  const approver = can("sales.order.approve");
  const editor = can("sales.quote.create");
  const u = util.data;
  return (
    <div>
      <p className="mb-2 text-sm"><Link className="text-blue-700 underline" to="/app/sales/contracts">← All contracts</Link></p>
      <PageHeader title={`${c.number || "Draft contract"} — ${c.title}`} description={`${c.start_date} → ${c.end_date} · version ${c.version}`}
        actions={<div className="flex items-center gap-2"><Badge tone={CONTRACT_STATUS[c.status].tone}>{CONTRACT_STATUS[c.status].label}</Badge>
          {approver && c.status === "DRAFT" && <Button onClick={() => void run("activate")}>Put in force</Button>}
          {approver && c.status === "ACTIVE" && <Button onClick={() => void run("renew")}>Renew</Button>}
          {approver && c.status === "ACTIVE" && <Button variant="danger" onClick={() => setDlg("terminate")}>End early</Button>}</div>} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {u && (
        <Card title="Use of the contract">
          <p className="text-sm">Ordered so far: <strong>{formatMoney(u.ordered)} {u.currency}</strong>{u.committed ? <> of {formatMoney(u.committed)} committed{u.percent !== null && <> ({u.percent}%)</>}{u.remaining && <>, {formatMoney(u.remaining)} remaining</>}</> : " (no committed value set)"}.</p>
          <p className="mt-1 text-sm text-slate-600">{u.obligations_open} open obligation{u.obligations_open === 1 ? "" : "s"}{u.obligations_overdue > 0 && <span className="text-red-700"> — {u.obligations_overdue} overdue</span>}.</p>
        </Card>
      )}
      <Card title="Agreed prices">
        {(c.items ?? []).length === 0 ? <EmptyState title="No agreed prices" hint="Orders use normal pricing." /> : (
          <table className="w-full text-sm"><caption className="sr-only">Agreed prices</caption><thead><tr className="text-left text-slate-500"><th>Product</th><th className="text-right">From quantity</th><th className="text-right">Price</th></tr></thead>
            <tbody>{(c.items ?? []).map((i) => <tr key={i.product} className="border-t border-slate-100"><td className="py-1">{prod(i.product)}</td><td className="text-right">{Number(i.min_quantity)}</td><td className="text-right">{formatMoney(i.unit_price)} {c.currency}</td></tr>)}</tbody></table>
        )}
      </Card>
      <Card title="Obligations" actions={editor && c.status !== "TERMINATED" ? <Button variant="secondary" onClick={() => setDlg("obligation")}>Add obligation</Button> : undefined}>
        {(c.obligations ?? []).length === 0 ? <EmptyState title="No obligations" hint="Add deadlines either side must meet." /> : (
          <ul className="text-sm">{(c.obligations ?? []).map((o) => (
            <li key={o.id} className="flex items-center justify-between border-t border-slate-100 py-1"><span>{o.description} — {PARTY[o.party] ?? o.party}, due {o.due_date}</span>
              {o.done ? <Badge tone="green">Done</Badge> : editor ? <Button variant="secondary" onClick={() => void doneOb(o.id)}>{`Mark done: ${o.description}`}</Button> : <Badge tone="amber">Open</Badge>}</li>
          ))}</ul>
        )}
      </Card>
      <Card title="History">
        {(hist.data ?? []).length === 0 ? <p className="text-sm text-slate-600">No changes recorded.</p> : <ul className="text-sm">{(hist.data ?? []).map((h) => <li key={`${h.version}-${h.event}`} className="border-t border-slate-100 py-1">Version {h.version}: {EVENT_TEXT[h.event] ?? h.event} on {h.created_at.slice(0, 10)}</li>)}</ul>}
      </Card>
      {dlg === "terminate" && <ActionDialog title="End contract early" cta="End contract" open onClose={() => setDlg(null)} fields={[{ name: "reason", label: "Why is it ending?", required: true }]} submit={async (v) => { await act({ id, action: "terminate", reason: v.reason }).unwrap(); }} />}
      {dlg === "obligation" && <ActionDialog title="Add obligation" cta="Add" open onClose={() => setDlg(null)} fields={[{ name: "description", label: "What must happen", required: true }, { name: "due_date", label: "Due date", type: "date", required: true }, { name: "party", label: "Who must do it", options: [["US", "Us"], ["CUSTOMER", "The customer"]] }]} submit={async (v) => { await addOb({ id, description: v.description ?? "", due_date: v.due_date ?? "", party: v.party || "US" }).unwrap(); }} />}
    </div>
  );
}

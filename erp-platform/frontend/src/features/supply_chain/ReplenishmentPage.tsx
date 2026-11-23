import { useState } from "react";

import { useApproveSupplyPlanMutation, useGetSupplyPlanQuery, useListSuggestionsQuery, useListSupplyPlansQuery, useListWarehousesQuery, useRunReplenishmentMutation, useSuggestionActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { SuggestionRow } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ActionDialog } from "../hr/ActionDialog";
import { Badge, Button, Card, EmptyState, ErrorState, Modal, PageHeader, Spinner } from "../../shared/ui/primitives";

export const ACTION: Record<string, string> = { BUY: "Buy", MAKE: "Make" };
export const PLAN_STATUS: Record<string, { label: string; tone: "green" | "amber" | "slate" }> = { DRAFT: { label: "Draft", tone: "amber" }, APPROVED: { label: "Approved", tone: "green" }, SUPERSEDED: { label: "Replaced", tone: "slate" } };
export function adjustProblem(qty: string, needBy: string, reason: string, current: { quantity: string; need_by: string }): string | null {
  if (!qty.trim() && !needBy) return "Change the quantity or the date.";
  if (qty.trim() && (!/^\d+(\.\d{1,4})?$/.test(qty.trim()) || Number(qty) <= 0)) return "The quantity must be more than 0.";
  if (Number(qty || current.quantity) === Number(current.quantity) && (!needBy || needBy === current.need_by)) return "Nothing has changed.";
  if (!reason.trim()) return "Give a reason for the change.";
  return null;
}

type Dlg = { kind: "convert" | "dismiss" | "adjust"; row: SuggestionRow } | null;

function PlanDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAccess();
  const q = useGetSupplyPlanQuery(id);
  const [approve, st] = useApproveSupplyPlanMutation();
  const [err, setErr] = useState<string | null>(null);
  const p = q.data;
  return (
    <Modal title={p ? `Supply plan ${p.number}` : "Supply plan"} open onClose={onClose}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {p && (
        <>
          <p className="mb-2 text-sm"><Badge tone={PLAN_STATUS[p.status]?.tone ?? "slate"}>{PLAN_STATUS[p.status]?.label ?? p.status}</Badge> · made on {p.plan_date} · revision {p.revision}</p>
          <h3 className="text-sm font-semibold">Demand against supply</h3>
          {(p.balance.items ?? []).length === 0 ? <p className="mb-2 text-sm text-slate-600">No items were short or over-stocked.</p> : (
            <table className="mb-2 w-full text-sm"><thead><tr className="text-left"><th>Item</th><th className="text-right">Available</th><th className="text-right">Coming in</th><th className="text-right">Demand</th><th className="text-right">Short</th><th className="text-right">Surplus</th></tr></thead>
              <tbody>{(p.balance.items ?? []).map((b) => <tr key={b.product} className="border-t border-slate-100"><td>{b.sku}</td><td className="text-right">{Number(b.available)}</td><td className="text-right">{Number(b.inbound)}</td><td className="text-right">{Number(b.demand)}</td><td className="text-right">{Number(b.shortage)}</td><td className="text-right">{Number(b.surplus)}</td></tr>)}</tbody></table>
          )}
          <h3 className="text-sm font-semibold">Suggestions in this plan</h3>
          <ul className="mb-2 text-sm">{p.suggestions.map((s) => <li key={s.id}>{ACTION[s.action] ?? s.action} {Number(s.quantity)} {s.sku}, needed by {s.need_by} ({s.status.toLowerCase()})</li>)}{p.suggestions.length === 0 && <li>None.</li>}</ul>
          {p.changes.length > 0 && <><h3 className="text-sm font-semibold">Changes</h3><ul className="mb-2 text-sm">{p.changes.map((c, i) => <li key={i}>Revision {c.revision}: {c.field.replace("_", " ")} {c.old} → {c.new}. {c.reason}</li>)}</ul></>}
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          {p.status === "DRAFT" && can("supply_chain.plan.approve") && <div className="flex justify-end"><Button loading={st.isLoading} onClick={async () => { setErr(null); try { await approve(id).unwrap(); } catch (e) { setErr(errorMessage(e)); } }}>Approve plan</Button></div>}
        </>
      )}
    </Modal>
  );
}

export function ReplenishmentPage() {
  const { can } = useAccess();
  const manage = can("supply_chain.plan.manage");
  const [cursor, setCursor] = useState<string | null>(null);
  const sg = useListSuggestionsQuery({ cursor });
  const plans = useListSupplyPlansQuery();
  const wh = useListWarehousesQuery(undefined, { skip: !manage });
  const [run, rs] = useRunReplenishmentMutation();
  const [act] = useSuggestionActionMutation();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const close = () => setDlg(null);
  const locs = (wh.data?.results ?? []).flatMap((w) => w.locations.filter((l) => !l.is_blocked).map((l) => [l.id, `${w.code} / ${l.code}`] as [string, string]));
  const doRun = async () => { setErr(null); setNote(null); try { const r = await run().unwrap(); setNote(`Planning run finished: ${r.suggestions.length} suggestion${r.suggestions.length === 1 ? "" : "s"}. Earlier open suggestions were replaced.`); } catch (e) { setErr(errorMessage(e)); } };
  const convert = async (row: SuggestionRow) => { if (row.action === "MAKE") return setDlg({ kind: "convert", row }); setErr(null); try { await act({ id: row.id, action: "convert" }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <>
      <PageHeader title="Replenishment" description="Run planning to see what to buy or make, then turn suggestions into purchase requisitions or production orders." actions={manage ? <Button loading={rs.isLoading} onClick={() => void doRun()}>Run planning</Button> : undefined} />
      {note && <p role="status" className="mb-2 rounded bg-green-50 p-2 text-sm text-green-800">{note}</p>}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <Card title="Open suggestions">
        {sg.isLoading && <Spinner />}
        {sg.error && <ErrorState error={sg.error} onRetry={sg.refetch} />}
        {sg.data && sg.data.results.length === 0 && <EmptyState title="No open suggestions" hint="Run planning to see what is needed." />}
        {sg.data && sg.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Item</th><th>Action</th><th className="text-right">Quantity</th><th>Start by</th><th>Needed by</th><th /></tr></thead>
            <tbody>{sg.data.results.map((r) => (
              <tr key={r.id} className="border-t border-slate-100"><td>{r.sku}</td><td>{ACTION[r.action] ?? r.action}</td><td className="text-right">{Number(r.quantity)}</td><td>{r.start_by}</td><td>{r.need_by}</td>
                <td>{manage && <div className="flex gap-1"><Button onClick={() => void convert(r)}>{r.action === "MAKE" ? `Create order for ${r.sku}` : `Create requisition for ${r.sku}`}</Button><Button variant="secondary" onClick={() => setDlg({ kind: "adjust", row: r })}>Adjust {r.sku}</Button><Button variant="secondary" onClick={() => setDlg({ kind: "dismiss", row: r })}>Dismiss {r.sku}</Button></div>}</td></tr>
            ))}</tbody></table>
        )}
        <div className="mt-2 flex justify-end gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{sg.data?.next && <Button variant="secondary" onClick={() => setCursor(sg.data!.next)}>Next page</Button>}</div>
      </Card>
      <Card title="Supply plans">
        {plans.isLoading && <Spinner />}
        {plans.error && <ErrorState error={plans.error} onRetry={plans.refetch} />}
        {plans.data && plans.data.results.length === 0 && <EmptyState title="No supply plans" hint="Each planning run creates a plan." />}
        {plans.data && plans.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Date</th><th>Revision</th><th>Status</th><th /></tr></thead>
            <tbody>{plans.data.results.map((p) => { const s = PLAN_STATUS[p.status] ?? { label: p.status, tone: "slate" as const }; return <tr key={p.id} className="border-t border-slate-100"><td>{p.number}</td><td>{p.plan_date}</td><td>{p.revision}</td><td><Badge tone={s.tone}>{s.label}</Badge></td><td><Button variant="secondary" onClick={() => setOpen(p.id)}>Open {p.number}</Button></td></tr>; })}</tbody></table>
        )}
      </Card>
      <ActionDialog title="Create production order" open={dlg?.kind === "convert"} onClose={close} cta="Create order" fields={[{ name: "location", label: "Finished goods go to", type: "select", options: locs }]}
        submit={async (v) => { if (!v.location) throw new Error("Choose the location for the finished goods."); await act({ id: dlg!.row.id, action: "convert", body: { location: v.location } }).unwrap(); }} />
      <ActionDialog title="Dismiss suggestion" open={dlg?.kind === "dismiss"} onClose={close} cta="Dismiss" fields={[{ name: "note", label: "Reason" }]}
        submit={async (v) => { if (!(v.note ?? "").trim()) throw new Error("Give a reason for dismissing."); await act({ id: dlg!.row.id, action: "dismiss", body: { note: v.note!.trim() } }).unwrap(); }} />
      <ActionDialog title="Adjust suggestion" open={dlg?.kind === "adjust"} onClose={close} cta="Save change" fields={[{ name: "quantity", label: "New quantity" }, { name: "need_by", label: "New needed-by date", type: "date" }, { name: "reason", label: "Reason" }]}
        submit={async (v) => {
          const row = dlg!.row; const p = adjustProblem(v.quantity ?? "", v.need_by ?? "", v.reason ?? "", row); if (p) throw new Error(p);
          await act({ id: row.id, action: "adjust", body: { ...(v.quantity?.trim() ? { quantity: v.quantity.trim() } : {}), ...(v.need_by ? { need_by: v.need_by } : {}), reason: v.reason!.trim() } }).unwrap();
        }} />
      {open && <PlanDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
export default ReplenishmentPage;

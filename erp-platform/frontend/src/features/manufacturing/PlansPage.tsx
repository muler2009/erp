import { useState } from "react";

import { useCreatePlanMutation, useGetPlanQuery, useLazyCheckPlanQuery, useLazySuggestPlanLinesQuery, useListPlansQuery, useListWarehousesQuery, usePlanActionMutation, useRevisePlanMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { PlanDetail, PlanInput, Product } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export const PLAN_STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate" }> = { DRAFT: { label: "Draft", tone: "slate" }, APPROVED: { label: "Approved", tone: "amber" }, RELEASED: { label: "Released", tone: "green" }, CANCELLED: { label: "Cancelled", tone: "red" } };
const QTY = /^\d+(\.\d{1,4})?$/;

export interface PlanLineDraft { product: string; sku: string; quantity: string; required_date: string }
export interface PlanDraft { name: string; start: string; end: string; lines: PlanLineDraft[] }
export function planProblem(d: PlanDraft): string | null {
  if (!d.name.trim()) return "Give the plan a name.";
  if (!d.start || !d.end) return "Choose the plan period.";
  if (d.end < d.start) return "The period ends before it starts.";
  if (d.lines.length === 0) return "Add at least one product to make.";
  for (const [i, l] of d.lines.entries()) {
    if (!QTY.test(l.quantity.trim()) || Number(l.quantity) <= 0) return `Line ${i + 1}: quantity must be more than 0.`;
    if (!l.required_date) return `Line ${i + 1}: choose the date it is needed.`;
    if (l.required_date < d.start || l.required_date > d.end) return `Line ${i + 1}: the date is outside the plan period.`;
  }
  return null;
}
export const planInput = (d: PlanDraft): PlanInput => ({ name: d.name.trim(), period_start: d.start, period_end: d.end, lines: d.lines.map((l) => ({ product: l.product, quantity: l.quantity.trim(), required_date: l.required_date })) });

function NewPlan({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, st] = useCreatePlanMutation();
  const [suggest, sg] = useLazySuggestPlanLinesQuery();
  const [d, setD] = useState<PlanDraft>({ name: "", start: "", end: "", lines: [] });
  const [err, setErr] = useState<string | null>(null);
  const add = (p: Product | null) => { if (p) setD((x) => ({ ...x, lines: [...x.lines, { product: p.id, sku: p.sku, quantity: "1", required_date: x.start }] })); };
  const fill = async () => {
    if (!d.start || !d.end || d.end < d.start) return setErr("Choose a valid period first.");
    setErr(null);
    const r = await suggest({ from: d.start, to: d.end });
    if (r.error) return setErr(errorMessage(r.error));
    const s = r.data ?? [];
    if (s.length === 0) return setErr("No demand was found for this period.");
    setD((x) => ({ ...x, lines: s.map((l) => ({ product: l.product, sku: l.sku, quantity: String(Number(l.quantity)), required_date: l.required_date })) }));
  };
  const up = (i: number, k: "quantity" | "required_date", v: string) => setD({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const go = async () => { const p = planProblem(d); if (p) return setErr(p); try { await create(planInput(d)).unwrap(); setD({ name: "", start: "", end: "", lines: [] }); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title="New production plan" open={open} onClose={onClose}>
      <FormField label="Plan name" htmlFor="pl-name"><input id="pl-name" className={inputClass} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="From" htmlFor="pl-from"><input id="pl-from" type="date" className={inputClass} value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} /></FormField>
        <FormField label="To" htmlFor="pl-to"><input id="pl-to" type="date" className={inputClass} value={d.end} onChange={(e) => setD({ ...d, end: e.target.value })} /></FormField>
      </div>
      <Button variant="secondary" loading={sg.isFetching} onClick={() => void fill()}>Fill from demand</Button>
      {d.lines.map((l, i) => (
        <div key={i} className="mt-2 flex items-center gap-2 text-sm">
          <span className="w-28 truncate">{l.sku}</span>
          <input aria-label={`Quantity of ${l.sku}`} className={`${inputClass} w-24`} value={l.quantity} onChange={(e) => up(i, "quantity", e.target.value)} />
          <input aria-label={`Needed by for ${l.sku}`} type="date" className={`${inputClass} w-40`} value={l.required_date} onChange={(e) => up(i, "required_date", e.target.value)} />
          <Button variant="secondary" onClick={() => setD({ ...d, lines: d.lines.filter((_, j) => j !== i) })}>Remove {l.sku}</Button>
        </div>
      ))}
      <ProductPicker label="Add a product" onChange={add} />
      {err && <p role="alert" className="my-2 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Create plan</Button></div>
    </Modal>
  );
}

export const reviseProblem = (d: PlanDraft, reason: string): string | null => (!reason.trim() ? "Give a reason for the revision." : planProblem({ ...d, name: d.name || "x" }));

function ReviseDialog({ plan, onClose }: { plan: PlanDetail; onClose: () => void }) {
  const [revise, st] = useRevisePlanMutation();
  const [lines, setLines] = useState<(PlanLineDraft & { priority: number })[]>(plan.lines.map((l) => ({ product: l.product, sku: l.sku, quantity: String(Number(l.quantity)), required_date: l.required_date, priority: l.priority })));
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const up = (i: number, k: "quantity" | "required_date", v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const go = async () => {
    const p = reviseProblem({ name: plan.name, start: plan.period_start, end: plan.period_end, lines }, reason);
    if (p) return setErr(p);
    try { await revise({ id: plan.id, reason: reason.trim(), lines: lines.map((l) => ({ product: l.product, quantity: l.quantity.trim(), required_date: l.required_date, priority: l.priority })) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Revise ${plan.number}`} open onClose={onClose}>
      <p className="mb-2 text-sm text-slate-600">Changing the lines creates a new revision{plan.status === "APPROVED" ? " and sends the plan back for approval" : ""}.</p>
      {lines.map((l, i) => (
        <div key={`${l.product}-${i}`} className="mb-1 flex items-center gap-2 text-sm">
          <span className="w-28 truncate">{l.sku}</span>
          <input aria-label={`Quantity of ${l.sku}`} className={`${inputClass} w-24`} value={l.quantity} onChange={(e) => up(i, "quantity", e.target.value)} />
          <input aria-label={`Needed by for ${l.sku}`} type="date" className={`${inputClass} w-40`} value={l.required_date} onChange={(e) => up(i, "required_date", e.target.value)} />
          <Button variant="secondary" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove {l.sku}</Button>
        </div>
      ))}
      <ProductPicker label="Add a product" onChange={(p) => { if (p) setLines([...lines, { product: p.id, sku: p.sku, quantity: "1", required_date: plan.period_start, priority: 3 }]); }} />
      <FormField label="Reason for the change" htmlFor="rv-reason"><input id="rv-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
      {err && <p role="alert" className="my-2 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Save revision</Button></div>
    </Modal>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAccess();
  const q = useGetPlanQuery(id);
  const wh = useListWarehousesQuery();
  const [check, ck] = useLazyCheckPlanQuery();
  const [act, st] = usePlanActionMutation();
  const [dlg, setDlg] = useState<"release" | "cancel" | "revise" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const p = q.data;
  const locs = (wh.data?.results ?? []).flatMap((w) => w.locations.filter((l) => !l.is_blocked).map((l) => [l.id, `${w.code} / ${l.code}`] as [string, string]));
  const approve = async () => { setErr(null); try { await act({ id, action: "approve" }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title={p ? `${p.number} — ${p.name}` : "Production plan"} open onClose={onClose}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {p && (
        <>
          <p className="mb-2 text-sm"><Badge tone={PLAN_STATUS[p.status]?.tone ?? "slate"}>{PLAN_STATUS[p.status]?.label ?? p.status}</Badge> · {p.period_start} to {p.period_end} · revision {p.revision}</p>
          <table className="mb-2 w-full text-sm"><thead><tr className="text-left"><th>Product</th><th className="text-right">Quantity</th><th>Needed by</th><th>Order</th></tr></thead>
            <tbody>{p.lines.map((l) => <tr key={l.id} className="border-t border-slate-100"><td>{l.sku}</td><td className="text-right">{Number(l.quantity)}</td><td>{l.required_date}</td><td>{l.order ? "Created" : "—"}</td></tr>)}</tbody></table>
          {p.revisions.length > 0 && <ul className="mb-2 text-sm text-slate-600">{p.revisions.map((r) => <li key={r.revision}>Revision {r.revision}: {r.reason || "no reason given"}</li>)}</ul>}
          {["DRAFT", "APPROVED"].includes(p.status) && <Button variant="secondary" loading={ck.isFetching} onClick={() => void check(id)}>Check feasibility</Button>}
          {ck.data && (
            <Card title={ck.data.feasible ? "Feasible" : "Not feasible"}>
              {ck.data.material_shortages.length === 0 && !ck.data.capacity.some((c) => c.bottleneck) && <p className="text-sm">Materials and capacity cover the plan.</p>}
              {ck.data.material_shortages.map((s) => <p key={s.sku} className="text-sm text-red-700">Short of {s.sku}: need {Number(s.required)}, have {Number(s.available)}.</p>)}
              {ck.data.capacity.filter((c) => c.bottleneck).map((c) => <p key={c.work_center} className="text-sm text-red-700">{c.work_center} is over capacity ({c.utilization_percent ? `${Number(c.utilization_percent)}%` : "no capacity"}).</p>)}
            </Card>
          )}
          {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {p.status === "DRAFT" && can("manufacturing.plan.approve") && <Button loading={st.isLoading} onClick={() => void approve()}>Approve</Button>}
            {p.status === "APPROVED" && can("manufacturing.plan.approve") && <Button onClick={() => setDlg("release")}>Release as production orders</Button>}
            {["DRAFT", "APPROVED"].includes(p.status) && can("manufacturing.plan.manage") && <Button variant="secondary" onClick={() => setDlg("revise")}>Revise plan</Button>}
            {["DRAFT", "APPROVED"].includes(p.status) && can("manufacturing.plan.manage") && <Button variant="danger" onClick={() => setDlg("cancel")}>Cancel plan</Button>}
          </div>
          {dlg === "revise" && <ReviseDialog plan={p} onClose={() => setDlg(null)} />}
          <ActionDialog title="Release plan" open={dlg === "release"} onClose={() => setDlg(null)} cta="Create orders" fields={[{ name: "location", label: "Finished goods go to", type: "select", options: locs }]}
            submit={async (v) => { if (!v.location) throw new Error("Choose the location for the finished goods."); await act({ id, action: "release", body: { location: v.location } }).unwrap(); }} />
          <ActionDialog title="Cancel plan" open={dlg === "cancel"} onClose={() => setDlg(null)} cta="Cancel plan" fields={[{ name: "reason", label: "Reason" }]}
            submit={async (v) => { if (!(v.reason ?? "").trim()) throw new Error("Give a reason for cancelling."); await act({ id, action: "cancel", body: { reason: v.reason!.trim() } }).unwrap(); }} />
        </>
      )}
    </Modal>
  );
}

export function PlansPage() {
  const { can } = useAccess();
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListPlansQuery({ cursor });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Production plans" description="Plan what to make over a period, check it is feasible, get it approved, then release it as production orders." actions={can("manufacturing.plan.manage") ? <Button onClick={() => setCreating(true)}>New plan</Button> : undefined} />
      <Card>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No production plans" hint="Create a plan to schedule production." />}
        {q.data && q.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Name</th><th>Period</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.results.map((r) => { const s = PLAN_STATUS[r.status] ?? { label: r.status, tone: "slate" as const }; return <tr key={r.id} className="border-t border-slate-100"><td>{r.number}</td><td>{r.name}</td><td>{r.period_start} to {r.period_end}</td><td><Badge tone={s.tone}>{s.label}</Badge></td><td><Button variant="secondary" onClick={() => setOpen(r.id)}>Open {r.number}</Button></td></tr>; })}</tbody></table>
        )}
        {q.data?.next && <div className="mt-3 text-right"><Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button></div>}
      </Card>
      <NewPlan open={creating} onClose={() => setCreating(false)} />
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

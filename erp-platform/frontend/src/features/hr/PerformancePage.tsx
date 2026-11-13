import { useState } from "react";

import { useAddGoalMutation, useCreateCycleMutation, useCycleActionMutation, useGoalProgressMutation, useListCyclesQuery, useListGoalsQuery, useListReviewsQuery, useReviewActionMutation } from "../../shared/api/endpoints";
import type { Goal, PerfReview } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "./ActionDialog";
import { EmployeeRequest } from "./EmployeeRequest";
import { pretty } from "./EmployeeDialogs";
import { useEmployeeNames } from "./names";

export function validateRating(r: string): string | null { return /^[1-5]$/.test(r) ? null : "Rating must be a whole number from 1 to 5."; }
export function validatePercent(p: string): string | null { return /^\d{1,3}(\.\d{1,2})?$/.test(p) && Number(p) <= 100 ? null : "Enter a percentage from 0 to 100."; }
export function validateCycle(f: { name: string; start_date: string; end_date: string }): string | null {
  if (!f.name.trim()) return "Enter a cycle name.";
  if (!f.start_date || !f.end_date || f.end_date < f.start_date) return "The end date must be on or after the start date.";
  return null;
}

function GoalRow({ g, closed }: { g: Goal; closed: boolean }) {
  const [save] = useGoalProgressMutation();
  const [v, setV] = useState(g.progress);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { const p = validatePercent(v); if (p) { setErr(p); return; } setErr(null); try { await save({ id: g.id, progress: v }).unwrap(); } catch (e) { setErr(failure(e)); } };
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2">
      <span className="min-w-40 flex-1">{g.title}</span><span className="text-sm text-slate-500">weight {g.weight}%</span>
      <label className="text-sm">Progress % <input aria-label={`Progress for ${g.title}`} className="w-20 rounded border border-slate-300 px-2 py-1" value={v} disabled={closed} onChange={(e) => setV(e.target.value)} /></label>
      {!closed && <Button variant="secondary" onClick={() => void go()}>Save progress</Button>}
      {err && <span role="alert" className="text-sm text-red-700">{err}</span>}
    </li>
  );
}

export function PerformancePage() {
  const { can } = useAccess();
  const manage = can("hr.performance.manage");
  const cycles = useListCyclesQuery();
  const [cycle, setCycle] = useState("");
  const active = cycle || cycles.data?.[0]?.id || "";
  const current = cycles.data?.find((c) => c.id === active);
  const reviews = useListReviewsQuery({ cycle: active || undefined }, { skip: !active });
  const goals = useListGoalsQuery({ cycle: active || undefined }, { skip: !active });
  const name = useEmployeeNames();
  const [createCycle] = useCreateCycleMutation();
  const [cycleAct] = useCycleActionMutation();
  const [review] = useReviewActionMutation();
  const [addGoal] = useAddGoalMutation();
  const [dlg, setDlg] = useState<"cycle" | "goal" | null>(null);
  const [rv, setRv] = useState<{ r: PerfReview; kind: "self" | "manager" } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(failure(e)); } };
  return (
    <>
      <PageHeader title="Performance" description="Review cycles, goals and ratings." actions={manage ? <Button onClick={() => setDlg("cycle")}>New cycle</Button> : undefined} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <Card title="Cycle">
        {cycles.isLoading ? <Spinner /> : cycles.error ? <ErrorState error={cycles.error} onRetry={cycles.refetch} /> : !cycles.data?.length ? <EmptyState title="No review cycles yet" /> : (
          <div className="flex flex-wrap items-center gap-3">
            <select aria-label="Review cycle" className="rounded border border-slate-300 px-2 py-1" value={active} onChange={(e) => setCycle(e.target.value)}>{cycles.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            {current && <Badge tone={current.status === "ACTIVE" ? "green" : current.status === "CLOSED" ? "slate" : "amber"}>{pretty(current.status)}</Badge>}
            {current && manage && current.status === "DRAFT" && <Button onClick={() => void run(() => cycleAct({ id: current.id, action: "activate" }).unwrap())}>Activate</Button>}
            {current && manage && current.status === "ACTIVE" && <Button variant="secondary" onClick={() => void run(() => cycleAct({ id: current.id, action: "close" }).unwrap())}>Close cycle</Button>}
          </div>
        )}
      </Card>
      {current && (
        <>
          <div className="mt-4"><Card title="Goals">
            {manage && current.status !== "CLOSED" && <div className="mb-2"><Button variant="secondary" onClick={() => setDlg("goal")}>Add goal</Button></div>}
            {goals.isLoading ? <Spinner /> : !goals.data?.results.length ? <EmptyState title="No goals in this cycle" /> : <ul>{goals.data.results.map((g) => <GoalRow key={g.id} g={g} closed={current.status === "CLOSED"} />)}</ul>}
          </Card></div>
          <div className="mt-4"><Card title="Reviews">
            {reviews.isLoading ? <Spinner /> : reviews.error ? <ErrorState error={reviews.error} onRetry={reviews.refetch} /> : !reviews.data?.results.length ? <EmptyState title="No reviews in this cycle" /> : (
              <ul>{reviews.data.results.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2">
                  <span className="min-w-40 flex-1">{name(r.employee)} ({r.employee_no})</span><Badge tone={r.status === "ACKNOWLEDGED" ? "green" : "slate"}>{pretty(r.status)}</Badge>
                  <span className="text-sm text-slate-500">Self {r.self_rating ?? "–"} · Manager {r.manager_rating ?? "–"} · Goals {r.goal_score ?? "–"}</span>
                  {r.status === "PENDING_SELF" && <Button variant="secondary" onClick={() => setRv({ r, kind: "self" })}>Self review</Button>}
                  {r.status === "PENDING_MANAGER" && <Button variant="secondary" onClick={() => setRv({ r, kind: "manager" })}>Manager review</Button>}
                  {r.status === "COMPLETED" && <Button variant="secondary" onClick={() => void run(() => review({ id: r.id, action: "acknowledge" }).unwrap())}>Acknowledge</Button>}
                </li>))}</ul>
            )}
          </Card></div>
        </>
      )}
      <ActionDialog title="New review cycle" open={dlg === "cycle"} onClose={() => setDlg(null)} cta="Create cycle" fields={[{ name: "name", label: "Name", required: true }, { name: "start_date", label: "Start date", type: "date", required: true }, { name: "end_date", label: "End date", type: "date", required: true }]}
        submit={async (v) => { const f = { name: v.name ?? "", start_date: v.start_date ?? "", end_date: v.end_date ?? "" }; const p = validateCycle(f); if (p) throw new Error(p); await createCycle({ ...f, name: f.name.trim() }).unwrap(); }} />
      <EmployeeRequest title="Add goal" open={dlg === "goal"} onClose={() => setDlg(null)} cta="Add goal" fields={[{ name: "title", label: "Goal", required: true }, { name: "weight", label: "Weight %", required: true }]}
        submit={async (emp, v) => { const p = validatePercent(v.weight ?? ""); if (p) throw new Error(p); await addGoal({ employee: emp, cycle: active, title: (v.title ?? "").trim(), weight: v.weight ?? "" }).unwrap(); }} />
      <ActionDialog title={rv?.kind === "manager" ? "Manager review" : "Self review"} open={!!rv} onClose={() => setRv(null)} cta="Submit review" fields={[{ name: "rating", label: "Rating (1-5)", required: true }, { name: "comment", label: "Comment" }]}
        submit={async (v) => { const p = validateRating(v.rating ?? ""); if (p) throw new Error(p); await review({ id: rv!.r.id, action: rv!.kind, rating: Number(v.rating), comment: v.comment ?? "" }).unwrap(); }} />
    </>
  );
}

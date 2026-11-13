import { useState } from "react";
import { useParams } from "react-router";

import { useAddDependencyMutation, useGetGanttQuery, useRemoveDependencyMutation, useShiftTaskMutation } from "../../shared/api/endpoints";
import type { GanttTask } from "../../shared/api/types";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { ProjectNav } from "./ProjectFinancePage";

const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;

/** Position of a bar on the project timeline, in percent of the span; clamped so bars never leave the track. */
export function barGeometry(start: string, end: string, projStart: string, projEnd: string): { left: number; width: number } {
  const span = Math.max(day(projEnd) - day(projStart) + 1, 1);
  const left = Math.min(Math.max(((day(start) - day(projStart)) / span) * 100, 0), 100);
  const width = Math.min(Math.max(((day(end) - day(start) + 1) / span) * 100, 1), 100 - left || 1);
  return { left: Math.round(left * 100) / 100, width: Math.round(width * 100) / 100 };
}

export function validateLink(f: { predecessor: string; successor: string; kind: string; lag: string }): string | null {
  if (!f.predecessor || !f.successor) return "Choose both tasks.";
  if (f.predecessor === f.successor) return "A task cannot depend on itself.";
  if (!["FS", "SS"].includes(f.kind)) return "Choose finish-to-start or start-to-start.";
  if (!/^-?\d{1,3}$/.test(f.lag)) return "Lag must be a whole number of days.";
  return null;
}
export function validateShift(days: string): string | null { return /^-?\d{1,4}$/.test(days) && Number(days) !== 0 ? null : "Enter a number of days other than zero (negative moves earlier)."; }

export function ProjectSchedulePage() {
  const { id = "" } = useParams();
  const { data, isLoading, error, refetch } = useGetGanttQuery(id);
  const [link] = useAddDependencyMutation();
  const [unlink] = useRemoveDependencyMutation();
  const [shift] = useShiftTaskMutation();
  const [dlg, setDlg] = useState<"link" | null>(null);
  const [moving, setMoving] = useState<GanttTask | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const leaves = (data?.tasks ?? []).filter((t) => !t.summary && !["DONE", "CANCELLED"].includes(t.status));
  const name = (tid: string) => data?.tasks.find((t) => t.id === tid)?.wbs ?? "?";
  return (
    <>
      <PageHeader title="Schedule" description="Timeline, dependencies and the critical path." actions={<Button variant="secondary" onClick={() => setDlg("link")}>Link tasks</Button>} />
      <ProjectNav id={id} current="schedule" />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <Card title="Gantt">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.tasks.length ? <EmptyState title="No tasks to schedule" /> : (
          <>
            <p className="mb-2 text-sm">Critical path: {data.critical_path.length ? data.critical_path.join(" → ") : "none"} · {data.start} to {data.end}</p>
            <ul>{data.tasks.map((t) => {
              const g = barGeometry(t.start, t.end, data.start, data.end);
              return (
                <li key={t.id} className="border-b border-slate-100 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="w-12 font-mono">{t.wbs}</span><span className="min-w-32 flex-1">{t.milestone ? "◆ " : ""}{t.name}</span>
                    {t.critical && <Badge tone="red">Critical</Badge>}{t.slack_days !== undefined && !t.critical && <span className="text-slate-500">slack {t.slack_days}d</span>}
                    {!t.summary && !["DONE", "CANCELLED"].includes(t.status) && <Button variant="secondary" onClick={() => setMoving(t)}>{`Move ${t.wbs}`}</Button>}
                  </div>
                  <div className="relative mt-1 h-3 rounded bg-slate-100" role="img" aria-label={`${t.wbs} ${t.name} from ${t.start} to ${t.end}, ${t.percent}% done`}>
                    <div className={`absolute h-3 rounded ${t.critical ? "bg-red-500" : "bg-indigo-500"}`} style={{ left: `${g.left}%`, width: `${g.width}%` }} />
                  </div>
                  {t.predecessors.length > 0 && <p className="mt-1 text-xs text-slate-500">After: {t.predecessors.map((p) => (
                    <span key={p.id} className="mr-3">{name(p.task)} ({p.kind}{p.lag_days ? ` ${p.lag_days > 0 ? "+" : ""}${p.lag_days}d` : ""}) <button type="button" className="underline" aria-label={`Remove link ${name(p.task)} to ${t.wbs}`} onClick={async () => { setErr(null); try { await unlink(p.id).unwrap(); } catch (e) { setErr(failure(e)); } }}>remove</button></span>))}</p>}
                </li>
              );
            })}</ul>
          </>
        )}
      </Card>
      <ActionDialog title="Link tasks" open={dlg === "link"} onClose={() => setDlg(null)} cta="Add link"
        fields={[{ name: "predecessor", label: "Predecessor", required: true, options: leaves.map((t) => [t.id, `${t.wbs} ${t.name}`] as [string, string]) }, { name: "successor", label: "Successor", required: true, options: leaves.map((t) => [t.id, `${t.wbs} ${t.name}`] as [string, string]) }, { name: "kind", label: "Type", required: true, options: [["FS", "Finish to start"], ["SS", "Start to start"]] }, { name: "lag", label: "Lag (days)" }]}
        submit={async (v) => { const f = { predecessor: v.predecessor ?? "", successor: v.successor ?? "", kind: v.kind ?? "", lag: (v.lag ?? "0").trim() || "0" }; const p = validateLink(f); if (p) throw new Error(p); await link({ predecessor: f.predecessor, successor: f.successor, kind: f.kind, lag_days: Number(f.lag) }).unwrap(); }} />
      <ActionDialog key={moving?.id} title={moving ? `Move ${moving.wbs}` : "Move task"} open={!!moving} onClose={() => setMoving(null)} cta="Move" fields={[{ name: "days", label: "Days", required: true }, { name: "cascade", label: "Also move dependent tasks", options: [["yes", "Yes"], ["no", "No"]] }]}
        submit={async (v) => { const p = validateShift((v.days ?? "").trim()); if (p) throw new Error(p); await shift({ id: moving!.id, days: Number(v.days), cascade: v.cascade !== "no" }).unwrap(); }} />
    </>
  );
}

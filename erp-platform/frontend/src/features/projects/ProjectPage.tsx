import { useState } from "react";
import { ProjectNav } from "./ProjectFinancePage";
import { useParams } from "react-router";

import { useCreateProjectTaskMutation, useGetProjectQuery, useListProjectTasksQuery, useSetProjectStatusMutation, useUpdateTaskProgressMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DirectoryUser, ProjectTask } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserPicker } from "../../shared/ui/UserPicker";
import { TaskDeleteDialog, TaskEditDialog } from "./TaskEdit";
import { HealthCard } from "./HealthPortfolio";
import { pretty, statusTone } from "./ProjectsPage";

/** Allowed next statuses; the server owns the rules and refuses anything else. */
export const NEXT: Record<string, string[]> = { PLANNING: ["ACTIVE", "CANCELLED"], ACTIVE: ["ON_HOLD", "COMPLETED", "CANCELLED"], ON_HOLD: ["ACTIVE", "CANCELLED"], COMPLETED: [], CANCELLED: [] };

export function validateTask(f: { name: string; start: string; end: string; hours: string }): string | null {
  if (!f.name.trim()) return "Name the task.";
  if (!f.start || !f.end) return "Enter the planned start and end dates.";
  if (f.end < f.start) return "The task cannot end before it starts.";
  const h = f.hours.trim() === "" ? 0n : parseMoney(f.hours);
  if (h === null || h < 0n) return "Planned hours must be a number of 0 or more.";
  return null;
}
export function validPercent(v: string): boolean {
  const n = parseMoney(v);
  return n !== null && n >= 0n && n <= 1000000n;
}

export function ProgressDialog({ task, onClose }: { task: ProjectTask | null; onClose: () => void }) {
  const [update, state] = useUpdateTaskProgressMutation();
  const [pct, setPct] = useState(task?.percent_complete ?? "0");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (!task) return;
    const value = pct;
    if (!validPercent(value)) { setErr("Percent complete must be between 0 and 100."); return; }
    setErr(null);
    try { await update({ id: task.id, percent: value.trim(), note: note.trim() }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={task ? `Progress: ${task.name}` : "Progress"} open={!!task} onClose={onClose}>
      {task?.milestone ? (
        <FormField label="Milestone" htmlFor="pg-pct"><select id="pg-pct" className={inputClass} value={pct} onChange={(e) => setPct(e.target.value)}><option value="0">Not reached</option><option value="100">Reached</option></select></FormField>
      ) : (
        <FormField label="Percent complete" htmlFor="pg-pct"><input id="pg-pct" inputMode="decimal" className={`${inputClass} text-right`} value={pct} onChange={(e) => setPct(e.target.value)} /></FormField>
      )}
      <FormField label="Note (optional)" htmlFor="pg-note"><input id="pg-note" maxLength={300} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Save progress</Button></div>
    </Modal>
  );
}

function NewTaskDialog({ project, open, onClose }: { project: string; open: boolean; onClose: () => void }) {
  const [create, state] = useCreateProjectTaskMutation();
  const [f, setF] = useState({ name: "", start: "", end: "", hours: "", milestone: false });
  const [assignee, setAssignee] = useState<DirectoryUser | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const problem = validateTask(f);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await create({ project, body: { name: f.name.trim(), planned_start: f.start, planned_end: f.end, milestone: f.milestone, planned_hours: f.hours.trim() || "0", ...(assignee ? { assignee: assignee.id } : {}) } }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New task" open={open} onClose={onClose}>
      <FormField label="Name" htmlFor="tk-name"><input id="tk-name" maxLength={200} className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Planned start" htmlFor="tk-start"><input id="tk-start" type="date" className={inputClass} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></FormField>
        <FormField label="Planned end" htmlFor="tk-end"><input id="tk-end" type="date" className={inputClass} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></FormField>
        <FormField label="Planned hours" htmlFor="tk-hours"><input id="tk-hours" inputMode="decimal" className={`${inputClass} text-right`} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></FormField>
      </div>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.milestone} onChange={(e) => setF({ ...f, milestone: e.target.checked })} /> This is a milestone</label>
      <UserPicker label="Assignee (optional)" onChange={setAssignee} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Add task</Button></div>
    </Modal>
  );
}

function StatusDialog({ id, current, to, onClose }: { id: string; current: string; to: string | null; onClose: () => void }) {
  const [set, state] = useSetProjectStatusMutation();
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { setErr(null); try { await set({ id, status: to!, reason: reason.trim() }).unwrap(); setReason(""); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title={to ? `Move project to ${pretty(to)}` : "Change status"} open={!!to} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">Currently {pretty(current)}. The server refuses the change when tasks are still open or the move is not allowed.</p>
      <FormField label="Reason" htmlFor="st-reason"><input id="st-reason" maxLength={300} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Confirm</Button></div>
    </Modal>
  );
}

export function ProjectPage() {
  const { id = "" } = useParams();
  const project = useGetProjectQuery(id);
  const tasks = useListProjectTasksQuery(id);
  const [adding, setAdding] = useState(false);
  const [progress, setProgress] = useState<ProjectTask | null>(null);
  const [editing, setEditing] = useState<ProjectTask | null>(null);
  const [deleting, setDeleting] = useState<ProjectTask | null>(null);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  if (project.isLoading) return <Spinner />;
  if (project.error || !project.data) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  const p = project.data;
  return (
    <>
      <PageHeader title={`${p.code} ${p.name}`} description={`${p.start_on} to ${p.end_on} · ${pretty(p.billing_type)}${Number(p.contract_value) > 0 ? ` · ${formatMoney(p.contract_value)}` : ""}`}
        actions={<div className="flex gap-2">{NEXT[p.status]?.map((s) => <Button key={s} variant="secondary" onClick={() => setMoveTo(s)}>{`Mark ${pretty(s)}`}</Button>)}<Button onClick={() => setAdding(true)}>Add task</Button></div>} />
      <ProjectNav id={id} current="" />
      <p className="mb-3"><Badge tone={statusTone(p.status)}>{pretty(p.status)}</Badge></p>
      {p.description && <p className="mb-4 text-sm">{p.description}</p>}
      <HealthCard id={id} />
      <Card title="Tasks">
        {tasks.isLoading ? <Spinner /> : tasks.error ? <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} /> : tasks.data!.results.length === 0 ? <EmptyState title="No tasks yet" /> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left"><th>WBS</th><th>Task</th><th>Planned</th><th className="text-right">Hours</th><th className="text-right">Done</th><th>Status</th><th /></tr></thead>
            <tbody>{tasks.data!.results.map((t) => (
              <tr key={t.id} className="border-t border-slate-100"><td>{t.wbs}</td><td>{t.milestone ? "◆ " : ""}{t.name}</td><td>{t.planned_start} to {t.planned_end}</td><td className="text-right">{formatMoney(t.planned_hours)}</td><td className="text-right">{formatMoney(t.percent_complete)}%</td><td>{pretty(t.status)}</td>
                <td className="space-x-1">{!["DONE", "CANCELLED"].includes(t.status) && p.status === "ACTIVE" && <Button variant="secondary" onClick={() => setProgress(t)}>Update progress</Button>}{!["DONE", "CANCELLED"].includes(t.status) && !["COMPLETED", "CANCELLED"].includes(p.status) && <Button variant="secondary" aria-label={`Edit task ${t.wbs}`} onClick={() => setEditing(t)}>Edit</Button>}{t.status === "TODO" && Number(t.percent_complete) === 0 && !["COMPLETED", "CANCELLED"].includes(p.status) && <Button variant="secondary" aria-label={`Delete task ${t.wbs}`} onClick={() => setDeleting(t)}>Delete</Button>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {editing && <TaskEditDialog key={editing.id} task={editing} summary={tasks.data!.results.some((x) => x.parent === editing.id)} onClose={() => setEditing(null)} />}
      {deleting && <TaskDeleteDialog task={deleting} onClose={() => setDeleting(null)} />}
      {adding && <NewTaskDialog project={id} open onClose={() => setAdding(false)} />}
      {progress && <ProgressDialog key={progress.id} task={progress} onClose={() => setProgress(null)} />}
      <StatusDialog id={id} current={p.status} to={moveTo} onClose={() => setMoveTo(null)} />
    </>
  );
}

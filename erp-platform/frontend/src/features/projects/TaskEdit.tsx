import { useState } from "react";

import { useDeleteProjectTaskMutation, useUpdateProjectTaskMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DirectoryUser, ProjectTask } from "../../shared/api/types";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";
import { UserPicker } from "../../shared/ui/UserPicker";
import { useUserNames } from "../quality/names";
import { validateTask } from "./ProjectPage";

/** Only what the person changed is sent, so a stale form cannot overwrite someone else's edit of another field. */
export function taskChanges(t: ProjectTask, f: { name: string; start: string; end: string; hours: string }, assignee: string | null, summary: boolean): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (f.name.trim() !== t.name) b.name = f.name.trim();
  if (!summary) {
    if (f.start !== t.planned_start) b.planned_start = f.start;
    if (f.end !== t.planned_end) b.planned_end = f.end;
    if (!t.milestone && Number(f.hours || 0) !== Number(t.planned_hours)) b.planned_hours = f.hours.trim() || "0";
  }
  if (assignee) b.assignee = assignee;
  return b;
}

export function TaskEditDialog({ task, summary, onClose }: { task: ProjectTask; summary: boolean; onClose: () => void }) {
  const [update, { isLoading }] = useUpdateProjectTaskMutation();
  const name = useUserNames();
  const [f, setF] = useState({ name: task.name, start: task.planned_start, end: task.planned_end, hours: String(Number(task.planned_hours)) });
  const [assignee, setAssignee] = useState<DirectoryUser | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateTask(f);
    if (p) { setErr(p); return; }
    const body = taskChanges(task, f, assignee?.id ?? null, summary);
    if (Object.keys(body).length === 0) { setErr("Nothing has changed."); return; }
    setErr(null);
    try { await update({ id: task.id, body }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Edit task ${task.wbs}`} open onClose={onClose}>
      {summary && <p className="mb-3 text-sm text-slate-600">This task groups sub-tasks, so its dates and hours come from them.</p>}
      <FormField label="Name" htmlFor="te-name"><input id="te-name" maxLength={200} className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Planned start" htmlFor="te-start"><input id="te-start" type="date" disabled={summary} className={inputClass} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></FormField>
        <FormField label="Planned end" htmlFor="te-end"><input id="te-end" type="date" disabled={summary} className={inputClass} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></FormField>
        {!task.milestone && <FormField label="Planned hours" htmlFor="te-hours"><input id="te-hours" inputMode="decimal" disabled={summary} className={`${inputClass} text-right`} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></FormField>}
      </div>
      <p className="mb-1 text-sm text-slate-600">Assignee: {task.assignee ? name(task.assignee) : "nobody"}</p>
      <UserPicker label="Change assignee (optional)" onChange={setAssignee} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Save changes</Button></div>
    </Modal>
  );
}

export function TaskDeleteDialog({ task, onClose }: { task: ProjectTask; onClose: () => void }) {
  const [del, { isLoading }] = useDeleteProjectTaskMutation();
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { setErr(null); try { await del(task.id).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title={`Delete task ${task.wbs}`} open onClose={onClose}>
      <p className="mb-3 text-sm">Delete “{task.name}”? This cannot be undone. A task that has started, or has time or expenses booked, cannot be deleted; cancel it instead.</p>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Keep task</Button><Button variant="danger" loading={isLoading} onClick={() => void go()}>Delete task</Button></div>
    </Modal>
  );
}

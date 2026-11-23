import { useState } from "react";

import { useCreateWorkflowDefinitionMutation, useListDepartmentsQuery, useListRolesQuery, useListWorkflowDefinitionsQuery, useListWorkflowSubjectTypesQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { WorkflowDefinitionRow } from "../../shared/api/types";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { useUserOptions } from "../quality/names";

export interface ApproverForm { type: string; ref: string }
export interface StageForm { name: string; policy: string; approvers: ApproverForm[]; min: string; max: string; due: string; escalate: string }
export interface DefForm { code: string; name: string; subject: string; sod: boolean; distinct: boolean; stages: StageForm[] }

export const APPROVER_LABEL: Record<string, string> = { ROLE: "A role", USER: "A specific person", DEPARTMENT_HEAD: "Head of a department", MANAGER: "The requester's manager" };
const AMT = /^\d+(\.\d{1,2})?$/;
export const blankStage = (): StageForm => ({ name: "", policy: "ANY_OF", approvers: [{ type: "ROLE", ref: "" }], min: "", max: "", due: "", escalate: "" });

export function definitionProblem(f: DefForm): string | null {
  if (!/^[-a-zA-Z0-9_]{1,60}$/.test(f.code)) return "The code may use letters, digits, hyphens and underscores only.";
  if (!f.name.trim()) return "Give the workflow a name.";
  if (!f.subject) return "Choose what the workflow approves.";
  if (f.stages.length === 0) return "Add at least one approval step.";
  for (const [i, s] of f.stages.entries()) {
    const n = `Step ${i + 1}`;
    if (s.approvers.length === 0) return `${n}: add at least one approver.`;
    for (const a of s.approvers) {
      if (a.type === "ROLE" && !a.ref) return `${n}: choose a role.`;
      if (a.type === "USER" && !a.ref) return `${n}: choose a person.`;
    }
    for (const [label, v] of [["From amount", s.min], ["Up to amount", s.max]] as const) if (v.trim() && !AMT.test(v.trim())) return `${n}: ${label} must be an amount such as 5000 or 5000.50.`;
    if (s.min.trim() && s.max.trim() && Number(s.min) >= Number(s.max)) return `${n}: "From amount" must be below "Up to amount".`;
    if (s.due.trim() && !/^[1-9]\d{0,3}$/.test(s.due.trim())) return `${n}: the deadline must be a whole number of hours.`;
  }
  return null;
}

export function definitionPayload(f: DefForm) {
  return {
    code: f.code.trim(), name: f.name.trim(), subject_type: f.subject, separation_of_duties: f.sod, distinct_approvers: f.distinct,
    stages: f.stages.map((s, i) => ({
      order: i + 1, name: s.name.trim() || `Step ${i + 1}`, policy: s.policy,
      approvers: s.approvers.map((a) => (a.ref ? { type: a.type, ref: a.ref } : { type: a.type })),
      min_amount: s.min.trim() || null, max_amount: s.max.trim() || null, due_hours: s.due.trim() ? Number(s.due) : null, escalate_to_user_id: s.escalate || null,
    })),
  };
}

export function formFrom(d: WorkflowDefinitionRow): DefForm {
  return {
    code: d.code, name: d.name, subject: d.subject_type, sod: d.separation_of_duties, distinct: d.distinct_approvers,
    stages: [...d.stages].sort((a, b) => a.order - b.order).map((s) => ({ name: s.name, policy: s.policy, approvers: s.approvers.map((a) => ({ type: a.type, ref: a.ref ?? "" })), min: s.min_amount ?? "", max: s.max_amount ?? "", due: s.due_hours ? String(s.due_hours) : "", escalate: s.escalate_to_user_id ?? "" })),
  };
}

function DefinitionDialog({ base, onClose }: { base: WorkflowDefinitionRow | null; onClose: () => void }) {
  const subjects = useListWorkflowSubjectTypesQuery();
  const roles = useListRolesQuery();
  const depts = useListDepartmentsQuery();
  const users = useUserOptions();
  const [create, { isLoading }] = useCreateWorkflowDefinitionMutation();
  const [f, setF] = useState<DefForm>(base ? formFrom(base) : { code: "", name: "", subject: "", sod: true, distinct: false, stages: [blankStage()] });
  const [err, setErr] = useState<string | null>(null);
  const setStage = (i: number, s: StageForm) => setF({ ...f, stages: f.stages.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= f.stages.length) return; const st = [...f.stages]; [st[i], st[j]] = [st[j]!, st[i]!]; setF({ ...f, stages: st }); };
  const go = async () => {
    const p = definitionProblem(f);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await create(definitionPayload(f)).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={base ? `New version of ${base.code}` : "New workflow"} open onClose={onClose}>
      {base && <p className="mb-3 text-sm text-slate-600">Saving creates version {base.version + 1} and retires the current one. Approvals already in progress keep following the version they started with.</p>}
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Code" htmlFor="wf-code"><input id="wf-code" className={inputClass} value={f.code} disabled={!!base} onChange={(e) => setF({ ...f, code: e.target.value })} /></FormField>
        <FormField label="Name" htmlFor="wf-name"><input id="wf-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
      </div>
      <FormField label="Approves" htmlFor="wf-subject"><select id="wf-subject" className={inputClass} value={f.subject} disabled={!!base} onChange={(e) => setF({ ...f, subject: e.target.value })}><option value="">Choose…</option>{(subjects.data ?? []).map((s) => <option key={s} value={s}>{s.replace(/[._]/g, " ")}</option>)}</select></FormField>
      <label className="mb-1 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.sod} onChange={(e) => setF({ ...f, sod: e.target.checked })} />Requester cannot approve their own request</label>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.distinct} onChange={(e) => setF({ ...f, distinct: e.target.checked })} />The same person cannot approve two steps</label>
      <h3 className="mb-1 text-sm font-semibold">Approval steps, in order</h3>
      {f.stages.map((s, i) => (
        <fieldset key={i} className="mb-3 rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium">Step {i + 1}</legend>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Step name" htmlFor={`st-name-${i}`}><input id={`st-name-${i}`} className={inputClass} value={s.name} onChange={(e) => setStage(i, { ...s, name: e.target.value })} /></FormField>
            <FormField label="Who must approve" htmlFor={`st-pol-${i}`}><select id={`st-pol-${i}`} className={inputClass} value={s.policy} onChange={(e) => setStage(i, { ...s, policy: e.target.value })}><option value="ANY_OF">Any one of the approvers</option><option value="ALL_OF">All of the approvers</option></select></FormField>
          </div>
          {s.approvers.map((a, k) => (
            <div key={k} className="mb-2 flex flex-wrap items-end gap-2">
              <FormField label={`Step ${i + 1} approver ${k + 1} type`} htmlFor={`st-${i}-at-${k}`}><select id={`st-${i}-at-${k}`} className={inputClass} value={a.type} onChange={(e) => setStage(i, { ...s, approvers: s.approvers.map((x, j) => (j === k ? { type: e.target.value, ref: "" } : x)) })}>{Object.entries(APPROVER_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
              {a.type === "ROLE" && <FormField label={`Step ${i + 1} approver ${k + 1} role`} htmlFor={`st-${i}-ar-${k}`}><select id={`st-${i}-ar-${k}`} className={inputClass} value={a.ref} onChange={(e) => setStage(i, { ...s, approvers: s.approvers.map((x, j) => (j === k ? { ...x, ref: e.target.value } : x)) })}><option value="">Choose…</option>{(roles.data ?? []).map((r) => <option key={r.id} value={r.name}>{r.display_name || r.name}</option>)}</select></FormField>}
              {a.type === "USER" && <FormField label={`Step ${i + 1} approver ${k + 1} person`} htmlFor={`st-${i}-au-${k}`}><select id={`st-${i}-au-${k}`} className={inputClass} value={a.ref} onChange={(e) => setStage(i, { ...s, approvers: s.approvers.map((x, j) => (j === k ? { ...x, ref: e.target.value } : x)) })}><option value="">Choose…</option>{users.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>}
              {a.type === "DEPARTMENT_HEAD" && <FormField label={`Step ${i + 1} approver ${k + 1} department`} htmlFor={`st-${i}-ad-${k}`}><select id={`st-${i}-ad-${k}`} className={inputClass} value={a.ref} onChange={(e) => setStage(i, { ...s, approvers: s.approvers.map((x, j) => (j === k ? { ...x, ref: e.target.value } : x)) })}><option value="">The requester's department</option>{(depts.data?.results ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></FormField>}
              {s.approvers.length > 1 && <Button variant="secondary" className="mb-3" aria-label={`Remove approver ${k + 1} from step ${i + 1}`} onClick={() => setStage(i, { ...s, approvers: s.approvers.filter((_, j) => j !== k) })}>Remove</Button>}
            </div>
          ))}
          <Button variant="secondary" aria-label={`Add approver to step ${i + 1}`} onClick={() => setStage(i, { ...s, approvers: [...s.approvers, { type: "ROLE", ref: "" }] })}>Add approver</Button>
          <div className="mt-3 grid grid-cols-4 gap-3">
            <FormField label={`Step ${i + 1} from amount`} htmlFor={`st-min-${i}`}><input id={`st-min-${i}`} inputMode="decimal" className={inputClass} value={s.min} onChange={(e) => setStage(i, { ...s, min: e.target.value })} /></FormField>
            <FormField label={`Step ${i + 1} up to amount`} htmlFor={`st-max-${i}`}><input id={`st-max-${i}`} inputMode="decimal" className={inputClass} value={s.max} onChange={(e) => setStage(i, { ...s, max: e.target.value })} /></FormField>
            <FormField label={`Step ${i + 1} deadline (hours)`} htmlFor={`st-due-${i}`}><input id={`st-due-${i}`} inputMode="numeric" className={inputClass} value={s.due} onChange={(e) => setStage(i, { ...s, due: e.target.value })} /></FormField>
            <FormField label={`Step ${i + 1} escalate to`} htmlFor={`st-esc-${i}`}><select id={`st-esc-${i}`} className={inputClass} value={s.escalate} onChange={(e) => setStage(i, { ...s, escalate: e.target.value })}><option value="">Nobody</option>{users.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
          </div>
          <p className="text-xs text-slate-500">Leave both amounts empty to apply the step to every request. The step is skipped when the request's amount is outside the range.</p>
          <div className="mt-2 flex gap-2">
            <Button variant="secondary" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>Up</Button>
            <Button variant="secondary" aria-label={`Move step ${i + 1} down`} disabled={i === f.stages.length - 1} onClick={() => move(i, 1)}>Down</Button>
            <Button variant="danger" aria-label={`Remove step ${i + 1}`} onClick={() => setF({ ...f, stages: f.stages.filter((_, j) => j !== i) })}>Remove step</Button>
          </div>
        </fieldset>
      ))}
      <Button variant="secondary" onClick={() => setF({ ...f, stages: [...f.stages, blankStage()] })}>Add step</Button>
      {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>{base ? "Save new version" : "Create workflow"}</Button></div>
    </Modal>
  );
}

export function WorkflowDefinitionsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListWorkflowDefinitionsQuery({ cursor });
  const [dlg, setDlg] = useState<{ base: WorkflowDefinitionRow | null } | null>(null);
  return (
    <>
      <PageHeader title="Approval workflows" description="Who must approve what. Changing a workflow creates a new version; the old one is kept for history." actions={<Button onClick={() => setDlg({ base: null })}>New workflow</Button>} />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data?.results.length ? <EmptyState title="No workflows yet" hint="Records that need approval cannot be submitted until a workflow exists for them." /> : (
        <div className="space-y-3">
          {q.data.results.map((d) => (
            <Card key={d.id} title={`${d.name} · ${d.code} v${d.version}`} actions={d.is_active ? <Button variant="secondary" aria-label={`New version of ${d.code}`} onClick={() => setDlg({ base: d })}>New version</Button> : undefined}>
              <p className="mb-1 text-sm"><Badge tone={d.is_active ? "green" : "slate"}>{d.is_active ? "In use" : "Retired"}</Badge> approves {d.subject_type.replace(/[._]/g, " ")}{d.separation_of_duties ? " · requester cannot approve" : ""}</p>
              <ol className="list-decimal pl-5 text-sm text-slate-700">{[...d.stages].sort((a, b) => a.order - b.order).map((s) => <li key={s.order}>{s.name}: {s.policy === "ALL_OF" ? "all of" : "any of"} {s.approvers.map((a) => (a.type === "ROLE" ? `role ${a.ref}` : (APPROVER_LABEL[a.type] ?? a.type).toLowerCase())).join(", ")}{s.min_amount || s.max_amount ? ` · amounts ${s.min_amount ?? "0"} to ${s.max_amount ?? "no limit"}` : ""}{s.due_hours ? ` · due in ${s.due_hours} h` : ""}</li>)}</ol>
            </Card>
          ))}
          <div className="flex gap-2">{cursor !== null && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Older versions</Button>}</div>
        </div>
      )}
      {dlg && <DefinitionDialog key={dlg.base?.id ?? "new"} base={dlg.base} onClose={() => setDlg(null)} />}
    </>
  );
}

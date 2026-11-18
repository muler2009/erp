import { useState } from "react";
import { Link } from "react-router";

import { useListChecklistTemplatesQuery, useListDepartmentsQuery, useListQualityAuditsQuery, useListQualityConfigQuery, useScheduleQualityAuditMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { UserSelect } from "../../shared/ui/UserSelect";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";

export const AUDIT_STATUSES = ["PLANNED", "IN_PROGRESS", "REPORTED", "CLOSED", "CANCELLED"];

export function auditTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "CLOSED") return "green";
  if (s === "CANCELLED") return "slate";
  return "amber";
}

export function validateAudit(f: { audit_type: string; title: string; scope: string; planned_start: string; planned_end: string; lead_auditor_id: string }): string | null {
  if (!f.audit_type) return "Choose the audit type.";
  if (!f.title.trim()) return "Give the audit a title.";
  if (!f.scope.trim()) return "Describe the scope.";
  if (!f.planned_start) return "Enter the start date.";
  if (!f.planned_end) return "Enter the end date.";
  if (f.planned_end < f.planned_start) return "The audit cannot end before it starts.";
  if (!f.lead_auditor_id) return "Choose the lead auditor.";
  return null;
}

export function AuditsPage() {
  const { can } = useAccess();
  const manage = can("quality.audit.manage");
  const [f, setF] = useState({ status: "", audit_type: "" });
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityAuditsQuery({ status: f.status || undefined, audit_type: f.audit_type || undefined, cursor });
  const types = useListQualityConfigQuery("AUDIT_TYPE");
  const depts = useListDepartmentsQuery(undefined, { skip: !manage });
  const templates = useListChecklistTemplatesQuery(undefined, { skip: !manage });
  const people = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [schedule] = useScheduleQualityAuditMutation();
  const empty = { audit_type: "", title: "", scope: "", objectives: "", criteria: "", planned_start: "", planned_end: "", lead_auditor_id: "", auditee_department_id: "", template_id: "", team: [] as string[] };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateAudit(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { audit_type: n.audit_type, title: n.title.trim(), scope: n.scope.trim(), planned_start: n.planned_start, planned_end: n.planned_end, lead_auditor_id: n.lead_auditor_id, team: n.team };
    for (const k of ["objectives", "criteria"] as const) if (n[k].trim()) body[k] = n[k].trim();
    if (n.auditee_department_id) body.auditee_department_id = n.auditee_department_id;
    if (n.template_id) body.template_id = n.template_id;
    try { await schedule(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  const toggle = (u: string) => setN({ ...n, team: n.team.includes(u) ? n.team.filter((x) => x !== u) : [...n.team, u] });
  return (
    <>
      <PageHeader title="Audits" description="Plan, carry out, report and close audits." actions={<span className="flex gap-3">{manage && <Link className="self-center text-sm text-blue-700 underline" to="/app/quality/checklist-templates">Checklist templates</Link>}{manage && <Button onClick={() => setOpen(true)}>Schedule an audit</Button>}</span>} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-3">
          <label className="text-sm">Status <select aria-label="Audit status" className={inputClass} value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setCursor(null); }}><option value="">All</option>{AUDIT_STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          <label className="text-sm">Type <select aria-label="Audit type" className={inputClass} value={f.audit_type} onChange={(e) => { setF({ ...f, audit_type: e.target.value }); setCursor(null); }}><option value="">All</option>{types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No audits match" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Title</th><th>Type</th><th>Dates</th><th>Lead</th><th>Findings open</th><th>Status</th></tr></thead>
            <tbody>{data.results.map((a) => (
              <tr key={a.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/audits/${a.id}`}>{a.number}</Link></td><td>{a.title}</td><td>{pretty(a.audit_type)}</td><td>{a.planned_start} to {a.planned_end}</td><td>{nameOf(a.lead_auditor_id)}</td>
                <td>{a.findings_open} of {a.findings_total}</td><td><Badge tone={auditTone(a.status)}>{pretty(a.status)}</Badge></td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="Schedule an audit" open={open} onClose={() => setOpen(false)}>
        <div className="grid grid-cols-1 gap-x-3 md:grid-cols-2">
          <FormField label="Audit type" htmlFor="au-type"><select id="au-type" className={inputClass} value={n.audit_type} onChange={(e) => setN({ ...n, audit_type: e.target.value })}><option value="">Choose…</option>{types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></FormField>
          <FormField label="Title" htmlFor="au-title"><input id="au-title" className={inputClass} value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} /></FormField>
          <FormField label="Start" htmlFor="au-start"><input id="au-start" type="date" className={inputClass} value={n.planned_start} onChange={(e) => setN({ ...n, planned_start: e.target.value })} /></FormField>
          <FormField label="End" htmlFor="au-end"><input id="au-end" type="date" className={inputClass} value={n.planned_end} onChange={(e) => setN({ ...n, planned_end: e.target.value })} /></FormField>
          <FormField label="Lead auditor" htmlFor="au-lead"><UserSelect id="au-lead" value={n.lead_auditor_id} onChange={(x) => setN({ ...n, lead_auditor_id: x })} options={people} placeholder="Choose…" /></FormField>
          <FormField label="Area audited" htmlFor="au-dept"><select id="au-dept" className={inputClass} value={n.auditee_department_id} onChange={(e) => setN({ ...n, auditee_department_id: e.target.value })}><option value="">None</option>{depts.data?.results.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></FormField>
          <FormField label="Checklist template" htmlFor="au-tpl"><select id="au-tpl" className={inputClass} value={n.template_id} onChange={(e) => setN({ ...n, template_id: e.target.value })}><option value="">None</option>{templates.data?.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></FormField>
        </div>
        <FormField label="Scope" htmlFor="au-scope"><textarea id="au-scope" className={inputClass} value={n.scope} onChange={(e) => setN({ ...n, scope: e.target.value })} /></FormField>
        <FormField label="Objectives" htmlFor="au-obj"><input id="au-obj" className={inputClass} value={n.objectives} onChange={(e) => setN({ ...n, objectives: e.target.value })} /></FormField>
        <FormField label="Criteria" htmlFor="au-crit"><input id="au-crit" className={inputClass} placeholder="for example ISO 9001:2015" value={n.criteria} onChange={(e) => setN({ ...n, criteria: e.target.value })} /></FormField>
        <fieldset className="mb-3"><legend className="text-sm font-medium">Audit team</legend>
          <div className="flex flex-wrap gap-3">{people.filter(([v]) => v !== n.lead_auditor_id).map(([v, l]) => <label key={v} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={n.team.includes(v)} onChange={() => toggle(v)} /> {l}</label>)}</div></fieldset>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Schedule</Button></div>
      </Modal>
    </>
  );
}

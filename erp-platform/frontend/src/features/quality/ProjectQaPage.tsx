import { useState } from "react";
import { Link, useParams } from "react-router";

import { useCancelQualityRequestMutation, useCreateQualityRequestMutation, useDecideQualityRequestMutation, useFixQualityPunchMutation, useGetQualityRequestQuery, useListProjectTasksQuery, useListProjectsQuery, useListQualityPlansQuery, useListQualityPunchQuery, useListQualityRequestsQuery, useRaiseQualityPunchMutation, useScheduleQualityRequestMutation, useVerifyQualityPunchMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QPunch } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserSelect } from "../../shared/ui/UserSelect";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";
import { EvidencePanel, HistoryPanel } from "./panels";

export const REQUEST_KINDS = ["WORK", "MATERIAL", "COMPLETION", "HANDOVER"];

export function requestTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "APPROVED") return "green";
  if (s === "REJECTED") return "red";
  if (s === "REQUESTED" || s === "SCHEDULED" || s === "INSPECTED") return "amber";
  return "slate";
}
export function punchTone(s: string, severity?: string): "green" | "red" | "amber" | "slate" {
  if (s === "CLOSED") return "green";
  if (s === "OPEN") return severity === "MAJOR" ? "red" : "amber";
  return "slate";
}

export function validateRequest(f: { project_id: string; kind: string; requested_for: string; hold_point: boolean; activity_task_id: string }): string | null {
  if (!f.project_id) return "Choose the project.";
  if (!REQUEST_KINDS.includes(f.kind)) return "Choose the kind of request.";
  if (!f.requested_for) return "Enter the date the inspection is wanted.";
  if (f.hold_point && !f.activity_task_id) return "A hold point must name the activity it holds.";
  return null;
}
export function validatePunch(f: { project_id: string; description: string; severity: string }): string | null {
  if (!f.project_id) return "Choose the project.";
  if (!f.description.trim()) return "Describe the defect.";
  if (!["MINOR", "MAJOR"].includes(f.severity)) return "Choose the severity.";
  return null;
}
/** Naming what blocks accepting the work; the server decides and also checks the inspection result and who inspected. */
export function approveBlock(punch: Pick<QPunch, "severity" | "status">[]): string | null {
  return punch.some((p) => p.severity === "MAJOR" && p.status !== "CLOSED") ? "Major punch items are still open." : null;
}

export function InspectionRequestsPage() {
  const { can } = useAccess();
  const manage = can("quality.project.manage");
  const [f, setF] = useState({ project_id: "", status: "", hold: false });
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityRequestsQuery({ project_id: f.project_id || undefined, status: f.status || undefined, hold_point: f.hold, cursor });
  const projects = useListProjectsQuery({});
  const projectName = (id: string) => { const p = projects.data?.results.find((x) => x.id === id); return p ? `${p.code} ${p.name}` : id.slice(0, 8); };
  const [create] = useCreateQualityRequestMutation();
  const empty = { project_id: "", kind: "WORK", requested_for: "", location: "", contractor: "", hold_point: false, activity_task_id: "" };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const tasks = useListProjectTasksQuery(n.project_id, { skip: !n.project_id || !open });
  const go = async () => {
    const p = validateRequest(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { project_id: n.project_id, kind: n.kind, requested_for: n.requested_for, hold_point: n.hold_point };
    for (const k of ["location", "contractor", "activity_task_id"] as const) if (n[k].trim()) body[k] = n[k].trim();
    try { await create(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Inspection requests" description="Contractors and site teams ask for inspections; hold points stop later work until approved." actions={manage ? <Button onClick={() => setOpen(true)}>Request an inspection</Button> : undefined} />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-4">
          <label className="text-sm">Project <select aria-label="Project filter" className={inputClass} value={f.project_id} onChange={(e) => { setF({ ...f, project_id: e.target.value }); setCursor(null); }}><option value="">All</option>{projects.data?.results.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}</select></label>
          <label className="text-sm">Status <select aria-label="Request status" className={inputClass} value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setCursor(null); }}><option value="">All</option>{["REQUESTED", "SCHEDULED", "INSPECTED", "APPROVED", "REJECTED", "CANCELLED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.hold} onChange={(e) => { setF({ ...f, hold: e.target.checked }); setCursor(null); }} />Hold points only</label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No inspection requests" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Project</th><th>Kind</th><th>Location</th><th>Wanted for</th><th>Status</th></tr></thead>
            <tbody>{data.results.map((r) => (
              <tr key={r.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/inspection-requests/${r.id}`}>{r.number}</Link> {r.hold_point && <Badge tone="red">Hold point</Badge>}</td><td>{projectName(r.project_id)}</td><td>{pretty(r.kind)}</td><td>{r.location || "–"}</td><td>{r.requested_for}</td><td><Badge tone={requestTone(r.status)}>{pretty(r.status)}</Badge></td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="Request an inspection" open={open} onClose={() => setOpen(false)}>
        <FormField label="Project" htmlFor="rq-proj"><select id="rq-proj" className={inputClass} value={n.project_id} onChange={(e) => setN({ ...n, project_id: e.target.value, activity_task_id: "" })}><option value="">Choose…</option>{projects.data?.results.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}</select></FormField>
        <FormField label="Kind" htmlFor="rq-kind"><select id="rq-kind" className={inputClass} value={n.kind} onChange={(e) => setN({ ...n, kind: e.target.value })}>{REQUEST_KINDS.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}</select></FormField>
        <FormField label="Wanted for" htmlFor="rq-date"><input id="rq-date" type="date" className={inputClass} value={n.requested_for} onChange={(e) => setN({ ...n, requested_for: e.target.value })} /></FormField>
        <FormField label="Location" htmlFor="rq-loc"><input id="rq-loc" className={inputClass} value={n.location} onChange={(e) => setN({ ...n, location: e.target.value })} /></FormField>
        <FormField label="Contractor" htmlFor="rq-con"><input id="rq-con" className={inputClass} value={n.contractor} onChange={(e) => setN({ ...n, contractor: e.target.value })} /></FormField>
        <FormField label="Activity" htmlFor="rq-task"><select id="rq-task" className={inputClass} value={n.activity_task_id} onChange={(e) => setN({ ...n, activity_task_id: e.target.value })}><option value="">None</option>{tasks.data?.results.map((t) => <option key={t.id} value={t.id}>{t.wbs} {t.name}</option>)}</select></FormField>
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={n.hold_point} onChange={(e) => setN({ ...n, hold_point: e.target.checked })} />This is a hold point (later work waits for approval)</label>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Request</Button></div>
      </Modal>
    </>
  );
}

function PunchTable({ items, manage, nameOf }: { items: QPunch[]; manage: boolean; nameOf: (id: string | null | undefined) => string }) {
  const [fix] = useFixQualityPunchMutation();
  const [verify] = useVerifyQualityPunchMutation();
  const [dlg, setDlg] = useState<{ kind: "fix" | "verify"; p: QPunch } | null>(null);
  return (
    <>
      <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Defect</th><th>Location</th><th>Severity</th><th>Assigned to</th><th>Due</th><th>Status</th><th /></tr></thead>
        <tbody>{items.map((p) => (
          <tr key={p.id} className="border-t"><td>{p.number}</td><td>{p.description}{p.fixed_note && <div className="text-slate-600">Fix: {p.fixed_note}</div>}</td><td>{p.location || "–"}</td><td><Badge tone={p.severity === "MAJOR" ? "red" : "slate"}>{pretty(p.severity)}</Badge></td><td>{nameOf(p.assigned_to)}</td><td>{p.due_date ?? "–"}</td><td><Badge tone={punchTone(p.status, p.severity)}>{pretty(p.status)}</Badge></td>
            <td>{manage && p.status === "OPEN" && <Button variant="secondary" onClick={() => setDlg({ kind: "fix", p })}>Mark fixed</Button>}{manage && p.status === "FIXED" && <Button variant="secondary" onClick={() => setDlg({ kind: "verify", p })}>Verify</Button>}</td></tr>))}</tbody></table>
      <ActionDialog title="Mark the item fixed" open={dlg?.kind === "fix"} onClose={() => setDlg(null)} cta="Mark fixed" fields={[{ name: "note", label: "What was done", required: true }]} submit={(v) => fix({ id: dlg?.p.id ?? "", body: { note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Verify the fix" open={dlg?.kind === "verify"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "accept", label: "Is the fix acceptable?", required: true, options: [["yes", "Yes, close the item"], ["no", "No, reopen it"]] }, { name: "note", label: "Note (required when reopening)" }]}
        submit={async (v) => { if (v.accept === "no" && !(v.note ?? "").trim()) throw new Error("Say what is still wrong."); return verify({ id: dlg?.p.id ?? "", body: { accept: v.accept === "yes", note: (v.note ?? "").trim() } }).unwrap(); }} />
    </>
  );
}

function RaisePunch({ open, onClose, fixedProject, requestId }: { open: boolean; onClose: () => void; fixedProject?: string; requestId?: string }) {
  const [raise] = useRaiseQualityPunchMutation();
  const projects = useListProjectsQuery({}, { skip: !!fixedProject });
  const people = useUserOptions(!open);
  const empty = { project_id: fixedProject ?? "", description: "", severity: "MINOR", location: "", contractor: "", assigned_to: "", due_date: "" };
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const close = () => { setN(empty); setErr(null); onClose(); };
  const go = async () => {
    const p = validatePunch(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { project_id: n.project_id, description: n.description.trim(), severity: n.severity };
    for (const k of ["location", "contractor", "assigned_to", "due_date"] as const) if (n[k].trim()) body[k] = n[k].trim();
    if (requestId) body.request_id = requestId;
    try { await raise(body).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Raise a punch item" open={open} onClose={close}>
      {!fixedProject && <FormField label="Project" htmlFor="pi-proj"><select id="pi-proj" className={inputClass} value={n.project_id} onChange={(e) => setN({ ...n, project_id: e.target.value })}><option value="">Choose…</option>{projects.data?.results.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}</select></FormField>}
      <FormField label="Defect" htmlFor="pi-desc"><textarea id="pi-desc" className={inputClass} value={n.description} onChange={(e) => setN({ ...n, description: e.target.value })} /></FormField>
      <FormField label="Severity" htmlFor="pi-sev"><select id="pi-sev" className={inputClass} value={n.severity} onChange={(e) => setN({ ...n, severity: e.target.value })}><option value="MINOR">Minor</option><option value="MAJOR">Major</option></select></FormField>
      <FormField label="Location" htmlFor="pi-loc"><input id="pi-loc" className={inputClass} value={n.location} onChange={(e) => setN({ ...n, location: e.target.value })} /></FormField>
      <FormField label="Contractor" htmlFor="pi-con"><input id="pi-con" className={inputClass} value={n.contractor} onChange={(e) => setN({ ...n, contractor: e.target.value })} /></FormField>
      <FormField label="Assigned to" htmlFor="pi-who"><UserSelect id="pi-who" value={n.assigned_to} onChange={(x) => setN({ ...n, assigned_to: x })} options={people} placeholder="Nobody yet" /></FormField>
      <FormField label="Due date" htmlFor="pi-due"><input id="pi-due" type="date" className={inputClass} value={n.due_date} onChange={(e) => setN({ ...n, due_date: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => void go()}>Raise</Button></div>
    </Modal>
  );
}

export function PunchListPage() {
  const { can } = useAccess();
  const manage = can("quality.project.manage");
  const [f, setF] = useState({ project_id: "", status: "OPEN", severity: "" });
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityPunchQuery({ project_id: f.project_id || undefined, status: f.status || undefined, severity: f.severity || undefined, cursor });
  const projects = useListProjectsQuery({});
  const nameOf = useUserNames();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Punch list" description="Defects found at inspection or walk-through, to be fixed and verified before handover." actions={manage ? <Button onClick={() => setOpen(true)}>Raise a punch item</Button> : undefined} />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-4">
          <label className="text-sm">Project <select aria-label="Punch project" className={inputClass} value={f.project_id} onChange={(e) => { setF({ ...f, project_id: e.target.value }); setCursor(null); }}><option value="">All</option>{projects.data?.results.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}</select></label>
          <label className="text-sm">Status <select aria-label="Punch status" className={inputClass} value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setCursor(null); }}><option value="">All</option><option value="OPEN">Open</option><option value="FIXED">Fixed</option><option value="CLOSED">Closed</option></select></label>
          <label className="text-sm">Severity <select aria-label="Punch severity" className={inputClass} value={f.severity} onChange={(e) => { setF({ ...f, severity: e.target.value }); setCursor(null); }}><option value="">All</option><option value="MINOR">Minor</option><option value="MAJOR">Major</option></select></label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No punch items" /> : <PunchTable items={data.results} manage={manage} nameOf={nameOf} />}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <RaisePunch open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function RequestPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.project.manage");
  const { data: r, isLoading, error, refetch } = useGetQualityRequestQuery(id);
  const [schedule] = useScheduleQualityRequestMutation();
  const [decide] = useDecideQualityRequestMutation();
  const [cancel] = useCancelQualityRequestMutation();
  const plans = useListQualityPlansQuery({ status: "ACTIVE" }, { skip: !manage });
  const inspectors = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"schedule" | "approve" | "reject" | "cancel" | "punch" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !r) return <ErrorState error={error} onRetry={refetch} />;
  const gateApprove = () => { const b = approveBlock(r.punch_items); if (b) { setErr(b); return; } setErr(null); setDlg("approve"); };
  const planOptions = (plans.data?.results ?? []).map((p) => [p.id, `${p.number} ${p.title}`] as [string, string]);
  return (
    <>
      <PageHeader title={`Inspection request ${r.number}`} description={r.location || undefined} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/inspection-requests">All requests</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={requestTone(r.status)}>{pretty(r.status)}</Badge><Badge tone="slate">{pretty(r.kind)}</Badge>{r.hold_point && <Badge tone="red">Hold point</Badge>}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Details">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <dt className="font-medium">Wanted for</dt><dd>{r.requested_for}</dd>
            <dt className="font-medium">Contractor</dt><dd>{r.contractor || "–"}</dd>
            {r.decision_note && <><dt className="font-medium">Decision</dt><dd>{r.decision_note}</dd></>}
            {r.inspection_id && <><dt className="font-medium">Inspection</dt><dd><Link className="text-blue-700 underline" to={`/app/quality/inspections/${r.inspection_id}`}>Open the inspection</Link></dd></>}
          </dl>
          {manage && (
            <div className="mt-3 flex flex-wrap gap-2">
              {r.status === "REQUESTED" && <Button onClick={() => setDlg("schedule")}>Schedule the inspection</Button>}
              {r.status === "INSPECTED" && <><Button onClick={gateApprove}>Approve the work</Button><Button variant="secondary" onClick={() => { setErr(null); setDlg("reject"); }}>Reject the work</Button></>}
              {["REQUESTED", "SCHEDULED"].includes(r.status) && <Button variant="secondary" onClick={() => setDlg("cancel")}>Cancel the request</Button>}
            </div>
          )}
        </Card>
        <Card title="Punch items" actions={manage ? <Button variant="secondary" onClick={() => setDlg("punch")}>Raise a punch item</Button> : undefined}>
          {!r.punch_items.length ? <EmptyState title="No punch items" /> : <PunchTable items={r.punch_items} manage={manage} nameOf={nameOf} />}
        </Card>
        <EvidencePanel record="inspection_request" id={r.id} evidence={r.evidence} canUpload={manage} />
        <HistoryPanel history={r.history} />
      </div>
      <ActionDialog title="Schedule the inspection" open={dlg === "schedule"} onClose={() => setDlg(null)} cta="Schedule"
        fields={[{ name: "inspector_id", label: "Inspector", required: true, options: inspectors, searchUsers: true }, ...(r.plan_id ? [] : [{ name: "plan_id", label: "Inspection plan (ITP)", required: true, options: planOptions }]), { name: "scheduled_for", label: "Inspection date", type: "date" }]}
        submit={(v) => { const body: Record<string, unknown> = { inspector_id: v.inspector_id }; if (v.plan_id) body.plan_id = v.plan_id; if (v.scheduled_for) body.scheduled_for = v.scheduled_for; return schedule({ id: r.id, body }).unwrap(); }} />
      <ActionDialog title="Approve the work" open={dlg === "approve"} onClose={() => setDlg(null)} cta="Approve" fields={[{ name: "note", label: "Decision note", required: true }]} submit={(v) => decide({ id: r.id, body: { approve: true, note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Reject the work" open={dlg === "reject"} onClose={() => setDlg(null)} cta="Reject" fields={[{ name: "note", label: "Decision note", required: true }]} submit={(v) => decide({ id: r.id, body: { approve: false, note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Cancel the request" open={dlg === "cancel"} onClose={() => setDlg(null)} cta="Cancel request" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => cancel({ id: r.id, body: { reason: (v.reason ?? "").trim() } }).unwrap()} />
      <RaisePunch open={dlg === "punch"} onClose={() => setDlg(null)} fixedProject={r.project_id} requestId={r.id} />
    </>
  );
}

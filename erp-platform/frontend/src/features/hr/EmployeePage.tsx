import { useState } from "react";
import { useParams } from "react-router";

import {
  useAddContractMutation, useAddPersonalRecordMutation, useAssignmentDecisionMutation, useChangeAssignmentMutation, useCompleteChecklistItemMutation,
  useAssignComponentMutation, useEmployeeActionMutation, useEndContractMutation, useGetSalaryHistoryQuery, useListComponentsQuery, useListEmployeePayslipsQuery, useListDepartmentsQuery, useListEmployeesQuery, useListPositionsQuery, useEvaluateProbationMutation, useGetAssignmentChangesQuery, useGetEmployeeContractsQuery,
  useGetEmployeeDayQuery, useGetEmployeeHistoryQuery, useGetEmployeeProfileQuery, useGetEmployeeQuery, useRecordSettlementMutation, useRemovePersonalRecordMutation, useUploadEmployeeDocumentMutation,
} from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "./ActionDialog";
import { EditEmployeeDialog, pretty } from "./EmployeeDialogs";

type Tab = "overview" | "employment" | "records" | "assignment" | "history";
const statusTone = (s: string) => (s === "ACTIVE" ? "green" : s === "TERMINATED" ? "red" : "amber") as "green" | "red" | "amber";

export function validateContract(f: { start: string; end: string; salary: string; currency: string }): string | null {
  if (!f.start) return "Enter the contract start date.";
  if (f.end && f.end < f.start) return "The contract cannot end before it starts.";
  const s = parseMoney(f.salary);
  if (s === null || s <= 0n) return "Monthly salary must be more than 0.";
  if (!/^[A-Za-z]{3}$/.test(f.currency.trim())) return "Currency must be a 3-letter code such as ETB.";
  return null;
}

export function DaySummary({ id }: { id: string }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const q = useGetEmployeeDayQuery({ id, date });
  return (
    <Card title="Attendance on a day">
      <label className="mb-2 block text-sm">Day <input aria-label="Day" type="date" className={inputClass} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
      {q.isFetching && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && !q.isFetching && (
        <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div><dt className="text-xs text-slate-500">Status</dt><dd>{pretty(q.data.status)}</dd></div>
          <div><dt className="text-xs text-slate-500">Day type</dt><dd>{pretty(q.data.day_type)}</dd></div>
          <div><dt className="text-xs text-slate-500">Scheduled hours</dt><dd>{Number(q.data.scheduled_hours)}</dd></div>
          <div><dt className="text-xs text-slate-500">Worked hours</dt><dd>{Number(q.data.worked_hours)}</dd></div>
          <div><dt className="text-xs text-slate-500">Late (minutes)</dt><dd>{q.data.late_minutes}</dd></div>
          <div><dt className="text-xs text-slate-500">Left early (minutes)</dt><dd>{q.data.early_minutes}</dd></div>
          <div><dt className="text-xs text-slate-500">Overtime hours</dt><dd>{Number(q.data.overtime_hours)}</dd></div>
          <div><dt className="text-xs text-slate-500">Problems</dt><dd>{q.data.exceptions.length ? q.data.exceptions.map((x) => pretty(x)).join(", ") : "None"}</dd></div>
        </dl>
      )}
    </Card>
  );
}

export function EmployeePage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const emp = useGetEmployeeQuery(id);
  const profile = useGetEmployeeProfileQuery(id);
  const [tab, setTab] = useState<Tab>("overview");
  const [dialog, setDialog] = useState<string | null>(null);
  const [act] = useEmployeeActionMutation();
  const [tick] = useCompleteChecklistItemMutation();
  const [probation] = useEvaluateProbationMutation();
  const [err, setErr] = useState<string | null>(null);
  if (emp.isLoading) return <Spinner />;
  if (emp.error || !emp.data) return <ErrorState error={emp.error} onRetry={() => void emp.refetch()} />;
  const e = emp.data;
  const manage = can("hr.employee.manage");
  const run = async (action: "activate" | "offboard" | "terminate", body?: Record<string, unknown>) => { setErr(null); try { await act({ id, action, body }).unwrap(); } catch (x) { setErr(errorMessage(x)); } };
  const tabs: [Tab, string][] = [["overview", "Overview"], ["employment", "Employment"], ["records", "Records"], ["assignment", "Assignment"], ["history", "History"]];
  return (
    <>
      <PageHeader title={`${e.employee_no} ${e.name}`} description={`${e.position ?? "No position"} · ${e.department ?? "No department"} · hired ${e.hire_date}`}
        actions={manage ? <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setDialog("edit")}>Edit</Button>
          {e.status === "ONBOARDING" && <Button onClick={() => void run("activate")}>Activate</Button>}
          {e.status === "ACTIVE" && <Button variant="danger" onClick={() => setDialog("offboard")}>Start offboarding</Button>}
          {e.status === "OFFBOARDING" && <Button variant="danger" onClick={() => void run("terminate")}>Complete termination</Button>}
        </div> : undefined} />
      <p className="mb-3"><Badge tone={statusTone(e.status)}>{pretty(e.status)}</Badge></p>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div role="tablist" className="mb-4 flex flex-wrap gap-2 border-b border-slate-200">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-indigo-600 font-medium" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === "overview" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Details"><dl className="space-y-1 text-sm">
            {([["Email", e.email || "—"], ["Phone", e.phone || "—"], ["Employment type", profile.data ? pretty(profile.data.employment_type) : "…"], ["Grade", profile.data?.grade ?? "—"], ["Probation", profile.data ? `${pretty(profile.data.probation_status)}${profile.data.probation_end ? ` until ${profile.data.probation_end}` : ""}` : "…"], ["Termination date", e.termination_date ?? "—"]] as const).map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-slate-600">{k}</dt><dd>{v}</dd></div>)}
          </dl>{manage && profile.data && ["IN_PROGRESS", "EXTENDED"].includes(profile.data.probation_status) && <div className="mt-3"><Button variant="secondary" onClick={() => setDialog("probation")}>Evaluate probation</Button></div>}</Card>
          <Card title="Checklist">{e.checklist.length === 0 ? <EmptyState title="No checklist items" /> : <ul className="space-y-2 text-sm">{e.checklist.map((i) => <li key={i.id} className="flex items-center justify-between"><span>{i.title} <span className="text-slate-500">({i.kind.toLowerCase()})</span></span>{i.done_at ? <Badge tone="green">Done</Badge> : <Button variant="secondary" onClick={() => void tick(i.id)}>Mark done</Button>}</li>)}</ul>}</Card>
        </div>
      )}
      {tab === "employment" && <><EmploymentTab id={id} /><PayExtras id={id} /><DaySummary id={id} /></>}
      {tab === "records" && <RecordsTab id={id} />}
      {tab === "assignment" && <AssignmentTab id={id} />}
      {tab === "history" && <HistoryTab id={id} />}

      {dialog === "edit" && <EditEmployeeDialog employee={e} open onClose={() => setDialog(null)} />}
      <ActionDialog title="Start offboarding" open={dialog === "offboard"} onClose={() => setDialog(null)} cta="Start offboarding"
        fields={[{ name: "date", label: "Last day", type: "date", required: true }, { name: "type", label: "Type", options: [["TERMINATION", "Termination"], ["RESIGNATION", "Resignation"], ["END_OF_CONTRACT", "End of contract"], ["RETIREMENT", "Retirement"], ["OTHER", "Other"]], required: true }, { name: "reason", label: "Reason", required: true }]}
        submit={(v) => act({ id, action: "offboard", body: { termination_date: v.date, separation_type: v.type, reason: (v.reason ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Evaluate probation" open={dialog === "probation"} onClose={() => setDialog(null)} cta="Record outcome"
        fields={[{ name: "outcome", label: "Outcome", options: [["CONFIRM", "Confirm"], ["EXTEND", "Extend"], ["FAIL", "Fail"]], required: true }, { name: "end", label: "New end date (to extend)", type: "date" }, { name: "notes", label: "Notes (required to extend or fail)" }]}
        submit={(v) => probation({ id, body: { outcome: v.outcome!, notes: (v.notes ?? "").trim(), ...(v.end ? { new_probation_end: v.end } : {}) } }).unwrap()} />
    </>
  );
}

function EmploymentTab({ id }: { id: string }) {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useGetEmployeeContractsQuery(id, { skip: !can("hr.compensation.view") });
  const [add] = useAddContractMutation();
  const [end] = useEndContractMutation();
  const [dialog, setDialog] = useState<"add" | { end: string } | null>(null);
  const [f, setF] = useState({ start: "", end: "", salary: "", currency: "ETB", kind: "PERMANENT" });
  const [err, setErr] = useState<string | null>(null);
  const [settle, setSettle] = useState(false);
  if (!can("hr.compensation.view")) return <EmptyState title="You do not have access to compensation details" />;
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const submit = async () => {
    const problem = validateContract(f);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await add({ id, body: { start_date: f.start, ...(f.end ? { end_date: f.end } : {}), monthly_salary: f.salary.trim(), currency: f.currency.trim().toUpperCase(), kind: f.kind } }).unwrap(); setDialog(null); } catch (x) { setErr(errorMessage(x)); }
  };
  return (
    <Card title="Contracts">
      {can("hr.compensation.manage") && <div className="mb-3"><Button onClick={() => setDialog("add")}>Add contract</Button> <Button variant="secondary" onClick={() => setSettle(true)}>Record final settlement</Button></div>}
      {data!.length === 0 ? <EmptyState title="No contracts yet" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Type</th><th>From</th><th>To</th><th className="text-right">Monthly salary</th><th /></tr></thead>
          <tbody>{data!.map((c) => <tr key={c.id} className="border-t border-slate-100"><td>{pretty(c.kind)}</td><td>{c.start_date}</td><td>{c.end_date ?? "Open"}</td><td className="text-right">{formatMoney(c.monthly_salary)} {c.currency}</td>
            <td>{!c.end_date && can("hr.compensation.manage") && <Button variant="secondary" onClick={() => setDialog({ end: c.id })}>End</Button>}</td></tr>)}</tbody></table>
      )}
      <Modal title="Add contract" open={dialog === "add"} onClose={() => setDialog(null)}>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Type" htmlFor="ct-kind"><select id="ct-kind" className={inputClass} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["PERMANENT", "FIXED_TERM", "CASUAL"].map((k) => <option key={k} value={k}>{pretty(k)}</option>)}</select></FormField>
          <FormField label="Currency" htmlFor="ct-cur"><input id="ct-cur" maxLength={3} className={inputClass} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} /></FormField>
          <FormField label="Start" htmlFor="ct-start"><input id="ct-start" type="date" className={inputClass} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></FormField>
          <FormField label="End (optional)" htmlFor="ct-end"><input id="ct-end" type="date" className={inputClass} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></FormField>
        </div>
        <FormField label="Monthly salary" htmlFor="ct-salary"><input id="ct-salary" inputMode="decimal" className={`${inputClass} text-right`} value={f.salary} onChange={(e) => setF({ ...f, salary: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button onClick={() => void submit()}>Save contract</Button></div>
      </Modal>
      <ActionDialog title="End contract" open={typeof dialog === "object" && dialog !== null} onClose={() => setDialog(null)} cta="End contract" fields={[{ name: "date", label: "End date", type: "date", required: true }]}
        submit={(v) => end({ id: (dialog as { end: string }).end, end_date: v.date! }).unwrap()} />
      <SettlementDialog id={id} open={settle} onClose={() => setSettle(false)} />
    </Card>
  );
}

function PayExtras({ id }: { id: string }) {
  const { can } = useAccess();
  const history = useGetSalaryHistoryQuery(id, { skip: !can("hr.compensation.view") });
  const comps = useListComponentsQuery(undefined, { skip: !can("hr.compensation.manage") });
  const slips = useListEmployeePayslipsQuery(id, { skip: !can("hr.payroll.view") });
  const [assign] = useAssignComponentMutation();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      {can("hr.compensation.view") && <Card title="Salary history">{history.data && history.data.length > 0 ? <ul className="space-y-1 text-sm">{history.data.map((h, i) => <li key={i} className="flex justify-between"><span>{h.effective_date}{h.end_date ? ` to ${h.end_date}` : " onward"}</span><span>{formatMoney(h.monthly_salary)} {h.currency}</span></li>)}</ul> : <EmptyState title="No salary history" />}</Card>}
      {can("hr.compensation.manage") && <Card title="Allowances and deductions"><Button variant="secondary" onClick={() => setOpen(true)}>Assign component</Button></Card>}
      {can("hr.payroll.view") && <Card title="Payslips">{slips.data && slips.data.results.length > 0 ? <ul className="space-y-1 text-sm">{slips.data.results.map((p) => <li key={p.id} className="flex justify-between"><span>{p.period_start} to {p.period_end}</span><span>Net {formatMoney(p.net)}</span></li>)}</ul> : <EmptyState title="No payslips" />}</Card>}
      <ActionDialog title="Assign pay component" open={open} onClose={() => setOpen(false)} cta="Assign"
        fields={[{ name: "component", label: "Component", options: (comps.data ?? []).filter((c) => c.is_active).map((c) => [c.id, `${c.code} ${c.name}`] as [string, string]), required: true }, { name: "start", label: "Start date", type: "date", required: true }, { name: "end", label: "End date (optional)", type: "date" }, { name: "override", label: "Override value (optional)" }]}
        submit={async (v) => { if (v.end && v.end < v.start!) throw new Error("The end date cannot be before the start date."); if (v.override && (parseMoney(v.override) ?? -1n) < 0n) throw new Error("Override must be a number of 0 or more."); return assign({ id, body: { component: v.component!, start_date: v.start!, ...(v.end ? { end_date: v.end } : {}), ...(v.override ? { override_value: v.override.trim() } : {}) } }).unwrap(); }} />
    </div>
  );
}

function SettlementDialog({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) {
  const [rec] = useRecordSettlementMutation();
  return <ActionDialog title="Final settlement" open={open} onClose={onClose} cta="Record settlement" fields={[{ name: "amount", label: "Amount", required: true }, { name: "notes", label: "Notes" }]}
    submit={async (v) => { const a = parseMoney(v.amount!); if (a === null || a < 0n) throw new Error("Amount must be a number of 0 or more."); return rec({ id, amount: v.amount!.trim(), notes: (v.notes ?? "").trim() }).unwrap(); }} />;
}

function RecordsTab({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useGetEmployeeProfileQuery(id);
  const [add] = useAddPersonalRecordMutation();
  const [remove] = useRemovePersonalRecordMutation();
  const [upload] = useUploadEmployeeDocumentMutation();
  const [dialog, setDialog] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const del = (kind: "emergency-contacts" | "qualifications" | "skills", rid: string) => void remove({ kind, id: rid });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Emergency contacts">
        <ul className="mb-2 space-y-1 text-sm">{data.emergency_contacts.map((c) => <li key={c.id} className="flex justify-between"><span>{c.name} ({c.relationship}) {c.phone}</span><Button variant="secondary" aria-label={`Remove ${c.name}`} onClick={() => del("emergency-contacts", c.id)}>Remove</Button></li>)}</ul>
        <Button variant="secondary" onClick={() => setDialog("contact")}>Add contact</Button>
      </Card>
      <Card title="Skills">
        <ul className="mb-2 space-y-1 text-sm">{data.skills.map((s) => <li key={s.id} className="flex justify-between"><span>{s.name} · level {s.level} of 5</span><Button variant="secondary" aria-label={`Remove ${s.name}`} onClick={() => del("skills", s.id)}>Remove</Button></li>)}</ul>
        <Button variant="secondary" onClick={() => setDialog("skill")}>Add skill</Button>
      </Card>
      <Card title="Qualifications">
        <ul className="mb-2 space-y-1 text-sm">{data.qualifications.map((q) => <li key={q.id} className="flex justify-between"><span>{q.title} · {q.institution}{q.expires_on ? ` (expires ${q.expires_on})` : ""}</span><Button variant="secondary" aria-label={`Remove ${q.title}`} onClick={() => del("qualifications", q.id)}>Remove</Button></li>)}</ul>
        <Button variant="secondary" onClick={() => setDialog("qual")}>Add qualification</Button>
      </Card>
      <Card title="Documents">
        {data.missing_documents.length > 0 && <p className="mb-2 text-sm text-amber-700">{data.missing_documents.length} required document(s) missing.</p>}
        <ul className="mb-2 space-y-1 text-sm">{data.documents.map((d) => <li key={d.id}>{d.title} <span className="text-slate-500">v{d.version}{d.expires_on ? `, expires ${d.expires_on}` : ""}</span></li>)}</ul>
        <Button variant="secondary" onClick={() => setDialog("doc")}>Upload document</Button>
      </Card>
      <ActionDialog title="Add emergency contact" open={dialog === "contact"} onClose={() => setDialog(null)} cta="Add" fields={[{ name: "name", label: "Name", required: true }, { name: "relationship", label: "Relationship", required: true }, { name: "phone", label: "Phone", required: true }]} submit={(v) => add({ id, kind: "emergency-contacts", body: { name: v.name!.trim(), relationship: v.relationship!.trim(), phone: v.phone!.trim() } }).unwrap()} />
      <ActionDialog title="Add skill" open={dialog === "skill"} onClose={() => setDialog(null)} cta="Add" fields={[{ name: "name", label: "Skill", required: true }, { name: "level", label: "Level", options: [["1", "1 – Beginner"], ["2", "2"], ["3", "3 – Competent"], ["4", "4"], ["5", "5 – Expert"]], required: true }]} submit={(v) => add({ id, kind: "skills", body: { name: v.name!.trim(), level: Number(v.level) } }).unwrap()} />
      <ActionDialog title="Add qualification" open={dialog === "qual"} onClose={() => setDialog(null)} cta="Add" fields={[{ name: "kind", label: "Kind", options: [["DEGREE", "Degree"], ["CERTIFICATE", "Certificate"], ["LICENSE", "License"], ["OTHER", "Other"]], required: true }, { name: "title", label: "Title", required: true }, { name: "institution", label: "Institution", required: true }, { name: "awarded_on", label: "Awarded on", type: "date" }, { name: "expires_on", label: "Expires on", type: "date" }]} submit={(v) => add({ id, kind: "qualifications", body: { kind: v.kind!, title: v.title!.trim(), institution: v.institution!.trim(), awarded_on: v.awarded_on ?? "", expires_on: v.expires_on ?? "" } }).unwrap()} />
      <Modal title="Upload document" open={dialog === "doc"} onClose={() => setDialog(null)}>
        <DocForm file={file} setFile={setFile} onSubmit={(t, title, exp) => { const form = new FormData(); form.append("file", file!); form.append("doc_type", t); form.append("title", title); if (exp) form.append("expires_on", exp); return upload({ id, form }).unwrap().then(() => { setDialog(null); setFile(null); }); }} />
      </Modal>
    </div>
  );
}

function DocForm({ file, setFile, onSubmit }: { file: File | null; setFile: (f: File | null) => void; onSubmit: (type: string, title: string, expires: string) => Promise<unknown> }) {
  const [type, setType] = useState("");
  const [title, setTitle] = useState("");
  const [exp, setExp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (!file) { setErr("Choose a file."); return; }
    if (!type.trim() || !title.trim()) { setErr("Enter the document type and title."); return; }
    setErr(null);
    try { await onSubmit(type.trim(), title.trim(), exp); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <FormField label="File" htmlFor="dc-file"><input id="dc-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></FormField>
      <FormField label="Document type" htmlFor="dc-type"><input id="dc-type" placeholder="e.g. ID, CONTRACT" className={inputClass} value={type} onChange={(e) => setType(e.target.value)} /></FormField>
      <FormField label="Title" htmlFor="dc-title"><input id="dc-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></FormField>
      <FormField label="Expires on (optional)" htmlFor="dc-exp"><input id="dc-exp" type="date" className={inputClass} value={exp} onChange={(e) => setExp(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end"><Button onClick={() => void go()}>Upload</Button></div>
    </>
  );
}

function AssignmentTab({ id }: { id: string }) {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useGetAssignmentChangesQuery(id);
  const [change] = useChangeAssignmentMutation();
  const [decide] = useAssignmentDecisionMutation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const go = async (a: "approve" | "reject" | "cancel", cid: string) => { setErr(null); try { await decide({ id: cid, action: a, note: a === "reject" ? "Rejected" : undefined }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Card title="Transfers, promotions and other changes">
      {can("hr.employee.manage") && <div className="mb-3"><Button onClick={() => setOpen(true)}>Request a change</Button></div>}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {data!.length === 0 ? <EmptyState title="No changes recorded" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Kind</th><th>Effective</th><th>Reason</th><th>Status</th><th /></tr></thead>
          <tbody>{data!.map((c) => <tr key={c.id} className="border-t border-slate-100"><td>{pretty(c.kind)}</td><td>{c.effective_date}</td><td>{c.reason || "—"}</td><td>{pretty(c.status)}</td>
            <td className="flex gap-2">{c.status === "PENDING" && can("hr.employee.manage") && <><Button onClick={() => void go("approve", c.id)}>Approve</Button><Button variant="secondary" onClick={() => void go("reject", c.id)}>Reject</Button></>}{c.status === "PENDING" && <Button variant="secondary" onClick={() => void go("cancel", c.id)}>Cancel</Button>}</td></tr>)}</tbody></table>
      )}
      <ChangeDialog id={id} open={open} onClose={() => setOpen(false)} change={change} />
    </Card>
  );
}

export function validateChange(f: { kind: string; date: string; reason: string; department: string; position: string; manager: string; clearManager: boolean }): string | null {
  if (!f.kind) return "Choose the kind of change.";
  if (!f.date) return "Enter the effective date.";
  if (!f.department && !f.position && !f.manager && !f.clearManager) return "Choose at least one thing to change: department, position or manager.";
  if (f.manager && f.clearManager) return "Choose a new manager or remove the manager, not both.";
  if (!f.reason.trim()) return "A reason is required.";
  return null;
}

function ChangeDialog({ id, open, onClose, change }: { id: string; open: boolean; onClose: () => void; change: (a: { id: string; body: Record<string, unknown> }) => { unwrap: () => Promise<unknown> } }) {
  const departments = useListDepartmentsQuery(undefined, { skip: !open });
  const positions = useListPositionsQuery(undefined, { skip: !open });
  const people = useListEmployeesQuery({ status: "ACTIVE" }, { skip: !open });
  const [f, setF] = useState({ kind: "", date: "", reason: "", department: "", position: "", manager: "", clearManager: false });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const problem = validateChange(f);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      await change({ id, body: { kind: f.kind, effective_date: f.date, reason: f.reason.trim(), ...(f.department ? { department: f.department } : {}), ...(f.position ? { position: f.position } : {}), ...(f.manager ? { manager: f.manager } : {}), ...(f.clearManager ? { clear_manager: true } : {}) } }).unwrap();
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Request a change" open={open} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Kind" htmlFor="ch-kind"><select id="ch-kind" className={inputClass} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="">Choose…</option><option value="PROMOTION">Promotion</option><option value="TRANSFER">Transfer</option><option value="REPORTING_LINE">Reporting line</option></select></FormField>
        <FormField label="Effective date" htmlFor="ch-date"><input id="ch-date" type="date" className={inputClass} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></FormField>
        <FormField label="New department" htmlFor="ch-dept"><select id="ch-dept" className={inputClass} value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}><option value="">No change</option>{departments.data?.results.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></FormField>
        <FormField label="New position" htmlFor="ch-pos"><select id="ch-pos" className={inputClass} value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })}><option value="">No change</option>{positions.data?.results.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></FormField>
        <FormField label="New manager" htmlFor="ch-mgr"><select id="ch-mgr" className={inputClass} value={f.manager} onChange={(e) => setF({ ...f, manager: e.target.value })}><option value="">No change</option>{people.data?.results.filter((p) => p.id !== id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></FormField>
      </div>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.clearManager} onChange={(e) => setF({ ...f, clearManager: e.target.checked })} /> Remove the manager</label>
      <FormField label="Reason" htmlFor="ch-reason"><input id="ch-reason" maxLength={300} className={inputClass} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Submit request</Button></div>
    </Modal>
  );
}

function HistoryTab({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useGetEmployeeHistoryQuery(id);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data || data.length === 0) return <EmptyState title="No history yet" />;
  return <Card title="Employment history"><ul className="space-y-2 text-sm">{data.map((h, i) => <li key={i}><strong>{pretty(h.kind)}</strong> · {h.effective_date} <span className="text-slate-500">{Object.entries(h.details).map(([k, v]) => `${k}: ${String(v)}`).join(", ")}</span></li>)}</ul></Card>;
}

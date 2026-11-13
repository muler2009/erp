import { useState } from "react";

import { useAllocateLeaveMutation, useDelegateApprovalsMutation, useGetAbsenceSummaryQuery, useGetLeaveCalendarQuery, useGetLeaveReportQuery, useGetLeaveTypeConfigQuery, useListLeaveTypesQuery, useRevokeDelegationMutation, useRunLeaveJobMutation, useSaveLeaveTypeConfigMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DirectoryUser, LeaveTypeConfig } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserPicker } from "../../shared/ui/UserPicker";
import { EmployeeRequest } from "./EmployeeRequest";
import { EMPLOYMENT_TYPES, pretty } from "./EmployeeDialogs";

const year = () => String(new Date().getFullYear());
const monthStart = () => new Date().toISOString().slice(0, 8) + "01";
const plus30 = () => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

export function validateDelegation(delegate: string, start: string, end: string): string | null {
  if (!delegate) return "Choose who will approve in your place.";
  if (!start || !end) return "Enter the first and last day of the delegation.";
  if (end < start) return "The delegation cannot end before it starts.";
  return null;
}
export function validateLeaveType(c: { name: string; annual_days: string; max_carryover_days: string; eligibility_months: string; max_consecutive_days: string; min_notice_days: string; carryover_expiry_months: string }): string | null {
  if (!c.name.trim()) return "A name is required.";
  for (const [label, v] of [["Annual days", c.annual_days], ["Maximum carry-over days", c.max_carryover_days]] as const) { const n = parseMoney(v); if (n === null || n < 0n) return `${label} must be a number of 0 or more.`; }
  for (const [label, v] of [["Eligibility months", c.eligibility_months], ["Maximum consecutive days", c.max_consecutive_days], ["Minimum notice days", c.min_notice_days], ["Carry-over expiry months", c.carryover_expiry_months]] as const) if (!/^\d+$/.test(v)) return `${label} must be a whole number of 0 or more.`;
  return null;
}

function Calendar() {
  const [r, setR] = useState({ from: monthStart(), to: plus30() });
  const { data, isFetching, error, refetch } = useGetLeaveCalendarQuery(r);
  return (
    <Card title="Who is away">
      <div className="mb-3 flex gap-3 text-sm"><label>From <input aria-label="From" type="date" className={inputClass} value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /></label><label>To <input aria-label="To" type="date" className={inputClass} value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /></label></div>
      {isFetching ? <Spinner /> : error ? <ErrorState error={error} onRetry={() => void refetch()} /> : (
        <>
          {data!.holidays.length > 0 && <p className="mb-2 text-sm text-slate-600">Holidays: {data!.holidays.map((h) => `${h.date} ${h.name}`).join(" · ")}</p>}
          {data!.leaves.length === 0 ? <EmptyState title="Nobody is on leave in this period" /> : (
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Employee</th><th>Department</th><th>Type</th><th>Dates</th><th className="text-right">Days</th><th>Status</th></tr></thead>
              <tbody>{data!.leaves.map((l, i) => <tr key={i} className="border-t border-slate-100"><td>{l.employee_no} {l.name}</td><td>{l.department ?? "—"}</td><td>{l.type}</td><td>{l.start_date} to {l.end_date}</td><td className="text-right">{l.days}</td><td>{pretty(l.status)}</td></tr>)}</tbody></table>
          )}
        </>
      )}
    </Card>
  );
}

function Report() {
  const [y, setY] = useState(year());
  const [group, setGroup] = useState("employee");
  const valid = /^\d{4}$/.test(y);
  const rep = useGetLeaveReportQuery({ year: y, group }, { skip: !valid || group === "absence" });
  const abs = useGetAbsenceSummaryQuery({ year: y }, { skip: !valid || group !== "absence" });
  const q = group === "absence" ? abs : rep;
  return (
    <Card title="Leave report">
      <div className="mb-3 flex gap-3 text-sm">
        <label>Year <input aria-label="Year" inputMode="numeric" maxLength={4} className={`${inputClass} w-24`} value={y} onChange={(e) => setY(e.target.value)} /></label>
        <label>Group by <select aria-label="Group by" className={inputClass} value={group} onChange={(e) => setGroup(e.target.value)}><option value="employee">Employee</option><option value="department">Department</option><option value="type">Leave type</option><option value="absence">Absence by month</option></select></label>
      </div>
      {!valid ? <p role="alert" className="text-sm text-red-700">Enter a four-digit year.</p> : q.isFetching ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : group === "absence" ? (
        abs.data!.length === 0 ? <EmptyState title="No absence recorded" /> : <table className="w-full text-sm"><thead><tr className="text-left"><th>Month</th><th>Type</th><th className="text-right">Days</th></tr></thead><tbody>{abs.data!.map((a, i) => <tr key={i} className="border-t border-slate-100"><td>{a.month}</td><td>{a.type}</td><td className="text-right">{formatMoney(a.days)}</td></tr>)}</tbody></table>
      ) : rep.data!.length === 0 ? <EmptyState title="No leave data for this year" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>{pretty(group)}</th><th className="text-right">Allocated</th><th className="text-right">Used</th><th className="text-right">Pending</th><th className="text-right">Expired</th><th className="text-right">Remaining</th><th className="text-right">Used %</th></tr></thead>
          <tbody>{rep.data!.map((r, i) => <tr key={i} className="border-t border-slate-100"><td>{r.key.join(" · ")}</td><td className="text-right">{formatMoney(r.allocated)}</td><td className="text-right">{formatMoney(r.used)}</td><td className="text-right">{formatMoney(r.pending)}</td><td className="text-right">{formatMoney(r.expired)}</td><td className="text-right">{formatMoney(r.remaining)}</td><td className="text-right">{r.utilization_percent ? `${formatMoney(r.utilization_percent)}%` : "—"}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

function TypeEditor({ code }: { code: string }) {
  const { data, isLoading, error, refetch } = useGetLeaveTypeConfigQuery(code);
  const [save, state] = useSaveLeaveTypeConfigMutation();
  const [f, setF] = useState<(Omit<LeaveTypeConfig, "eligibility_months" | "max_consecutive_days" | "min_notice_days" | "carryover_expiry_months"> & { eligibility_months: string; max_consecutive_days: string; min_notice_days: string; carryover_expiry_months: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const cur = f ?? { ...data, eligibility_months: String(data.eligibility_months), max_consecutive_days: String(data.max_consecutive_days), min_notice_days: String(data.min_notice_days), carryover_expiry_months: String(data.carryover_expiry_months) };
  const set = (p: Partial<typeof cur>) => { setSaved(false); setF({ ...cur, ...p }); };
  const go = async () => {
    const problem = validateLeaveType(cur);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      await save({ code, body: { name: cur.name.trim(), is_paid: cur.is_paid, annual_days: cur.annual_days.trim(), grant_mode: cur.grant_mode, eligibility_months: Number(cur.eligibility_months), eligible_employment_types: cur.eligible_employment_types, max_carryover_days: cur.max_carryover_days.trim(), carryover_expiry_months: Number(cur.carryover_expiry_months), allow_half_day: cur.allow_half_day, max_consecutive_days: Number(cur.max_consecutive_days), min_notice_days: Number(cur.min_notice_days), is_active: cur.is_active } }).unwrap();
      setF(null); setSaved(true);
    } catch (e) { setErr(errorMessage(e)); }
  };
  const num = (id: string, label: string, key: "annual_days" | "max_carryover_days" | "eligibility_months" | "max_consecutive_days" | "min_notice_days" | "carryover_expiry_months") => (
    <FormField label={label} htmlFor={id}><input id={id} inputMode="decimal" className={`${inputClass} text-right`} value={cur[key]} onChange={(e) => set({ [key]: e.target.value })} /></FormField>
  );
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Name" htmlFor="lt-name"><input id="lt-name" className={inputClass} value={cur.name} onChange={(e) => set({ name: e.target.value })} /></FormField>
        <FormField label="How days are granted" htmlFor="lt-grant"><select id="lt-grant" className={inputClass} value={cur.grant_mode} onChange={(e) => set({ grant_mode: e.target.value })}>{["MANUAL", "ACCRUAL", "UPFRONT"].map((g) => <option key={g} value={g}>{pretty(g)}</option>)}</select></FormField>
        {num("lt-days", "Annual days", "annual_days")}{num("lt-carry", "Maximum carry-over days", "max_carryover_days")}
        {num("lt-elig", "Eligible after (months)", "eligibility_months")}{num("lt-exp", "Carry-over expires after (months)", "carryover_expiry_months")}
        {num("lt-max", "Maximum consecutive days (0 = no limit)", "max_consecutive_days")}{num("lt-notice", "Minimum notice (days)", "min_notice_days")}
      </div>
      <fieldset className="my-3 text-sm"><legend className="mb-1">Eligible employment types (none ticked = everyone)</legend>
        {EMPLOYMENT_TYPES.map((t) => <label key={t} className="mr-4"><input type="checkbox" checked={cur.eligible_employment_types.includes(t)} onChange={(e) => set({ eligible_employment_types: e.target.checked ? [...cur.eligible_employment_types, t] : cur.eligible_employment_types.filter((x) => x !== t) })} /> {pretty(t)}</label>)}
      </fieldset>
      <div className="mb-3 flex gap-6 text-sm">
        <label><input type="checkbox" checked={cur.is_paid} onChange={(e) => set({ is_paid: e.target.checked })} /> Paid leave</label>
        <label><input type="checkbox" checked={cur.allow_half_day} onChange={(e) => set({ allow_half_day: e.target.checked })} /> Allow half days</label>
        <label><input type="checkbox" checked={cur.is_active} onChange={(e) => set({ is_active: e.target.checked })} /> Active</label>
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {saved && <p role="status" className="mb-2 text-sm text-green-700">Leave type saved.</p>}
      <Button loading={state.isLoading} onClick={() => void go()}>Save leave type</Button>
    </div>
  );
}

function Types() {
  const types = useListLeaveTypesQuery();
  const [code, setCode] = useState("");
  return (
    <Card title="Leave types">
      <FormField label="Leave type" htmlFor="lt-pick"><select id="lt-pick" className={inputClass} value={code} onChange={(e) => setCode(e.target.value)}><option value="">Choose…</option>{types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></FormField>
      {code && <TypeEditor key={code} code={code} />}
    </Card>
  );
}

function Allocations() {
  const [allocate] = useAllocateLeaveMutation();
  const [job, jobState] = useRunLeaveJobMutation();
  const types = useListLeaveTypesQuery();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const run = async (j: "accrue" | "year-end", body: Record<string, unknown>) => { setErr(null); setMsg(null); try { const r = await job({ job: j, body }).unwrap(); setMsg(`${j === "accrue" ? "Accrual" : "Year-end"} finished: ${r.created} record(s) created. Running it again creates nothing new.`); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Card title="Allocations and scheduled jobs">
      <div className="mb-3 flex flex-wrap gap-2">
        <Button onClick={() => setOpen(true)}>Set an employee's allocation</Button>
        {can("hr.config.manage") && <><Button variant="secondary" loading={jobState.isLoading} onClick={() => void run("accrue", {})}>Run accrual now</Button><Button variant="secondary" loading={jobState.isLoading} onClick={() => void run("year-end", { year: Number(year()) - 1 })}>Run year-end for {Number(year()) - 1}</Button></>}
      </div>
      {msg && <p role="status" className="text-sm text-green-700">{msg}</p>}
      {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
      <EmployeeRequest title="Set leave allocation" open={open} onClose={() => setOpen(false)} cta="Save allocation"
        fields={[{ name: "type", label: "Leave type", options: (types.data ?? []).map((t) => [t.code, t.name] as [string, string]), required: true }, { name: "year", label: "Year", required: true }, { name: "days", label: "Days", required: true }]}
        submit={async (emp, v) => { if (!/^\d{4}$/.test(v.year!)) throw new Error("Enter a four-digit year."); const d = parseMoney(v.days!); if (d === null || d < 0n) throw new Error("Days must be a number of 0 or more."); return allocate({ employee: emp, leave_type: v.type!, year: Number(v.year), days: v.days!.trim() }).unwrap(); }} />
    </Card>
  );
}

function Delegations() {
  const [create, state] = useDelegateApprovalsMutation();
  const [revoke] = useRevokeDelegationMutation();
  const [delegate, setDelegate] = useState<DirectoryUser | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [mine, setMine] = useState<{ id: string; name: string; start: string; end: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const problem = validateDelegation(delegate?.id ?? "", start, end);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { const d = await create({ delegate: delegate!.id, start_date: start, end_date: end }).unwrap(); setMine((m) => [...m, { id: d.id, name: delegate!.display_name, start, end }]); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="Delegate my leave approvals">
      <p className="mb-3 text-sm text-slate-600">While you are away, someone who can approve leave decides on your behalf. Delegations you create here this session can be revoked below; the server does not list earlier ones.</p>
      <UserPicker label="Delegate to" onChange={setDelegate} />
      <div className="grid grid-cols-2 gap-3"><FormField label="From" htmlFor="dg-start"><input id="dg-start" type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} /></FormField><FormField label="Until" htmlFor="dg-end"><input id="dg-end" type="date" className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} /></FormField></div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <Button loading={state.isLoading} onClick={() => void go()}>Delegate</Button>
      {mine.length > 0 && <ul className="mt-3 text-sm">{mine.map((d) => <li key={d.id} className="flex items-center justify-between">{d.name}: {d.start} to {d.end}<Button variant="secondary" onClick={() => void revoke(d.id).unwrap().then(() => setMine((m) => m.filter((x) => x.id !== d.id)))}>Revoke</Button></li>)}</ul>}
    </Card>
  );
}

export function LeaveAdminPage() {
  const { can } = useAccess();
  const all: ["calendar" | "report" | "types" | "alloc" | "delegations", string, boolean][] = [["calendar", "Calendar", true], ["report", "Report", true], ["types", "Leave types", can("hr.config.manage")], ["alloc", "Allocations", can("hr.employee.manage")], ["delegations", "Delegations", can("hr.leave.approve")]];
  const tabs = all.filter((t) => t[2]);
  const [tab, setTab] = useState(tabs[0]![0]);
  return (
    <>
      <PageHeader title="Leave management" description="Team calendar, reports, policy and delegation." />
      <div role="tablist" className="mb-4 flex gap-2 border-b border-slate-200">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-indigo-600 font-medium" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "calendar" && <Calendar />}{tab === "report" && <Report />}{tab === "types" && <Types />}{tab === "alloc" && <Allocations />}{tab === "delegations" && <Delegations />}
    </>
  );
}

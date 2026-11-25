import { useState } from "react";

import { useAssignScheduleMutation, useCreateScheduleMutation, useGetOvertimePolicyQuery, useListSchedulesQuery, useSaveOvertimePolicyMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { OvertimePolicy } from "../../shared/api/types";
import { parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { EmployeeRequest } from "./EmployeeRequest";

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function validateSchedule(f: { code: string; name: string; days: number[]; start: string; end: string; brk: string; grace: string }): string | null {
  if (!f.code.trim() || !f.name.trim()) return "Enter a code and a name.";
  if (f.days.length === 0) return "Choose at least one working day.";
  if (!f.start || !f.end) return "Enter the start and end times.";
  if (f.end <= f.start) return "The end time must be after the start time.";
  if (!/^\d+$/.test(f.brk) || !/^\d+$/.test(f.grace)) return "Break and grace minutes must be whole numbers.";
  return null;
}
export function validatePolicy(p: OvertimePolicy): string | null {
  for (const [label, v] of [["Weekday multiplier", p.weekday_multiplier], ["Rest day multiplier", p.rest_day_multiplier], ["Holiday multiplier", p.holiday_multiplier]] as const) { const n = parseMoney(v); if (n === null || n < 10000n) return `${label} must be at least 1.`; }
  const d = parseMoney(p.max_daily_hours); if (d === null || d <= 0n || d > 240000n) return "Maximum daily hours must be more than 0 and at most 24.";
  const m = parseMoney(p.monthly_hours_divisor); if (m === null || m <= 0n) return "Monthly hours divisor must be more than 0.";
  return null;
}

function Schedules() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListSchedulesQuery();
  const [create, state] = useCreateScheduleMutation();
  const [assign] = useAssignScheduleMutation();
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [f, setF] = useState({ code: "", name: "", days: [0, 1, 2, 3, 4] as number[], start: "08:30", end: "17:30", brk: "60", grace: "10", def: false });
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const go = async () => {
    const problem = validateSchedule(f);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await create({ code: f.code.trim().toUpperCase(), name: f.name.trim(), work_days: f.days, start_time: f.start, end_time: f.end, break_minutes: Number(f.brk), grace_minutes: Number(f.grace), is_default: f.def }).unwrap(); setAdding(false); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="Work schedules">
      <div className="mb-3 flex gap-2">
        {can("hr.config.manage") && <Button onClick={() => setAdding(true)}>New schedule</Button>}
        {can("hr.employee.manage") && <Button variant="secondary" onClick={() => setAssigning(true)}>Assign schedule to an employee</Button>}
      </div>
      {data!.length === 0 ? <EmptyState title="No schedules yet" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Name</th><th>Days</th><th>Hours</th><th className="text-right">Break</th><th className="text-right">Grace</th></tr></thead>
          <tbody>{data!.map((s) => <tr key={s.id} className="border-t border-slate-100"><td>{s.code}{s.is_default && <> <Badge tone="green">Default</Badge></>}</td><td>{s.name}</td><td>{s.work_days.map((d) => DAYS[d]).join(" ")}</td><td>{s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}</td><td className="text-right">{s.break_minutes} min</td><td className="text-right">{s.grace_minutes} min</td></tr>)}</tbody></table>
      )}
      {adding && (
        <div role="dialog" aria-label="Schedule form" className="mt-4 rounded border border-slate-200 p-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Code" htmlFor="sc-code"><input id="sc-code" className={inputClass} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></FormField>
            <FormField label="Name" htmlFor="sc-name"><input id="sc-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
            <FormField label="Start" htmlFor="sc-start"><input id="sc-start" type="time" className={inputClass} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></FormField>
            <FormField label="End" htmlFor="sc-end"><input id="sc-end" type="time" className={inputClass} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></FormField>
            <FormField label="Break (minutes)" htmlFor="sc-brk"><input id="sc-brk" inputMode="numeric" className={inputClass} value={f.brk} onChange={(e) => setF({ ...f, brk: e.target.value })} /></FormField>
            <FormField label="Grace (minutes)" htmlFor="sc-grace"><input id="sc-grace" inputMode="numeric" className={inputClass} value={f.grace} onChange={(e) => setF({ ...f, grace: e.target.value })} /></FormField>
          </div>
          <fieldset className="my-2 text-sm"><legend>Working days</legend>{DAYS.map((d, i) => <label key={d} className="mr-3"><input type="checkbox" checked={f.days.includes(i)} onChange={(e) => setF({ ...f, days: e.target.checked ? [...f.days, i].sort() : f.days.filter((x) => x !== i) })} /> {d}</label>)}</fieldset>
          <label className="mb-2 block text-sm"><input type="checkbox" checked={f.def} onChange={(e) => setF({ ...f, def: e.target.checked })} /> Default schedule for everyone without one</label>
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          <div className="flex gap-2"><Button loading={state.isLoading} onClick={() => void go()}>Save schedule</Button><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button></div>
        </div>
      )}
      <EmployeeRequest title="Assign schedule" open={assigning} onClose={() => setAssigning(false)} cta="Assign"
        fields={[{ name: "schedule", label: "Schedule", options: data!.map((s) => [s.id, `${s.code} ${s.name}`] as [string, string]), required: true }, { name: "from", label: "From", type: "date", required: true }, { name: "to", label: "Until (optional)", type: "date" }]}
        submit={async (emp, v) => { if (v.to && v.to < v.from!) throw new Error("The end date cannot be before the start date."); return assign({ employee: emp, schedule: v.schedule!, effective_from: v.from!, ...(v.to ? { effective_to: v.to } : {}) }).unwrap(); }} />
    </Card>
  );
}

function Policy() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useGetOvertimePolicyQuery();
  const [save, state] = useSaveOvertimePolicyMutation();
  const [f, setF] = useState<OvertimePolicy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const cur = f ?? data;
  const edit = can("hr.config.manage");
  const field = (id: string, label: string, key: keyof OvertimePolicy) => <FormField label={label} htmlFor={id}><input id={id} disabled={!edit} inputMode="decimal" className={`${inputClass} text-right`} value={cur[key]} onChange={(e) => { setSaved(false); setF({ ...cur, [key]: e.target.value }); }} /></FormField>;
  const go = async () => {
    const problem = validatePolicy(cur);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await save({ weekday_multiplier: cur.weekday_multiplier.trim(), rest_day_multiplier: cur.rest_day_multiplier.trim(), holiday_multiplier: cur.holiday_multiplier.trim(), max_daily_hours: cur.max_daily_hours.trim(), monthly_hours_divisor: cur.monthly_hours_divisor.trim() }).unwrap(); setF(null); setSaved(true); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="Overtime policy">
      <div className="grid gap-3 sm:grid-cols-2">{field("op-wd", "Weekday multiplier", "weekday_multiplier")}{field("op-rd", "Rest day multiplier", "rest_day_multiplier")}{field("op-hd", "Holiday multiplier", "holiday_multiplier")}{field("op-max", "Maximum daily hours", "max_daily_hours")}{field("op-div", "Monthly hours divisor (hourly rate = monthly salary ÷ this)", "monthly_hours_divisor")}</div>
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
      {saved && <p role="status" className="mt-2 text-sm text-green-700">Policy saved. It applies to payroll runs calculated from now on.</p>}
      {edit && <div className="mt-3"><Button loading={state.isLoading} onClick={() => void go()}>Save policy</Button></div>}
    </Card>
  );
}

export function WorkTimePage() {
  const [tab, setTab] = useState<"schedules" | "policy">("schedules");
  return (
    <>
      <PageHeader title="Work time setup" description="Work schedules and the overtime policy." />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2 border-b border-slate-200">
        {([["schedules", "Schedules"], ["policy", "Overtime policy"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-indigo-600 font-medium" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "schedules" ? <Schedules /> : <Policy />}
    </>
  );
}

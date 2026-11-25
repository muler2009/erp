import { useState } from "react";

import { useDecideCorrectionMutation, useDecideOvertimeMutation, useGetAttendanceReportQuery, useGetExceptionsQuery, useListCorrectionsQuery, useListOvertimeQuery, useRequestCorrectionMutation, useRequestOvertimeMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { pretty } from "./EmployeeDialogs";
import { EmployeeRequest } from "./EmployeeRequest";
import { useEmployeeNames } from "./names";

const tone = (s: string) => (s === "APPROVED" ? "green" : s === "REJECTED" ? "red" : "amber") as "green" | "red" | "amber";
const monthStart = () => new Date().toISOString().slice(0, 8) + "01";
const today = () => new Date().toISOString().slice(0, 10);

/** A datetime-local value ("2026-11-10T08:00") becomes an ISO instant with the browser's offset, as the server requires a timezone. */
export function toIsoWithZone(local: string): string { return local ? new Date(local).toISOString() : ""; }
export function validateOvertime(hours: string): string | null {
  const h = parseMoney(hours);
  return h === null || h <= 0n || h > 240000n ? "Hours must be more than 0 and at most 24." : null;
}

function Corrections() {
  const { can } = useAccess();
  const nameOf = useEmployeeNames();
  const { data, isLoading, error, refetch } = useListCorrectionsQuery({});
  const [request] = useRequestCorrectionMutation();
  const [decide] = useDecideCorrectionMutation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (id: string, decision: "approve" | "reject") => { setErr(null); try { await decide({ id, decision, note: decision === "reject" ? "Rejected" : undefined }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  return (
    <Card title="Attendance corrections">
      <div className="mb-3"><Button onClick={() => setOpen(true)}>{can("hr.employee.manage") ? "Request correction for an employee" : "Request a correction"}</Button></div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {data!.results.length === 0 ? <EmptyState title="No corrections" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Who</th><th>Date</th><th>In</th><th>Out</th><th>Reason</th><th>Status</th><th /></tr></thead>
          <tbody>{data!.results.map((c) => <tr key={c.id} className="border-t border-slate-100"><td>{nameOf(c.employee)}</td><td>{c.work_date}</td><td>{c.check_in.slice(11, 16)}</td><td>{c.check_out ? c.check_out.slice(11, 16) : "—"}</td><td>{c.reason}</td><td><Badge tone={tone(c.status)}>{pretty(c.status)}</Badge></td>
            <td>{c.status === "PENDING" && can("hr.timesheet.approve") && <div className="flex gap-2"><Button onClick={() => void go(c.id, "approve")}>Approve</Button><Button variant="secondary" onClick={() => void go(c.id, "reject")}>Reject</Button></div>}</td></tr>)}</tbody></table>
      )}
      <EmployeeRequest title="Request attendance correction" open={open} onClose={() => setOpen(false)} cta="Submit correction" pickEmployee={can("hr.employee.manage")}
        fields={[{ name: "date", label: "Date", type: "date", required: true }, { name: "in", label: "Clock in", type: "datetime-local", required: true }, { name: "out", label: "Clock out (optional)", type: "datetime-local" }, { name: "mode", label: "Work mode", options: [["OFFICE", "Office"], ["REMOTE", "Remote"], ["FIELD", "Field"], ["TRAVEL", "Travel"]], required: true }, { name: "reason", label: "Reason", required: true }]}
        submit={async (emp, v) => { if (v.out && v.out <= v.in!) throw new Error("Clock out must be after clock in."); return request({ ...(emp ? { employee: emp } : {}), work_date: v.date!, check_in: toIsoWithZone(v.in!), ...(v.out ? { check_out: toIsoWithZone(v.out) } : {}), work_mode: v.mode!, reason: v.reason!.trim() }).unwrap(); }} />
    </Card>
  );
}

function Overtime() {
  const { can } = useAccess();
  const nameOf = useEmployeeNames();
  const { data, isLoading, error, refetch } = useListOvertimeQuery({});
  const [request] = useRequestOvertimeMutation();
  const [decide] = useDecideOvertimeMutation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (id: string, decision: "approve" | "reject") => { setErr(null); try { await decide({ id, decision, note: decision === "reject" ? "Rejected" : undefined }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  return (
    <Card title="Overtime requests">
      <div className="mb-3"><Button onClick={() => setOpen(true)}>{can("hr.employee.manage") ? "Request overtime for an employee" : "Request overtime"}</Button></div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {data!.results.length === 0 ? <EmptyState title="No overtime requests" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Who</th><th>Date</th><th className="text-right">Hours</th><th>Reason</th><th>Status</th><th /></tr></thead>
          <tbody>{data!.results.map((o) => <tr key={o.id} className="border-t border-slate-100"><td>{nameOf(o.employee)}</td><td>{o.work_date}</td><td className="text-right">{formatMoney(o.hours)}</td><td>{o.reason}</td><td><Badge tone={tone(o.status)}>{pretty(o.status)}</Badge></td>
            <td>{o.status === "PENDING" && can("hr.timesheet.approve") && <div className="flex gap-2"><Button onClick={() => void go(o.id, "approve")}>Approve</Button><Button variant="secondary" onClick={() => void go(o.id, "reject")}>Reject</Button></div>}</td></tr>)}</tbody></table>
      )}
      <EmployeeRequest title="Request overtime" open={open} onClose={() => setOpen(false)} cta="Submit request" pickEmployee={can("hr.employee.manage")}
        fields={[{ name: "date", label: "Date worked", type: "date", required: true }, { name: "hours", label: "Hours", required: true }, { name: "reason", label: "Reason", required: true }]}
        submit={async (emp, v) => { const p = validateOvertime(v.hours!); if (p) throw new Error(p); return request({ ...(emp ? { employee: emp } : {}), work_date: v.date!, hours: v.hours!.trim(), reason: v.reason!.trim() }).unwrap(); }} />
    </Card>
  );
}

function Range({ from, to, set }: { from: string; to: string; set: (f: string, t: string) => void }) {
  return (
    <div className="mb-3 flex items-end gap-3 text-sm">
      <label>From <input aria-label="From" type="date" className={inputClass} value={from} onChange={(e) => set(e.target.value, to)} /></label>
      <label>To <input aria-label="To" type="date" className={inputClass} value={to} onChange={(e) => set(from, e.target.value)} /></label>
    </div>
  );
}

function Exceptions() {
  const [r, setR] = useState({ from: monthStart(), to: today() });
  const { data, isFetching, error, refetch } = useGetExceptionsQuery(r);
  return (
    <Card title="Days needing attention">
      <Range from={r.from} to={r.to} set={(from, to) => setR({ from, to })} />
      {isFetching ? <Spinner /> : error ? <ErrorState error={error} onRetry={() => void refetch()} /> : data!.length === 0 ? <EmptyState title="No exceptions in this period" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Employee</th><th>Date</th><th>Exceptions</th><th>Correction</th><th>Overtime</th></tr></thead>
          <tbody>{data!.map((x, i) => <tr key={i} className="border-t border-slate-100"><td>{x.employee_no} {x.name}</td><td>{x.date}</td><td>{x.exceptions.map(pretty).join(", ")}</td><td>{x.correction_status ? pretty(x.correction_status) : "—"}</td><td>{x.overtime_request_status ? pretty(x.overtime_request_status) : "—"}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

function Report() {
  const [r, setR] = useState({ from: monthStart(), to: today() });
  const [group, setGroup] = useState("month");
  const { data, isFetching, error, refetch } = useGetAttendanceReportQuery({ ...r, group });
  return (
    <Card title="Attendance report">
      <div className="flex flex-wrap items-end gap-3"><Range from={r.from} to={r.to} set={(from, to) => setR({ from, to })} />
        <label className="mb-3 text-sm">Group by <select aria-label="Group by" className={inputClass} value={group} onChange={(e) => setGroup(e.target.value)}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label></div>
      {isFetching ? <Spinner /> : error ? <ErrorState error={error} onRetry={() => void refetch()} /> : data!.length === 0 ? <EmptyState title="No attendance in this period" /> : (
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left"><th>Employee</th><th>Period</th><th className="text-right">Present</th><th className="text-right">Absent</th><th className="text-right">Leave</th><th className="text-right">Late</th><th className="text-right">Hours</th><th className="text-right">Overtime</th><th className="text-right">Missed punches</th></tr></thead>
          <tbody>{data!.map((x, i) => <tr key={i} className="border-t border-slate-100"><td>{x.employee_no} {x.name}</td><td>{x.period}</td><td className="text-right">{x.present_days}</td><td className="text-right">{x.absent_days}</td><td className="text-right">{x.leave_days}</td><td className="text-right">{x.late_count} ({x.late_minutes} min)</td><td className="text-right">{formatMoney(x.worked_hours)}</td><td className="text-right">{formatMoney(x.overtime_hours)}</td><td className="text-right">{x.missed_punches}</td></tr>)}</tbody></table></div>
      )}
    </Card>
  );
}

export function AttendanceAdminPage() {
  const [tab, setTab] = useState<"corrections" | "overtime" | "exceptions" | "report">("corrections");
  const tabs = [["corrections", "Corrections"], ["overtime", "Overtime"], ["exceptions", "Exceptions"], ["report", "Report"]] as const;
  return (
    <>
      <PageHeader title="Attendance management" description="Corrections, overtime and attendance reports for the people you manage." />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2 border-b border-slate-200">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-indigo-600 font-medium" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "corrections" && <Corrections />}
      {tab === "overtime" && <Overtime />}
      {tab === "exceptions" && <Exceptions />}
      {tab === "report" && <Report />}
    </>
  );
}

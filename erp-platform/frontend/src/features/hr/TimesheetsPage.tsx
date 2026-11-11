import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useGetHrMeQuery, useListTimesheetsQuery, useSaveTimesheetMutation, useTimesheetActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Timesheet, TimesheetEntry } from "../../shared/api/types";
import { formatMoney, parseMoney, sumMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { useEmployeeNames } from "./names";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

const tone = (s: string) => (s === "APPROVED" ? "green" : s === "REJECTED" ? "red" : s === "SUBMITTED" ? "amber" : "slate") as "green" | "red" | "amber" | "slate";
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const addDays = (iso: string, n: number) => new Date(day(iso).getTime() + n * 86400000).toISOString().slice(0, 10);

/** Returns an error message or null. The server repeats every check. */
export function validateTimesheet(weekStart: string, rows: TimesheetEntry[]): string | null {
  if (!weekStart) return "Choose the week.";
  if (day(weekStart).getUTCDay() !== 1) return "The week must start on a Monday.";
  if (rows.length === 0) return "Add at least one entry.";
  const perDay: Record<string, bigint> = {};
  for (const r of rows) {
    if (!r.work_date || r.work_date < weekStart || r.work_date > addDays(weekStart, 6)) return "Every entry must fall inside the chosen week.";
    const h = parseMoney(r.hours);
    if (h === null || h <= 0n || h > 240000n) return "Hours must be more than 0 and at most 24.";
    perDay[r.work_date] = (perDay[r.work_date] ?? 0n) + h;
    if (perDay[r.work_date]! > 240000n) return `More than 24 hours on ${r.work_date}.`;
  }
  return null;
}

function EditDialog({ sheet, open, onClose }: { sheet: Timesheet | null; open: boolean; onClose: () => void }) {
  const [save, state] = useSaveTimesheetMutation();
  const [week, setWeek] = useState(sheet?.week_start ?? "");
  const [rows, setRows] = useState<TimesheetEntry[]>(sheet?.entries.length ? sheet.entries : [{ work_date: "", hours: "8", project_ref: "", description: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const patch = (i: number, p: Partial<TimesheetEntry>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const go = async () => {
    const problem = validateTimesheet(week, rows);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await save({ week_start: week, entries: rows.map((r) => ({ ...r, hours: r.hours.trim() })) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  const total = sumMoney(rows.map((r) => r.hours));
  return (
    <Modal title={sheet ? "Edit timesheet" : "New timesheet"} open={open} onClose={onClose}>
      <FormField label="Week starting (Monday)" htmlFor="ts-week"><input id="ts-week" type="date" disabled={!!sheet} className={inputClass} value={week} onChange={(e) => setWeek(e.target.value)} /></FormField>
      <div className="max-h-[50vh] overflow-y-auto">
        {rows.map((r, i) => (
          <div key={i} className="mb-2 grid grid-cols-[9rem_5rem_1fr_1fr_auto] gap-2">
            <input aria-label={`Entry ${i + 1} date`} type="date" className={inputClass} value={r.work_date} onChange={(e) => patch(i, { work_date: e.target.value })} />
            <input aria-label={`Entry ${i + 1} hours`} inputMode="decimal" className={`${inputClass} text-right`} value={r.hours} onChange={(e) => patch(i, { hours: e.target.value })} />
            <input aria-label={`Entry ${i + 1} project`} placeholder="Project (optional)" maxLength={60} className={inputClass} value={r.project_ref} onChange={(e) => patch(i, { project_ref: e.target.value })} />
            <input aria-label={`Entry ${i + 1} description`} placeholder="What you did" maxLength={200} className={inputClass} value={r.description} onChange={(e) => patch(i, { description: e.target.value })} />
            {rows.length > 1 && <Button variant="secondary" aria-label={`Remove entry ${i + 1}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</Button>}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between"><Button variant="secondary" onClick={() => setRows((rs) => [...rs, { work_date: "", hours: "8", project_ref: "", description: "" }])}>Add entry</Button><span className="text-sm">Total {formatMoney(total)} h</span></div>
      {err && <p role="alert" className="my-3 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Save draft</Button></div>
    </Modal>
  );
}

export function TimesheetsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ sheet: Timesheet | null } | null>(null);
  const [rejecting, setRejecting] = useState<Timesheet | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const me = useGetHrMeQuery();
  const nameOf = useEmployeeNames();
  const { data, isLoading, error, refetch } = useListTimesheetsQuery({ cursor });
  const [act, state] = useTimesheetActionMutation();
  const mine = (t: Timesheet) => t.employee === me.data?.id;
  const run = async (id: string, action: "submit" | "approve" | "reject", n?: string) => {
    setErr(null);
    try { await act({ id, action, note: n }).unwrap(); setRejecting(null); setNote(""); } catch (e) { setErr(errorMessage(e)); }
  };
  const columns: ColumnDef<Timesheet>[] = [
    { header: "Week of", cell: ({ row }) => row.original.week_start },
    { header: "Who", cell: ({ row }) => (mine(row.original) ? "Me" : nameOf(row.original.employee)) },
    { header: "Hours", cell: ({ row }) => formatMoney(row.original.total_hours) },
    { header: "Status", cell: ({ row }) => <Badge tone={tone(row.original.status)}>{label(row.original.status)}</Badge> },
    { header: "Note", cell: ({ row }) => row.original.decision_note || "—" },
    { header: "", id: "a", cell: ({ row }) => {
      const t = row.original;
      return (
        <div className="flex gap-2">
          {mine(t) && ["DRAFT", "REJECTED"].includes(t.status) && <Button variant="secondary" onClick={() => setEditing({ sheet: t })}>Edit</Button>}
          {mine(t) && t.status === "DRAFT" && t.entries.length > 0 && <Button loading={state.isLoading} onClick={() => void run(t.id, "submit")}>Submit</Button>}
          {!mine(t) && t.status === "SUBMITTED" && can("hr.timesheet.approve") && <><Button loading={state.isLoading} onClick={() => void run(t.id, "approve")}>Approve</Button><Button variant="secondary" onClick={() => setRejecting(t)}>Reject</Button></>}
        </div>
      );
    } },
  ];
  return (
    <>
      <PageHeader title="Timesheets" description="Weekly hours, submitted for approval by your manager." actions={<Button onClick={() => setEditing({ sheet: null })}>New timesheet</Button>} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <DataTable caption="Timesheets" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No timesheets yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      {editing && <EditDialog key={editing.sheet?.id ?? "new"} sheet={editing.sheet} open onClose={() => setEditing(null)} />}
      <Modal title="Reject timesheet" open={!!rejecting} onClose={() => setRejecting(null)}>
        <FormField label="Reason (required)" htmlFor="ts-note"><input id="ts-note" maxLength={300} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setRejecting(null)}>Close</Button><Button onClick={() => (note.trim() ? void run(rejecting!.id, "reject", note.trim()) : setErr("A reason is required to reject a timesheet."))}>Reject</Button></div>
      </Modal>
    </>
  );
}

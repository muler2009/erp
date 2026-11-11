import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useGetHrMeQuery, useLeaveActionMutation, useListLeaveRequestsQuery, useListLeaveTypesQuery, useRequestLeaveMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { LeaveRequest } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { useEmployeeNames } from "./names";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, Card, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

export const leaveTone = (s: string) => (s === "APPROVED" ? "green" : s === "REJECTED" || s === "CANCELLED" ? "red" : s === "PENDING" ? "amber" : "slate") as "green" | "red" | "amber" | "slate";

/** Returns an error message or null; the server repeats the checks and owns balances and eligibility. */
export function validateLeave(f: { type: string; start: string; end: string; half: string }): string | null {
  if (!f.type) return "Choose a leave type.";
  if (!f.start || !f.end) return "Enter the first and last day.";
  if (f.end < f.start) return "The last day must be on or after the first day.";
  if (f.start.slice(0, 4) !== f.end.slice(0, 4)) return "Leave must stay within one calendar year; request the new year separately.";
  if (f.half && f.start !== f.end) return "A half day must be a single day.";
  return null;
}

function NewLeaveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const types = useListLeaveTypesQuery(undefined, { skip: !open });
  const [request, state] = useRequestLeaveMutation();
  const [type, setType] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [half, setHalf] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    const problem = validateLeave({ type, start, end, half });
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await request({ leave_type: type, start_date: start, end_date: end, reason: reason.trim(), ...(half ? { half_day: half } : {}) }).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Request leave" open={open} onClose={close}>
      <FormField label="Leave type" htmlFor="lv-type"><select id="lv-type" className={inputClass} value={type} onChange={(e) => setType(e.target.value)}><option value="">Choose…</option>{types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}{t.is_paid ? "" : " (unpaid)"}</option>)}</select></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="First day" htmlFor="lv-start"><input id="lv-start" type="date" className={inputClass} value={start} onChange={(e) => { setStart(e.target.value); if (!end) setEnd(e.target.value); }} /></FormField>
        <FormField label="Last day" htmlFor="lv-end"><input id="lv-end" type="date" className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} /></FormField>
      </div>
      <FormField label="Half day (optional)" htmlFor="lv-half"><select id="lv-half" className={inputClass} value={half} onChange={(e) => setHalf(e.target.value)}><option value="">Full days</option><option value="AM">Morning</option><option value="PM">Afternoon</option></select></FormField>
      <FormField label="Reason (optional)" htmlFor="lv-reason"><input id="lv-reason" maxLength={300} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Submit request</Button></div>
    </Modal>
  );
}

function DecideDialog({ req, mode, onClose }: { req: LeaveRequest | null; mode: "approve" | "reject"; onClose: () => void }) {
  const [act, state] = useLeaveActionMutation();
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (mode === "reject" && !note.trim()) { setErr("A reason is required to reject leave."); return; }
    setErr(null);
    try { await act({ id: req!.id, action: mode, note: note.trim() }).unwrap(); setNote(""); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={mode === "approve" ? "Approve leave" : "Reject leave"} open={!!req} onClose={onClose}>
      {req && <p className="mb-3 text-sm">{req.leave_type}: {req.start_date} to {req.end_date} ({req.days} days)</p>}
      <FormField label={mode === "reject" ? "Reason (required)" : "Note (optional)"} htmlFor="lv-note"><input id="lv-note" maxLength={300} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={state.isLoading} onClick={() => void go()}>{mode === "approve" ? "Approve" : "Reject"}</Button></div>
    </Modal>
  );
}

export function LeavePage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState<{ req: LeaveRequest; mode: "approve" | "reject" } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const me = useGetHrMeQuery();
  const nameOf = useEmployeeNames();
  const { data, isLoading, error, refetch } = useListLeaveRequestsQuery({ cursor, status });
  const [act, state] = useLeaveActionMutation();
  const cancel = async (id: string) => { setErr(null); try { await act({ id, action: "cancel" }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const mine = (r: LeaveRequest) => r.employee === me.data?.id;
  const columns: ColumnDef<LeaveRequest>[] = [
    { header: "Who", cell: ({ row }) => (mine(row.original) ? "Me" : nameOf(row.original.employee)) },
    { header: "Type", cell: ({ row }) => row.original.leave_type + (row.original.half_day ? ` (${row.original.half_day})` : "") },
    { header: "Dates", cell: ({ row }) => `${row.original.start_date} to ${row.original.end_date}` },
    { header: "Days", cell: ({ row }) => row.original.days },
    { header: "Status", cell: ({ row }) => <Badge tone={leaveTone(row.original.status)}>{row.original.status.charAt(0) + row.original.status.slice(1).toLowerCase()}</Badge> },
    { header: "Decision note", cell: ({ row }) => row.original.decision_note || "—" },
    { header: "", id: "a", cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex gap-2">
          {r.status === "PENDING" && !mine(r) && can("hr.leave.approve") && <><Button onClick={() => setDeciding({ req: r, mode: "approve" })}>Approve</Button><Button variant="secondary" onClick={() => setDeciding({ req: r, mode: "reject" })}>Reject</Button></>}
          {["PENDING", "APPROVED"].includes(r.status) && mine(r) && <Button variant="secondary" loading={state.isLoading} onClick={() => void cancel(r.id)}>Cancel</Button>}
        </div>
      );
    } },
  ];
  return (
    <>
      <PageHeader title="Leave" description="Your balances and requests, and requests from your team." actions={<Button onClick={() => setCreating(true)}>Request leave</Button>} />
      {me.data && me.data.leave_balances.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {me.data.leave_balances.map((b) => (
            <Card key={b.leave_type}><p className="text-sm text-slate-600">{b.leave_type} {b.year}</p><p className="text-sm">{Object.entries(b).filter(([k]) => !["leave_type", "year"].includes(k)).map(([k, v]) => <span key={k} className="mr-3">{k.replace(/_/g, " ")}: <strong>{String(v)}</strong></span>)}</p></Card>
          ))}
        </div>
      )}
      <div className="mb-3"><label className="text-sm">Show <select aria-label="Status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option><option value="PENDING">Pending</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="CANCELLED">Cancelled</option></select></label></div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <DataTable caption="Leave requests" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No leave requests" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <NewLeaveDialog open={creating} onClose={() => setCreating(false)} />
      <DecideDialog req={deciding?.req ?? null} mode={deciding?.mode ?? "approve"} onClose={() => setDeciding(null)} />
    </>
  );
}

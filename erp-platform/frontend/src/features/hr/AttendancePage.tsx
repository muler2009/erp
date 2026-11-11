import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useCheckInMutation, useCheckOutMutation, useGetHrMeQuery, useListAttendanceQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { AttendanceRecord } from "../../shared/api/types";
import { DataTable } from "../../shared/ui/DataTable";
import { Button, Card, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");

/** My clock-in/out and my attendance history. The server decides the clock time; the browser never sends one. */
export function AttendancePage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [mode, setMode] = useState("OFFICE");
  const [err, setErr] = useState<string | null>(null);
  const me = useGetHrMeQuery();
  const { data, isLoading, error, refetch } = useListAttendanceQuery({ cursor, employee: me.data?.id }, { skip: !me.data });
  const [checkIn, inState] = useCheckInMutation();
  const [checkOut, outState] = useCheckOutMutation();
  const open = !cursor ? data?.results.find((r) => !r.check_out) : undefined;
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(errorMessage(e)); } };
  const columns: ColumnDef<AttendanceRecord>[] = [
    { header: "Date", cell: ({ row }) => row.original.work_date },
    { header: "In", cell: ({ row }) => time(row.original.check_in) },
    { header: "Out", cell: ({ row }) => time(row.original.check_out) },
    { header: "Hours", cell: ({ row }) => row.original.hours ?? "—" },
  ];
  return (
    <>
      <PageHeader title="Attendance" description="Clock in and out, and review your recorded days." />
      <Card>
        {me.isLoading ? <Spinner /> : open ? (
          <div className="flex items-center justify-between"><p>You clocked in at <strong>{time(open.check_in)}</strong> on {open.work_date}.</p><Button loading={outState.isLoading} onClick={() => void run(() => checkOut().unwrap())}>Check out</Button></div>
        ) : (
          <div className="flex items-end gap-3">
            <label className="text-sm">Working from <select aria-label="Work mode" className={inputClass} value={mode} onChange={(e) => setMode(e.target.value)}><option value="OFFICE">Office</option><option value="REMOTE">Remote</option><option value="FIELD">Field</option><option value="TRAVEL">Travel</option></select></label>
            <Button loading={inState.isLoading} onClick={() => void run(() => checkIn({ work_mode: mode }).unwrap())}>Check in</Button>
          </div>
        )}
        {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
      </Card>
      <div className="mt-4"><DataTable caption="My attendance" columns={columns} page={data} isLoading={isLoading || me.isLoading} error={error} onRetry={refetch} emptyTitle="No attendance recorded" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} /></div>
    </>
  );
}

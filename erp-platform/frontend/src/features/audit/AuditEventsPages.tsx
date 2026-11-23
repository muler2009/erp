import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { useListOutboxEventsQuery, useListTenantAuditQuery, useRetryOutboxEventMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { OutboxEventRow, TenantAuditEvent } from "../../shared/api/types";
import { formatDateTime } from "../../shared/lib/format";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, Card, FormField, PageHeader, inputClass } from "../../shared/ui/primitives";
import { useUserNames } from "../quality/names";

/** A short readable form of the details stored with an event. */
export function metaText(m: Record<string, unknown> | null | undefined): string {
  const parts = Object.entries(m ?? {}).filter(([, v]) => v !== "" && v !== null && v !== undefined).map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  const t = parts.join("; ");
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

export function TenantAuditPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [applied, setApplied] = useState("");
  const q = useListTenantAuditQuery({ cursor, action: applied });
  const name = useUserNames();
  const columns = useMemo<ColumnDef<TenantAuditEvent>[]>(() => [
    { header: "When", cell: ({ row }) => formatDateTime(row.original.created_at) },
    { header: "Who", cell: ({ row }) => (row.original.actor_user_id ? name(row.original.actor_user_id) : "System") },
    { header: "Action", accessorKey: "action" },
    { header: "Target", cell: ({ row }) => `${row.original.target_type} ${row.original.target_id}`.trim() || "—" },
    { header: "Details", cell: ({ row }) => <span className="text-xs text-slate-600">{metaText(row.original.metadata)}</span> },
    { header: "Correlation ID", cell: ({ row }) => <span className="font-mono text-xs">{row.original.correlation_id}</span> },
  ], [name]);
  return (
    <>
      <PageHeader title="Audit log" description="Who changed what in this workspace. Entries cannot be edited or deleted." />
      <form className="mb-3 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setCursor(null); setApplied(action.trim()); }}>
        <FormField label="Action (exact, for example role.assigned)" htmlFor="au-action"><input id="au-action" className={inputClass} value={action} onChange={(e) => setAction(e.target.value)} /></FormField>
        <Button type="submit" className="mb-3">Filter</Button>
        {applied && <Button variant="secondary" className="mb-3" onClick={() => { setAction(""); setApplied(""); setCursor(null); }}>Clear</Button>}
      </form>
      <DataTable caption="Audit events" columns={columns} page={q.data} isLoading={q.isLoading} error={q.error} onRetry={q.refetch} emptyTitle="No events" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
    </>
  );
}

const age = (s: number) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h`);

export function EventOutboxPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const q = useListOutboxEventsQuery({ cursor, status });
  const [retry, r] = useRetryOutboxEventMutation();
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const go = async (id: string) => { setErr(null); try { await retry(id).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const columns = useMemo<ColumnDef<OutboxEventRow>[]>(() => [
    { header: "Event", cell: ({ row }) => `${row.original.type} v${row.original.version}` },
    { header: "Status", cell: ({ row }) => <Badge tone={row.original.status === "DEAD" ? "red" : row.original.status === "PENDING" ? "amber" : "green"}>{row.original.status === "DEAD" ? "Failed" : row.original.status === "PENDING" ? "Waiting" : "Delivered"}</Badge> },
    { header: "Attempts", accessorKey: "attempts" },
    { header: "Created", cell: ({ row }) => formatDateTime(row.original.created_at) },
    { header: "Last error", cell: ({ row }) => <span className="text-xs text-red-700">{row.original.last_error || "—"}</span> },
    ...(can("events.manage") ? [{ id: "act", header: "", cell: ({ row }: { row: { original: OutboxEventRow } }) => row.original.status === "DEAD" ? <Button variant="secondary" aria-label={`Retry ${row.original.type}`} loading={r.isLoading && r.originalArgs === row.original.id} onClick={() => void go(row.original.id)}>Retry</Button> : null } as ColumnDef<OutboxEventRow>] : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [can, r.isLoading, r.originalArgs]);
  const st = q.data?.stats;
  return (
    <>
      <PageHeader title="Integration events" description="Messages this workspace sends to other parts of the system. Failed ones can be retried." />
      {st && (
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <Card title="Waiting"><p className="text-2xl font-semibold">{st.pending}</p><p className="text-xs text-slate-500">{st.pending ? `oldest ${age(st.oldest_pending_age_seconds)}` : "nothing queued"}</p></Card>
          <Card title="Failed"><p className={`text-2xl font-semibold ${st.dead ? "text-red-700" : ""}`}>{st.dead}</p><p className="text-xs text-slate-500">gave up after retries</p></Card>
        </div>
      )}
      <FormField label="Show" htmlFor="ev-status"><select id="ev-status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option><option value="PENDING">Waiting</option><option value="DEAD">Failed</option><option value="PUBLISHED">Delivered</option></select></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <DataTable caption="Integration events" columns={columns} page={q.data} isLoading={q.isLoading} error={q.error} onRetry={q.refetch} emptyTitle="No events" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
    </>
  );
}

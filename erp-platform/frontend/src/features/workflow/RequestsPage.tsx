import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { useListWorkflowInstancesQuery } from "../../shared/api/endpoints";
import type { WorkflowInstance } from "../../shared/api/types";
import { formatDateTime } from "../../shared/lib/format";
import { formatMoney } from "../../shared/lib/money";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, PageHeader, inputClass } from "../../shared/ui/primitives";
import { InstanceDialog, pretty, statusTone } from "./InstanceDialog";

export function RequestsPage({ currentUserId }: { currentUserId: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useListWorkflowInstancesQuery({ cursor, status });
  const [openId, setOpenId] = useState<string | null>(null);
  const open = data?.results.find((i) => i.id === openId);
  const columns = useMemo<ColumnDef<WorkflowInstance>[]>(
    () => [
      { header: "Request", cell: ({ row }) => <button type="button" className="text-brand-700 underline" onClick={() => setOpenId(row.original.id)}>{row.original.title}</button> },
      { header: "Type", cell: ({ row }) => pretty(row.original.subject_type) },
      { header: "Amount", cell: ({ row }) => <span className="block text-right">{row.original.amount != null ? formatMoney(row.original.amount) : "—"}</span> },
      { header: "Status", cell: ({ row }) => <Badge tone={statusTone(row.original.status)}>{pretty(row.original.status)}</Badge> },
      { header: "Submitted", cell: ({ row }) => formatDateTime(row.original.created_at) },
    ],
    [],
  );
  return (
    <>
      <PageHeader title="Requests" description="Approval requests you submitted or took part in." />
      <label className="mb-3 flex items-center gap-2 text-sm">Status
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}>
          <option value="">All</option>
          {["PENDING", "CHANGES_REQUESTED", "APPROVED", "REJECTED", "CANCELLED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
        </select>
      </label>
      <DataTable caption="Requests" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No requests" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <InstanceDialog instanceId={openId} canCancel={open?.requester_id === currentUserId} isRequester={open?.requester_id === currentUserId} onClose={() => setOpenId(null)} />
    </>
  );
}

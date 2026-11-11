import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { useListInboxQuery } from "../../shared/api/endpoints";
import type { WorkflowTask } from "../../shared/api/types";
import { formatDateTime } from "../../shared/lib/format";
import { formatMoney } from "../../shared/lib/money";
import { DataTable } from "../../shared/ui/DataTable";
import { Button, PageHeader } from "../../shared/ui/primitives";
import { InstanceDialog, pretty } from "./InstanceDialog";

export function InboxPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListInboxQuery({ cursor });
  const [open, setOpen] = useState<WorkflowTask | null>(null);
  const columns = useMemo<ColumnDef<WorkflowTask>[]>(
    () => [
      { header: "Request", accessorKey: "title" },
      { header: "Type", cell: ({ row }) => pretty(row.original.subject_type) },
      { header: "Amount", cell: ({ row }) => <span className="block text-right">{row.original.amount != null ? formatMoney(row.original.amount) : "—"}</span> },
      { header: "Due", cell: ({ row }) => (row.original.due_at ? formatDateTime(row.original.due_at) : "—") },
      { id: "review", header: "", cell: ({ row }) => <Button variant="secondary" aria-label={`Review ${row.original.title}`} onClick={() => setOpen(row.original)}>Review</Button> },
    ],
    [],
  );
  return (
    <>
      <PageHeader title="Approvals" description="Requests waiting for your decision." />
      <DataTable caption="Approval inbox" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="Nothing is waiting for you" emptyHint="New requests appear here when they are assigned to you." onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <InstanceDialog instanceId={open?.instance_id ?? null} taskId={open?.id ?? null} onClose={() => setOpen(null)} />
    </>
  );
}

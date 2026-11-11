import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useListPlatformAuditQuery } from "../../shared/api/endpoints";
import type { PlatformAuditEvent } from "../../shared/api/types";
import { formatDateTime } from "../../shared/lib/format";
import { DataTable } from "../../shared/ui/DataTable";
import { PageHeader } from "../../shared/ui/primitives";

const columns: ColumnDef<PlatformAuditEvent>[] = [
  { header: "When", cell: ({ row }) => formatDateTime(row.original.created_at) },
  { header: "Action", accessorKey: "action" },
  { header: "Target", cell: ({ row }) => `${row.original.target_type} ${row.original.target_id}`.trim() },
  { header: "Tenant", cell: ({ row }) => row.original.tenant_id ?? "—" },
  { header: "Correlation ID", cell: ({ row }) => <span className="font-mono text-xs">{row.original.correlation_id}</span> },
];

export function PlatformAuditPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListPlatformAuditQuery({ cursor });
  return (
    <>
      <PageHeader title="Audit log" description="Platform-level security and administration events." />
      <DataTable
        caption="Platform audit events" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch}
        emptyTitle="No events" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)}
      />
    </>
  );
}

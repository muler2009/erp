import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useListDepartmentsQuery } from "../../shared/api/endpoints";
import type { Department } from "../../shared/api/types";
import { Badge, PageHeader } from "../../shared/ui/primitives";
import { DataTable } from "../../shared/ui/DataTable";

const columns: ColumnDef<Department>[] = [
  { header: "Code", accessorKey: "code" },
  { header: "Name", accessorKey: "name" },
  { header: "Status", cell: ({ row }) => <Badge tone={row.original.is_active ? "green" : "slate"}>{row.original.is_active ? "Active" : "Inactive"}</Badge> },
];

export function DepartmentsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListDepartmentsQuery({ cursor });
  return (
    <>
      <PageHeader title="Departments" description="Your organisation's departments." />
      <DataTable
        caption="Departments"
        columns={columns}
        page={data}
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        emptyTitle="No departments yet"
        onCursor={setCursor}
        hasPrevious={cursor !== null}
        onFirst={() => setCursor(null)}
      />
    </>
  );
}

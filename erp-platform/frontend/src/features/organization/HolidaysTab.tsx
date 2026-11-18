import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useCreateHolidayMutation, useListHolidaysQuery, useListOrgOptionsQuery } from "../../shared/api/endpoints";
import type { Holiday } from "../../shared/api/types";
import { DataTable } from "../../shared/ui/DataTable";
import { Button, Card } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export function HolidaysTab({ canManage }: { canManage: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { data, isLoading, error, refetch } = useListHolidaysQuery({ cursor });
  const branches = useListOrgOptionsQuery("branches", { skip: !open && !data });
  const [add] = useCreateHolidayMutation();
  const branchName = (id: string | null) => (id ? (branches.data?.find((b) => b.id === id)?.name ?? "Branch") : "All branches");
  const columns: ColumnDef<Holiday>[] = [
    { header: "Date", accessorKey: "holiday_date" },
    { header: "Name", accessorKey: "name" },
    { header: "Applies to", cell: ({ row }) => branchName(row.original.branch) },
  ];
  return (
    <Card title="Holidays" actions={canManage ? <Button onClick={() => setOpen(true)}>Add holiday</Button> : undefined}>
      <DataTable caption="Holidays" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No holidays yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <ActionDialog title="Add holiday" cta="Add" open={open} onClose={() => setOpen(false)}
        fields={[{ name: "holiday_date", label: "Date", type: "date", required: true }, { name: "name", label: "Name", required: true }, { name: "branch", label: "Branch (blank = all)", options: (branches.data ?? []).map((b) => [b.id, `${b.code} ${b.name}`]) }]}
        submit={async (v) => { await add({ holiday_date: v.holiday_date!, name: v.name!.trim(), branch: v.branch || null }).unwrap(); }} />
    </Card>
  );
}

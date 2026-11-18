import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useListOrgRecordsQuery } from "../../shared/api/endpoints";
import type { OrgRecord } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, PageHeader } from "../../shared/ui/primitives";
import { OrgRecordDialog } from "./OrgRecordDialog";
import { ORG_KINDS, type OrgKindConfig } from "./structure";

function KindTable({ config, canManage }: { config: OrgKindConfig; canManage: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrgRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error, refetch } = useListOrgRecordsQuery({ kind: config.kind, cursor });
  const columns: ColumnDef<OrgRecord>[] = [
    { header: "Code", accessorKey: "code" },
    { header: config.nameField === "title" ? "Title" : "Name", cell: ({ row }) => row.original[config.nameField] ?? "" },
    { header: "Status", cell: ({ row }) => <Badge tone={row.original.is_active ? "green" : "slate"}>{row.original.is_active ? "Active" : "Inactive"}</Badge> },
    ...(canManage ? [{ header: "", id: "edit", cell: ({ row }: { row: { original: OrgRecord } }) => <Button variant="secondary" onClick={() => setEditing(row.original)}>Edit</Button> } as ColumnDef<OrgRecord>] : []),
  ];
  return (
    <>
      {canManage && <div className="mb-3 flex justify-end"><Button onClick={() => setCreating(true)}>{`Add ${config.singular}`}</Button></div>}
      <DataTable caption={config.label} columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch}
        emptyTitle={`No ${config.label.toLowerCase()} yet`} onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      {creating && <OrgRecordDialog config={config} record={null} open onClose={() => setCreating(false)} />}
      {editing && <OrgRecordDialog key={editing.id} config={config} record={editing} open onClose={() => setEditing(null)} />}
    </>
  );
}

/** Departments, teams, positions, business units, cost centers, branches and legal entities in one tabbed screen. */
export function StructurePage() {
  const { can } = useAccess();
  const [kind, setKind] = useState(ORG_KINDS[0]!.kind);
  const config = ORG_KINDS.find((k) => k.kind === kind)!;
  return (
    <>
      <PageHeader title="Organization structure" description="How your company is organised. Records are deactivated, never deleted, so history stays intact." />
      <div role="tablist" aria-label="Structure" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {ORG_KINDS.map((k) => (
          <button key={k.kind} role="tab" aria-selected={k.kind === kind} onClick={() => setKind(k.kind)}
            className={`px-3 py-2 text-sm ${k.kind === kind ? "border-b-2 border-indigo-600 font-medium text-indigo-700" : "text-slate-600 hover:text-slate-900"}`}>{k.label}</button>
        ))}
      </div>
      <KindTable key={kind} config={config} canManage={can("org.structure.manage")} />
    </>
  );
}

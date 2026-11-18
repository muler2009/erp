import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "react-router";

import { useCreateCrmAccountMutation, useListCrmAccountsQuery, useListEmployeesQuery } from "../../shared/api/endpoints";
import type { CrmAccount } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, PageHeader, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { CREDIT, LIFECYCLES, label } from "./options";

export function CrmAccountsPage() {
  const { can } = useAccess();
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const { data, isLoading, error, refetch } = useListCrmAccountsQuery({ cursor, ...(q.trim() ? { q: q.trim() } : {}) });
  const [create] = useCreateCrmAccountMutation();
  const employees = useListEmployeesQuery({ status: "ACTIVE" }, { skip: !open || !can("crm.assign") });
  const owners: [string, string][] = (employees.data?.results ?? []).filter((e) => e.user_id).map((e) => [e.user_id as string, `${e.employee_no} ${e.name}`]);
  const columns: ColumnDef<CrmAccount>[] = [
    { header: "Name", cell: ({ row }) => <Link className="text-indigo-700 hover:underline" to={`/app/crm/accounts/${row.original.id}`}>{row.original.name}</Link> },
    { header: "Industry", accessorKey: "industry" },
    { header: "Segment", accessorKey: "segment" },
    { header: "Lifecycle", cell: ({ row }) => label(LIFECYCLES, row.original.lifecycle_stage) },
    { header: "Credit", cell: ({ row }) => <Badge tone={row.original.credit_status === "OK" ? "green" : "red"}>{label(CREDIT, row.original.credit_status)}</Badge> },
    { header: "Status", cell: ({ row }) => <Badge tone={row.original.is_active ? "green" : "slate"}>{row.original.is_active ? "Active" : "Inactive"}</Badge> },
  ];
  return (
    <>
      <PageHeader title="Customer accounts" description="The companies and people you sell to." actions={can("crm.manage") ? <Button onClick={() => setOpen(true)}>New account</Button> : undefined} />
      <input aria-label="Search accounts" placeholder="Search by name" className={`${inputClass} mb-3 max-w-sm`} value={q} onChange={(e) => { setQ(e.target.value); setCursor(null); }} />
      <DataTable caption="Customer accounts" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No accounts found" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      {open && (
        <ActionDialog title="New account" cta="Create account" open onClose={() => setOpen(false)}
          fields={[{ name: "name", label: "Name", required: true }, { name: "industry", label: "Industry" }, { name: "segment", label: "Segment" }, { name: "website", label: "Website" }, { name: "tax_id", label: "Tax ID" },
            ...(can("crm.assign") ? [{ name: "owner_id", label: "Owner (blank = you)", options: owners, searchUsers: true }] : [])]}
          submit={async (v) => { await create({ name: v.name!.trim(), industry: v.industry ?? "", segment: v.segment ?? "", website: v.website ?? "", tax_id: v.tax_id ?? "", ...(v.owner_id ? { owner_id: v.owner_id } : {}) }).unwrap(); }} />
      )}
    </>
  );
}

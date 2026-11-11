import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "react-router";

import { useListEmployeesQuery } from "../../shared/api/endpoints";
import type { Employee } from "../../shared/api/types";
import { NewEmployeeDialog } from "./EmployeeDialogs";
import { DataTable } from "../../shared/ui/DataTable";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, PageHeader, inputClass } from "../../shared/ui/primitives";

const tone = (s: string) => (s === "ACTIVE" ? "green" : s === "TERMINATED" ? "red" : "amber") as "green" | "red" | "amber";

/** Directory of the employees the server lets this user see: everyone for HR, otherwise themselves and their direct reports. */
export function EmployeesPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListEmployeesQuery({ cursor, status });
  const needle = q.trim().toLowerCase();
  const shown = data && needle ? { ...data, results: data.results.filter((e) => `${e.name} ${e.employee_no} ${e.email}`.toLowerCase().includes(needle)) } : data;
  const columns: ColumnDef<Employee>[] = [
    { header: "No.", cell: ({ row }) => row.original.employee_no },
    { header: "Name", cell: ({ row }) => <Link className="text-indigo-700 underline" to={`/app/hr/employees/${row.original.id}`}>{row.original.name}</Link> },
    { header: "Department", cell: ({ row }) => row.original.department ?? "—" },
    { header: "Position", cell: ({ row }) => row.original.position ?? "—" },
    { header: "Hired", cell: ({ row }) => row.original.hire_date },
    { header: "Status", cell: ({ row }) => <Badge tone={tone(row.original.status)}>{row.original.status.charAt(0) + row.original.status.slice(1).toLowerCase()}</Badge> },
  ];
  return (
    <>
      <PageHeader title="Employees" description="People you are allowed to see." actions={can("hr.employee.manage") ? <Button onClick={() => setCreating(true)}>New employee</Button> : undefined} />
      <div className="mb-3 flex gap-3">
        <input aria-label="Search this page" placeholder="Search this page…" className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="ONBOARDING">Onboarding</option><option value="TERMINATED">Terminated</option></select>
      </div>
      <DataTable caption="Employees" columns={columns} page={shown} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No employees" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <NewEmployeeDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

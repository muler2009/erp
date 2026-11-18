import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "react-router";

import { useListCrmAccountsQuery, useListServiceCasesQuery, useOpenServiceCaseMutation } from "../../shared/api/endpoints";
import type { ServiceCase } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { useAccountNames } from "../../shared/ui/useAccountNames";
import { Badge, Button, PageHeader } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export const CASE_KINDS: [string, string][] = [["COMPLAINT", "Complaint"], ["INQUIRY", "Inquiry"], ["REQUEST", "Request"]];
export const CASE_PRIORITIES: [string, string][] = [["LOW", "Low"], ["MEDIUM", "Medium"], ["HIGH", "High"], ["URGENT", "Urgent"]];
export const CASE_SEVERITIES: [string, string][] = [["MINOR", "Minor"], ["MAJOR", "Major"], ["CRITICAL", "Critical"]];
export const CASE_STATUSES: [string, string][] = [["NEW", "New"], ["OPEN", "Open"], ["PENDING_CUSTOMER", "Waiting for customer"], ["RESOLVED", "Resolved"], ["CLOSED", "Closed"], ["CANCELLED", "Cancelled"]];
export const statusLabel = (s: string) => CASE_STATUSES.find(([k]) => k === s)?.[1] ?? s;
const OPEN = ["NEW", "OPEN", "PENDING_CUSTOMER"];

/** What the service-level clock says about a case right now. */
export function slaText(c: ServiceCase): { text: string; tone: "red" | "green" | "slate" } {
  if (c.sla.resolution_breached) return { text: "Resolution target missed", tone: "red" };
  if (c.sla.response_breached) return { text: "First response late", tone: "red" };
  if (!OPEN.includes(c.status)) return { text: "Met", tone: "green" };
  return { text: "On track", tone: "slate" };
}

export function ServiceCasesPage() {
  const { can } = useAccess();
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [overdue, setOverdue] = useState(false);
  const [open, setOpen] = useState(false);
  const { data, isLoading, error, refetch } = useListServiceCasesQuery({ cursor, status, priority, overdue });
  const accounts = useListCrmAccountsQuery(undefined, { skip: !open });
  const accountName = useAccountNames();
  const [create] = useOpenServiceCaseMutation();
  const reset = (f: () => void) => { f(); setCursor(null); };
  const columns: ColumnDef<ServiceCase>[] = [
    { header: "Number", cell: ({ row }) => <Link className="text-indigo-700 hover:underline" to={`/app/crm/cases/${row.original.id}`}>{row.original.number}</Link> },
    { header: "Subject", accessorKey: "subject" },
    { header: "Customer", cell: ({ row }) => accountName(row.original.account) },
    { header: "Priority", cell: ({ row }) => <Badge tone={row.original.priority === "URGENT" || row.original.priority === "HIGH" ? "red" : "slate"}>{row.original.priority.toLowerCase()}</Badge> },
    { header: "Status", cell: ({ row }) => statusLabel(row.original.status) },
    { header: "Service level", cell: ({ row }) => { const s = slaText(row.original); return <Badge tone={s.tone}>{s.text}</Badge>; } },
    { header: "Escalation", cell: ({ row }) => (row.original.escalation_level ? `Level ${row.original.escalation_level}` : "–") },
  ];
  const sel = (label: string, value: string, set: (v: string) => void, options: [string, string][]) => (
    <label className="text-sm">{label} <select aria-label={label} className="rounded border border-slate-300 px-2 py-1" value={value} onChange={(e) => reset(() => set(e.target.value))}><option value="">All</option>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
  );
  return (
    <>
      <PageHeader title="Service cases" description="Complaints, inquiries and requests from customers, each with a response and resolution deadline." actions={can("crm.manage") ? <Button onClick={() => setOpen(true)}>New case</Button> : undefined} />
      <div className="mb-3 flex flex-wrap items-center gap-4">
        {sel("Status", status, setStatus, CASE_STATUSES)}{sel("Priority", priority, setPriority, CASE_PRIORITIES)}
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={overdue} onChange={(e) => reset(() => setOverdue(e.target.checked))} /> Overdue only</label>
      </div>
      <DataTable caption="Service cases" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No cases found" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      {open && (
        <ActionDialog title="New case" cta="Open case" open onClose={() => setOpen(false)} initial={{ kind: "COMPLAINT", priority: "MEDIUM", severity: "MINOR" }}
          fields={[{ name: "account", label: "Customer account", required: true, options: (accounts.data?.results ?? []).map((a) => [a.id, a.name]) }, { name: "subject", label: "Subject", required: true }, { name: "description", label: "Description", type: "textarea" },
            { name: "kind", label: "Type", options: CASE_KINDS }, { name: "category", label: "Category" }, { name: "priority", label: "Priority", options: CASE_PRIORITIES }, { name: "severity", label: "Severity", options: CASE_SEVERITIES }]}
          submit={async (v) => { await create({ account: v.account, subject: v.subject!.trim(), description: v.description ?? "", kind: v.kind || "COMPLAINT", category: (v.category ?? "").trim(), priority: v.priority || "MEDIUM", severity: v.severity || "MINOR" }).unwrap(); }} />
      )}
    </>
  );
}

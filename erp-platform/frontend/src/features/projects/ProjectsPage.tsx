import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "react-router";

import { useCreateProjectMutation, useListProjectsQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DirectoryUser, Project } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";
import { UserPicker } from "../../shared/ui/UserPicker";

export const statusTone = (s: string) => (s === "ACTIVE" || s === "COMPLETED" ? "green" : s === "CANCELLED" ? "red" : s === "ON_HOLD" ? "amber" : "slate") as "green" | "red" | "amber" | "slate";
export const pretty = (s: string) => (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, " ");

export function validateProject(f: { name: string; start: string; end: string; billing: string; value: string }): string | null {
  if (!f.name.trim()) return "Name the project.";
  if (!f.start || !f.end) return "Enter the planned start and end dates.";
  if (f.end < f.start) return "The project cannot end before it starts.";
  const v = f.value.trim() === "" ? 0n : parseMoney(f.value);
  if (v === null || v < 0n) return "Contract value must be a number of 0 or more.";
  if (f.billing === "NON_BILLABLE" && v > 0n) return "A non-billable project has no contract value.";
  return null;
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, state] = useCreateProjectMutation();
  const [f, setF] = useState({ name: "", start: "", end: "", billing: "FIXED", value: "", description: "" });
  const [manager, setManager] = useState<DirectoryUser | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    const problem = validateProject(f);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      await create({ name: f.name.trim(), start_on: f.start, end_on: f.end, description: f.description.trim(), billing_type: f.billing, contract_value: f.value.trim() || "0", ...(manager ? { manager_id: manager.id } : {}) }).unwrap();
      close();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New project" open={open} onClose={close}>
      <FormField label="Name" htmlFor="pj-name"><input id="pj-name" maxLength={200} className={inputClass} value={f.name} onChange={(e) => set({ name: e.target.value })} /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Planned start" htmlFor="pj-start"><input id="pj-start" type="date" className={inputClass} value={f.start} onChange={(e) => set({ start: e.target.value })} /></FormField>
        <FormField label="Planned end" htmlFor="pj-end"><input id="pj-end" type="date" className={inputClass} value={f.end} onChange={(e) => set({ end: e.target.value })} /></FormField>
        <FormField label="Billing" htmlFor="pj-bill"><select id="pj-bill" className={inputClass} value={f.billing} onChange={(e) => set({ billing: e.target.value })}><option value="FIXED">Fixed price</option><option value="TIME_MATERIAL">Time and material</option><option value="NON_BILLABLE">Non-billable</option></select></FormField>
        <FormField label="Contract value" htmlFor="pj-value"><input id="pj-value" inputMode="decimal" className={`${inputClass} text-right`} value={f.value} onChange={(e) => set({ value: e.target.value })} /></FormField>
      </div>
      <UserPicker label="Project manager (defaults to you)" onChange={setManager} />
      <FormField label="Description (optional)" htmlFor="pj-desc"><input id="pj-desc" className={inputClass} value={f.description} onChange={(e) => set({ description: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Create project</Button></div>
    </Modal>
  );
}

export function ProjectsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListProjectsQuery({ cursor, status, q: q.trim() });
  const columns: ColumnDef<Project>[] = [
    { header: "Code", cell: ({ row }) => <Link className="text-indigo-700 underline" to={`/app/projects/projects/${row.original.id}`}>{row.original.code}</Link> },
    { header: "Name", cell: ({ row }) => row.original.name },
    { header: "Dates", cell: ({ row }) => `${row.original.start_on} to ${row.original.end_on}` },
    { header: "Billing", cell: ({ row }) => pretty(row.original.billing_type) },
    { header: "Value", cell: ({ row }) => formatMoney(row.original.contract_value) },
    { header: "Status", cell: ({ row }) => <Badge tone={statusTone(row.original.status)}>{pretty(row.original.status)}</Badge> },
  ];
  return (
    <>
      <PageHeader title="Projects" description="Projects you are a member of (or all, with wider access)." actions={can("projects.create") ? <Button onClick={() => setCreating(true)}>New project</Button> : undefined} />
      <div className="mb-3 flex gap-3">
        <input aria-label="Search projects" placeholder="Search by name…" className={inputClass} value={q} onChange={(e) => { setQ(e.target.value); setCursor(null); }} />
        <select aria-label="Status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All statuses</option>{["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select>
      </div>
      <DataTable caption="Projects" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No projects" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

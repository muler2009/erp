import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useAssignMemberProfileMutation, useListMemberProfilesQuery, useListOrgOptionsQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { MemberProfile, OrgKind, OrgRecord } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserSelect } from "../../shared/ui/UserSelect";

const SLOTS: { name: "department" | "team" | "position" | "business_unit" | "cost_center"; label: string; kind: OrgKind }[] = [
  { name: "department", label: "Department", kind: "departments" },
  { name: "team", label: "Team", kind: "teams" },
  { name: "position", label: "Position", kind: "positions" },
  { name: "business_unit", label: "Business unit", kind: "business-units" },
  { name: "cost_center", label: "Cost center", kind: "cost-centers" },
];
const label = (r: OrgRecord) => `${r.code} ${r.name ?? r.title ?? ""}`.trim();

function Slot({ slot, value, onChange }: { slot: (typeof SLOTS)[number]; value: string; onChange: (v: string) => void }) {
  const { data = [], isLoading } = useListOrgOptionsQuery(slot.kind);
  return (
    <FormField label={slot.label} htmlFor={`mp-${slot.name}`}>
      <select id={`mp-${slot.name}`} className={inputClass} disabled={isLoading} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">None</option>{data.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
      </select>
    </FormField>
  );
}

function AssignDialog({ member, colleagues, onClose }: { member: MemberProfile; colleagues: MemberProfile[]; onClose: () => void }) {
  const [save, { isLoading }] = useAssignMemberProfileMutation();
  const p = member.profile;
  const [v, setV] = useState<Record<string, string>>({ department: p?.department ?? "", team: p?.team ?? "", position: p?.position ?? "", business_unit: p?.business_unit ?? "", cost_center: p?.cost_center ?? "", manager_user_id: p?.manager_user_id ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    try { await save({ user_id: member.user_id, body: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || null])) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Assign ${member.display_name}`} open onClose={onClose}>
      {SLOTS.map((s) => <Slot key={s.name} slot={s} value={v[s.name] ?? ""} onChange={(x) => setV({ ...v, [s.name]: x })} />)}
      <FormField label="Reports to" htmlFor="mp-manager">
        <UserSelect id="mp-manager" value={v.manager_user_id ?? ""} onChange={(x) => setV({ ...v, manager_user_id: x })} options={colleagues.filter((c) => c.user_id !== member.user_id).map((c) => [c.user_id, c.display_name])} />
      </FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void submit()}>Save assignment</Button></div>
    </Modal>
  );
}

function Name({ kind, id }: { kind: OrgKind; id: string | null | undefined }) {
  const { data } = useListOrgOptionsQuery(kind, { skip: !id });
  if (!id) return <span className="text-slate-400">–</span>;
  const r = data?.find((x) => x.id === id);
  return <>{r ? (r.name ?? r.title) : "…"}</>;
}

export function MembersPage() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListMemberProfilesQuery();
  const [editing, setEditing] = useState<MemberProfile | null>(null);
  const manage = can("org.profiles.manage");
  const columns: ColumnDef<MemberProfile>[] = [
    { header: "Name", accessorKey: "display_name" },
    { header: "Email", accessorKey: "email" },
    { header: "Department", cell: ({ row }) => <Name kind="departments" id={row.original.profile?.department} /> },
    { header: "Position", cell: ({ row }) => <Name kind="positions" id={row.original.profile?.position} /> },
    ...(manage ? [{ header: "", id: "assign", cell: ({ row }: { row: { original: MemberProfile } }) => <Button variant="secondary" onClick={() => setEditing(row.original)}>{`Assign ${row.original.display_name}`}</Button> } as ColumnDef<MemberProfile>] : []),
  ];
  return (
    <>
      <PageHeader title="Member assignments" description="Where each active member sits in the organisation." />
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data || data.length === 0 ? <EmptyState title="No active members" /> : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <caption className="sr-only">Member assignments</caption>
            <thead className="bg-slate-50"><tr>{columns.map((c, i) => <th key={i} className="px-3 py-2 text-left font-medium text-slate-600">{c.header as string}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">{data.map((m) => (
              <tr key={m.user_id}>{columns.map((c, i) => <td key={i} className="px-3 py-2">{typeof c.cell === "function" ? (c.cell as (x: unknown) => React.ReactNode)({ row: { original: m } }) : String((m as unknown as Record<string, unknown>)[(c as { accessorKey: string }).accessorKey] ?? "")}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {editing && <AssignDialog key={editing.user_id} member={editing} colleagues={data ?? []} onClose={() => setEditing(null)} />}
    </>
  );
}

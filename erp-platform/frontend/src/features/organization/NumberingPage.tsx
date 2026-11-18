import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useCreateSequenceMutation, useGetSequenceQuery, useListSequencesQuery, useUpdateSequenceMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { NumberSequence } from "../../shared/api/types";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

const RESET: [string, string][] = [["NEVER", "Never"], ["YEARLY", "Every year"], ["MONTHLY", "Every month"]];
const resetLabel = (r: string) => RESET.find(([k]) => k === r)?.[1] ?? r;

function EditDialog({ seq, onClose }: { seq: NumberSequence; onClose: () => void }) {
  const detail = useGetSequenceQuery(seq.code);
  const [update, { isLoading }] = useUpdateSequenceMutation();
  const [f, setF] = useState({ name: seq.name, template: seq.template, reset_policy: seq.reset_policy, next_value: String(seq.next_value), is_active: seq.is_active });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!f.name.trim() || !f.template.trim()) { setErr("Name and template are required."); return; }
    if (!/^[1-9]\d*$/.test(f.next_value)) { setErr("The next number must be a whole number of at least 1."); return; }
    try { await update({ code: seq.code, body: { ...f, name: f.name.trim(), template: f.template.trim(), next_value: Number(f.next_value) } }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Edit ${seq.code}`} open onClose={onClose}>
      <FormField label="Name" htmlFor="sq-name"><input id="sq-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
      <FormField label="Template" htmlFor="sq-template"><input id="sq-template" className={inputClass} value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })} /></FormField>
      <p className="-mt-2 mb-3 text-xs text-slate-500">Example: PO-{"{yyyy}"}-{"{seq:05d}"}. {detail.data?.preview ? `The next number would look like ${detail.data.preview}.` : ""}</p>
      <FormField label="Restart numbering" htmlFor="sq-reset">
        <select id="sq-reset" className={inputClass} value={f.reset_policy} onChange={(e) => setF({ ...f, reset_policy: e.target.value as NumberSequence["reset_policy"] })}>{RESET.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </FormField>
      <FormField label="Next number" htmlFor="sq-next"><input id="sq-next" inputMode="numeric" className={inputClass} value={f.next_value} onChange={(e) => setF({ ...f, next_value: e.target.value })} /></FormField>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Active</label>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void save()}>Save changes</Button></div>
    </Modal>
  );
}

export function NumberingPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<NumberSequence | null>(null);
  const { data, isLoading, error, refetch } = useListSequencesQuery({ cursor });
  const [create] = useCreateSequenceMutation();
  const columns: ColumnDef<NumberSequence>[] = [
    { header: "Code", accessorKey: "code" },
    { header: "Name", accessorKey: "name" },
    { header: "Template", accessorKey: "template" },
    { header: "Restarts", cell: ({ row }) => resetLabel(row.original.reset_policy) },
    { header: "Next number", accessorKey: "next_value" },
    { header: "Status", cell: ({ row }) => <Badge tone={row.original.is_active ? "green" : "slate"}>{row.original.is_active ? "Active" : "Inactive"}</Badge> },
    { header: "", id: "edit", cell: ({ row }) => <Button variant="secondary" onClick={() => setEditing(row.original)}>{`Edit ${row.original.code}`}</Button> },
  ];
  return (
    <>
      <PageHeader title="Numbering" description="How invoices, orders and other documents are numbered." actions={<Button onClick={() => setCreating(true)}>Add sequence</Button>} />
      <DataTable caption="Numbering sequences" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No sequences yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <ActionDialog title="Add sequence" cta="Create" open={creating} onClose={() => setCreating(false)}
        fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "template", label: "Template", required: true }, { name: "reset_policy", label: "Restart numbering", options: RESET }]}
        submit={async (v) => {
          if (!/^[a-z0-9_-]+$/i.test(v.code!.trim())) throw new Error("The code may only contain letters, digits, - and _.");
          await create({ code: v.code!.trim(), name: v.name!.trim(), template: v.template!.trim(), reset_policy: v.reset_policy || "NEVER" }).unwrap();
        }} />
      {editing && <EditDialog key={editing.code} seq={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

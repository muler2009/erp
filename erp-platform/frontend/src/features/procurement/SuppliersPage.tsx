import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";

import { useCreateSupplierMutation, useListSuppliersQuery, useSupplierActionMutation } from "../../shared/api/endpoints";
import { errorMessage, fieldErrors } from "../../shared/api/errors";
import type { Supplier } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

export const supplierSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  tax_id: z.string().trim().max(40),
  email: z.union([z.literal(""), z.string().trim().email("Enter a valid email address")]),
});
type SupplierForm = z.infer<typeof supplierSchema>;

const tone = (s: string) => (s === "QUALIFIED" ? "green" : s === "BLOCKED" ? "red" : "amber");
const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ");

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, state] = useCreateSupplierMutation();
  const { register, handleSubmit, setError, reset, formState } = useForm<SupplierForm>({ resolver: zodResolver(supplierSchema), defaultValues: { name: "", tax_id: "", email: "" } });
  const close = () => { reset(); onClose(); };
  const submit = handleSubmit(async (body) => {
    try { await create(body).unwrap(); close(); } catch (e) {
      const fe = fieldErrors(e);
      const known = Object.keys(fe).filter((k) => k in body);
      known.forEach((k) => setError(k as keyof SupplierForm, { message: fe[k] }));
      if (known.length === 0) setError("root", { message: errorMessage(e) });
    }
  });
  return (
    <Modal title="New supplier" open={open} onClose={close}>
      <form onSubmit={submit} noValidate>
        <FormField label="Name" htmlFor="sup-name" error={formState.errors.name?.message}><input id="sup-name" className={inputClass} {...register("name")} /></FormField>
        <FormField label="Tax ID" htmlFor="sup-tax" error={formState.errors.tax_id?.message}><input id="sup-tax" className={inputClass} {...register("tax_id")} /></FormField>
        <FormField label="Email" htmlFor="sup-email" error={formState.errors.email?.message}><input id="sup-email" type="email" className={inputClass} {...register("email")} /></FormField>
        {formState.errors.root && <p role="alert" className="mb-3 text-sm text-red-700">{formState.errors.root.message}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={state.isLoading}>Create supplier</Button></div>
      </form>
    </Modal>
  );
}

/** Qualify / block need a note or reason, so they open a small confirmation dialog. */
function ActionDialog({ target, onClose }: { target: { supplier: Supplier; action: "qualify" | "block" } | null; onClose: () => void }) {
  const [act, state] = useSupplierActionMutation();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const close = () => { setText(""); setErr(null); onClose(); };
  const go = async () => {
    if (target!.action === "block" && text.trim() === "") { setErr("A reason is required to block a supplier."); return; }
    try { await act({ id: target!.supplier.id, action: target!.action, text: text.trim() }).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  const block = target?.action === "block";
  return (
    <Modal title={target ? `${block ? "Block" : "Qualify"} ${target.supplier.name}` : ""} open={!!target} onClose={close}>
      <FormField label={block ? "Reason" : "Notes (optional)"} htmlFor="sup-action-text">
        <textarea id="sup-action-text" rows={3} className={inputClass} value={text} onChange={(e) => setText(e.target.value)} />
      </FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button variant={block ? "danger" : "primary"} loading={state.isLoading} onClick={() => void go()}>{block ? "Block supplier" : "Qualify supplier"}</Button></div>
    </Modal>
  );
}

export function SuppliersPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useListSuppliersQuery({ cursor, status });
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<{ supplier: Supplier; action: "qualify" | "block" } | null>(null);
  const { can } = useAccess();
  const manage = can("procurement.supplier.manage");
  const columns = useMemo<ColumnDef<Supplier>[]>(() => {
    const cols: ColumnDef<Supplier>[] = [
      { header: "Name", cell: ({ row }) => <Link className="text-blue-700 underline" to={`/app/procurement/suppliers/${row.original.id}`}>{row.original.name}</Link> },
      { header: "Tax ID", accessorKey: "tax_id" },
      { header: "Email", accessorKey: "email" },
      { header: "Status", cell: ({ row }) => <Badge tone={tone(row.original.status)}>{pretty(row.original.status)}</Badge> },
    ];
    if (manage) cols.push({
      id: "actions", header: "Actions",
      cell: ({ row }) => (
        <div className="flex gap-1">
          {row.original.status !== "QUALIFIED" && row.original.status !== "BLOCKED" && <Button variant="secondary" aria-label={`Qualify ${row.original.name}`} onClick={() => setTarget({ supplier: row.original, action: "qualify" })}>Qualify</Button>}
          {row.original.status !== "BLOCKED" && <Button variant="secondary" aria-label={`Block ${row.original.name}`} onClick={() => setTarget({ supplier: row.original, action: "block" })}>Block</Button>}
        </div>
      ),
    });
    return cols;
  }, [manage]);
  return (
    <>
      <PageHeader title="Suppliers" actions={manage ? <Button onClick={() => setCreating(true)}>New supplier</Button> : undefined} />
      <label className="mb-3 flex items-center gap-2 text-sm">Status
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}>
          <option value="">All</option>{["PROSPECT", "QUALIFIED", "BLOCKED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
        </select>
      </label>
      <DataTable caption="Suppliers" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No suppliers" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
      <ActionDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}

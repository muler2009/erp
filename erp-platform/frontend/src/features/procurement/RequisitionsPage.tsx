import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { useCreateRequisitionMutation, useGetRequisitionQuery, useListRequisitionsQuery, useRequisitionActionMutation } from "../../shared/api/endpoints";
import { errorMessage, fieldErrors } from "../../shared/api/errors";
import type { Requisition } from "../../shared/api/types";
import { formatMoney, multiplyMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ");
export const reqTone = (s: string) => (s === "APPROVED" || s === "CONVERTED" ? "green" : s === "CANCELLED" ? "red" : s === "DRAFT" ? "slate" : "amber");

const money = (what: string, allowZero: boolean) =>
  z.string().trim().refine((v) => { const n = parseMoney(v); return n !== null && (allowZero ? n >= 0n : n > 0n); }, `${what} must be ${allowZero ? "0 or more" : "more than 0"}, up to 4 decimals`);

export const requisitionSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  needed_by: z.string(),
  lines: z.array(z.object({ description: z.string().trim().min(1, "Describe the item").max(300), quantity: money("Quantity", false), estimated_unit_price: money("Price", true) })).min(1, "Add at least one line"),
});
type ReqForm = z.infer<typeof requisitionSchema>;

function NewRequisition({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, state] = useCreateRequisitionMutation();
  const blank = { description: "", quantity: "1", estimated_unit_price: "0" };
  const { register, control, handleSubmit, setError, reset, formState } = useForm<ReqForm>({ resolver: zodResolver(requisitionSchema), defaultValues: { title: "", needed_by: "", lines: [blank] } });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const lines = useWatch({ control, name: "lines" });
  const total = lines.reduce((acc, l) => acc + multiplyMoney(l.quantity, l.estimated_unit_price), 0n);
  const close = () => { reset(); onClose(); };
  const submit = handleSubmit(async (v) => {
    try { await create({ title: v.title, needed_by: v.needed_by || null, lines: v.lines }).unwrap(); close(); } catch (e) {
      const fe = fieldErrors(e);
      setError("root", { message: Object.values(fe)[0] ?? errorMessage(e) });
    }
  });
  return (
    <Modal title="New purchase requisition" open={open} onClose={close}>
      <form onSubmit={submit} noValidate className="max-h-[75vh] overflow-y-auto">
        <FormField label="Title" htmlFor="rq-title" error={formState.errors.title?.message}><input id="rq-title" className={inputClass} {...register("title")} /></FormField>
        <FormField label="Needed by" htmlFor="rq-needed"><input id="rq-needed" type="date" className={inputClass} {...register("needed_by")} /></FormField>
        <table className="mb-2 w-full text-sm">
          <thead><tr><th className="text-left">Item</th><th className="text-right">Qty</th><th className="text-right">Est. price</th><th /></tr></thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={f.id}>
                <td><input aria-label={`Line ${i + 1} item`} className={inputClass} {...register(`lines.${i}.description`)} /></td>
                <td><input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className={`${inputClass} text-right`} {...register(`lines.${i}.quantity`)} /></td>
                <td><input aria-label={`Line ${i + 1} price`} inputMode="decimal" className={`${inputClass} text-right`} {...register(`lines.${i}.estimated_unit_price`)} /></td>
                <td>{fields.length > 1 && <Button variant="secondary" aria-label={`Remove line ${i + 1}`} onClick={() => remove(i)}>×</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {formState.errors.lines?.map?.((le, i) => le && <p key={i} role="alert" className="text-xs text-red-700">Line {i + 1}: {le.description?.message ?? le.quantity?.message ?? le.estimated_unit_price?.message}</p>)}
        <div className="mb-3 flex items-center justify-between text-sm"><Button variant="secondary" onClick={() => append(blank)}>Add line</Button><span className="font-medium">Estimated total {formatMoney(total)}</span></div>
        {formState.errors.root && <p role="alert" className="mb-3 text-sm text-red-700">{formState.errors.root.message}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={state.isLoading}>Save draft</Button></div>
      </form>
    </Modal>
  );
}

function Detail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isFetching, error } = useGetRequisitionQuery(id ?? "", { skip: !id });
  const [act, state] = useRequisitionActionMutation();
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const run = async (action: "submit" | "approve" | "cancel") => { setErr(null); try { await act({ id: id!, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const create = can("procurement.requisition.create");
  return (
    <Modal title={data ? `Requisition ${data.number}` : "Requisition"} open={!!id} onClose={onClose}>
      {isFetching && !data && <Spinner />}
      {error && <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>}
      {data && (
        <>
          <p className="mb-2 text-sm text-slate-600">{data.title} · <Badge tone={reqTone(data.status)}>{pretty(data.status)}</Badge></p>
          <table className="w-full text-sm">
            <thead><tr><th className="text-left">Item</th><th className="text-right">Qty</th><th className="text-right">Est. price</th></tr></thead>
            <tbody>{data.lines?.map((l) => <tr key={l.id} className="border-t border-slate-100"><td>{l.description}</td><td className="text-right">{formatMoney(l.quantity)}</td><td className="text-right">{formatMoney(l.estimated_unit_price)}</td></tr>)}</tbody>
          </table>
          <p className="mt-3 text-right text-sm font-semibold">Estimated total {formatMoney(data.estimated_total)}</p>
          {data.workflow_instance_id && data.status === "SUBMITTED" && <p className="mt-2 text-sm text-slate-600">Waiting in the approvals workflow.</p>}
          {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {data.status === "DRAFT" && create && <Button loading={state.isLoading} onClick={() => void run("submit")}>Submit for approval</Button>}
            {data.status === "SUBMITTED" && can("procurement.requisition.approve") && <Button loading={state.isLoading} onClick={() => void run("approve")}>Approve</Button>}
            {(data.status === "DRAFT" || data.status === "SUBMITTED") && create && <Button variant="danger" loading={state.isLoading} onClick={() => void run("cancel")}>Cancel requisition</Button>}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function RequisitionsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListRequisitionsQuery({ cursor });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { can } = useAccess();
  const columns = useMemo<ColumnDef<Requisition>[]>(() => [
    { header: "Number", cell: ({ row }) => <button type="button" className="text-brand-700 underline" onClick={() => setOpenId(row.original.id)}>{row.original.number}</button> },
    { header: "Title", accessorKey: "title" },
    { header: "Needed by", cell: ({ row }) => row.original.needed_by ?? "—" },
    { header: "Estimate", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.estimated_total)}</span> },
    { header: "Status", cell: ({ row }) => <Badge tone={reqTone(row.original.status)}>{pretty(row.original.status)}</Badge> },
  ], []);
  return (
    <>
      <PageHeader title="Purchase requisitions" actions={can("procurement.requisition.create") ? <Button onClick={() => setCreating(true)}>New requisition</Button> : undefined} />
      <DataTable caption="Purchase requisitions" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No requisitions" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <NewRequisition open={creating} onClose={() => setCreating(false)} />
      <Detail id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

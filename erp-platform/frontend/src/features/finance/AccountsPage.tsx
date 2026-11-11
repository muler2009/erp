import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useCreateAccountMutation, useListAccountsQuery } from "../../shared/api/endpoints";
import { errorMessage, fieldErrors } from "../../shared/api/errors";
import type { Account } from "../../shared/api/types";
import { Can } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

const TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;
export const accountSchema = z.object({
  code: z.string().trim().min(1, "Code is required").max(20),
  name: z.string().trim().min(1, "Name is required").max(200),
  type: z.enum(TYPES),
  is_postable: z.boolean(),
});
type AccountForm = z.infer<typeof accountSchema>;

const columns: ColumnDef<Account>[] = [
  { header: "Code", accessorKey: "code" },
  { header: "Name", accessorKey: "name" },
  { header: "Type", accessorKey: "type" },
  { header: "Posting", cell: ({ row }) => (row.original.is_postable ? "Postable" : "Header") },
  { header: "Status", cell: ({ row }) => <Badge tone={row.original.is_active ? "green" : "slate"}>{row.original.is_active ? "Active" : "Inactive"}</Badge> },
];

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, state] = useCreateAccountMutation();
  const { register, handleSubmit, setError, reset, formState } = useForm<AccountForm>({
    resolver: zodResolver(accountSchema),
    defaultValues: { code: "", name: "", type: "ASSET", is_postable: true },
  });
  const close = () => { reset(); onClose(); };
  const submit = handleSubmit(async (body) => {
    try {
      await create(body).unwrap();
      close();
    } catch (e) {
      const fe = fieldErrors(e);
      const known = Object.keys(fe).filter((k) => k in body);
      known.forEach((k) => setError(k as keyof AccountForm, { message: fe[k] }));
      if (known.length === 0) setError("root", { message: errorMessage(e) });
    }
  });
  return (
    <Modal title="New account" open={open} onClose={close}>
      <form onSubmit={submit} noValidate>
        <FormField label="Code" htmlFor="acc-code" error={formState.errors.code?.message}>
          <input id="acc-code" className={inputClass} {...register("code")} />
        </FormField>
        <FormField label="Name" htmlFor="acc-name" error={formState.errors.name?.message}>
          <input id="acc-name" className={inputClass} {...register("name")} />
        </FormField>
        <FormField label="Type" htmlFor="acc-type" error={formState.errors.type?.message}>
          <select id="acc-type" className={inputClass} {...register("type")}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </FormField>
        <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" {...register("is_postable")} /> Journal lines can be posted to this account</label>
        {formState.errors.root && <p role="alert" className="mb-3 text-sm text-red-700">{formState.errors.root.message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" loading={state.isLoading}>Create account</Button>
        </div>
      </form>
    </Modal>
  );
}

export function AccountsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListAccountsQuery({ cursor });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Chart of accounts" actions={<Can permission="finance.accounts.manage"><Button onClick={() => setCreating(true)}>New account</Button></Can>} />
      <DataTable caption="Chart of accounts" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No accounts yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

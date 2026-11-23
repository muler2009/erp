import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useCreateTenantMutation, useListTenantsQuery, useResendAdminSetupMutation, useRetryProvisioningMutation, useTenantLifecycleMutation } from "../../shared/api/endpoints";
import { errorMessage, fieldErrors } from "../../shared/api/errors";
import type { PlatformTenant } from "../../shared/api/types";
import { formatDateTime } from "../../shared/lib/format";
import { Can, useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

export const tenantSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  slug: z.string().trim().regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/, "Use 3–40 lowercase letters, digits or hyphens, starting with a letter"),
  plan: z.string().trim().min(1, "Plan is required"),
  admin_email: z.string().trim().email("Enter a valid email address"),
  admin_display_name: z.string().trim().min(1, "Administrator name is required").max(200),
});
type TenantForm = z.infer<typeof tenantSchema>;

const tone = (s: string) => (s === "ACTIVE" ? "green" : s === "SUSPENDED" || s === "PROVISIONING" ? "amber" : s.includes("FAILED") ? "red" : "slate");

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, state] = useCreateTenantMutation();
  // One key per opened dialog: a double click or a retry after a timeout cannot create two tenants.
  const key = useRef(crypto.randomUUID());
  const { register, handleSubmit, setError, reset, formState } = useForm<TenantForm>({
    resolver: zodResolver(tenantSchema),
    defaultValues: { name: "", slug: "", plan: "standard", admin_email: "", admin_display_name: "" },
  });
  const close = () => { reset(); key.current = crypto.randomUUID(); onClose(); };
  const submit = handleSubmit(async (body) => {
    try {
      await create({ body, idempotencyKey: key.current }).unwrap();
      close();
    } catch (e) {
      const fe = fieldErrors(e);
      const known = Object.keys(fe).filter((k) => k in body);
      known.forEach((k) => setError(k as keyof TenantForm, { message: fe[k] }));
      if (known.length === 0) setError("root", { message: errorMessage(e) });
    }
  });
  const f = (name: keyof TenantForm, label: string, type = "text") => (
    <FormField label={label} htmlFor={`t-${name}`} error={formState.errors[name]?.message}>
      <input id={`t-${name}`} type={type} className={inputClass} aria-invalid={!!formState.errors[name]} {...register(name)} />
    </FormField>
  );
  return (
    <Modal title="Create tenant" open={open} onClose={close}>
      <form onSubmit={submit} noValidate>
        {f("name", "Company name")}
        {f("slug", "Short name (used in the address)")}
        {f("plan", "Plan")}
        {f("admin_display_name", "Administrator name")}
        {f("admin_email", "Administrator email", "email")}
        {formState.errors.root && <p role="alert" className="mb-3 text-sm text-red-700">{formState.errors.root.message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" loading={state.isLoading}>Create tenant</Button>
        </div>
      </form>
    </Modal>
  );
}

export function TenantsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListTenantsQuery({ cursor });
  const [lifecycle] = useTenantLifecycleMutation();
  const [retry] = useRetryProvisioningMutation();
  const [resend] = useResendAdminSetupMutation();
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { can } = useAccess();

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null); setNotice(null);
    try { await fn(); } catch (e) { setActionError(errorMessage(e)); }
  };

  const columns = useMemo<ColumnDef<PlatformTenant>[]>(() => {
    const cols: ColumnDef<PlatformTenant>[] = [
      { header: "Name", accessorKey: "name" },
      { header: "Short name", accessorKey: "slug" },
      { header: "Plan", cell: ({ row }) => row.original.plan ?? "—" },
      { header: "Status", cell: ({ row }) => <Badge tone={tone(row.original.status)}>{row.original.status.replace(/_/g, " ")}</Badge> },
      { header: "Created", cell: ({ row }) => formatDateTime(row.original.created_at) },
    ];
    if (can("platform.tenants.lifecycle") || can("platform.tenants.provision")) {
      cols.push({
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const t = row.original;
          const act = (action: "suspend" | "reactivate" | "deactivate", label: string) => (
            <Button variant="secondary" aria-label={`${label} ${t.name}`} onClick={() => void run(() => lifecycle({ id: t.id, action }).unwrap())}>{label}</Button>
          );
          const lifecycleOk = can("platform.tenants.lifecycle");
          return (
            <div className="flex flex-wrap gap-1">
              {t.status === "ACTIVE" && can("platform.tenants.provision") && (
                <Button variant="secondary" aria-label={`Resend setup email ${t.name}`} onClick={() => void run(async () => { await resend(t.id).unwrap(); setNotice(`Setup email sent again to the administrator of ${t.name}.`); })}>Resend setup email</Button>
              )}
              {lifecycleOk && t.status === "ACTIVE" && <>{act("suspend", "Suspend")}{act("deactivate", "Deactivate")}</>}
              {lifecycleOk && t.status === "SUSPENDED" && <>{act("reactivate", "Reactivate")}{act("deactivate", "Deactivate")}</>}
              {lifecycleOk && t.status === "DEACTIVATED" && act("reactivate", "Reactivate")}
              {can("platform.tenants.provision") && (t.status === "PROVISIONING_FAILED" || t.status === "PROVISIONING") && (
                <Button variant="secondary" aria-label={`Retry provisioning ${t.name}`} onClick={() => void run(() => retry(t.id).unwrap())}>Retry provisioning</Button>
              )}
            </div>
          );
        },
      });
    }
    return cols;
  }, [can, lifecycle, retry, resend]);

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Customer workspaces on this platform."
        actions={<Can permission="platform.tenants.create"><Button onClick={() => setCreating(true)}>Create tenant</Button></Can>}
      />
      {notice && <p role="status" className="mb-3 rounded-md bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
      {actionError && <p role="alert" className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-800">{actionError}</p>}
      <DataTable
        caption="Tenants" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch}
        emptyTitle="No tenants yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)}
      />
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

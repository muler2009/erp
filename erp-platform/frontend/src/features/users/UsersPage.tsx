import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  useDeactivateUserMutation,
  useInviteUserMutation,
  useListRolesQuery,
  useListUsersQuery,
  useReactivateUserMutation,
} from "../../shared/api/endpoints";
import { errorMessage, fieldErrors } from "../../shared/api/errors";
import type { Membership } from "../../shared/api/types";
import { formatDateTime } from "../../shared/lib/format";
import { Can, useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";
import { RolesDialog } from "./RoleAssign";
import { DataTable } from "../../shared/ui/DataTable";

export const inviteSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  display_name: z.string().trim().min(1, "Name is required").max(150),
  role_ids: z.array(z.string()).min(1, "Choose at least one role"),
});
type InviteForm = z.infer<typeof inviteSchema>;

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const roles = useListRolesQuery(undefined, { skip: !open });
  const [invite, state] = useInviteUserMutation();
  const form = useForm<InviteForm>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "", display_name: "", role_ids: [] } });
  const { register, handleSubmit, setError, reset, formState } = form;

  const submit = handleSubmit(async (values) => {
    try {
      await invite(values).unwrap();
      reset();
      onClose();
    } catch (e) {
      const fe = fieldErrors(e);
      const known = Object.keys(fe).filter((k) => k in values);
      known.forEach((k) => setError(k as keyof InviteForm, { message: fe[k] }));
      if (known.length === 0) setError("root", { message: errorMessage(e) });
    }
  });

  return (
    <Modal title="Invite user" open={open} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <FormField label="Email" htmlFor="invite-email" error={formState.errors.email?.message}>
          <input id="invite-email" type="email" className={inputClass} aria-invalid={!!formState.errors.email} {...register("email")} />
        </FormField>
        <FormField label="Display name" htmlFor="invite-name" error={formState.errors.display_name?.message}>
          <input id="invite-name" className={inputClass} aria-invalid={!!formState.errors.display_name} {...register("display_name")} />
        </FormField>
        <fieldset className="mb-4">
          <legend className="mb-1 text-sm font-medium text-slate-700">Roles</legend>
          {roles.isLoading && <p className="text-sm text-slate-500">Loading roles…</p>}
          {roles.data?.map((r) => (
            <label key={r.id} className="flex items-center gap-2 py-0.5 text-sm">
              <input type="checkbox" value={r.id} {...register("role_ids")} /> {r.display_name || r.name}
            </label>
          ))}
          {formState.errors.role_ids && (
            <p role="alert" className="mt-1 text-xs text-red-700">
              {formState.errors.role_ids.message}
            </p>
          )}
        </fieldset>
        {formState.errors.root && (
          <p role="alert" className="mb-3 text-sm text-red-700">
            {formState.errors.root.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={state.isLoading}>
            Send invitation
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function UsersPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, isFetching, error, refetch } = useListUsersQuery({ cursor });
  const [deactivate] = useDeactivateUserMutation();
  const [reactivate] = useReactivateUserMutation();
  const [inviting, setInviting] = useState(false);
  const [rolesFor, setRolesFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { can } = useAccess();

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const columns = useMemo<ColumnDef<Membership>[]>(
    () => [
      { header: "Name", accessorKey: "display_name" },
      { header: "Email", accessorKey: "email" },
      { header: "Roles", cell: ({ row }) => row.original.roles.map((r) => r.role).join(", ") || "—" },
      {
        header: "Status",
        cell: ({ row }) => <Badge tone={row.original.status === "ACTIVE" ? "green" : "slate"}>{row.original.status}</Badge>,
      },
      { header: "Added", cell: ({ row }) => formatDateTime(row.original.created_at) },
      ...(can("roles.assign")
        ? [{ id: "roles", header: "Roles", cell: ({ row }: { row: { original: Membership } }) => <Button variant="secondary" aria-label={`Manage roles for ${row.original.display_name || row.original.email}`} onClick={() => setRolesFor(row.original.id)}>Manage roles</Button> } satisfies ColumnDef<Membership>]
        : []),
      ...(can("users.deactivate")
        ? [
            {
              id: "actions",
              header: "Actions",
              cell: ({ row }: { row: { original: Membership } }) =>
                row.original.status === "ACTIVE" ? (
                  <Button variant="secondary" onClick={() => void run(() => deactivate(row.original.id).unwrap())}>
                    Deactivate
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => void run(() => reactivate(row.original.id).unwrap())}>
                    Reactivate
                  </Button>
                ),
            } satisfies ColumnDef<Membership>,
          ]
        : []),
    ],
    [can, deactivate, reactivate],
  );

  return (
    <>
      <PageHeader
        title="Users"
        description="People who can sign in to this workspace."
        actions={
          <Can permission="users.create">
            <Button onClick={() => setInviting(true)}>Invite user</Button>
          </Can>
        }
      />
      {actionError && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {actionError}
        </p>
      )}
      <DataTable
        caption="Users"
        columns={columns}
        page={data}
        isLoading={isLoading || (isFetching && !data)}
        error={error}
        onRetry={refetch}
        emptyTitle="No users yet"
        onCursor={setCursor}
        hasPrevious={cursor !== null}
        onFirst={() => setCursor(null)}
      />
      {rolesFor && data?.results.find((m) => m.id === rolesFor) && <RolesDialog member={data.results.find((m) => m.id === rolesFor)!} onClose={() => setRolesFor(null)} />}
      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
    </>
  );
}

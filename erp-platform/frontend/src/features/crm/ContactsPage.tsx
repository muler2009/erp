import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "react-router";

import { useListCrmAccountsQuery, useListCrmContactsQuery, useSetCrmContactConsentMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { CrmContact } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, PageHeader, inputClass } from "../../shared/ui/primitives";
import { ContactDialog } from "./ContactDialog";
import { CONTACT_ROLES, label } from "./options";

export function consentSummary(c: CrmContact["consent"]): string {
  if (c.opted_out) return "Opted out";
  const on = [c.email && "email", c.phone && "phone", c.sms && "SMS"].filter(Boolean);
  return on.length ? on.join(", ") : "No consent recorded";
}

export function ContactsTable({ account, canManage }: { account?: string; canManage: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<CrmContact | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const accounts = useListCrmAccountsQuery(undefined, { skip: !!account });
  const { data, isLoading, error, refetch } = useListCrmContactsQuery({ cursor, ...(account ? { account } : {}), ...(q.trim() ? { q: q.trim() } : {}) });
  const [consent] = useSetCrmContactConsentMutation();
  const nameOf = (id: string | null) => (id ? (accounts.data?.results.find((a) => a.id === id)?.name ?? "Account") : "–");
  const toggle = (c: CrmContact, body: Record<string, unknown>) => { setErr(null); consent({ id: c.id, body }).unwrap().catch((e) => setErr(errorMessage(e))); };
  const columns: ColumnDef<CrmContact>[] = [
    { header: "Name", cell: ({ row }) => `${row.original.first_name} ${row.original.last_name}`.trim() },
    { header: "Job title", accessorKey: "job_title" },
    { header: "Email", accessorKey: "email" },
    { header: "Phone", accessorKey: "phone" },
    { header: "Role", cell: ({ row }) => label(CONTACT_ROLES, row.original.role) || "–" },
    ...(account ? [] : [{ header: "Account", cell: ({ row }: { row: { original: CrmContact } }) => row.original.account ? <Link className="text-indigo-700 hover:underline" to={`/app/crm/accounts/${row.original.account}`}>{nameOf(row.original.account)}</Link> : "–" } as ColumnDef<CrmContact>]),
    { header: "Consent", cell: ({ row }) => <Badge tone={row.original.consent.opted_out ? "red" : "slate"}>{consentSummary(row.original.consent)}</Badge> },
    ...(canManage ? [{ header: "", id: "actions", cell: ({ row }: { row: { original: CrmContact } }) => {
      const c = row.original;
      const name = `${c.first_name} ${c.last_name}`.trim();
      return (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setEditing(c)}>{`Edit ${name}`}</Button>
          {c.consent.opted_out
            ? <Button variant="secondary" onClick={() => toggle(c, { opt_out: false })}>{`Resume contact with ${name}`}</Button>
            : <><Button variant="secondary" onClick={() => toggle(c, { email: !c.consent.email })}>{c.consent.email ? `Withdraw email consent for ${name}` : `Record email consent for ${name}`}</Button>
              <Button variant="secondary" onClick={() => toggle(c, { opt_out: true })}>{`Opt out ${name}`}</Button></>}
        </div>
      );
    } } as ColumnDef<CrmContact>] : []),
  ];
  return (
    <>
      <input aria-label="Search contacts" placeholder="Search by name or email" className={`${inputClass} mb-3 max-w-sm`} value={q} onChange={(e) => { setQ(e.target.value); setCursor(null); }} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <DataTable caption="Contacts" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No contacts found" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      {editing && <ContactDialog key={editing.id} contact={editing} accounts={account ? undefined : (accounts.data?.results ?? []).map((a) => [a.id, a.name])} onClose={() => setEditing(null)} />}
    </>
  );
}

export function ContactsPage() {
  const { can } = useAccess();
  const [open, setOpen] = useState(false);
  const accounts = useListCrmAccountsQuery();
  return (
    <>
      <PageHeader title="Contacts" description="People at your customers. Consent is recorded per channel; an opt-out stops all contact." actions={can("crm.manage") ? <Button onClick={() => setOpen(true)}>New contact</Button> : undefined} />
      <ContactsTable canManage={can("crm.manage")} />
      {open && <ContactDialog contact={null} accounts={(accounts.data?.results ?? []).map((a) => [a.id, a.name])} onClose={() => setOpen(false)} />}
    </>
  );
}

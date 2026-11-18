import { useState } from "react";
import { Link, useParams } from "react-router";

import { useAddCrmAddressMutation, useAssignCrmAccountByTerritoryMutation, useAssignCrmOwnerMutation, useDeleteCrmAddressMutation, useGetCrmAccountQuery, useGetCrmTimelineQuery, useListCrmAddressesQuery, useSetCrmAccountCreditMutation, useUpdateCrmAccountMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { CrmAccount } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames, useUserOptions } from "../quality/names";
import { ContactDialog } from "./ContactDialog";
import { ContactsTable } from "./ContactsPage";
import { CHANNELS, CREDIT, CUSTOMER_TYPES, LIFECYCLES, label } from "./options";

const KINDS: [string, string][] = [["BILLING", "Billing"], ["DELIVERY", "Delivery"], ["BRANCH", "Branch"]];

function Fact({ k, v }: { k: string; v: string | undefined | null }) {
  return <div><dt className="text-xs text-slate-500">{k}</dt><dd className="text-sm">{v || "–"}</dd></div>;
}

function ProfileCard({ a, canEdit }: { a: CrmAccount; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [update] = useUpdateCrmAccountMutation();
  return (
    <Card title="Profile" actions={canEdit ? <Button variant="secondary" onClick={() => setOpen(true)}>Edit profile</Button> : undefined}>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Fact k="Industry" v={a.industry} /><Fact k="Segment" v={a.segment} /><Fact k="Classification" v={a.classification} /><Fact k="Customer type" v={label(CUSTOMER_TYPES, a.customer_type)} />
        <Fact k="Lifecycle" v={label(LIFECYCLES, a.lifecycle_stage)} /><Fact k="Website" v={a.website} /><Fact k="Tax ID" v={a.tax_id} /><Fact k="Preferred channel" v={label(CHANNELS, a.preferred_channel)} />
      </dl>
      {open && (
        <ActionDialog title="Edit profile" cta="Save profile" open onClose={() => setOpen(false)}
          initial={{ name: a.name, industry: a.industry, segment: a.segment, classification: a.classification ?? "", customer_type: a.customer_type ?? "", lifecycle_stage: a.lifecycle_stage, website: a.website ?? "", tax_id: a.tax_id ?? "", preferred_channel: a.preferred_channel ?? "", language: a.language ?? "", is_active: a.is_active ? "yes" : "no" }}
          fields={[{ name: "name", label: "Name", required: true }, { name: "industry", label: "Industry" }, { name: "segment", label: "Segment" }, { name: "classification", label: "Classification" },
            { name: "customer_type", label: "Customer type", options: CUSTOMER_TYPES }, { name: "lifecycle_stage", label: "Lifecycle", options: LIFECYCLES }, { name: "website", label: "Website" }, { name: "tax_id", label: "Tax ID" },
            { name: "preferred_channel", label: "Preferred channel", options: CHANNELS }, { name: "language", label: "Language" }, { name: "is_active", label: "Active", options: [["yes", "Yes"], ["no", "No (archived)"]] }]}
          submit={async (v) => { const { is_active, ...rest } = v; await update({ id: a.id, body: { ...rest, name: rest.name!.trim(), is_active: is_active !== "no" } }).unwrap(); }} />
      )}
    </Card>
  );
}

function CreditCard({ a, canEdit }: { a: CrmAccount; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [save] = useSetCrmAccountCreditMutation();
  return (
    <Card title="Credit" actions={canEdit ? <Button variant="secondary" onClick={() => setOpen(true)}>Change credit terms</Button> : undefined}>
      <p className="text-sm"><Badge tone={a.credit_status === "OK" ? "green" : "red"}>{label(CREDIT, a.credit_status)}</Badge> <span className="ml-2">Limit: {a.credit_limit ?? "not set"}</span></p>
      {a.restriction_note && <p className="mt-2 text-sm text-slate-600">Reason: {a.restriction_note}</p>}
      {open && (
        <ActionDialog title="Change credit terms" cta="Save credit terms" open onClose={() => setOpen(false)}
          initial={{ credit_status: a.credit_status, credit_limit: a.credit_limit ?? "", note: "" }}
          fields={[{ name: "credit_status", label: "Status", options: CREDIT, required: true }, { name: "credit_limit", label: "Credit limit" }, { name: "note", label: "Reason (needed unless status is OK)" }]}
          submit={async (v) => {
            const limit = (v.credit_limit ?? "").trim();
            if (limit && !/^\d+(\.\d{1,2})?$/.test(limit)) throw new Error("The credit limit must be a positive amount with at most 2 decimals.");
            if (v.credit_status !== "OK" && !(v.note ?? "").trim()) throw new Error("Give a reason when putting an account on hold or blocking it.");
            await save({ id: a.id, body: { credit_status: v.credit_status, note: (v.note ?? "").trim(), ...(limit ? { credit_limit: limit } : {}) } }).unwrap();
          }} />
      )}
    </Card>
  );
}

function AddressCard({ id, canEdit }: { id: string; canEdit: boolean }) {
  const { data, isLoading, error, refetch } = useListCrmAddressesQuery(id);
  const [add] = useAddCrmAddressMutation();
  const [del] = useDeleteCrmAddressMutation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Addresses" actions={canEdit ? <Button variant="secondary" onClick={() => setOpen(true)}>Add address</Button> : undefined}>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No addresses yet" /> : (
        <ul className="divide-y divide-slate-100 text-sm">{data.map((ad) => (
          <li key={ad.id} className="flex items-center justify-between py-2">
            <span><Badge tone="slate">{label(KINDS, ad.kind)}</Badge> {[ad.label, ad.line1, ad.city, ad.region, ad.country].filter(Boolean).join(", ")}{ad.is_default ? " (default)" : ""}</span>
            {canEdit && <Button variant="secondary" onClick={() => { setErr(null); del(ad.id).unwrap().catch((e) => setErr(errorMessage(e))); }}>{`Remove ${ad.line1}`}</Button>}
          </li>))}</ul>
      )}
      {open && (
        <ActionDialog title="Add address" cta="Save address" open onClose={() => setOpen(false)}
          fields={[{ name: "kind", label: "Kind", options: KINDS, required: true }, { name: "line1", label: "Address", required: true }, { name: "city", label: "City" }, { name: "region", label: "Region" }, { name: "country", label: "Country" }, { name: "label", label: "Label" }]}
          submit={async (v) => { await add({ id, body: { kind: v.kind, line1: v.line1!.trim(), city: v.city ?? "", region: v.region ?? "", country: v.country ?? "", label: v.label ?? "" } }).unwrap(); }} />
      )}
    </Card>
  );
}

function TimelineCard({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useGetCrmTimelineQuery(id);
  return (
    <Card title="Timeline">
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="Nothing has happened with this customer yet" /> : (
        <ol className="space-y-2 text-sm">{data.map((e, i) => (
          <li key={`${e.ref}-${i}`} className="flex gap-3"><time className="w-40 shrink-0 text-slate-500" dateTime={e.at}>{new Date(e.at).toLocaleString()}</time><Badge tone="slate">{e.kind}</Badge><span>{e.summary}</span></li>))}</ol>
      )}
    </Card>
  );
}

function OwnerCard({ a }: { a: CrmAccount }) {
  const nameOf = useUserNames();
  const [assign] = useAssignCrmOwnerMutation();
  const [byTerritory] = useAssignCrmAccountByTerritoryMutation();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const people = useUserOptions(!open);
  return (
    <Card title="Account owner" actions={<div className="flex gap-2"><Button variant="secondary" onClick={() => setOpen(true)}>Change owner</Button>
      <Button variant="secondary" onClick={() => { setMsg(null); byTerritory(a.id).unwrap().then((r) => setMsg({ ok: true, text: `Assigned by territory "${r.territory}".` })).catch((e) => setMsg({ ok: false, text: errorMessage(e) })); }}>Assign by territory</Button></div>}>
      <p className="text-sm">{nameOf(a.owner_id)}</p>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</p>}
      {open && <ActionDialog title="Change owner" cta="Change owner" open onClose={() => setOpen(false)} initial={{ owner_id: a.owner_id }} fields={[{ name: "owner_id", label: "New owner", required: true, options: people, searchUsers: true }]} submit={async (v) => { await assign({ kind: "account", id: a.id, owner_id: v.owner_id! }).unwrap(); }} />}
    </Card>
  );
}

export function AccountDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useGetCrmAccountQuery(id);
  const [addContact, setAddContact] = useState(false);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const manage = can("crm.manage");
  return (
    <>
      <PageHeader title={data.name} description={data.is_active ? "Customer account" : "Archived customer account"} actions={<Link className="text-sm text-indigo-700 hover:underline" to="/app/crm/accounts">All accounts</Link>} />
      <ProfileCard a={data} canEdit={manage} />
      {can("crm.assign") ? <OwnerCard a={data} /> : null}
      <CreditCard a={data} canEdit={can("crm.assign")} />
      <Card title="Contacts" actions={manage ? <Button variant="secondary" onClick={() => setAddContact(true)}>Add contact</Button> : undefined}>
        <ContactsTable account={id} canManage={manage} />
      </Card>
      <AddressCard id={id} canEdit={manage} />
      <TimelineCard id={id} />
      {addContact && <ContactDialog contact={null} accountId={id} onClose={() => setAddContact(false)} />}
    </>
  );
}

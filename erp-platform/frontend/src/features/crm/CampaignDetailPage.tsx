import { useState } from "react";
import { Link, useParams } from "react-router";

import { useCampaignActionMutation, useGetCampaignQuery, useGetCampaignReportQuery, useListCampaignMembersQuery, useListCrmContactsQuery, useListLeadsQuery, useRespondCampaignMemberMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Campaign, CampaignMember } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { statusTone } from "./CampaignsPage";

const MEMBER_STATUSES = ["TARGETED", "SENT", "RESPONDED", "EXCLUDED"];

function ReportCard({ id }: { id: string }) {
  const { data: r, isLoading, error, refetch } = useGetCampaignReportQuery(id);
  if (isLoading) return <Card title="Results"><Spinner /></Card>;
  if (error || !r) return <Card title="Results"><ErrorState error={error} onRetry={refetch} /></Card>;
  const cell = (k: string, v: string | number | null) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="text-sm">{v ?? "–"}</dd></div>;
  const money = (v: string) => `${formatMoney(v)} ${r.currency}`;
  return (
    <Card title="Results">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cell("Budget", money(r.budget))}{cell("Spent", money(r.spent))}{cell("Remaining", money(r.remaining))}{cell("Cost per lead", r.cost_per_lead ? money(r.cost_per_lead) : null)}
        {cell("Targeted", r.members.TARGETED ?? 0)}{cell("Sent", r.members.SENT ?? 0)}{cell("Responded", r.members.RESPONDED ?? 0)}{cell("Excluded", r.excluded)}
        {cell("Response rate", r.response_rate ? `${r.response_rate}%` : null)}{cell("Leads generated", r.leads_generated)}{cell("Leads converted", r.leads_converted)}{cell("Opportunities", r.opportunities)}
        {cell("Open pipeline", money(r.open_pipeline))}{cell("Won revenue", money(r.won_revenue))}{cell("ROI", r.roi_percent ? `${r.roi_percent}%` : null)}
      </dl>
    </Card>
  );
}

function MembersCard({ c, canManage }: { c: Campaign; canManage: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListCampaignMembersQuery({ id: c.id, cursor, ...(status ? { status } : {}) });
  const leads = useListLeadsQuery();
  const contacts = useListCrmContactsQuery({});
  const [respond] = useRespondCampaignMemberMutation();
  const who = (m: CampaignMember) => {
    if (m.lead) return leads.data?.results.find((l) => l.id === m.lead)?.name ?? `Lead ${m.lead.slice(0, 8)}`;
    if (m.contact) { const ct = contacts.data?.results.find((x) => x.id === m.contact); return ct ? `${ct.first_name} ${ct.last_name}`.trim() : `Contact ${m.contact.slice(0, 8)}`; }
    return "–";
  };
  return (
    <Card title="Audience">
      <label className="mb-3 block text-sm">Show <select aria-label="Member status" className="rounded border border-slate-300 px-2 py-1" value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{MEMBER_STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</select></label>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No one in this audience yet" hint="Build the audience from the criteria." /> : (
        <ul className="divide-y divide-slate-100 text-sm">{data.results.map((m) => (
          <li key={m.id} className="flex items-center justify-between py-2">
            <span>{who(m)} <Badge tone={m.status === "EXCLUDED" ? "red" : m.status === "RESPONDED" ? "green" : "slate"}>{m.status.toLowerCase()}</Badge>{m.excluded_reason ? ` — ${m.excluded_reason}` : ""}</span>
            {canManage && m.status === "SENT" && <Button variant="secondary" onClick={() => { setErr(null); respond(m.id).unwrap().catch((e) => setErr(errorMessage(e))); }}>{`Record response from ${who(m)}`}</Button>}
          </li>))}</ul>
      )}
      {(data?.next || cursor) && <div className="mt-3 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{data?.next && <Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button>}</div>}
    </Card>
  );
}

export function CampaignDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const { data: c, isLoading, error, refetch } = useGetCampaignQuery(id);
  const [act] = useCampaignActionMutation();
  const [dialog, setDialog] = useState<"expense" | "budget" | "lead" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !c) return <ErrorState error={error} onRetry={refetch} />;
  const run = async (action: string, body?: Record<string, unknown>, done?: (r: Record<string, unknown>) => string) => {
    setMsg(null);
    try { const r = await act({ id, action, body }).unwrap(); setMsg({ ok: true, text: done ? done(r) : "Done." }); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); }
  };
  const live = c.status === "DRAFT" || c.status === "ACTIVE";
  return (
    <>
      <PageHeader title={c.name} description={`${c.number} · ${c.channel.toLowerCase()} · ${c.start_date} to ${c.end_date}`}
        actions={<div className="flex items-center gap-3"><Badge tone={statusTone(c.status)}>{c.status.toLowerCase()}</Badge><Link className="text-sm text-indigo-700 hover:underline" to="/app/crm/campaigns">All campaigns</Link></div>} />
      {c.objective && <p className="mb-3 text-sm text-slate-600">{c.objective}</p>}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mb-3 text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</p>}
      {can("crm.campaign.manage") && (
        <div className="mb-4 flex flex-wrap gap-2">
          {live && <Button variant="secondary" onClick={() => void run("audience", {}, (r) => `Added ${r.added} to the audience; ${r.excluded} excluded for missing consent or address.`)}>Build audience</Button>}
          {c.status === "DRAFT" && <Button onClick={() => void run("activate")}>Activate</Button>}
          {c.status === "ACTIVE" && <Button onClick={() => void run("send", {}, (r) => `Marked ${r.sent} as sent; ${r.blocked} blocked because consent was withdrawn.`)}>Mark all as sent</Button>}
          {c.status === "ACTIVE" && <Button variant="secondary" onClick={() => void run("complete")}>Complete</Button>}
          {live && <Button variant="danger" onClick={() => void run("cancel")}>Cancel campaign</Button>}
          {live && <Button variant="secondary" onClick={() => setDialog("expense")}>Record expense</Button>}
          {live && <Button variant="secondary" onClick={() => setDialog("lead")}>Capture lead</Button>}
          {can("crm.assign") && live && <Button variant="secondary" onClick={() => setDialog("budget")}>Change budget</Button>}
        </div>
      )}
      <ReportCard id={id} />
      <MembersCard c={c} canManage={can("crm.campaign.manage")} />
      {dialog === "expense" && (
        <ActionDialog title="Record expense" cta="Save expense" open onClose={() => setDialog(null)} fields={[{ name: "on_date", label: "Date", type: "date", required: true }, { name: "description", label: "What was it for?", required: true }, { name: "amount", label: "Amount", required: true }]}
          submit={async (v) => { if (!/^\d+(\.\d{1,2})?$/.test(v.amount!.trim()) || Number(v.amount) <= 0) throw new Error("The amount must be greater than zero with at most 2 decimals."); await act({ id, action: "expenses", body: { on_date: v.on_date, description: v.description!.trim(), amount: v.amount!.trim() } }).unwrap(); }} />
      )}
      {dialog === "budget" && (
        <ActionDialog title="Change budget" cta="Save budget" open onClose={() => setDialog(null)} initial={{ budget: c.budget }} fields={[{ name: "budget", label: "Budget", required: true }]}
          submit={async (v) => { if (!/^\d+(\.\d{1,2})?$/.test(v.budget!.trim())) throw new Error("The budget must be an amount with at most 2 decimals."); await act({ id, action: "budget", body: { budget: v.budget!.trim() } }).unwrap(); }} />
      )}
      {dialog === "lead" && (
        <ActionDialog title="Capture lead" cta="Capture" open onClose={() => setDialog(null)} fields={[{ name: "name", label: "Name", required: true }, { name: "company", label: "Company" }, { name: "email", label: "Email", type: "email" }, { name: "phone", label: "Phone" }, { name: "consent", label: "Agreed to marketing", options: [["yes", "Yes"], ["no", "No"]] }]}
          submit={async (v) => { await act({ id, action: "capture", body: { name: v.name!.trim(), company: v.company ?? "", email: (v.email ?? "").trim(), phone: v.phone ?? "", marketing_consent: v.consent === "yes" } }).unwrap(); }} />
      )}
    </>
  );
}

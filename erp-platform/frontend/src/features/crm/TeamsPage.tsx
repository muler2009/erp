import { useState } from "react";

import { useCreateCrmTeamMutation, useGetCrmPortfolioQuery, useListCrmTeamsQuery, useListCrmTerritoriesQuery, useRemoveCrmTeamMemberMutation, useSaveCrmTerritoryMutation, useSetCrmTeamMemberMutation, useTransferCrmPortfolioMutation, useUpdateCrmTeamMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { TeamNode, Territory } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames, useUserOptions } from "../quality/names";

export function flattenTeams(nodes: TeamNode[], depth = 0): { id: string; name: string; depth: number }[] {
  return nodes.flatMap((n) => [{ id: n.id, name: n.name, depth }, ...flattenTeams(n.children, depth + 1)]);
}
/** "ET, ke" -> ["ET","KE"]; blanks dropped; each code must be two letters. */
export function parseCountries(text: string): string[] {
  const out = text.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const bad = out.find((c) => !/^[A-Z]{2}$/.test(c));
  if (bad) throw new Error(`"${bad}" is not a 2-letter country code.`);
  return out;
}
const list = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);

type TeamDialog = { kind: "new" } | { kind: "edit"; team: TeamNode } | { kind: "member"; team: TeamNode } | null;

function TeamBranch({ t, depth, canManage, onDialog }: { t: TeamNode; depth: number; canManage: boolean; onDialog: (d: TeamDialog) => void }) {
  const nameOf = useUserNames();
  const [remove] = useRemoveCrmTeamMemberMutation();
  const [err, setErr] = useState<string | null>(null);
  return (
    <li style={{ marginLeft: depth * 20 }} className="mb-3 rounded border border-slate-200 p-3 text-sm">
      <div className="flex items-center justify-between">
        <div><span className="font-medium">{t.name}</span>{t.manager_id && <span className="ml-2 text-slate-500">managed by {nameOf(t.manager_id)}</span>}</div>
        {canManage && <div className="flex gap-2"><Button variant="secondary" onClick={() => onDialog({ kind: "member", team: t })}>{`Add member to ${t.name}`}</Button><Button variant="secondary" onClick={() => onDialog({ kind: "edit", team: t })}>{`Edit ${t.name}`}</Button></div>}
      </div>
      {err && <p role="alert" className="mt-1 text-red-700">{err}</p>}
      {t.members.length ? <ul className="mt-2 flex flex-wrap gap-2">{t.members.map((m) => (
        <li key={m.user_id}><Badge tone={m.is_lead ? "amber" : "slate"}>{nameOf(m.user_id)}{m.is_lead ? " (lead)" : ""}</Badge>
          {canManage && <button className="ml-1 text-xs text-red-700 hover:underline" aria-label={`Remove ${nameOf(m.user_id)} from ${t.name}`} onClick={() => { setErr(null); remove({ id: t.id, user_id: m.user_id }).unwrap().catch((e) => setErr(errorMessage(e))); }}>remove</button>}</li>))}</ul>
        : <p className="mt-1 text-slate-500">No members yet.</p>}
      {t.children.length > 0 && <ul className="mt-3">{t.children.map((c) => <TeamBranch key={c.id} t={c} depth={depth + 1} canManage={canManage} onDialog={onDialog} />)}</ul>}
    </li>
  );
}

function TeamsTab({ canManage }: { canManage: boolean }) {
  const { data, isLoading, error, refetch } = useListCrmTeamsQuery();
  const [create] = useCreateCrmTeamMutation();
  const [update] = useUpdateCrmTeamMutation();
  const [setMember] = useSetCrmTeamMemberMutation();
  const [dialog, setDialog] = useState<TeamDialog>(null);
  const people = useUserOptions(!dialog);
  const flat = flattenTeams(data ?? []);
  const parentOptions = (self?: string): [string, string][] => flat.filter((t) => t.id !== self).map((t) => [t.id, `${"– ".repeat(t.depth)}${t.name}`]);
  return (
    <>
      {canManage && <div className="mb-3 flex justify-end"><Button onClick={() => setDialog({ kind: "new" })}>New team</Button></div>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No sales teams yet" /> : <ul>{data.map((t) => <TeamBranch key={t.id} t={t} depth={0} canManage={canManage} onDialog={setDialog} />)}</ul>}
      {dialog?.kind === "new" && (
        <ActionDialog title="New team" cta="Create team" open onClose={() => setDialog(null)} fields={[{ name: "name", label: "Name", required: true }, { name: "parent", label: "Part of", options: parentOptions() }, { name: "manager_id", label: "Manager", options: people, searchUsers: true }]}
          submit={async (v) => { await create({ name: v.name!.trim(), parent: v.parent || null, manager_id: v.manager_id || null }).unwrap(); }} />
      )}
      {dialog?.kind === "edit" && (
        <ActionDialog title={`Edit ${dialog.team.name}`} cta="Save team" open onClose={() => setDialog(null)} initial={{ parent: flat.find((f) => f.id !== dialog.team.id && data?.some((r) => r.id === f.id && r.children.some((c) => c.id === dialog.team.id)))?.id ?? "", manager_id: dialog.team.manager_id ?? "", is_active: "yes" }}
          fields={[{ name: "parent", label: "Part of", options: parentOptions(dialog.team.id) }, { name: "manager_id", label: "Manager", options: people, searchUsers: true }, { name: "is_active", label: "Active", options: [["yes", "Yes"], ["no", "No (disband)"]] }]}
          submit={async (v) => { await update({ id: dialog.team.id, body: { parent: v.parent || null, manager_id: v.manager_id || null, is_active: v.is_active !== "no" } }).unwrap(); }} />
      )}
      {dialog?.kind === "member" && (
        <ActionDialog title={`Add member to ${dialog.team.name}`} cta="Add member" open onClose={() => setDialog(null)} initial={{ is_lead: "no" }}
          fields={[{ name: "user_id", label: "Person", required: true, options: people, searchUsers: true }, { name: "is_lead", label: "Team lead", options: [["no", "No"], ["yes", "Yes"]] }]}
          submit={async (v) => { await setMember({ id: dialog.team.id, user_id: v.user_id!, is_lead: v.is_lead === "yes" }).unwrap(); }} />
      )}
    </>
  );
}

function TerritoriesTab({ canManage }: { canManage: boolean }) {
  const { data, isLoading, error, refetch } = useListCrmTerritoriesQuery();
  const teams = useListCrmTeamsQuery();
  const [save] = useSaveCrmTerritoryMutation();
  const [editing, setEditing] = useState<Territory | "new" | null>(null);
  const teamName = (id: string) => flattenTeams(teams.data ?? []).find((t) => t.id === id)?.name ?? "Team";
  const crit = (t: Territory) => [t.criteria.country?.length && `countries ${t.criteria.country.join(", ")}`, t.criteria.industry?.length && `industries ${t.criteria.industry.join(", ")}`, t.criteria.segment?.length && `segments ${t.criteria.segment.join(", ")}`].filter(Boolean).join("; ") || "all accounts";
  const e = editing && editing !== "new" ? editing : null;
  return (
    <>
      <p className="mb-3 text-sm text-slate-600">A new account goes to the least loaded member of the first matching territory's team (lowest priority number first).</p>
      {canManage && <div className="mb-3 flex justify-end"><Button onClick={() => setEditing("new")}>New territory</Button></div>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No territories yet" /> : (
        <table className="min-w-full text-sm"><caption className="sr-only">Territories</caption>
          <thead><tr className="text-left text-slate-500"><th className="py-1">Priority</th><th>Name</th><th>Team</th><th>Covers</th><th>Status</th><th /></tr></thead>
          <tbody>{data.map((t) => (
            <tr key={t.id} className="border-t border-slate-100"><td className="py-1">{t.priority}</td><td>{t.name}</td><td>{teamName(t.team)}</td><td>{crit(t)}</td><td><Badge tone={t.is_active ? "green" : "slate"}>{t.is_active ? "Active" : "Inactive"}</Badge></td>
              <td>{canManage && <Button variant="secondary" onClick={() => setEditing(t)}>{`Edit ${t.name}`}</Button>}</td></tr>))}</tbody></table>
      )}
      {editing && (
        <ActionDialog title={e ? `Edit ${e.name}` : "New territory"} cta="Save territory" open onClose={() => setEditing(null)}
          initial={{ name: e?.name ?? "", team: e?.team ?? "", countries: e?.criteria.country?.join(", ") ?? "", industries: e?.criteria.industry?.join(", ") ?? "", segments: e?.criteria.segment?.join(", ") ?? "", priority: String(e?.priority ?? 100), is_active: e?.is_active === false ? "no" : "yes" }}
          fields={[{ name: "name", label: "Name", required: true }, { name: "team", label: "Team", required: true, options: flattenTeams(teams.data ?? []).map((t) => [t.id, t.name]) }, { name: "countries", label: "Countries (2-letter codes, comma separated)" }, { name: "industries", label: "Industries (comma separated)" }, { name: "segments", label: "Segments (comma separated)" }, { name: "priority", label: "Priority (lower is checked first)" }, { name: "is_active", label: "Active", options: [["yes", "Yes"], ["no", "No"]] }]}
          submit={async (v) => {
            const priority = Number(v.priority);
            if (!Number.isInteger(priority) || priority < 0) throw new Error("The priority must be a whole number, 0 or more.");
            const criteria: Record<string, string[]> = {};
            const c = parseCountries(v.countries ?? ""); if (c.length) criteria.country = c;
            const i = list(v.industries ?? ""); if (i.length) criteria.industry = i;
            const s = list(v.segments ?? ""); if (s.length) criteria.segment = s;
            await save({ name: v.name!.trim(), team: v.team!, criteria, priority, is_active: v.is_active !== "no" }).unwrap();
          }} />
      )}
    </>
  );
}

function PortfoliosTab({ canManage }: { canManage: boolean }) {
  const { data, isLoading, error, refetch } = useGetCrmPortfolioQuery();
  const [transfer] = useTransferCrmPortfolioMutation();
  const nameOf = useUserNames();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const people = useUserOptions(!open);
  return (
    <>
      {canManage && <div className="mb-3 flex justify-end"><Button onClick={() => { setDone(null); setOpen(true); }}>Transfer a portfolio</Button></div>}
      {done && <p role="status" className="mb-3 text-sm text-green-700">{done}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="Nobody owns any accounts or deals yet" /> : (
        <table className="min-w-full text-sm"><caption className="sr-only">Portfolios</caption>
          <thead><tr className="text-left text-slate-500"><th className="py-1">Owner</th><th className="text-right">Accounts</th><th className="text-right">Open deals</th><th className="text-right">Open value</th></tr></thead>
          <tbody>{data.map((r) => (
            <tr key={r.owner_id} className="border-t border-slate-100"><td className="py-1">{nameOf(r.owner_id)}</td><td className="text-right">{r.accounts}</td><td className="text-right">{r.open_opportunities}</td>
              <td className="text-right">{Object.entries(r.open_value).map(([c, v]) => `${formatMoney(v)} ${c}`).join(", ") || "–"}</td></tr>))}</tbody></table>
      )}
      {open && (
        <ActionDialog title="Transfer a portfolio" cta="Transfer" open onClose={() => setOpen(false)}
          fields={[{ name: "from_user", label: "From", required: true, options: people, searchUsers: true }, { name: "to_user", label: "To", required: true, options: people, searchUsers: true }, { name: "reason", label: "Reason", required: true }]}
          submit={async (v) => {
            if (v.from_user === v.to_user) throw new Error("Choose two different people.");
            const r = await transfer({ from_user: v.from_user!, to_user: v.to_user!, reason: v.reason!.trim() }).unwrap();
            setDone(`Moved ${r.account ?? 0} accounts, ${r.opportunity ?? 0} open opportunities and ${r.lead ?? 0} open leads.`);
          }} />
      )}
    </>
  );
}

const TABS = ["Teams", "Territories", "Portfolios"] as const;

export function TeamsPage() {
  const { can } = useAccess();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Teams");
  const manage = can("crm.assign");
  return (
    <>
      <PageHeader title="Sales teams" description="Who sells, who covers which territory, and who owns what." />
      <div role="tablist" aria-label="Sales organisation" className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)} className={`px-3 py-2 text-sm ${t === tab ? "border-b-2 border-indigo-600 font-medium text-indigo-700" : "text-slate-600 hover:text-slate-900"}`}>{t}</button>)}
      </div>
      <Card title={tab}>
        {tab === "Teams" && <TeamsTab canManage={manage} />}
        {tab === "Territories" && <TerritoriesTab canManage={manage} />}
        {tab === "Portfolios" && <PortfoliosTab canManage={manage} />}
      </Card>
    </>
  );
}

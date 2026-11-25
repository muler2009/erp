import { useMemo, useState } from "react";
import { Link } from "react-router";

import { useCompleteCrmActivityMutation, useListCrmAccountsQuery, useListCrmCalendarQuery, useListCrmFollowupsQuery, useListCrmOverdueQuery, useScheduleCrmActivityMutation } from "../../shared/api/endpoints";
import type { CrmActivity } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export const ACTIVITY_TYPES: [string, string][] = [["CALL", "Call"], ["MEETING", "Meeting"], ["TASK", "Task"], ["NOTE", "Note"], ["DEMO", "Demo"], ["EMAIL", "Email"]];
const PRIORITIES: [string, string][] = [["LOW", "Low"], ["MEDIUM", "Medium"], ["HIGH", "High"]];
const typeLabel = (t: string) => ACTIVITY_TYPES.find(([k]) => k === t)?.[1] ?? t;

/** `datetime-local` gives "2026-11-20T14:30" (the user's local time); the API wants an absolute time. */
export function toIso(local: string): string {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) throw new Error("Enter a valid date and time.");
  return d.toISOString();
}

function ActivityList({ items, isLoading, error, refetch, empty, canManage, onDone }: { items: CrmActivity[] | undefined; isLoading: boolean; error: unknown; refetch: () => void; empty: string; canManage: boolean; onDone: (a: CrmActivity) => void }) {
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!items?.length) return <EmptyState title={empty} />;
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {items.map((a) => (
        <li key={a.id} className="flex items-center justify-between gap-3 py-2">
          <div>
            <div><Badge tone="slate">{typeLabel(a.type)}</Badge> <span className="font-medium">{a.subject}</span> {a.priority === "HIGH" && <Badge tone="red">High</Badge>}</div>
            <div className="text-xs text-slate-500">
              {a.due_at ? `Due ${new Date(a.due_at).toLocaleString()}` : "No due date"}{a.done_at ? ` · done ${new Date(a.done_at).toLocaleString()}` : ""}
              {a.outcome ? ` · ${a.outcome}` : ""}
              {a.account && <> · <Link className="text-indigo-700 hover:underline" to={`/app/crm/accounts/${a.account}`}>account</Link></>}
              {a.opportunity && <> · <Link className="text-indigo-700 hover:underline" to={`/app/crm/opportunities/${a.opportunity}`}>opportunity</Link></>}
            </div>
          </div>
          {canManage && !a.done_at && <Button variant="secondary" onClick={() => onDone(a)}>{`Complete ${a.subject}`}</Button>}
        </li>
      ))}
    </ul>
  );
}

const TABS = ["Upcoming", "Follow-ups due", "Overdue"] as const;

export function ActivitiesPage() {
  const { can } = useAccess();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Upcoming");
  const [days, setDays] = useState(14);
  const [team, setTeam] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [completing, setCompleting] = useState<CrmActivity | null>(null);
  const range = useMemo(() => { const from = new Date(); from.setHours(0, 0, 0, 0); const to = new Date(from.getTime() + days * 86400000); return { from: from.toISOString(), to: to.toISOString() }; }, [days]);
  const cal = useListCrmCalendarQuery({ ...range, ...(team ? { scope: "team" } : {}) }, { skip: tab !== "Upcoming" });
  const due = useListCrmFollowupsQuery(undefined, { skip: tab !== "Follow-ups due" });
  const overdue = useListCrmOverdueQuery(undefined, { skip: tab !== "Overdue" });
  const accounts = useListCrmAccountsQuery(undefined, { skip: !scheduling });
  const [schedule] = useScheduleCrmActivityMutation();
  const [complete] = useCompleteCrmActivityMutation();
  const manage = can("crm.manage");
  return (
    <>
      <PageHeader title="Activities" description="Calls, meetings and tasks with your customers." actions={manage ? <Button onClick={() => setScheduling(true)}>Schedule activity</Button> : undefined} />
      <div role="tablist" aria-label="Activity views" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)} className={`px-3 py-2 text-sm ${t === tab ? "border-b-2 border-indigo-600 font-medium text-indigo-700" : "text-slate-600 hover:text-slate-900"}`}>{t}</button>)}
      </div>
      <Card title={tab}>
        {tab === "Upcoming" && (
          <div className="mb-3 flex items-center gap-4 text-sm">
            <label>Show the next <select aria-label="Days ahead" className="rounded border border-slate-300 px-2 py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
            {can("crm.view_all") && <label className="flex items-center gap-1"><input type="checkbox" checked={team} onChange={(e) => setTeam(e.target.checked)} /> Whole team</label>}
          </div>
        )}
        {tab === "Upcoming" && <ActivityList items={cal.data?.results} isLoading={cal.isLoading} error={cal.error} refetch={cal.refetch} empty="Nothing scheduled in this period" canManage={manage} onDone={setCompleting} />}
        {tab === "Follow-ups due" && <ActivityList items={due.data} isLoading={due.isLoading} error={due.error} refetch={due.refetch} empty="No follow-ups are due" canManage={manage} onDone={setCompleting} />}
        {tab === "Overdue" && <ActivityList items={overdue.data} isLoading={overdue.isLoading} error={overdue.error} refetch={overdue.refetch} empty="Nothing is overdue" canManage={manage} onDone={setCompleting} />}
      </Card>
      {scheduling && (
        <ActionDialog title="Schedule activity" cta="Schedule" open onClose={() => setScheduling(false)} initial={{ type: "CALL", priority: "MEDIUM" }}
          fields={[{ name: "type", label: "Type", options: ACTIVITY_TYPES, required: true }, { name: "subject", label: "Subject", required: true }, { name: "due_at", label: "Due", type: "datetime-local" },
            { name: "priority", label: "Priority", options: PRIORITIES }, { name: "account", label: "Customer account", options: (accounts.data?.results ?? []).map((a) => [a.id, a.name]) }, { name: "notes", label: "Notes" }]}
          submit={async (v) => { await schedule({ type: v.type, subject: v.subject!.trim(), priority: v.priority || "MEDIUM", notes: v.notes ?? "", ...(v.due_at ? { due_at: toIso(v.due_at) } : {}), ...(v.account ? { account: v.account } : {}) }).unwrap(); }} />
      )}
      {completing && (
        <ActionDialog title="Complete activity" cta="Mark done" open onClose={() => setCompleting(null)} fields={[{ name: "outcome", label: "What was the outcome?" }]}
          submit={async (v) => { await complete({ id: completing.id, outcome: (v.outcome ?? "").trim() }).unwrap(); }} />
      )}
    </>
  );
}

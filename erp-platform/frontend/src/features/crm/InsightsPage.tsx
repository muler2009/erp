import { useState } from "react";
import { Link } from "react-router";

import { useGetCrmDashboardQuery, useGetCrmProfitabilityQuery, useGetCrmRetentionQuery, useGetCrmSatisfactionQuery, useGetCrmSegmentationQuery, useRefreshCrmLifecycleMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { RetentionRow } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { useUserNames } from "../quality/names";

const TABS = ["Overview", "Customer tiers", "Retention", "Satisfaction", "Profitability"] as const;
const Stat = ({ k, v }: { k: string; v: string | number }) => <div><dt className="text-xs text-slate-500">{k}</dt><dd className="text-lg">{v}</dd></div>;
const acct = (id: string, name: string) => <Link className="text-indigo-700 hover:underline" to={`/app/crm/accounts/${id}`}>{name}</Link>;
function State({ q, children }: { q: { isLoading: boolean; error?: unknown; refetch: () => void; data?: unknown }; children: React.ReactNode }) {
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.refetch} />;
  return <>{children}</>;
}
const money = (rec: Record<string, string>) => Object.entries(rec).map(([c, v]) => `${formatMoney(v)} ${c}`).join(", ") || "–";

function Overview() {
  const q = useGetCrmDashboardQuery();
  const nameOf = useUserNames();
  const d = q.data;
  return (
    <State q={q}>{d && (
      <>
        <Card title="At a glance"><dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat k="Open opportunities" v={d.pipeline.open_count} /><Stat k="Open value" v={money(d.pipeline.open_value_by_currency)} /><Stat k="Won" v={d.won} /><Stat k="Lost" v={d.lost} />
          <Stat k="Overdue activities" v={d.overdue_activities} /><Stat k="Active customers" v={d.customers.active} /><Stat k="At risk" v={d.customers.at_risk} /><Stat k="Churn rate" v={`${d.customers.churn_rate_percent}%`} />
        </dl></Card>
        <Card title="Where leads come from">{Object.keys(d.lead_sources).length ? (
          <table className="min-w-full text-sm"><caption className="sr-only">Lead sources</caption><thead><tr className="text-left text-slate-500"><th className="py-1">Source</th><th className="text-right">Leads</th><th className="text-right">Converted</th><th className="text-right">Rate</th></tr></thead>
            <tbody>{Object.entries(d.lead_sources).map(([k, v]) => <tr key={k} className="border-t border-slate-100"><td className="py-1">{k}</td><td className="text-right">{v.leads}</td><td className="text-right">{v.converted}</td><td className="text-right">{v.conversion_percent}%</td></tr>)}</tbody></table>
        ) : <EmptyState title="No leads yet" />}</Card>
        <Card title="Deals going quiet (no activity for 14 days)">{d.neglected_opportunities.length ? (
          <ul className="text-sm">{d.neglected_opportunities.map((o) => <li key={o.id}><Link className="text-indigo-700 hover:underline" to={`/app/crm/opportunities/${o.id}`}>{o.name}</Link> · {formatMoney(o.amount)} · {nameOf(o.owner_id)} · {o.last_activity_at ? `last activity ${new Date(o.last_activity_at).toLocaleDateString()}` : "never contacted"}</li>)}</ul>
        ) : <EmptyState title="Every open deal has recent activity" />}</Card>
        <Card title="Activity by rep">{d.activity_performance.length ? (
          <ul className="text-sm">{d.activity_performance.map((p) => <li key={p.owner_id}>{nameOf(p.owner_id)}: {p.completed} of {p.activities} done ({p.completion_percent}%)</li>)}</ul>
        ) : <EmptyState title="No activities recorded" />}</Card>
      </>
    )}</State>
  );
}

function Tiers() {
  const q = useGetCrmSegmentationQuery();
  const d = q.data;
  const label: Record<string, string> = { A: "Top customers (first 80% of revenue)", B: "Next 15%", C: "Remaining 5%", N: "No purchases yet" };
  return (
    <State q={q}>{d && (
      <>
        <p className="mb-3 text-sm text-slate-600">Total revenue {formatMoney(d.total_revenue)} {d.currency}</p>
        {(["A", "B", "C", "N"] as const).map((t) => (
          <Card key={t} title={`Tier ${t} · ${label[t]} · ${d.tiers[t].length}`}>{d.tiers[t].length ? <ul className="text-sm">{d.tiers[t].map((r) => <li key={r.account}>{acct(r.account, r.name)} · {formatMoney(r.revenue)}</li>)}</ul> : <EmptyState title="Nobody in this tier" />}</Card>
        ))}
        <Card title="Revenue by segment"><ul className="text-sm">{Object.entries(d.by_segment).map(([k, v]) => <li key={k}>{k}: {formatMoney(v)}</li>)}</ul></Card>
        <Card title="Revenue by industry"><ul className="text-sm">{Object.entries(d.by_industry).map(([k, v]) => <li key={k}>{k}: {formatMoney(v)}</li>)}</ul></Card>
      </>
    )}</State>
  );
}

function Retention({ canManage }: { canManage: boolean }) {
  const q = useGetCrmRetentionQuery();
  const [refresh, { isLoading }] = useRefreshCrmLifecycleMutation();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const d = q.data;
  const rows = (title: string, r: RetentionRow[]) => (
    <Card title={`${title} · ${r.length}`}>{r.length ? <ul className="text-sm">{r.map((x) => <li key={x.account}>{acct(x.account, x.name)} · last order {x.last_order} ({x.days_idle} days ago) · lifetime {formatMoney(x.lifetime_value)}</li>)}</ul> : <EmptyState title="None" />}</Card>
  );
  return (
    <State q={q}>{d && (
      <>
        <div className="mb-3 flex items-center justify-between"><p className="text-sm text-slate-600">At risk = no order for 90 days, churned = 180 days. Churn rate {d.churn_rate_percent}%. {d.never_purchased} customers have never purchased.</p>
          {canManage && <Button variant="secondary" loading={isLoading} onClick={() => { setMsg(null); refresh().unwrap().then((r) => setMsg({ ok: true, text: `${r.changed} accounts updated.` })).catch((e) => setMsg({ ok: false, text: errorMessage(e) })); }}>Update customer lifecycle stages</Button>}</div>
        {msg && <p role={msg.ok ? "status" : "alert"} className={`mb-3 text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</p>}
        {rows("At risk", d.at_risk)}{rows("Churned", d.churned)}{rows("Active", d.active)}
      </>
    )}</State>
  );
}

function Satisfaction() {
  const q = useGetCrmSatisfactionQuery();
  const d = q.data;
  return (
    <State q={q}>{d && (
      <>
        <Card title="Ratings"><dl className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat k="Responses" v={d.responses} /><Stat k="Average" v={d.average === null ? "–" : `${d.average} / 5`} /><Stat k="Happy (4–5)" v={`${d.promoter_percent}%`} /><Stat k="Unhappy (1–2)" v={`${d.detractor_percent}%`} /></dl>
          <ul className="mt-3 text-sm">{Object.entries(d.distribution).map(([k, n]) => <li key={k}>{k} stars: {n}</li>)}</ul></Card>
        <Card title="Lowest-rated customers">{d.lowest_accounts.length ? <ul className="text-sm">{d.lowest_accounts.map((a) => <li key={a.account}>{acct(a.account, a.name)} · {a.average ?? "–"} ({a.responses} responses)</li>)}</ul> : <EmptyState title="No ratings yet" />}</Card>
      </>
    )}</State>
  );
}

function Profitability() {
  const q = useGetCrmProfitabilityQuery();
  return (
    <State q={q}>{q.data && (q.data.length ? (
      <Card title="Margin by customer (delivered goods)"><table className="min-w-full text-sm"><caption className="sr-only">Profitability</caption>
        <thead><tr className="text-left text-slate-500"><th className="py-1">Customer</th><th className="text-right">Revenue</th><th className="text-right">Cost</th><th className="text-right">Margin</th><th className="text-right">Margin %</th></tr></thead>
        <tbody>{q.data.map((r) => <tr key={r.account} className="border-t border-slate-100"><td className="py-1">{acct(r.account, r.name)}</td><td className="text-right">{formatMoney(r.revenue)}</td><td className="text-right">{formatMoney(r.cost)}</td><td className="text-right">{formatMoney(r.margin)}</td><td className="text-right">{r.margin_percent}%</td></tr>)}</tbody></table></Card>
    ) : <EmptyState title="No delivered sales yet" />)}</State>
  );
}

export function InsightsPage() {
  const { can } = useAccess();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  return (
    <>
      <PageHeader title="Customer insights" description="Who your best customers are, who is drifting away, and how they feel." />
      <div role="tablist" aria-label="Insights" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)} className={`px-3 py-2 text-sm ${t === tab ? "border-b-2 border-indigo-600 font-medium text-indigo-700" : "text-slate-600 hover:text-slate-900"}`}>{t}</button>)}
      </div>
      {tab === "Overview" && <Overview />}{tab === "Customer tiers" && <Tiers />}{tab === "Retention" && <Retention canManage={can("crm.assign")} />}{tab === "Satisfaction" && <Satisfaction />}{tab === "Profitability" && <Profitability />}
    </>
  );
}

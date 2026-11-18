import { useState } from "react";

import { useGetCrmConversionQuery, useGetCrmForecastByQuery, useGetCrmForecastQuery } from "../../shared/api/endpoints";
import type { ForecastRow } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { useUserNames } from "../quality/names";

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(1)}%`);
const GROUPS: [string, string][] = [["owner", "Sales rep"], ["stage", "Stage"], ["product", "Product"], ["month", "Expected close month"]];

function Rows({ rows, first }: { rows: ForecastRow[]; first: (r: ForecastRow) => string }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-1">Group</th><th>Currency</th><th className="text-right">Deals</th><th className="text-right">Pipeline</th><th className="text-right">Weighted</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} className="border-t border-slate-100"><td className="py-1">{first(r)}</td><td>{r.currency}</td><td className="text-right">{r.count}</td><td className="text-right">{formatMoney(r.amount)}</td><td className="text-right">{formatMoney(r.weighted)}</td></tr>))}</tbody>
      </table>
    </div>
  );
}

export function CrmReportsPage() {
  const [group, setGroup] = useState("owner");
  const forecast = useGetCrmForecastQuery();
  const by = useGetCrmForecastByQuery(group);
  const conv = useGetCrmConversionQuery();
  const nameOf = useUserNames();
  return (
    <>
      <PageHeader title="Sales reports" description="What is in the pipeline and how leads and deals turn out. Weighted = amount × stage probability." />
      <Card title="Pipeline by expected close month">
        {forecast.isLoading ? <Spinner /> : forecast.error ? <ErrorState error={forecast.error} onRetry={forecast.refetch} /> : !forecast.data?.length ? <EmptyState title="No open opportunities" /> : <Rows rows={forecast.data} first={(r) => r.month ?? ""} />}
      </Card>
      <Card title="Pipeline breakdown">
        <label className="mb-3 block text-sm">Group by <select aria-label="Group by" className="rounded border border-slate-300 px-2 py-1" value={group} onChange={(e) => setGroup(e.target.value)}>{GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {by.isLoading ? <Spinner /> : by.error ? <ErrorState error={by.error} onRetry={by.refetch} /> : !by.data?.length ? <EmptyState title="No open opportunities" /> : <Rows rows={by.data} first={(r) => (group === "owner" ? nameOf(r.group) : (r.group ?? ""))} />}
      </Card>
      <Card title="Conversion">
        {conv.isLoading ? <Spinner /> : conv.error || !conv.data ? <ErrorState error={conv.error} onRetry={conv.refetch} /> : (
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><dt className="text-xs text-slate-500">Leads converted to opportunities</dt><dd className="text-lg">{pct(conv.data.lead_to_opportunity_rate)}</dd></div>
            <div><dt className="text-xs text-slate-500">Win rate</dt><dd className="text-lg">{pct(conv.data.win_rate)}</dd></div>
            <div><dt className="text-xs text-slate-500">Won</dt><dd className="text-lg">{conv.data.won}</dd></div>
            <div><dt className="text-xs text-slate-500">Lost</dt><dd className="text-lg">{conv.data.lost}</dd></div>
            {Object.entries(conv.data.leads).map(([k, n]) => <div key={k}><dt className="text-xs text-slate-500">Leads {k.toLowerCase()}</dt><dd>{n}</dd></div>)}
          </dl>
        )}
      </Card>
    </>
  );
}

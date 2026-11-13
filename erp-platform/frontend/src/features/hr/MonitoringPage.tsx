import { useState } from "react";

import { useGetMonitoringQuery } from "../../shared/api/endpoints";
import { Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

function List({ title, rows }: { title: string; rows: string[] }) {
  return <Card title={title}>{rows.length === 0 ? <p className="text-sm text-slate-500">Nothing due.</p> : <ul className="text-sm">{rows.map((r, i) => <li key={i} className="border-b border-slate-200 py-1">{r}</li>)}</ul>}</Card>;
}

export function MonitoringPage() {
  const [days, setDays] = useState(60);
  const { data, isLoading, error, refetch } = useGetMonitoringQuery(days);
  return (
    <>
      <PageHeader title="Monitoring" description="Dates that need attention in the coming period." />
      <label className="mb-3 block text-sm">Look ahead <select aria-label="Look ahead" className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[30, 60, 90, 180].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data ? <EmptyState title="No data" /> : (
        <div className="grid gap-4 md:grid-cols-2">
          <List title="Probation ending" rows={data.probation_ending.map((r) => `${r.name} (${r.employee}) — ${r.probation_end}`)} />
          <List title="Contracts expiring" rows={data.contracts_expiring.map((r) => `${r.name} (${r.employee}) — ${r.end_date}`)} />
          <List title="Documents expiring" rows={data.documents_expiring.map((r) => `${r.employee}: ${r.title} — ${r.expires_on}`)} />
          <List title="Qualifications expiring" rows={data.qualifications_expiring.map((r) => `${r.employee}: ${r.title} — ${r.expires_on}`)} />
          <List title="Upcoming retirements" rows={data.retirements.map((r) => `${r.name} (${r.employee}) — ${r.retirement_date}`)} />
        </div>
      )}
    </>
  );
}

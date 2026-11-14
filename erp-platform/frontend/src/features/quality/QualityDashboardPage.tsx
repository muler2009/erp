import { Link } from "react-router";

import { useGetQualityDashboardQuery } from "../../shared/api/endpoints";
import { Card, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { pretty } from "../hr/EmployeeDialogs";

function Tile({ label, value, warn, to }: { label: string; value: string | number; warn?: boolean; to?: string }) {
  const body = (
    <div className={`rounded border p-3 ${warn ? "border-red-300 bg-red-50" : "border-slate-200 bg-white"}`}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-slate-600">{label}</div>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function QualityDashboardPage() {
  const { data: d, isLoading, error, refetch } = useGetQualityDashboardQuery();
  if (isLoading) return <Spinner />;
  if (error || !d) return <ErrorState error={error} onRetry={refetch} />;
  const rate = d.inspection_pass_rate_90d == null ? "–" : `${d.inspection_pass_rate_90d}%`;
  const comp = d.compliance == null ? "–" : `${d.compliance}%`;
  return (
    <>
      <PageHeader title="Quality dashboard" description="Open work and what is overdue across quality." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Open non-conformances" value={d.open_ncrs} to="/app/quality/ncrs" />
        <Tile label="Open CAPAs" value={d.open_capas} />
        <Tile label="Overdue CAPAs" value={d.overdue_capas} warn={d.overdue_capas > 0} />
        <Tile label="Overdue actions" value={d.overdue_actions} warn={d.overdue_actions > 0} to="/app/quality/my-actions" />
        <Tile label="Inspections scheduled" value={d.inspections_scheduled} />
        <Tile label="Inspections overdue" value={d.inspections_overdue} warn={d.inspections_overdue > 0} />
        <Tile label="Inspection pass rate (90 days)" value={rate} />
        <Tile label="Active quality holds" value={d.active_holds} warn={d.active_holds > 0} />
        <Tile label="Open complaints" value={d.open_complaints} />
        <Tile label="Open audit findings" value={d.open_findings} />
        <Tile label="High risks" value={d.high_risks} warn={d.high_risks > 0} />
        <Tile label="Compliance" value={comp} />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card title="Open non-conformances by severity">
          {Object.keys(d.open_ncrs_by_severity).length === 0 ? <p className="text-sm text-slate-600">None open.</p> : (
            <ul className="text-sm">{Object.entries(d.open_ncrs_by_severity).map(([k, v]) => <li key={k}>{pretty(k)}: {v}</li>)}</ul>
          )}
        </Card>
        <Card title="Suppliers by quality status">
          {Object.keys(d.supplier_status).length === 0 ? <p className="text-sm text-slate-600">No supplier profiles yet.</p> : (
            <ul className="text-sm">{Object.entries(d.supplier_status).map(([k, v]) => <li key={k}>{pretty(k)}: {v}</li>)}</ul>
          )}
        </Card>
      </div>
    </>
  );
}

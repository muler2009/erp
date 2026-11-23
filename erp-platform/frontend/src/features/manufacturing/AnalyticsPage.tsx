import { useState } from "react";

import { useGetMfgAnalyticsQuery } from "../../shared/api/endpoints";
import { Button, Card, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ReportTable, cell } from "../../shared/ui/ReportTable";
import { rangeProblem } from "./PlanningPage";

export { cell };
export const REPORTS: [string, string, string][] = [
  ["plan-vs-actual", "Plan versus actual", "What each order planned against what it delivered."],
  ["order-status", "Orders by status", "How many orders are in each state."],
  ["output", "Output by product", "Quantities produced."],
  ["efficiency", "Efficiency", "Planned hours against actual hours."],
  ["utilization", "Machine utilisation", "How much of each work centre's time was used."],
  ["oee", "Overall equipment effectiveness", "Availability, performance and quality together."],
  ["bottlenecks", "Capacity bottlenecks", "Work centres closest to or over capacity."],
  ["downtime", "Downtime", "Stopped minutes by work centre and kind."],
  ["consumption", "Material consumption", "Planned versus actual material use."],
  ["scrap", "Scrap and waste", "Quantity and cost of scrap."],
  ["rework", "Rework", "Rework orders raised from other orders."],
  ["quality-rejection", "Quality rejection", "Defect rate and failed checks."],
  ["cost", "Production cost", "Cost of production by order."],
  ["by-line", "Cost by production line", "Conversion cost per line."],
  ["labor-productivity", "Labour productivity", "Good units per labour hour."],
  ["on-time", "On-time completion", "Orders finished by their planned end date."],
];

export function AnalyticsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const [name, setName] = useState(REPORTS[0]![0]);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const q = useGetMfgAnalyticsQuery({ name, from: applied?.from ?? "", to: applied?.to ?? "" }, { skip: !applied });
  const info = REPORTS.find((r) => r[0] === name);
  const run = () => { const p = rangeProblem(from, to); setErr(p); if (!p) setApplied({ from, to }); };
  return (
    <div>
      <PageHeader title="Manufacturing reports" description="Production performance for a period." />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Report" htmlFor="rep"><select id="rep" className={inputClass} value={name} onChange={(e) => setName(e.target.value)}>{REPORTS.map((r) => <option key={r[0]} value={r[0]}>{r[1]}</option>)}</select></FormField>
          <FormField label="From" htmlFor="rep-from"><input id="rep-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label="To" htmlFor="rep-to"><input id="rep-to" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
          <Button onClick={run}>Show report</Button>
        </div>
        {info && <p className="mt-2 text-sm text-slate-600">{info[2]}</p>}
        {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
      </Card>
      {applied && (
        <Card title={info?.[1]}>
          {q.isFetching && <Spinner />}
          {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
          {!q.isFetching && q.data !== undefined && <ReportTable data={q.data} />}
        </Card>
      )}
    </div>
  );
}
export default AnalyticsPage;

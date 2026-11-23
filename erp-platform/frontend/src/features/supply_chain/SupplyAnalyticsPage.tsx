import { useState } from "react";

import { useGetScAnalyticsQuery } from "../../shared/api/endpoints";
import { Button, Card, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ReportTable } from "../../shared/ui/ReportTable";
import { rangeProblem } from "../manufacturing/PlanningPage";

export const SC_ANALYTICS: [string, string, string][] = [
  ["dashboard", "Overview", "Key supply chain figures for the period."],
  ["fulfilment-risk", "Orders at risk", "Open orders that may not be delivered on time."],
  ["backorders", "Back-orders", "Ordered goods not yet delivered."],
  ["fulfilment-rate", "Fulfilment rate", "How much of what was ordered was delivered."],
  ["inventory-turnover", "Inventory turnover", "How quickly stock is used and replaced."],
  ["supply-cost", "Supply cost", "What supply and logistics cost."],
  ["vehicle-utilisation", "Vehicle utilisation", "How much of each vehicle's capacity is used."],
  ["stock-health", "Stock health", "Stock that is low, excess or ageing."],
  ["shortages", "Shortages", "Items that are short against demand."],
  ["transfer-recommendations", "Suggested transfers", "Moves between warehouses that would fix shortages."],
  ["stock-in-transit", "Stock in transit", "Goods currently moving between places."],
  ["warehouse-capacity", "Warehouse capacity", "Space used against capacity."],
  ["procurement-status", "Purchase order status", "Open purchase orders and whether they are late."],
  ["supply-risks", "Warning signals", "Problems found automatically."],
  ["risk-register", "Risk register", "Every logged risk with its score."],
  ["single-source", "Single-source items", "Items bought from only one supplier."],
  ["incidents", "Disruption history", "Disruptions started in the period."],
];

export function SupplyAnalyticsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const [name, setName] = useState(SC_ANALYTICS[0]![0]);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const q = useGetScAnalyticsQuery({ name, from: applied?.from ?? "", to: applied?.to ?? "" }, { skip: !applied });
  const info = SC_ANALYTICS.find((r) => r[0] === name);
  const run = () => { const p = rangeProblem(from, to); setErr(p); if (!p) setApplied({ from, to }); };
  return (
    <div>
      <PageHeader title="Supply chain analytics" description="Performance and health of the supply chain." />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Report" htmlFor="sa-rep"><select id="sa-rep" className={inputClass} value={name} onChange={(e) => setName(e.target.value)}>{SC_ANALYTICS.map((r) => <option key={r[0]} value={r[0]}>{r[1]}</option>)}</select></FormField>
          <FormField label="From" htmlFor="sa-from"><input id="sa-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label="To" htmlFor="sa-to"><input id="sa-to" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
          <Button onClick={run}>Show report</Button>
        </div>
        {info && <p className="mt-2 text-sm text-slate-600">{info[2]}</p>}
        {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
      </Card>
      {applied && <Card title={info?.[1]}>{q.isFetching && <Spinner />}{q.error && <ErrorState error={q.error} onRetry={q.refetch} />}{!q.isFetching && q.data !== undefined && <ReportTable data={q.data} />}</Card>}
    </div>
  );
}
export default SupplyAnalyticsPage;

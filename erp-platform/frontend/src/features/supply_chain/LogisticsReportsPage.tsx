import { useState } from "react";

import { useGetScReportQuery, useListShipmentExceptionsQuery, useResolveShipmentExceptionMutation } from "../../shared/api/endpoints";
import { Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ReportTable } from "../../shared/ui/ReportTable";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ActionDialog } from "../hr/ActionDialog";
import { rangeProblem } from "../manufacturing/PlanningPage";
import { EXC_KIND, SEVERITY } from "./ShipmentsPage";

export const SC_REPORTS: [string, string, string][] = [
  ["reports/costs", "Logistics costs", "What shipping cost, by kind and by carrier."],
  ["reports/carriers", "Carrier performance", "On-time rate, transit time, problems and cost per carrier."],
  ["reports/supplier-delivery", "Supplier delivery", "How reliably suppliers deliver, with suggested lead times."],
];

function Exceptions() {
  const { can } = useAccess();
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListShipmentExceptionsQuery({ cursor });
  const [resolve] = useResolveShipmentExceptionMutation();
  const [target, setTarget] = useState<string | null>(null);
  return (
    <Card title="Open delivery problems">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.results.length === 0 && <EmptyState title="No open problems" hint="Delays, damage and shortages reported on shipments appear here." />}
      {q.data && q.data.results.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Problem</th><th>Seriousness</th><th>Description</th><th /></tr></thead>
          <tbody>{q.data.results.map((x) => <tr key={x.id} className="border-t border-slate-100"><td>{EXC_KIND[x.kind] ?? x.kind}{x.auto_detected ? " (found automatically)" : ""}</td><td>{SEVERITY[x.severity] ?? x.severity}</td><td>{x.description}</td>
            <td>{can("supply_chain.logistics.manage") && <Button variant="secondary" onClick={() => setTarget(x.id)}>{`Resolve ${EXC_KIND[x.kind] ?? x.kind}: ${x.description.slice(0, 20)}`}</Button>}</td></tr>)}</tbody></table>
      )}
      <div className="mt-2 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button>}</div>
      <ActionDialog title="Resolve problem" open={target !== null} onClose={() => setTarget(null)} cta="Mark resolved" fields={[{ name: "resolution", label: "What was done" }]}
        submit={async (v) => { if (!(v.resolution ?? "").trim()) throw new Error("Say what was done to resolve it."); await resolve({ id: target!, resolution: v.resolution!.trim() }).unwrap(); }} />
    </Card>
  );
}

export function LogisticsReportsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const [path, setPath] = useState(SC_REPORTS[0]![0]);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const q = useGetScReportQuery({ path, from: applied?.from ?? "", to: applied?.to ?? "" }, { skip: !applied });
  const info = SC_REPORTS.find((r) => r[0] === path);
  const run = () => { const p = rangeProblem(from, to); setErr(p); if (!p) setApplied({ from, to }); };
  return (
    <div>
      <PageHeader title="Logistics reports" description="Delivery problems and logistics performance." />
      <Exceptions />
      <Card title="Performance reports">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Report" htmlFor="lr-rep"><select id="lr-rep" className={inputClass} value={path} onChange={(e) => setPath(e.target.value)}>{SC_REPORTS.map((r) => <option key={r[0]} value={r[0]}>{r[1]}</option>)}</select></FormField>
          <FormField label="From" htmlFor="lr-from"><input id="lr-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label="To" htmlFor="lr-to"><input id="lr-to" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
          <Button onClick={run}>Show report</Button>
        </div>
        {info && <p className="mt-2 text-sm text-slate-600">{info[2]}</p>}
        {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
        {applied && <div className="mt-3">{q.isFetching && <Spinner />}{q.error && <ErrorState error={q.error} onRetry={q.refetch} />}{!q.isFetching && q.data !== undefined && <ReportTable data={q.data} />}</div>}
      </Card>
    </div>
  );
}
export default LogisticsReportsPage;

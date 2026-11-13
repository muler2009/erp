import { useState } from "react";

import { useGetResourceLoadQuery } from "../../shared/api/endpoints";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { validatePeriod } from "./ProjectBillingPage";

export function validateHours(v: string): string | null { return /^\d{1,3}(\.\d{1,2})?$/.test(v) && Number(v) > 0 && Number(v) <= 168 ? null : "Weekly hours must be between 1 and 168."; }

export function ResourceLoadPage() {
  const [f, setF] = useState({ from: "", to: "", weekly: "40" });
  const [applied, setApplied] = useState<typeof f | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useGetResourceLoadQuery({ from: applied?.from ?? "", to: applied?.to ?? "", weekly_hours: applied?.weekly ?? "40" }, { skip: !applied });
  const go = () => { const p = validatePeriod(f.from, f.to) ?? validateHours(f.weekly); setErr(p); if (!p) setApplied(f); };
  return (
    <>
      <PageHeader title="Resource load" description="Who is over-allocated or over-loaded across live projects." />
      <Card title="Period">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="From" htmlFor="rl-from"><input id="rl-from" type="date" className={inputClass} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></FormField>
          <FormField label="To" htmlFor="rl-to"><input id="rl-to" type="date" className={inputClass} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></FormField>
          <FormField label="Weekly hours" htmlFor="rl-wk"><input id="rl-wk" className={inputClass} value={f.weekly} onChange={(e) => setF({ ...f, weekly: e.target.value })} /></FormField>
          <div className="mb-3"><Button onClick={go}>Show</Button></div>
        </div>
        {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
      </Card>
      {applied && <div className="mt-4"><Card title="Load by person">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No one is assigned in this period" /> : (
          <table className="w-full text-sm"><caption className="sr-only">Resource load</caption><thead><tr className="text-left"><th>Person</th><th>Projects</th><th>Allocation</th><th>Planned / capacity</th><th>Load</th></tr></thead>
            <tbody>{data.map((r) => <tr key={r.user_id} className="border-t border-slate-100"><td>User {r.user_id.slice(0, 8)}</td><td>{r.projects.join(", ")}</td><td>{r.allocation_percent}% {r.over_allocated && <Badge tone="red">Over-allocated</Badge>}</td><td>{r.planned_hours} / {r.capacity_hours} h</td><td>{r.load_percent}% {r.overloaded && <Badge tone="red">Overloaded</Badge>}</td></tr>)}</tbody></table>
        )}
      </Card></div>}
    </>
  );
}

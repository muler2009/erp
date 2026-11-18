import { useState } from "react";

import { useGetServiceReportQuery, useListSlaQuery, useSetSlaMutation } from "../../shared/api/endpoints";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames } from "../quality/names";
import { CASE_PRIORITIES } from "./ServiceCasesPage";

const num = (v: number | null, suffix = "") => (v === null ? "–" : `${v}${suffix}`);

/** Whether the range can be sent: both dates optional, but not reversed. */
export function rangeProblem(from: string, to: string): string | null {
  return from && to && to < from ? "The end date is before the start date." : null;
}

function SlaCard({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, error, refetch } = useListSlaQuery();
  const [save] = useSetSlaMutation();
  const [open, setOpen] = useState(false);
  return (
    <Card title="Service levels" actions={canEdit ? <Button variant="secondary" onClick={() => setOpen(true)}>Change a service level</Button> : undefined}>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="Default service levels apply" /> : (
        <table className="min-w-full text-sm"><caption className="sr-only">Service levels</caption>
          <thead><tr className="text-left text-slate-500"><th className="py-1">Priority</th><th className="text-right">First response (hours)</th><th className="text-right">Resolution (hours)</th></tr></thead>
          <tbody>{data.map((p) => <tr key={p.priority} className="border-t border-slate-100"><td className="py-1">{p.priority.toLowerCase()}</td><td className="text-right">{p.first_response_hours}</td><td className="text-right">{p.resolution_hours}</td></tr>)}</tbody></table>
      )}
      {open && (
        <ActionDialog title="Change service level" cta="Save service level" open onClose={() => setOpen(false)} fields={[{ name: "priority", label: "Priority", required: true, options: CASE_PRIORITIES }, { name: "first_response_hours", label: "First response within (hours)", required: true }, { name: "resolution_hours", label: "Resolve within (hours)", required: true }]}
          submit={async (v) => {
            const fr = Number(v.first_response_hours), rs = Number(v.resolution_hours);
            if (!Number.isInteger(fr) || !Number.isInteger(rs) || fr < 1) throw new Error("Hours must be whole numbers, at least 1.");
            if (rs < fr) throw new Error("Resolution time cannot be shorter than the first response time.");
            await save({ priority: v.priority!, first_response_hours: fr, resolution_hours: rs }).unwrap();
          }} />
      )}
    </Card>
  );
}

export function ServiceReportPage() {
  const { can } = useAccess();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const problem = rangeProblem(from, to);
  const { data, isLoading, error, refetch } = useGetServiceReportQuery({ ...(from ? { from } : {}), ...(to ? { to } : {}) }, { skip: !!problem });
  const nameOf = useUserNames();
  const stat = (k: string, v: string | number) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="text-lg">{v}</dd></div>;
  return (
    <>
      <PageHeader title="Service report" description="How quickly cases are handled and how customers rate it." />
      <div className="mb-3 flex gap-4 text-sm">
        <label>From <input type="date" aria-label="From" className={`${inputClass} w-auto`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" aria-label="To" className={`${inputClass} w-auto`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {problem ? <EmptyState title="Fix the date range to run the report" hint={problem} /> : isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
        <>
          <Card title="Summary">
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {stat("Cases", data.total)}{stat("Open", data.open)}{stat("Complaints", data.complaints)}{stat("Escalated", data.escalated)}
              {stat("Average resolution", num(data.avg_resolution_hours, " h"))}{stat("Resolved on time", num(data.sla_met_percent, "%"))}{stat("Customer rating", num(data.avg_satisfaction, " / 5"))}
            </dl>
          </Card>
          <Card title="By category">{Object.keys(data.by_category).length ? <ul className="text-sm">{Object.entries(data.by_category).map(([k, n]) => <li key={k}>{k}: {n}</li>)}</ul> : <EmptyState title="No cases in this period" />}</Card>
          <Card title="By month">{Object.keys(data.by_month).length ? <ul className="text-sm">{Object.entries(data.by_month).map(([k, n]) => <li key={k}>{k}: {n}</li>)}</ul> : <EmptyState title="No cases in this period" />}</Card>
          <Card title="By handler">{Object.keys(data.by_owner).length ? <ul className="text-sm">{Object.entries(data.by_owner).map(([k, v]) => <li key={k}>{nameOf(k)}: {v.resolved} of {v.handled} resolved</li>)}</ul> : <EmptyState title="No handled cases in this period" />}</Card>
        </>
      )}
      <SlaCard canEdit={can("crm.assign")} />
    </>
  );
}

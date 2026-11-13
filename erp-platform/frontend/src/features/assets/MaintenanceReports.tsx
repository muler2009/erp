import { useState } from "react";

import { useCreateMaintenancePlanMutation, useGetBreakdownAnalysisQuery, useGetMaintCostsQuery, useGetMaintScheduleQuery, useGetUnavailableAssetsQuery, useListFixedAssetsQuery, useListMaintenancePlansQuery, useRecordMeterMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

const DEC = /^\d+(\.\d{1,4})?$/;

export function validatePlan(f: { asset: string; name: string; trigger: string; kind: string; interval_days: string; interval_usage: string }): string | null {
  if (!f.asset) return "Choose the asset.";
  if (!f.name.trim()) return "Name the plan.";
  if (f.trigger === "TIME" && (!/^\d+$/.test(f.interval_days.trim()) || Number(f.interval_days) < 1)) return "A time-based plan needs an interval of at least 1 day.";
  if (f.trigger === "USAGE" && (!DEC.test(f.interval_usage.trim()) || Number(f.interval_usage) <= 0)) return "A usage-based plan needs a positive interval in hours or kilometres.";
  return null;
}
export function validateReportPeriod(from: string, to: string): string | null {
  if (!from || !to) return "Choose both dates.";
  if (to < from) return "The end date must be on or after the start date.";
  return null;
}

export function MaintenancePlans() {
  const { can } = useAccess();
  const manage = can("assets.maintenance.manage");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListMaintenancePlansQuery({ cursor });
  const assets = useListFixedAssetsQuery({}, { skip: !manage });
  const [create] = useCreateMaintenancePlanMutation();
  const [meter] = useRecordMeterMutation();
  const [open, setOpen] = useState(false);
  const [metering, setMetering] = useState(false);
  const [f, setF] = useState({ asset: "", name: "", trigger: "TIME", kind: "PREVENTIVE", interval_days: "", interval_usage: "", estimated_cost: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validatePlan(f);
    if (p) { setErr(p); return; }
    setErr(null);
    try {
      await create({ asset: f.asset, name: f.name.trim(), trigger: f.trigger, kind: f.kind, ...(f.trigger === "TIME" ? { interval_days: Number(f.interval_days) } : { interval_usage: f.interval_usage.trim() }), ...(f.estimated_cost.trim() ? { estimated_cost: f.estimated_cost.trim() } : {}) }).unwrap();
      setOpen(false);
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="Maintenance plans">
      {manage && <div className="mb-2 flex gap-2"><Button onClick={() => setOpen(true)}>New plan</Button><Button variant="secondary" onClick={() => setMetering(true)}>Record a meter reading</Button></div>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No plans yet" /> : (
        <table className="w-full text-sm"><caption className="sr-only">Maintenance plans</caption><thead><tr className="text-left"><th>Plan</th><th>Trigger</th><th>Next due</th><th>Last done</th><th>Status</th></tr></thead>
          <tbody>{data.results.map((p) => <tr key={p.id} className="border-t border-slate-100"><td>{p.name} <span className="text-slate-500">({pretty(p.kind)})</span></td><td>{p.trigger === "TIME" ? `Every ${p.interval_days} days` : `Every ${p.interval_usage} units`}</td><td>{p.trigger === "TIME" ? (p.next_due_on ?? "–") : `At meter ${p.next_due_meter ?? "–"}`}</td><td>{p.last_done_on ?? "–"}</td><td><Badge tone={p.is_active ? "green" : "slate"}>{p.is_active ? "Active" : "Inactive"}</Badge></td></tr>)}</tbody></table>
      )}
      {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      <Modal title="New maintenance plan" open={open} onClose={() => setOpen(false)}>
        <FormField label="Asset" htmlFor="pl-asset"><select id="pl-asset" className={inputClass} value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}><option value="">Choose…</option>{assets.data?.results.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></FormField>
        <FormField label="Name" htmlFor="pl-name"><input id="pl-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Kind" htmlFor="pl-kind"><select id="pl-kind" className={inputClass} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="PREVENTIVE">Preventive</option><option value="INSPECTION">Inspection</option></select></FormField>
          <FormField label="Triggered by" htmlFor="pl-trig"><select id="pl-trig" className={inputClass} value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}><option value="TIME">Time</option><option value="USAGE">Usage (meter)</option></select></FormField>
        </div>
        {f.trigger === "TIME" ? <FormField label="Interval (days)" htmlFor="pl-days"><input id="pl-days" className={inputClass} value={f.interval_days} onChange={(e) => setF({ ...f, interval_days: e.target.value })} /></FormField> : <FormField label="Interval (hours or km)" htmlFor="pl-use"><input id="pl-use" className={inputClass} value={f.interval_usage} onChange={(e) => setF({ ...f, interval_usage: e.target.value })} /></FormField>}
        <FormField label="Estimated cost" htmlFor="pl-cost"><input id="pl-cost" className={inputClass} value={f.estimated_cost} onChange={(e) => setF({ ...f, estimated_cost: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Create plan</Button></div>
      </Modal>
      <ActionDialog title="Record a meter reading" open={metering} onClose={() => setMetering(false)} cta="Record reading"
        fields={[{ name: "asset", label: "Asset", required: true, options: (assets.data?.results ?? []).map((a) => [a.id, `${a.number} ${a.name}`] as [string, string]) }, { name: "reading", label: "Reading", required: true }, { name: "read_on", label: "Read on", type: "date" }]}
        submit={async (v) => { if (!DEC.test((v.reading ?? "").trim())) throw new Error("Enter the reading as a number."); await meter({ id: v.asset ?? "", reading: (v.reading ?? "").trim(), ...(v.read_on ? { read_on: v.read_on } : {}) }).unwrap(); }} />
    </Card>
  );
}

function Costs() {
  const today = new Date().toISOString().slice(0, 10);
  const [p, setP] = useState({ from: `${today.slice(0, 4)}-01-01`, to: today, group_by: "asset" });
  const bad = validateReportPeriod(p.from, p.to);
  const costs = useGetMaintCostsQuery(p, { skip: !!bad });
  const bd = useGetBreakdownAnalysisQuery({ from: p.from, to: p.to }, { skip: !!bad });
  return (
    <>
      <Card title="Period">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="From" htmlFor="mr-from"><input id="mr-from" type="date" className={inputClass} value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} /></FormField>
          <FormField label="To" htmlFor="mr-to"><input id="mr-to" type="date" className={inputClass} value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} /></FormField>
          <FormField label="Group costs by" htmlFor="mr-grp"><select id="mr-grp" className={inputClass} value={p.group_by} onChange={(e) => setP({ ...p, group_by: e.target.value })}><option value="asset">Asset</option><option value="category">Category</option><option value="kind">Kind of work</option></select></FormField>
        </div>
        {bad && <p role="alert" className="mt-2 text-sm text-red-700">{bad}</p>}
      </Card>
      <div className="mt-4"><Card title="Verified maintenance cost">
        {bad ? null : costs.isLoading ? <Spinner /> : costs.error ? <ErrorState error={costs.error} onRetry={costs.refetch} /> : !costs.data?.length ? <EmptyState title="No verified work in this period" /> : (
          <table className="w-full text-sm"><caption className="sr-only">Maintenance cost</caption><thead><tr className="text-left"><th>{pretty(p.group_by.toUpperCase())}</th><th className="text-right">Orders</th><th className="text-right">Labour</th><th className="text-right">Parts</th><th className="text-right">External</th><th className="text-right">Total</th></tr></thead>
            <tbody>{costs.data.map((r) => <tr key={r.key} className="border-t border-slate-100"><td>{r.key}</td><td className="text-right">{r.work_orders}</td><td className="text-right">{formatMoney(r.labor)}</td><td className="text-right">{formatMoney(r.material)}</td><td className="text-right">{formatMoney(r.external)}</td><td className="text-right font-semibold">{formatMoney(r.total)}</td></tr>)}</tbody></table>
        )}
      </Card></div>
      <div className="mt-4"><Card title="Breakdown analysis">
        {bad ? null : bd.isLoading ? <Spinner /> : bd.error ? <ErrorState error={bd.error} onRetry={bd.refetch} /> : !bd.data?.length ? <EmptyState title="No breakdowns in this period" /> : (
          <table className="w-full text-sm"><caption className="sr-only">Breakdown analysis</caption><thead><tr className="text-left"><th>Asset</th><th className="text-right">Breakdowns</th><th className="text-right">Downtime (h)</th><th className="text-right">MTTR (h)</th><th className="text-right">MTBF (h)</th><th>Repeat failures</th></tr></thead>
            <tbody>{bd.data.map((r) => <tr key={r.asset} className="border-t border-slate-100"><td>{r.asset} {r.name}</td><td className="text-right">{r.breakdowns}</td><td className="text-right">{r.downtime_hours}</td><td className="text-right">{r.mttr_hours ?? "–"}</td><td className="text-right">{r.mtbf_hours}</td><td>{r.recurring ? <Badge tone="red">Recurring</Badge> : null} {r.repeated_failure_codes.join(", ")}</td></tr>)}</tbody></table>
        )}
      </Card></div>
    </>
  );
}

export function MaintenanceReports() {
  const [days, setDays] = useState(30);
  const sched = useGetMaintScheduleQuery(days);
  const down = useGetUnavailableAssetsQuery();
  return (
    <div className="grid gap-4">
      <Card title="Out of service">
        {down.isLoading ? <Spinner /> : down.error ? <ErrorState error={down.error} onRetry={down.refetch} /> : !down.data?.length ? <EmptyState title="Nothing is out of service for maintenance" /> : (
          <ul className="text-sm">{down.data.map((r) => <li key={r.asset} className="border-b border-slate-100 py-1">{r.asset} {r.name} — since {r.since}{r.open_work_orders.length ? ` · ${r.open_work_orders.join(", ")}` : ""}</li>)}</ul>
        )}
      </Card>
      <Card title="Coming due">
        <label className="mb-2 block text-sm">Look ahead <select aria-label="Look ahead days" className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
        {sched.isLoading ? <Spinner /> : sched.error ? <ErrorState error={sched.error} onRetry={sched.refetch} /> : !sched.data?.length ? <EmptyState title="Nothing due in this window" /> : (
          <ul className="text-sm">{sched.data.map((r) => <li key={`${r.plan}${r.asset}`} className="border-b border-slate-100 py-1">{r.asset} — {r.plan}: {r.trigger === "TIME" ? `due ${r.next_due_on}` : `meter ${r.meter} of ${r.next_due_meter}`}</li>)}</ul>
        )}
      </Card>
      <Costs />
    </div>
  );
}

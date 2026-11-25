import { useState } from "react";

import { useAllocateAssetMutation, useEndAllocationMutation, useGetProjectUsageQuery, useGetUtilizationQuery, useListAllocationsQuery, useListDepartmentsQuery, useListFixedAssetsQuery, useListProjectsQuery, useLogAssetUsageMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { AssetAllocation } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

const DEC = /^\d+(\.\d{1,2})?$/;

export function validateAllocation(f: { asset: string; target_kind: string; target: string; start_on: string; end_on: string; share: string }): string | null {
  if (!f.asset) return "Choose the asset.";
  if (!f.target) return `Choose the ${f.target_kind === "PROJECT" ? "project" : "department"}.`;
  if (!f.start_on) return "Enter the start date.";
  if (f.end_on && f.end_on < f.start_on) return "The allocation cannot end before it starts.";
  if (!DEC.test(f.share.trim()) || Number(f.share) <= 0 || Number(f.share) > 100) return "The share must be above 0 and at most 100 percent.";
  return null;
}
export function validateHours(hours: string): string | null {
  if (!DEC.test(hours.trim()) || Number(hours) <= 0 || Number(hours) > 24) return "Hours must be above 0 and at most 24.";
  return null;
}
export function validateUsagePeriod(from: string, to: string, daily: string, below: string): string | null {
  if (!from || !to) return "Choose both dates.";
  if (to < from) return "The end date must be on or after the start date.";
  if (!DEC.test(daily.trim()) || Number(daily) <= 0 || Number(daily) > 24) return "Daily hours must be between 1 and 24.";
  if (!/^\d+$/.test(below.trim()) || Number(below) > 100) return "The under-use threshold is a whole percentage up to 100.";
  return null;
}

function Allocations() {
  const { can } = useAccess();
  const manage = can("assets.custody.manage");
  const [asset, setAsset] = useState("");
  const { data, isLoading, error, refetch } = useListAllocationsQuery({ asset: asset || undefined });
  const assets = useListFixedAssetsQuery({});
  const projects = useListProjectsQuery({}, { skip: !manage });
  const depts = useListDepartmentsQuery(undefined, { skip: !manage });
  const [allocate] = useAllocateAssetMutation();
  const [end] = useEndAllocationMutation();
  const [log] = useLogAssetUsageMutation();
  const [open, setOpen] = useState(false);
  const empty = { asset: "", target_kind: "PROJECT", target: "", start_on: new Date().toISOString().slice(0, 10), end_on: "", share: "100" };
  const [f, setF] = useState(empty);
  const [ferr, setFerr] = useState<string | null>(null);
  const [ending, setEnding] = useState<AssetAllocation | null>(null);
  const [logging, setLogging] = useState<AssetAllocation | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const targetName = (a: AssetAllocation) => a.target_kind === "PROJECT" ? projects.data?.results.find((p) => p.id === a.target_id)?.name ?? a.target_id : a.target_kind === "DEPARTMENT" ? depts.data?.results.find((d) => d.id === a.target_id)?.name ?? a.target_id : a.target_id;
  const go = async () => {
    const p = validateAllocation(f);
    if (p) { setFerr(p); return; }
    setFerr(null);
    try { await allocate({ asset: f.asset, target_kind: f.target_kind, target_id: f.target, start_on: f.start_on, share_percent: f.share.trim(), ...(f.end_on ? { end_on: f.end_on } : {}) }).unwrap(); setOpen(false); setF(empty); } catch (e) { setFerr(errorMessage(e)); }
  };
  return (
    <Card title="Allocations">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <label className="text-sm">Asset <select aria-label="Filter by asset" className={inputClass} value={asset} onChange={(e) => setAsset(e.target.value)}><option value="">All</option>{assets.data?.results.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></label>
        {manage && <Button onClick={() => setOpen(true)}>Allocate an asset</Button>}
      </div>
      {msg && <p role="status" className="mb-2 text-sm text-green-700">{msg}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No allocations" /> : (
        <ul>{data.results.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 border-b border-slate-200 py-2 text-sm">
            <span className="font-medium">{a.asset.number}</span><Badge tone="slate">{pretty(a.target_kind)}</Badge><span>{targetName(a)}</span><span>{a.share_percent}%</span><span className="text-slate-500">{a.start_on} to {a.end_on ?? "open"}</span><Badge tone={a.status === "ACTIVE" ? "green" : "slate"}>{pretty(a.status)}</Badge>
            {manage && a.status === "ACTIVE" && <><Button variant="secondary" onClick={() => setLogging(a)}>{`Log usage ${a.asset.number}`}</Button><Button variant="secondary" onClick={() => setEnding(a)}>{`End allocation ${a.asset.number}`}</Button></>}
          </li>))}</ul>
      )}
      <Modal title="Allocate an asset" open={open} onClose={() => setOpen(false)}>
        <FormField label="Asset" htmlFor="al-asset"><select id="al-asset" className={inputClass} value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}><option value="">Choose…</option>{assets.data?.results.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="To a" htmlFor="al-kind"><select id="al-kind" className={inputClass} value={f.target_kind} onChange={(e) => setF({ ...f, target_kind: e.target.value, target: "" })}><option value="PROJECT">Project</option><option value="DEPARTMENT">Department</option></select></FormField>
          <FormField label={f.target_kind === "PROJECT" ? "Project" : "Department"} htmlFor="al-target"><select id="al-target" className={inputClass} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })}><option value="">Choose…</option>{(f.target_kind === "PROJECT" ? projects.data?.results : depts.data?.results)?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></FormField>
          <FormField label="Starts" htmlFor="al-start"><input id="al-start" type="date" className={inputClass} value={f.start_on} onChange={(e) => setF({ ...f, start_on: e.target.value })} /></FormField>
          <FormField label="Ends" htmlFor="al-end"><input id="al-end" type="date" className={inputClass} value={f.end_on} onChange={(e) => setF({ ...f, end_on: e.target.value })} /></FormField>
          <FormField label="Share (%)" htmlFor="al-share"><input id="al-share" className={inputClass} value={f.share} onChange={(e) => setF({ ...f, share: e.target.value })} /></FormField>
        </div>
        {ferr && <p role="alert" className="mb-3 text-sm text-red-700">{ferr}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Allocate</Button></div>
      </Modal>
      <ActionDialog key={`en${ending?.id}`} title="End allocation" open={!!ending} onClose={() => setEnding(null)} cta="End allocation" fields={[{ name: "ended_on", label: "Ended on", type: "date" }]} submit={(v) => end({ id: ending!.id, ...(v.ended_on ? { ended_on: v.ended_on } : {}) }).unwrap()} />
      <ActionDialog key={`lg${logging?.id}`} title="Log usage" open={!!logging} onClose={() => setLogging(null)} cta="Log hours" fields={[{ name: "hours", label: "Hours", required: true }, { name: "logged_on", label: "Day", type: "date" }]}
        submit={async (v) => { const p = validateHours(v.hours ?? ""); if (p) throw new Error(p); const r = await log({ id: logging!.asset.id, hours: (v.hours ?? "").trim(), allocation: logging!.id, ...(v.logged_on ? { logged_on: v.logged_on } : {}) }).unwrap(); setMsg(`Logged ${r.hours} hours on ${logging!.asset.number}.`); }} />
    </Card>
  );
}

function Utilization() {
  const today = new Date().toISOString().slice(0, 10);
  const [p, setP] = useState({ from: new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10), to: today, daily_hours: "8", below: "20" });
  const bad = validateUsagePeriod(p.from, p.to, p.daily_hours, p.below);
  const util = useGetUtilizationQuery(p, { skip: !!bad });
  const proj = useGetProjectUsageQuery({ from: p.from, to: p.to }, { skip: !!bad });
  const projects = useListProjectsQuery({});
  const depts = useListDepartmentsQuery();
  const nameOf = (kind: string, id: string) => kind === "PROJECT" ? projects.data?.results.find((x) => x.id === id)?.name ?? id : kind === "DEPARTMENT" ? depts.data?.results.find((x) => x.id === id)?.name ?? id : id;
  return (
    <div className="grid gap-4">
      <Card title="Period">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="From" htmlFor="ut-from"><input id="ut-from" type="date" className={inputClass} value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} /></FormField>
          <FormField label="To" htmlFor="ut-to"><input id="ut-to" type="date" className={inputClass} value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} /></FormField>
          <FormField label="Hours available per day" htmlFor="ut-daily"><input id="ut-daily" className={inputClass} value={p.daily_hours} onChange={(e) => setP({ ...p, daily_hours: e.target.value })} /></FormField>
          <FormField label="Under-used below (%)" htmlFor="ut-below"><input id="ut-below" className={inputClass} value={p.below} onChange={(e) => setP({ ...p, below: e.target.value })} /></FormField>
        </div>
        {bad && <p role="alert" className="mt-2 text-sm text-red-700">{bad}</p>}
      </Card>
      <Card title="Utilization">
        {bad ? null : util.isLoading ? <Spinner /> : util.error || !util.data ? <ErrorState error={util.error} onRetry={util.refetch} /> : !util.data.rows.length ? <EmptyState title="No assets in service" /> : (
          <>
            <p className="mb-2 text-sm text-slate-600">{util.data.idle} idle · {util.data.underutilized} under-used</p>
            <table className="w-full text-sm"><caption className="sr-only">Utilization</caption><thead><tr className="text-left"><th>Asset</th><th>Category</th><th className="text-right">Hours used</th><th className="text-right">Available</th><th className="text-right">Utilization</th><th></th></tr></thead>
              <tbody>{util.data.rows.map((r) => <tr key={r.asset} className="border-t border-slate-100"><td>{r.asset} {r.name}</td><td>{r.category}</td><td className="text-right">{r.hours}</td><td className="text-right">{r.available_hours}</td><td className="text-right">{r.utilization_percent}%</td><td>{r.idle ? <Badge tone="red">Idle</Badge> : r.underutilized ? <Badge tone="amber">Under-used</Badge> : null}</td></tr>)}</tbody></table>
          </>
        )}
      </Card>
      <Card title="Hours by project and department">
        {bad ? null : proj.isLoading ? <Spinner /> : proj.error ? <ErrorState error={proj.error} onRetry={proj.refetch} /> : !proj.data?.length ? <EmptyState title="No allocated usage in this period" /> : (
          <ul className="text-sm">{proj.data.map((r) => <li key={r.target_kind + r.target_id} className="border-b border-slate-100 py-1">{pretty(r.target_kind)}: {nameOf(r.target_kind, r.target_id)} — <strong>{r.hours} h</strong></li>)}</ul>
        )}
      </Card>
    </div>
  );
}

export function AllocationsPage() {
  const [tab, setTab] = useState<"alloc" | "util">("alloc");
  return (
    <>
      <PageHeader title="Asset allocation and use" description="Share assets across projects and departments, log hours, and see what sits idle." />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2 border-b border-slate-200">
        {([["alloc", "Allocations"], ["util", "Utilization"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-slate-900 font-semibold" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "alloc" ? <Allocations /> : <Utilization />}
    </>
  );
}

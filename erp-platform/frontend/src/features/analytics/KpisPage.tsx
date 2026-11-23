import { useState } from "react";

import { useCreateBiKpiMutation, useGetBiCatalogQuery, useGetBiKpiSeriesQuery, useListBiKpisQuery, useUpdateBiKpiMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { BiKpiInput, KpiView } from "../../shared/api/types";
import { formatNumber } from "../../shared/lib/format";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { PERIODS } from "./ReportsPage";

export const STATUS_TONE = { GOOD: "green", WARN: "amber", CRITICAL: "red", NO_DATA: "slate", NO_TARGET: "slate" } as const;
export const STATUS_LABEL = { GOOD: "On target", WARN: "Warning", CRITICAL: "Critical", NO_DATA: "No data", NO_TARGET: "No target set" } as const;

const num = (v: string): number | null => (v.trim() === "" || Number.isNaN(Number(v)) ? NaN : Number(v));

/** Thresholds must run critical, warning, target in the better direction. Returns what is wrong, or null. */
export function kpiProblem(name: string, direction: string, target: string, warn: string, critical: string, code?: string, metric?: string): string | null {
  if (code !== undefined && !code.trim()) return "Give the KPI a code.";
  if (!name.trim()) return "Give the KPI a name.";
  if (metric !== undefined && !metric) return "Choose what to measure.";
  const vals: number[] = [];
  for (const [label, v] of [["Critical level", critical], ["Warning level", warn], ["Target", target]] as const) {
    if (v.trim() === "") continue;
    const n = num(v);
    if (n === null || Number.isNaN(n)) return `${label} must be a number.`;
    vals.push(n);
  }
  const asc = [...vals].sort((a, b) => a - b);
  const ok = direction === "HIGHER" ? vals.every((v, i) => v === asc[i]) : vals.every((v, i) => v === asc[asc.length - 1 - i]);
  return ok ? null : "Levels must run critical, warning, target in the better direction.";
}

function KpiForm({ kpi, open, onClose }: { kpi: KpiView | null; open: boolean; onClose: () => void }) {
  const cat = useGetBiCatalogQuery(undefined, { skip: !open || !!kpi });
  const [create, creating] = useCreateBiKpiMutation();
  const [update, updating] = useUpdateBiKpiMutation();
  const [code, setCode] = useState("");
  const [name, setName] = useState(kpi?.name ?? "");
  const [metric, setMetric] = useState("");
  const [period, setPeriod] = useState(String(kpi?.params?.period ?? ""));
  const [direction, setDirection] = useState<string>(kpi?.direction ?? "HIGHER");
  const [target, setTarget] = useState(kpi?.target ?? "");
  const [warn, setWarn] = useState(kpi?.warn_at ?? "");
  const [crit, setCrit] = useState(kpi?.critical_at ?? "");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = kpiProblem(name, direction, target, warn, crit, kpi ? undefined : code, kpi ? undefined : metric);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: BiKpiInput = { name: name.trim(), direction, target: target.trim() || null, warn_at: warn.trim() || null, critical_at: crit.trim() || null, params: { ...(kpi?.params ?? {}), ...(period ? { period } : {}) } };
    if (!period && body.params) delete body.params.period;
    try {
      if (kpi) await update({ id: kpi.id, body }).unwrap();
      else await create({ ...body, code: code.trim(), metric }).unwrap();
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={kpi ? `Change ${kpi.name}` : "Add KPI"} open={open} onClose={onClose}>
      {!kpi && <FormField label="Code" htmlFor="kp-code"><input id="kp-code" className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} /></FormField>}
      <FormField label="Name" htmlFor="kp-name"><input id="kp-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></FormField>
      {!kpi && (
        <FormField label="Measure" htmlFor="kp-metric">
          <select id="kp-metric" className={inputClass} value={metric} onChange={(e) => { setMetric(e.target.value); const m = cat.data?.metrics.find((x) => x.code === e.target.value); if (m) setDirection(m.direction); }}>
            <option value="">Choose…</option>
            {(cat.data?.metrics ?? []).map((m) => <option key={m.code} value={m.code}>{m.module} — {m.label}</option>)}
          </select>
        </FormField>
      )}
      <FormField label="Period" htmlFor="kp-period"><select id="kp-period" className={inputClass} value={period} onChange={(e) => setPeriod(e.target.value)}><option value="">Not period-based</option>{PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
      <FormField label="Better when" htmlFor="kp-dir"><select id="kp-dir" className={inputClass} value={direction} onChange={(e) => setDirection(e.target.value)}><option value="HIGHER">Higher</option><option value="LOWER">Lower</option></select></FormField>
      <div className="grid grid-cols-3 gap-2">
        <FormField label="Target" htmlFor="kp-t"><input id="kp-t" inputMode="decimal" className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)} /></FormField>
        <FormField label="Warning level" htmlFor="kp-w"><input id="kp-w" inputMode="decimal" className={inputClass} value={warn} onChange={(e) => setWarn(e.target.value)} /></FormField>
        <FormField label="Critical level" htmlFor="kp-c"><input id="kp-c" inputMode="decimal" className={inputClass} value={crit} onChange={(e) => setCrit(e.target.value)} /></FormField>
      </div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={creating.isLoading || updating.isLoading} onClick={() => void go()}>{kpi ? "Save changes" : "Add KPI"}</Button></div>
    </Modal>
  );
}

function Series({ kpi, onClose }: { kpi: KpiView; onClose: () => void }) {
  const [days, setDays] = useState(30);
  const q = useGetBiKpiSeriesQuery({ id: kpi.id, days });
  return (
    <Modal title={`${kpi.name} over time`} open onClose={onClose}>
      <FormField label="Show" htmlFor="ks-days"><select id="ks-days" className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select></FormField>
      {q.isFetching && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data?.length === 0 && <EmptyState title="No history yet" hint="Values are recorded once a day." />}
      <ol className="max-h-72 overflow-y-auto text-sm" aria-label="Recorded values">
        {q.data?.map((s) => <li key={s.as_of} className="flex justify-between border-t border-slate-100 py-1"><span>{s.as_of}</span><span>{s.value != null ? formatNumber(s.value) : "—"} {kpi.unit}</span><Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge></li>)}
      </ol>
      <div className="mt-3 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Modal>
  );
}

export function KpisPage() {
  const { can } = useAccess();
  const manage = can("analytics.kpi.manage");
  const [module, setModule] = useState("");
  const [all, setAll] = useState(false);
  const list = useListBiKpisQuery({ module: module || undefined, all: manage && all });
  const allKpis = useListBiKpisQuery();
  const [update] = useUpdateBiKpiMutation();
  const [editing, setEditing] = useState<KpiView | null>(null);
  const [adding, setAdding] = useState(false);
  const [series, setSeries] = useState<KpiView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const modules = [...new Set((allKpis.data ?? []).map((k) => k.module).filter((m): m is string => !!m))].sort();
  return (
    <>
      <PageHeader title="KPIs" description="Key figures with a target and traffic-light status." actions={manage ? <Button onClick={() => setAdding(true)}>Add KPI</Button> : undefined} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <FormField label="Area" htmlFor="kpi-mod"><select id="kpi-mod" className={inputClass} value={module} onChange={(e) => setModule(e.target.value)}><option value="">All areas</option>{modules.map((m) => <option key={m} value={m}>{m}</option>)}</select></FormField>
        {manage && <label className="mb-2 flex items-center gap-1 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Include switched-off KPIs</label>}
      </div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {list.isLoading && <Spinner />}
      {list.error && <ErrorState error={list.error} onRetry={list.refetch} />}
      {list.data?.length === 0 && <Card><EmptyState title="No KPIs to show" hint={manage ? "Add one, or create the default dashboards to get the standard set." : undefined} /></Card>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {list.data?.map((k) => {
          const st = k.latest?.status ?? "NO_DATA";
          return (
            <Card key={k.id} title={k.name} actions={k.is_active === false ? <Badge tone="slate">Switched off</Badge> : undefined}>
              {k.restricted ? <p className="text-sm text-slate-500">You do not have access to this data.</p> : (
                <>
                  <p className="text-3xl font-semibold text-slate-900">{k.latest?.value != null ? formatNumber(k.latest.value) : "—"} <span className="text-base font-normal text-slate-500">{k.unit}</span></p>
                  <div className="mt-2 flex items-center gap-2"><Badge tone={STATUS_TONE[st]}>{STATUS_LABEL[st]}</Badge>{k.change_pct != null && <span className="text-xs text-slate-500">{k.change_pct}% vs previous</span>}</div>
                  {k.target != null && <p className="mt-1 text-xs text-slate-500">Target {formatNumber(k.target)}; better when {k.direction === "HIGHER" ? "higher" : "lower"}.</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="secondary" aria-label={`History of ${k.name}`} onClick={() => setSeries(k)}>History</Button>
                    {manage && <Button variant="secondary" aria-label={`Change ${k.name}`} onClick={() => setEditing(k)}>Change</Button>}
                    {manage && <Button variant="secondary" aria-label={`${k.is_active === false ? "Switch on" : "Switch off"} ${k.name}`} onClick={() => { setErr(null); update({ id: k.id, body: { is_active: k.is_active === false } }).unwrap().catch((e) => setErr(errorMessage(e))); }}>{k.is_active === false ? "Switch on" : "Switch off"}</Button>}
                  </div>
                </>
              )}
            </Card>
          );
        })}
      </div>
      {adding && <KpiForm key="new" kpi={null} open onClose={() => setAdding(false)} />}
      {editing && <KpiForm key={editing.id} kpi={editing} open onClose={() => setEditing(null)} />}
      {series && <Series kpi={series} onClose={() => setSeries(null)} />}
    </>
  );
}

import { useState } from "react";

import { useAddBiWidgetMutation, useCreateBiDashboardMutation, useGetBiCatalogQuery, useListBiKpisQuery, useListRolesQuery, useUpdateBiDashboardMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DashboardSummary } from "../../shared/api/types";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";
import { PERIODS } from "./ReportsPage";

export const VISIBILITY: [string, string][] = [["PRIVATE", "Only me"], ["ALL", "Everyone with analytics access"], ["ROLES", "Only people with chosen roles"]];

export function dashboardProblem(name: string, visibility: string, roles: string[], code?: string): string | null {
  if (code !== undefined && !/^[a-z0-9_-]+$/i.test(code.trim())) return "Give the dashboard a short code (letters, numbers, - or _).";
  if (!name.trim()) return "Give the dashboard a name.";
  if (visibility === "ROLES" && roles.length === 0) return "Choose the roles that can see it.";
  return null;
}

export function widgetProblem(kind: string, kpi: string, days: string, dataset: string, limit: string): string | null {
  if (!kind) return "Choose the kind of widget.";
  if ((kind === "KPI" || kind === "TREND") && !kpi) return "Choose a KPI.";
  if (kind === "TREND" && !(Number(days) >= 1 && Number(days) <= 730)) return "Days must be 1 to 730.";
  if (kind === "DATASET") {
    if (!dataset) return "Choose a data set.";
    if (!(Number(limit) >= 1 && Number(limit) <= 200)) return "Rows must be 1 to 200.";
  }
  return null;
}

/** Create a dashboard, or change the name, audience and archive state of an existing one. */
export function DashboardDialog({ dashboard, open, onClose, onSaved }: { dashboard: DashboardSummary | null; open: boolean; onClose: () => void; onSaved?: (id: string) => void }) {
  const roles = useListRolesQuery(undefined, { skip: !open });
  const [create] = useCreateBiDashboardMutation();
  const [update] = useUpdateBiDashboardMutation();
  const [code, setCode] = useState("");
  const [name, setName] = useState(dashboard?.name ?? "");
  const [description, setDescription] = useState(dashboard?.description ?? "");
  const [vis, setVis] = useState(dashboard?.visibility ?? "ALL");
  const [picked, setPicked] = useState<string[]>(dashboard?.roles ?? []);
  const [err, setErr] = useState<string | null>(null);
  const save = async (extra: { is_active?: boolean } = {}) => {
    const p = dashboardProblem(name, vis, picked, dashboard ? undefined : code);
    if (p) { setErr(p); return; }
    setErr(null);
    try {
      const body = { name: name.trim(), description, visibility: vis, roles: vis === "ROLES" ? picked : [], ...extra };
      if (dashboard) { await update({ id: dashboard.id, body }).unwrap(); onSaved?.(dashboard.id); }
      else { const r = await create({ ...body, code: code.trim() }).unwrap(); onSaved?.(r.id); }
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={dashboard ? "Change dashboard" : "New dashboard"} open={open} onClose={onClose}>
      {!dashboard && <FormField label="Code" htmlFor="db-code"><input id="db-code" className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} /></FormField>}
      <FormField label="Name" htmlFor="db-name"><input id="db-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></FormField>
      <FormField label="Description" htmlFor="db-desc"><input id="db-desc" className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} /></FormField>
      <FormField label="Who can see it" htmlFor="db-vis"><select id="db-vis" className={inputClass} value={vis} onChange={(e) => setVis(e.target.value as "PRIVATE" | "ALL" | "ROLES")}>{VISIBILITY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
      {vis === "ROLES" && (
        <fieldset className="mb-3"><legend className="text-sm font-medium text-slate-700">Roles</legend>
          {(roles.data ?? []).map((r) => <label key={r.id} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={picked.includes(r.name)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.name] : picked.filter((x) => x !== r.name))} />{r.display_name}</label>)}
        </fieldset>
      )}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2">
        {dashboard && !dashboard.is_system && <Button variant="danger" onClick={() => void save({ is_active: false })}>Archive dashboard</Button>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void save()}>{dashboard ? "Save changes" : "Create dashboard"}</Button>
      </div>
    </Modal>
  );
}

export function AddWidgetDialog({ dashboard, open, onClose }: { dashboard: string; open: boolean; onClose: () => void }) {
  const kpis = useListBiKpisQuery(undefined, { skip: !open });
  const cat = useGetBiCatalogQuery(undefined, { skip: !open });
  const [add] = useAddBiWidgetMutation();
  const [kind, setKind] = useState("KPI");
  const [kpi, setKpi] = useState("");
  const [days, setDays] = useState("30");
  const [dataset, setDataset] = useState("");
  const [limit, setLimit] = useState("10");
  const [period, setPeriod] = useState("");
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = widgetProblem(kind, kpi, days, dataset, limit);
    if (p) { setErr(p); return; }
    setErr(null);
    const k = kpis.data?.find((x) => x.code === kpi);
    const ds = cat.data?.datasets.find((x) => x.code === dataset);
    const config = kind === "DATASET" ? { dataset, limit: Number(limit), ...(period ? { period } : {}) } : { kpi, ...(kind === "TREND" ? { days: Number(days) } : {}) };
    try {
      await add({ dashboard, body: { kind, title: title.trim() || (kind === "DATASET" ? ds?.title ?? dataset : k?.name ?? kpi), config } }).unwrap();
      setTitle(""); onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Add to dashboard" open={open} onClose={onClose}>
      <FormField label="Kind" htmlFor="aw-kind"><select id="aw-kind" className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}><option value="KPI">One key figure</option><option value="TREND">Key figure over time</option><option value="DATASET">Table of figures</option></select></FormField>
      {kind !== "DATASET" && <FormField label="KPI" htmlFor="aw-kpi"><select id="aw-kpi" className={inputClass} value={kpi} onChange={(e) => setKpi(e.target.value)}><option value="">Choose…</option>{(kpis.data ?? []).map((k) => <option key={k.code} value={k.code}>{k.name}</option>)}</select></FormField>}
      {kind === "TREND" && <FormField label="Days to show" htmlFor="aw-days"><input id="aw-days" type="number" className={inputClass} value={days} onChange={(e) => setDays(e.target.value)} /></FormField>}
      {kind === "DATASET" && (
        <>
          <FormField label="Data set" htmlFor="aw-ds"><select id="aw-ds" className={inputClass} value={dataset} onChange={(e) => setDataset(e.target.value)}><option value="">Choose…</option>{(cat.data?.datasets ?? []).map((d) => <option key={d.code} value={d.code}>{d.module} — {d.title}</option>)}</select></FormField>
          <FormField label="Period" htmlFor="aw-period"><select id="aw-period" className={inputClass} value={period} onChange={(e) => setPeriod(e.target.value)}><option value="">Data set default</option>{PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
          <FormField label="Rows to show" htmlFor="aw-limit"><input id="aw-limit" type="number" className={inputClass} value={limit} onChange={(e) => setLimit(e.target.value)} /></FormField>
        </>
      )}
      <FormField label="Title (optional)" htmlFor="aw-title"><input id="aw-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Add</Button></div>
    </Modal>
  );
}

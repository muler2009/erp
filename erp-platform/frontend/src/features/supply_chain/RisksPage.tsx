import { useState } from "react";

import { useAddAlternativeSourceMutation, useAddRiskActionMutation, useCompleteRiskActionMutation, useCreateSupplyRiskMutation, useGetScAnalyticsQuery, useGetSupplyRiskQuery, useListCriticalMaterialsQuery, useListDisruptionsQuery, useListSuppliersQuery, useListSupplyRisksQuery, useMarkCriticalMutation, useRecordDisruptionMutation, useResolveDisruptionMutation, useUpdateSupplyRiskMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { ReportTable } from "../../shared/ui/ReportTable";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames, useUserOptions } from "../quality/names";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const CATEGORY: Record<string, string> = { SUPPLIER: "Supplier", LOGISTICS: "Logistics", INVENTORY: "Inventory", PRODUCTION: "Production", OTHER: "Other" };
export const RISK_STATUS: Record<string, string> = { OPEN: "Open", MITIGATING: "Being mitigated", ACCEPTED: "Accepted", CLOSED: "Closed" };
const NUM = /^\d+(\.\d{1,4})?$/;
export const CRITICAL_SCORE = 15;
export const scoreTone = (score: number): "red" | "amber" | "green" => (score >= CRITICAL_SCORE ? "red" : score >= 8 ? "amber" : "green");
export function riskProblem(d: { category: string; title: string; likelihood: string; impact: string; owner: string; cost: string }): string | null {
  if (!CATEGORY[d.category]) return "Choose the kind of risk.";
  if (!d.title.trim()) return "Give the risk a title.";
  for (const [n, v] of [["Likelihood", d.likelihood], ["Impact", d.impact]] as const) if (!/^[1-5]$/.test(v.trim())) return `${n} must be a number from 1 to 5.`;
  if (!d.owner) return "Choose who owns the risk.";
  if (d.cost.trim() && !NUM.test(d.cost.trim())) return "The financial impact must be an amount.";
  return null;
}
export const actionProblem = (description: string, owner: string, due: string): string | null => (!description.trim() ? "Describe the action." : !owner ? "Choose who is responsible." : !due ? "Choose the due date." : null);
export const disruptionProblem = (category: string, title: string, cause: string, started: string, cost: string): string | null =>
  !CATEGORY[category] ? "Choose the kind of disruption." : !title.trim() ? "Give it a title." : !cause.trim() ? "Say what caused it." : !started ? "Choose the date it started." : cost.trim() && !NUM.test(cost.trim()) ? "The financial impact must be an amount." : null;
export const criticalProblem = (p: Product | null, reason: string, min: string): string | null => (!p ? "Choose the material." : !reason.trim() ? "Say why it is critical." : !/^[1-9]\d*$/.test(min.trim()) ? "The number of sources needed must be at least 1." : null);
export const alternativeProblem = (p: Product | null, supplier: string, rank: string, days: string): string | null =>
  !p ? "Choose the material." : !supplier ? "Choose the supplier." : !/^[1-9]\d*$/.test(rank.trim()) ? "Rank must be a whole number, 1 or more." : !/^\d+$/.test(days.trim()) ? "Lead time must be a whole number of days." : null;

function NewRisk({ open, onClose }: { open: boolean; onClose: () => void }) {
  const people = useUserOptions(!open);
  const [create, st] = useCreateSupplyRiskMutation();
  const blank = { category: "SUPPLIER", title: "", description: "", likelihood: "3", impact: "3", owner: "", cost: "" };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    const p = riskProblem(f); if (p) return setErr(p);
    try { await create({ category: f.category, title: f.title.trim(), likelihood: Number(f.likelihood), impact: Number(f.impact), owner: f.owner, ...(f.description.trim() ? { description: f.description.trim() } : {}), ...(f.cost.trim() ? { financial_impact: f.cost.trim() } : {}) }).unwrap(); setF(blank); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Log a supply risk" open={open} onClose={onClose}>
      <FormField label="Kind of risk" htmlFor="rk-cat"><select id="rk-cat" className={inputClass} value={f.category} onChange={set("category")}>{Object.entries(CATEGORY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
      <FormField label="Title" htmlFor="rk-title"><input id="rk-title" className={inputClass} value={f.title} onChange={set("title")} /></FormField>
      <FormField label="Description" htmlFor="rk-desc"><input id="rk-desc" className={inputClass} value={f.description} onChange={set("description")} /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Likelihood (1–5)" htmlFor="rk-lik"><input id="rk-lik" className={inputClass} value={f.likelihood} onChange={set("likelihood")} /></FormField>
        <FormField label="Impact (1–5)" htmlFor="rk-imp"><input id="rk-imp" className={inputClass} value={f.impact} onChange={set("impact")} /></FormField>
      </div>
      <FormField label="Owner" htmlFor="rk-owner"><select id="rk-owner" className={inputClass} value={f.owner} onChange={set("owner")}><option value="">Choose</option>{people.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
      <FormField label="Financial impact" htmlFor="rk-cost"><input id="rk-cost" className={inputClass} value={f.cost} onChange={set("cost")} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Log risk</Button></div>
    </Modal>
  );
}

function RiskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAccess();
  const manage = can("supply_chain.risk.manage");
  const q = useGetSupplyRiskQuery(id);
  const [update] = useUpdateSupplyRiskMutation();
  const [addAction] = useAddRiskActionMutation();
  const [complete] = useCompleteRiskActionMutation();
  const people = useUserOptions(!manage);
  const name = useUserNames();
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const r = q.data;
  const setStatus = async (status: string) => { setErr(null); try { await update({ id, status }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const done = async (aid: string) => { setErr(null); try { await complete(aid).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title={r ? `Risk ${r.number}` : "Risk"} open onClose={onClose}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {r && (
        <>
          <p className="mb-1 font-medium">{r.title}</p>
          <p className="mb-2 text-sm"><Badge tone={scoreTone(r.score)}>Score {r.score}</Badge> · {CATEGORY[r.category] ?? r.category} · likelihood {r.likelihood}, impact {r.impact} · {RISK_STATUS[r.status] ?? r.status} · owner {name(r.owner)}{Number(r.financial_impact) ? ` · ${formatMoney(r.financial_impact)} at stake` : ""}</p>
          {r.description && <p className="mb-2 text-sm">{r.description}</p>}
          {manage && <FormField label="Status" htmlFor="rk-status"><select id="rk-status" className={inputClass} value={r.status} onChange={(e) => void setStatus(e.target.value)}>{Object.entries(RISK_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>}
          <h3 className="text-sm font-semibold">Mitigation actions</h3>
          {r.actions.length === 0 && <p className="mb-2 text-sm text-slate-600">No actions yet.</p>}
          <ul className="mb-2 text-sm">{r.actions.map((a) => <li key={a.id}>{a.description} — {name(a.owner)}, due {a.due_date} · {a.status === "DONE" ? "Done" : "Open"} {manage && a.status !== "DONE" && <Button variant="secondary" onClick={() => void done(a.id)}>Complete: {a.description.slice(0, 20)}</Button>}</li>)}</ul>
          {r.disruptions.length > 0 && <><h3 className="text-sm font-semibold">Disruptions linked to this risk</h3><ul className="mb-2 text-sm">{r.disruptions.map((d) => <li key={d.id}>{d.title} ({d.started_on}) — {d.status === "OPEN" ? "Open" : "Resolved"}</li>)}</ul></>}
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          {manage && <div className="flex justify-end"><Button variant="secondary" onClick={() => setAdding(true)}>Add an action</Button></div>}
          <ActionDialog title="Add a mitigation action" open={adding} onClose={() => setAdding(false)} cta="Add action"
            fields={[{ name: "description", label: "Action" }, { name: "owner", label: "Responsible", type: "select", options: people }, { name: "due", label: "Due date", type: "date" }]}
            submit={async (v) => { const p = actionProblem(v.description ?? "", v.owner ?? "", v.due ?? ""); if (p) throw new Error(p); await addAction({ risk: id, description: v.description!.trim(), owner: v.owner!, due_date: v.due! }).unwrap(); }} />
        </>
      )}
    </Modal>
  );
}

function Risks() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListSupplyRisksQuery({ cursor, ...(status ? { status } : {}) });
  const name = useUserNames();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="Risk register" actions={can("supply_chain.risk.manage") ? <Button onClick={() => setCreating(true)}>Log a risk</Button> : undefined}>
      <FormField label="Status" htmlFor="rkf-status"><select id="rkf-status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{Object.entries(RISK_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.results.length === 0 && <EmptyState title="No risks logged" hint="Log supply risks so they can be mitigated." />}
      {q.data && q.data.results.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Risk</th><th>Kind</th><th>Score</th><th>Status</th><th>Owner</th><th /></tr></thead>
          <tbody>{q.data.results.map((r) => <tr key={r.id} className="border-t border-slate-100"><td>{r.number}</td><td>{r.title}</td><td>{CATEGORY[r.category] ?? r.category}</td><td><Badge tone={scoreTone(r.score)}>{r.score}</Badge></td><td>{RISK_STATUS[r.status] ?? r.status}</td><td>{name(r.owner)}</td><td><Button variant="secondary" onClick={() => setOpen(r.id)}>Open {r.number}</Button></td></tr>)}</tbody></table>
      )}
      <div className="mt-2 flex justify-end gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button>}</div>
      <NewRisk open={creating} onClose={() => setCreating(false)} />
      {open && <RiskDetail id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function Disruptions() {
  const { can } = useAccess();
  const manage = can("supply_chain.risk.manage");
  const q = useListDisruptionsQuery();
  const [record] = useRecordDisruptionMutation();
  const [resolve] = useResolveDisruptionMutation();
  const [dlg, setDlg] = useState<"new" | string | null>(null);
  return (
    <Card title="Disruptions" actions={manage ? <Button onClick={() => setDlg("new")}>Record a disruption</Button> : undefined}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.length === 0 && <EmptyState title="No disruptions recorded" hint="Record supply interruptions to learn from them." />}
      {q.data && q.data.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Started</th><th>Disruption</th><th>Cause</th><th className="text-right">Cost</th><th>Status</th><th /></tr></thead>
          <tbody>{q.data.map((d) => <tr key={d.id} className="border-t border-slate-100"><td>{d.started_on}</td><td>{d.title}</td><td>{d.cause}</td><td className="text-right">{formatMoney(d.financial_impact)}</td><td>{d.status === "OPEN" ? <Badge tone="red">Open</Badge> : <Badge tone="slate">Resolved {d.ended_on}</Badge>}</td>
            <td>{manage && d.status === "OPEN" && <Button variant="secondary" onClick={() => setDlg(d.id)}>Resolve {d.title}</Button>}</td></tr>)}</tbody></table>
      )}
      <ActionDialog title="Record a disruption" open={dlg === "new"} onClose={() => setDlg(null)} cta="Record"
        fields={[{ name: "category", label: "Kind", type: "select", options: Object.entries(CATEGORY) }, { name: "title", label: "Title" }, { name: "cause", label: "Cause" }, { name: "started_on", label: "Started on", type: "date" }, { name: "impact", label: "Effect on operations" }, { name: "cost", label: "Financial impact" }]}
        submit={async (v) => {
          const p = disruptionProblem(v.category ?? "", v.title ?? "", v.cause ?? "", v.started_on ?? "", v.cost ?? ""); if (p) throw new Error(p);
          await record({ category: v.category!, title: v.title!.trim(), cause: v.cause!.trim(), started_on: v.started_on!, ...(v.impact?.trim() ? { operational_impact: v.impact.trim() } : {}), ...(v.cost?.trim() ? { financial_impact: v.cost.trim() } : {}) }).unwrap();
        }} />
      <ActionDialog title="Resolve disruption" open={dlg !== null && dlg !== "new"} onClose={() => setDlg(null)} cta="Mark resolved" fields={[{ name: "resolution", label: "How it was resolved" }]}
        submit={async (v) => { if (!(v.resolution ?? "").trim()) throw new Error("Say how it was resolved."); await resolve({ id: dlg!, resolution: v.resolution!.trim() }).unwrap(); }} />
    </Card>
  );
}

function Critical() {
  const { can } = useAccess();
  const manage = can("supply_chain.risk.manage");
  const q = useListCriticalMaterialsQuery();
  const sup = useListSuppliersQuery(undefined, { skip: !manage });
  const [mark, ms] = useMarkCriticalMutation();
  const [alt, as] = useAddAlternativeSourceMutation();
  const [p1, setP1] = useState<Product | null>(null);
  const [m, setM] = useState({ reason: "", min: "2" });
  const [p2, setP2] = useState<Product | null>(null);
  const [a, setA] = useState({ supplier: "", rank: "1", days: "0", notes: "" });
  const [e1, setE1] = useState<string | null>(null);
  const [e2, setE2] = useState<string | null>(null);
  const go1 = async () => { const p = criticalProblem(p1, m.reason, m.min); if (p) return setE1(p); try { await mark({ product: p1!.id, reason: m.reason.trim(), min_sources: Number(m.min) }).unwrap(); setE1(null); setM({ reason: "", min: "2" }); } catch (e) { setE1(errorMessage(e)); } };
  const go2 = async () => { const p = alternativeProblem(p2, a.supplier, a.rank, a.days); if (p) return setE2(p); try { await alt({ product: p2!.id, supplier: a.supplier, rank: Number(a.rank), lead_time_days: Number(a.days), notes: a.notes.trim() }).unwrap(); setE2(null); } catch (e) { setE2(errorMessage(e)); } };
  return (
    <Card title="Critical materials and sourcing">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.length === 0 && <EmptyState title="No critical materials" hint="Mark the materials you cannot run without." />}
      {q.data && q.data.length > 0 && (
        <table className="mb-3 w-full text-sm"><thead><tr className="text-left"><th>Material</th><th>Why critical</th><th className="text-right">Sources</th><th className="text-right">Needed</th><th>Status</th></tr></thead>
          <tbody>{q.data.map((c) => <tr key={c.product} className="border-t border-slate-100"><td>{c.product}</td><td>{c.reason}</td><td className="text-right">{c.sources}</td><td className="text-right">{c.required_sources}</td><td>{c.at_risk ? <Badge tone="red">{c.single_source ? "Single source" : "Too few sources"}</Badge> : <Badge tone="green">Covered</Badge>}</td></tr>)}</tbody></table>
      )}
      {manage && (
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-semibold">Mark a material critical</h3>
            <ProductPicker label="Critical material" onChange={setP1} />
            <FormField label="Why it is critical" htmlFor="cm-reason"><input id="cm-reason" className={inputClass} value={m.reason} onChange={(e) => setM({ ...m, reason: e.target.value })} /></FormField>
            <FormField label="Sources needed" htmlFor="cm-min"><input id="cm-min" className={inputClass} value={m.min} onChange={(e) => setM({ ...m, min: e.target.value })} /></FormField>
            {e1 && <p role="alert" className="mb-2 text-sm text-red-700">{e1}</p>}
            <Button loading={ms.isLoading} onClick={() => void go1()}>Mark critical</Button>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">Add an alternative source</h3>
            <ProductPicker label="Material" onChange={setP2} />
            <FormField label="Alternative supplier" htmlFor="as-sup"><select id="as-sup" className={inputClass} value={a.supplier} onChange={(e) => setA({ ...a, supplier: e.target.value })}><option value="">Choose</option>{(sup.data?.results ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Preference rank" htmlFor="as-rank"><input id="as-rank" className={inputClass} value={a.rank} onChange={(e) => setA({ ...a, rank: e.target.value })} /></FormField>
              <FormField label="Lead time in days" htmlFor="as-days"><input id="as-days" className={inputClass} value={a.days} onChange={(e) => setA({ ...a, days: e.target.value })} /></FormField>
            </div>
            <FormField label="Notes" htmlFor="as-notes"><input id="as-notes" className={inputClass} value={a.notes} onChange={(e) => setA({ ...a, notes: e.target.value })} /></FormField>
            {e2 && <p role="alert" className="mb-2 text-sm text-red-700">{e2}</p>}
            <Button loading={as.isLoading} onClick={() => void go2()}>Add source</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function Signals() {
  const today = new Date().toISOString().slice(0, 10);
  const q = useGetScAnalyticsQuery({ name: "supply-risks", from: today, to: today });
  return (
    <Card title="Warning signals">
      <p className="mb-2 text-sm text-slate-600">Found automatically: late purchase orders, delivery delays, projected shortages, late shipments and critical materials with too few sources.</p>
      {q.isFetching && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {!q.isFetching && q.data !== undefined && (Array.isArray(q.data) && q.data.length === 0 ? <EmptyState title="No warning signals" hint="Nothing needs attention right now." /> : <ReportTable data={q.data} />)}
    </Card>
  );
}

const TABS = [["risks", "Risks"], ["disruptions", "Disruptions"], ["critical", "Critical materials"], ["signals", "Warning signals"]] as const;
export function RisksPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("risks");
  return (
    <>
      <PageHeader title="Supply risks" description="Risks, disruptions and sourcing resilience." />
      <div role="tablist" className="mb-3 flex gap-2">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 text-sm ${tab === k ? "bg-indigo-600 text-white" : "border border-slate-300 bg-white"}`}>{l}</button>)}</div>
      {tab === "risks" && <Risks />}
      {tab === "disruptions" && <Disruptions />}
      {tab === "critical" && <Critical />}
      {tab === "signals" && <Signals />}
    </>
  );
}
export default RisksPage;

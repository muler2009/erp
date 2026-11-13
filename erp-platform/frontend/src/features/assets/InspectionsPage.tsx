import { useState } from "react";

import { useCreateInspectionTemplateMutation, useFindingActionMutation, useGetConditionReportQuery, useInspectionActionMutation, useListAssetCategoriesQuery, useListFixedAssetsQuery, useListInspectionTemplatesQuery, useListInspectionsQuery, useScheduleInspectionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { AssetInspection, InspectionItem, InspectionTemplate } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export const CONDITIONS = ["NEW", "GOOD", "FAIR", "POOR", "DAMAGED"];
export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export type Finding = { description: string; severity: string };

/** The checks the server also makes, so the user hears about a gap before the round trip. */
export function validateCompletion(items: InspectionItem[], answers: string[], condition: string, findings: Finding[]): string | null {
  if (!CONDITIONS.includes(condition)) return "Choose the asset's condition.";
  for (const [i, it] of items.entries()) {
    const v = (answers[i] ?? "").trim();
    if (it.kind === "PASS_FAIL" && v !== "PASS" && v !== "FAIL") return `Answer pass or fail for "${it.text}".`;
    if (it.kind === "READING" && !v) return `Enter a reading for "${it.text}".`;
  }
  const failed = items.some((it, i) => it.kind === "PASS_FAIL" && answers[i] === "FAIL");
  if (failed && findings.length === 0) return "A failed item must be recorded as a finding.";
  if (findings.some((f) => !f.description.trim())) return "Each finding needs a description.";
  return null;
}
export function validateTemplate(code: string, name: string, items: { text: string; kind: string }[]): string | null {
  if (!code.trim() || !name.trim()) return "Enter a code and a name.";
  if (!items.length || items.some((i) => !i.text.trim())) return "Every checklist item needs text, and there must be at least one.";
  return null;
}

function CompleteDialog({ inspection, template, onClose }: { inspection: AssetInspection | null; template: InspectionTemplate | undefined; onClose: () => void }) {
  const [act] = useInspectionActionMutation();
  const items = template?.items ?? [];
  const [answers, setAnswers] = useState<string[]>([]);
  const [condition, setCondition] = useState("");
  const [notes, setNotes] = useState("");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateCompletion(items, answers, condition, findings);
    if (p) { setErr(p); return; }
    setErr(null);
    try {
      await act({ id: inspection!.id, action: "complete", body: { results: items.map((_, i) => ({ result: (answers[i] ?? "").trim() })), condition, notes: notes.trim(), findings: findings.map((f) => ({ description: f.description.trim(), severity: f.severity })) } }).unwrap();
      setAnswers([]); setCondition(""); setNotes(""); setFindings([]); onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Complete inspection of ${inspection?.asset.number ?? ""}`} open={!!inspection} onClose={onClose}>
      {items.map((it, i) => (
        <FormField key={i} label={it.text} htmlFor={`ck-${i}`}>
          {it.kind === "PASS_FAIL"
            ? <select id={`ck-${i}`} className={inputClass} value={answers[i] ?? ""} onChange={(e) => setAnswers(items.map((_, k) => (k === i ? e.target.value : answers[k] ?? "")))}><option value="">Choose…</option><option value="PASS">Pass</option><option value="FAIL">Fail</option></select>
            : <input id={`ck-${i}`} className={inputClass} value={answers[i] ?? ""} onChange={(e) => setAnswers(items.map((_, k) => (k === i ? e.target.value : answers[k] ?? "")))} />}
        </FormField>
      ))}
      <FormField label="Condition found" htmlFor="ck-cond"><select id="ck-cond" className={inputClass} value={condition} onChange={(e) => setCondition(e.target.value)}><option value="">Choose…</option>{CONDITIONS.map((c) => <option key={c} value={c}>{pretty(c)}</option>)}</select></FormField>
      <FormField label="Notes" htmlFor="ck-notes"><textarea id="ck-notes" className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
      <p className="mb-1 text-sm font-medium">Findings</p>
      {findings.map((f, i) => (
        <div key={i} className="mb-2 flex gap-2">
          <input aria-label={`Finding ${i + 1} description`} className={inputClass} value={f.description} onChange={(e) => setFindings(findings.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))} />
          <select aria-label={`Finding ${i + 1} severity`} className={inputClass} value={f.severity} onChange={(e) => setFindings(findings.map((x, k) => (k === i ? { ...x, severity: e.target.value } : x)))}>{SEVERITIES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select>
          <Button variant="secondary" onClick={() => setFindings(findings.filter((_, k) => k !== i))}>Remove</Button>
        </div>
      ))}
      <div className="mb-3"><Button variant="secondary" onClick={() => setFindings([...findings, { description: "", severity: "MEDIUM" }])}>Add a finding</Button></div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Record inspection</Button></div>
    </Modal>
  );
}

function Inspections() {
  const { can } = useAccess();
  const manage = can("assets.maintenance.manage");
  const [status, setStatus] = useState("SCHEDULED");
  const { data, isLoading, error, refetch } = useListInspectionsQuery({ status: status || undefined });
  const templates = useListInspectionTemplatesQuery();
  const assets = useListFixedAssetsQuery({}, { skip: !manage });
  const [schedule] = useScheduleInspectionMutation();
  const [act] = useInspectionActionMutation();
  const [finding] = useFindingActionMutation();
  const [sched, setSched] = useState(false);
  const [f, setF] = useState({ asset: "", template: "", scheduled_on: new Date().toISOString().slice(0, 10) });
  const [ferr, setFerr] = useState<string | null>(null);
  const [completing, setCompleting] = useState<AssetInspection | null>(null);
  const [cancelling, setCancelling] = useState<AssetInspection | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tpl = (id: string | null) => templates.data?.results.find((t) => t.id === id);
  const submit = async () => {
    if (!f.asset) { setFerr("Choose the asset."); return; }
    if (!f.scheduled_on) { setFerr("Enter the date."); return; }
    setFerr(null);
    try { await schedule({ asset: f.asset, scheduled_on: f.scheduled_on, ...(f.template ? { template: f.template } : {}) }).unwrap(); setSched(false); } catch (e) { setFerr(errorMessage(e)); }
  };
  const quick = async (id: string, action: "corrective-action") => { setErr(null); try { await finding({ id, action }).unwrap(); } catch (e) { setErr(failure(e)); } };
  return (
    <Card title="Inspections">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <label className="text-sm">Status <select aria-label="Inspection status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["SCHEDULED", "COMPLETED", "CANCELLED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        {manage && <Button onClick={() => setSched(true)}>Schedule an inspection</Button>}
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No inspections" /> : (
        <ul>{data.results.map((i) => (
          <li key={i.id} className="border-b border-slate-200 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{i.asset.number}</span><Badge tone={i.status === "COMPLETED" ? "green" : i.status === "CANCELLED" ? "red" : "amber"}>{pretty(i.status)}</Badge>{i.condition_result && <Badge tone={i.condition_result === "POOR" || i.condition_result === "DAMAGED" ? "red" : "slate"}>{pretty(i.condition_result)}</Badge>}<span className="text-slate-500">{i.status === "COMPLETED" ? `done ${i.performed_on}` : `scheduled ${i.scheduled_on}`}</span>{tpl(i.template) && <span className="text-slate-500">· {tpl(i.template)!.name}</span>}</div>
            {i.notes && <p className="mt-1">{i.notes}</p>}
            {i.findings.length > 0 && <ul className="mt-1">{i.findings.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2"><Badge tone={x.severity === "HIGH" || x.severity === "CRITICAL" ? "red" : "amber"}>{pretty(x.severity)}</Badge>{x.description}<Badge tone={x.status === "OPEN" ? "amber" : "green"}>{pretty(x.status)}</Badge>{x.work_order && <span className="text-slate-500">Work order raised</span>}
                {manage && x.status === "OPEN" && !x.work_order && <Button variant="secondary" onClick={() => void quick(x.id, "corrective-action")}>{`Raise repair for: ${x.description}`}</Button>}
                {manage && x.status === "OPEN" && <Button variant="secondary" onClick={() => setResolving(x.id)}>{`Resolve: ${x.description}`}</Button>}</li>))}</ul>}
            {manage && i.status === "SCHEDULED" && <div className="mt-2 flex gap-2"><Button onClick={() => setCompleting(i)}>{`Complete ${i.asset.number}`}</Button><Button variant="secondary" onClick={() => setCancelling(i)}>{`Cancel ${i.asset.number}`}</Button></div>}
          </li>))}</ul>
      )}
      <Modal title="Schedule an inspection" open={sched} onClose={() => setSched(false)}>
        <FormField label="Asset" htmlFor="is-asset"><select id="is-asset" className={inputClass} value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}><option value="">Choose…</option>{assets.data?.results.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></FormField>
        <FormField label="Checklist" htmlFor="is-tpl"><select id="is-tpl" className={inputClass} value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })}><option value="">None</option>{templates.data?.results.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></FormField>
        <FormField label="Date" htmlFor="is-date"><input id="is-date" type="date" className={inputClass} value={f.scheduled_on} onChange={(e) => setF({ ...f, scheduled_on: e.target.value })} /></FormField>
        {ferr && <p role="alert" className="mb-3 text-sm text-red-700">{ferr}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setSched(false)}>Cancel</Button><Button onClick={() => void submit()}>Schedule</Button></div>
      </Modal>
      <CompleteDialog key={completing?.id} inspection={completing} template={tpl(completing?.template ?? null)} onClose={() => setCompleting(null)} />
      <ActionDialog key={`c${cancelling?.id}`} title="Cancel inspection" open={!!cancelling} onClose={() => setCancelling(null)} cta="Cancel inspection" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => act({ id: cancelling!.id, action: "cancel", body: { reason: (v.reason ?? "").trim() } }).unwrap()} />
      <ActionDialog key={`r${resolving}`} title="Resolve finding" open={!!resolving} onClose={() => setResolving(null)} cta="Resolve" fields={[{ name: "notes", label: "What was done", required: true }]} submit={(v) => finding({ id: resolving!, action: "resolve", body: { notes: (v.notes ?? "").trim() } }).unwrap()} />
    </Card>
  );
}

function Templates() {
  const { can } = useAccess();
  const manage = can("assets.maintenance.manage");
  const { data, isLoading, error, refetch } = useListInspectionTemplatesQuery();
  const cats = useListAssetCategoriesQuery(undefined, { skip: !manage });
  const [create] = useCreateInspectionTemplateMutation();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: "", name: "", category: "" });
  const [items, setItems] = useState<{ text: string; kind: string }[]>([{ text: "", kind: "PASS_FAIL" }]);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateTemplate(f.code, f.name, items);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await create({ code: f.code.trim(), name: f.name.trim(), items: items.map((i) => ({ text: i.text.trim(), kind: i.kind })), ...(f.category ? { category: f.category } : {}) }).unwrap(); setOpen(false); setF({ code: "", name: "", category: "" }); setItems([{ text: "", kind: "PASS_FAIL" }]); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="Checklist templates">
      {manage && <div className="mb-2"><Button onClick={() => setOpen(true)}>New checklist</Button></div>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No checklists yet" /> : (
        <ul className="text-sm">{data.results.map((t) => <li key={t.id} className="border-b border-slate-100 py-2"><span className="font-mono">{t.code}</span> <span className="font-medium">{t.name}</span> <span className="text-slate-500">— {t.items.length} item(s): {t.items.map((i) => i.text).join("; ")}</span></li>)}</ul>
      )}
      <Modal title="New checklist" open={open} onClose={() => setOpen(false)}>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Code" htmlFor="tp-code"><input id="tp-code" className={inputClass} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></FormField>
          <FormField label="Name" htmlFor="tp-name"><input id="tp-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
        </div>
        <FormField label="Category" htmlFor="tp-cat"><select id="tp-cat" className={inputClass} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Any</option>{cats.data?.results.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></FormField>
        {items.map((it, i) => (
          <div key={i} className="mb-2 flex gap-2">
            <input aria-label={`Item ${i + 1} text`} className={inputClass} value={it.text} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} />
            <select aria-label={`Item ${i + 1} kind`} className={inputClass} value={it.kind} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, kind: e.target.value } : x)))}><option value="PASS_FAIL">Pass / fail</option><option value="READING">Reading</option></select>
            {items.length > 1 && <Button variant="secondary" onClick={() => setItems(items.filter((_, k) => k !== i))}>Remove</Button>}
          </div>
        ))}
        <div className="mb-3"><Button variant="secondary" onClick={() => setItems([...items, { text: "", kind: "PASS_FAIL" }])}>Add an item</Button></div>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Create checklist</Button></div>
      </Modal>
    </Card>
  );
}

function Condition() {
  const { data, isLoading, error, refetch } = useGetConditionReportQuery();
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div className="grid gap-4">
      <Card title="Condition by category">
        <p className="mb-2 text-sm text-slate-600">{data.never_inspected} asset(s) never inspected · {data.open_findings} open finding(s)</p>
        {!data.by_category.length ? <EmptyState title="No assets in service" /> : (
          <table className="w-full text-sm"><caption className="sr-only">Condition by category</caption><thead><tr className="text-left"><th>Category</th>{CONDITIONS.map((c) => <th key={c} className="text-right">{pretty(c)}</th>)}</tr></thead>
            <tbody>{data.by_category.map((r) => <tr key={r.category} className="border-t border-slate-100"><td>{r.category}</td>{CONDITIONS.map((c) => <td key={c} className="text-right">{r[c]}</td>)}</tr>)}</tbody></table>
        )}
      </Card>
      <Card title="Overdue inspections">
        {!data.overdue_inspections.length ? <EmptyState title="Nothing overdue" /> : <ul className="text-sm">{data.overdue_inspections.map((o) => <li key={o.id} className="border-b border-slate-100 py-1">{o.asset} — due {o.scheduled_on} ({o.days_overdue} days overdue)</li>)}</ul>}
      </Card>
    </div>
  );
}

const TABS = [["inspections", "Inspections"], ["templates", "Checklists"], ["condition", "Condition"]] as const;

export function InspectionsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("inspections");
  return (
    <>
      <PageHeader title="Inspections" description="Scheduled checks, checklists, findings and the condition of the asset base." />
      <div role="tablist" className="mb-4 flex gap-2 border-b border-slate-200">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-slate-900 font-semibold" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "inspections" && <Inspections />}
      {tab === "templates" && <Templates />}
      {tab === "condition" && <Condition />}
    </>
  );
}

import { useState } from "react";
import { Link, useParams } from "react-router";

import { useAddQualityParameterMutation, useCreateQualityPlanMutation, useGetQualityPlanQuery, useListProductsQuery, useListQualityPlansQuery, useRetireQualityParameterMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export const STAGES = ["INCOMING", "IN_PROCESS", "FINAL", "PROJECT", "EQUIPMENT", "SUPPLIER"];
export const SUBJECTS = ["PRODUCT", "MATERIAL", "EQUIPMENT", "PROCESS", "SERVICE", "SITE"];
const NUM = /^-?\d+(\.\d+)?$/;

export function validatePlan(f: { title: string; stage: string; subject_type: string; sampling: string; sample_value: string }): string | null {
  if (!f.title.trim()) return "Give the plan a title.";
  if (!STAGES.includes(f.stage)) return "Choose the inspection stage.";
  if (!SUBJECTS.includes(f.subject_type)) return "Choose what is inspected.";
  if (f.sampling !== "ALL") {
    if (!NUM.test(f.sample_value.trim()) || Number(f.sample_value) <= 0) return "Give the sample size.";
    if (f.sampling === "PERCENT" && Number(f.sample_value) > 100) return "A percentage sample must be between 0 and 100.";
  }
  return null;
}

export function validateParameter(f: { name: string; kind: string; lower: string; upper: string; target: string }): string | null {
  if (!f.name.trim()) return "Name the parameter.";
  for (const [label, v] of [["lower limit", f.lower], ["upper limit", f.upper], ["target", f.target]] as const) if (v.trim() && !NUM.test(v.trim())) return `The ${label} must be a number.`;
  if (f.kind === "NUMERIC") {
    if (!f.lower.trim() && !f.upper.trim()) return "A numeric parameter needs a lower or an upper limit.";
    if (f.lower.trim() && f.upper.trim() && Number(f.lower) > Number(f.upper)) return "The lower limit is above the upper limit.";
  }
  return null;
}

export function InspectionPlansPage() {
  const { can } = useAccess();
  const inspect = can("quality.inspect");
  const [f, setF] = useState({ stage: "", status: "" });
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityPlansQuery({ stage: f.stage || undefined, status: f.status || undefined, cursor });
  const products = useListProductsQuery(undefined, { skip: !inspect });
  const [create] = useCreateQualityPlanMutation();
  const empty = { title: "", stage: "INCOMING", subject_type: "MATERIAL", product_id: "", frequency: "", sampling: "ALL", sample_value: "", is_itp: false };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validatePlan(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { title: n.title.trim(), stage: n.stage, subject_type: n.subject_type, sampling: n.sampling, is_itp: n.is_itp };
    if (n.product_id) body.product_id = n.product_id;
    if (n.frequency.trim()) body.frequency = n.frequency.trim();
    if (n.sampling !== "ALL") body.sample_value = n.sample_value.trim();
    try { await create(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Inspection plans" description="What to measure, the limits, and how much to sample." actions={inspect ? <Button onClick={() => setOpen(true)}>New inspection plan</Button> : undefined} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-3">
          <label className="text-sm">Stage <select aria-label="Plan stage" className={inputClass} value={f.stage} onChange={(e) => { setF({ ...f, stage: e.target.value }); setCursor(null); }}><option value="">All</option>{STAGES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No inspection plans" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Title</th><th>Stage</th><th>Sampling</th><th>Revision</th><th>Status</th></tr></thead>
            <tbody>{data.results.map((p) => (
              <tr key={p.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/inspection-plans/${p.id}`}>{p.number}</Link></td><td>{p.title}{p.is_itp && <> <Badge tone="slate">ITP</Badge></>}</td><td>{pretty(p.stage)}</td>
                <td>{p.sampling === "ALL" ? "Every unit" : p.sampling === "PERCENT" ? `${p.sample_value}%` : `${p.sample_value} units`}</td><td>{p.revision}</td><td><Badge tone={p.status === "ACTIVE" ? "green" : "slate"}>{pretty(p.status)}</Badge></td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="New inspection plan" open={open} onClose={() => setOpen(false)}>
        <div className="grid grid-cols-1 gap-x-3 md:grid-cols-2">
          <FormField label="Title" htmlFor="ip-title"><input id="ip-title" className={inputClass} value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} /></FormField>
          <FormField label="Stage" htmlFor="ip-stage"><select id="ip-stage" className={inputClass} value={n.stage} onChange={(e) => setN({ ...n, stage: e.target.value })}>{STAGES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></FormField>
          <FormField label="Inspects" htmlFor="ip-subj"><select id="ip-subj" className={inputClass} value={n.subject_type} onChange={(e) => setN({ ...n, subject_type: e.target.value })}>{SUBJECTS.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></FormField>
          <FormField label="Product" htmlFor="ip-prod"><select id="ip-prod" className={inputClass} value={n.product_id} onChange={(e) => setN({ ...n, product_id: e.target.value })}><option value="">Any</option>{products.data?.results.map((p) => <option key={p.id} value={p.id}>{p.sku} {p.name}</option>)}</select></FormField>
          <FormField label="Sampling" htmlFor="ip-samp"><select id="ip-samp" className={inputClass} value={n.sampling} onChange={(e) => setN({ ...n, sampling: e.target.value })}><option value="ALL">Every unit</option><option value="PERCENT">Percentage</option><option value="FIXED">Fixed number</option></select></FormField>
          {n.sampling !== "ALL" && <FormField label="Sample size" htmlFor="ip-sv"><input id="ip-sv" className={inputClass} value={n.sample_value} onChange={(e) => setN({ ...n, sample_value: e.target.value })} /></FormField>}
          <FormField label="Frequency" htmlFor="ip-freq"><input id="ip-freq" className={inputClass} placeholder="for example every delivery" value={n.frequency} onChange={(e) => setN({ ...n, frequency: e.target.value })} /></FormField>
        </div>
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={n.is_itp} onChange={(e) => setN({ ...n, is_itp: e.target.checked })} /> This is an inspection and test plan (ITP)</label>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Create plan</Button></div>
      </Modal>
    </>
  );
}

export function InspectionPlanPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const inspect = can("quality.inspect");
  const { data: p, isLoading, error, refetch } = useGetQualityPlanQuery(id);
  const [add] = useAddQualityParameterMutation();
  const [retire] = useRetireQualityParameterMutation();
  const empty = { name: "", kind: "NUMERIC", lower: "", upper: "", target: "", unit: "", mandatory: true, critical: false };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const [pageErr, setPageErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !p) return <ErrorState error={error} onRetry={refetch} />;
  const go = async () => {
    const v = validateParameter(n);
    if (v) { setErr(v); return; }
    setErr(null);
    const body: Record<string, unknown> = { name: n.name.trim(), kind: n.kind, mandatory: n.mandatory, critical: n.critical };
    for (const k of ["lower", "upper", "target", "unit"] as const) if (n[k].trim()) body[k] = n[k].trim();
    try { await add({ id: p.id, body }).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  const limits = (x: { lower: string | null; upper: string | null; target: string | null; unit: string; kind: string }) => x.kind !== "NUMERIC" ? "–" : `${x.lower ?? "–"} to ${x.upper ?? "–"}${x.target ? ` (target ${x.target})` : ""} ${x.unit}`.trim();
  return (
    <>
      <PageHeader title={`${p.number} · ${p.title}`} description={`${pretty(p.stage)} · revision ${p.revision}`} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/inspection-plans">All plans</Link>} />
      {pageErr && <p role="alert" className="mb-3 text-sm text-red-700">{pageErr}</p>}
      <Card title="Parameters" actions={inspect ? <Button variant="secondary" onClick={() => setOpen(true)}>Add a parameter</Button> : undefined}>
        {!p.parameters.length ? <EmptyState title="No parameters yet" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>#</th><th>Name</th><th>Kind</th><th>Limits</th><th></th><th></th></tr></thead>
            <tbody>{p.parameters.map((x) => (
              <tr key={x.id} className="border-t"><td>{x.position}</td><td>{x.name}</td><td>{pretty(x.kind)}</td><td>{limits(x)}</td>
                <td>{x.critical && <Badge tone="red">Critical</Badge>} {x.mandatory && <Badge tone="slate">Mandatory</Badge>}</td>
                <td>{inspect && <Button variant="secondary" aria-label={`Retire ${x.name}`} onClick={async () => { setPageErr(null); try { await retire(x.id).unwrap(); } catch (e) { setPageErr(failure(e)); } }}>Retire</Button>}</td></tr>))}</tbody></table>
        )}
        <p className="mt-2 text-xs text-slate-500">Changing parameters after the plan has been used raises its revision. Earlier inspections keep their own results.</p>
      </Card>
      <Modal title="Add a parameter" open={open} onClose={() => setOpen(false)}>
        <div className="grid grid-cols-1 gap-x-3 md:grid-cols-2">
          <FormField label="Name" htmlFor="pm-name"><input id="pm-name" className={inputClass} value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} /></FormField>
          <FormField label="Kind" htmlFor="pm-kind"><select id="pm-kind" className={inputClass} value={n.kind} onChange={(e) => setN({ ...n, kind: e.target.value })}><option value="NUMERIC">Measured value</option><option value="BOOLEAN">Pass or fail</option><option value="TEXT">Text</option></select></FormField>
          {n.kind === "NUMERIC" && <>
            <FormField label="Lower limit" htmlFor="pm-lo"><input id="pm-lo" className={inputClass} value={n.lower} onChange={(e) => setN({ ...n, lower: e.target.value })} /></FormField>
            <FormField label="Upper limit" htmlFor="pm-up"><input id="pm-up" className={inputClass} value={n.upper} onChange={(e) => setN({ ...n, upper: e.target.value })} /></FormField>
            <FormField label="Target" htmlFor="pm-tg"><input id="pm-tg" className={inputClass} value={n.target} onChange={(e) => setN({ ...n, target: e.target.value })} /></FormField>
            <FormField label="Unit" htmlFor="pm-un"><input id="pm-un" className={inputClass} value={n.unit} onChange={(e) => setN({ ...n, unit: e.target.value })} /></FormField>
          </>}
        </div>
        <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={n.mandatory} onChange={(e) => setN({ ...n, mandatory: e.target.checked })} /> Mandatory</label>
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={n.critical} onChange={(e) => setN({ ...n, critical: e.target.checked })} /> Critical (a failure cannot be accepted conditionally)</label>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Add parameter</Button></div>
      </Modal>
    </>
  );
}

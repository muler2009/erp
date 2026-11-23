import { useState } from "react";

import { useBomActionMutation, useCreateBomMutation, useGetBomQuery, useLazyGetExplosionQuery, useListBomsQuery, useListWorkCentersQuery, useUpdateBomMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { BomDetail, BomInput, Product } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const BOM_STATUS: Record<string, { label: string; tone: "green" | "amber" | "slate" }> = { DRAFT: { label: "Draft", tone: "amber" }, ACTIVE: { label: "Active", tone: "green" }, ARCHIVED: { label: "Archived", tone: "slate" } };
const NUM = /^\d+(\.\d{1,4})?$/;

export interface BomLineDraft { component: string; label: string; quantity: string; scrap: string; substitutes: { product: string; ratio: string; sku?: string }[] }
export interface BomByproductDraft { product: string; label: string; quantity: string }
export interface BomStepDraft { sequence: string; name: string; work_center: string; setup: string; run: string }
export interface BomCheckDraft { name: string; step: string; spec: string; lower: string; upper: string }
export interface BomDraft { product: Product | null; name: string; quantity: string; lines: BomLineDraft[]; steps: BomStepDraft[]; checks: BomCheckDraft[]; byproducts: BomByproductDraft[]; from: string; to: string }

export function bomProblem(d: BomDraft, isNew: boolean): string | null {
  if (isNew && !d.product) return "Choose the product this bill of materials makes.";
  if (!NUM.test(d.quantity.trim()) || Number(d.quantity) <= 0) return "The quantity produced must be more than 0.";
  if (d.lines.length === 0) return "Add at least one component.";
  const seen = new Set<string>();
  for (const [i, l] of d.lines.entries()) {
    if (!l.component) return `Component ${i + 1}: choose the material.`;
    if (seen.has(l.component)) return `Component ${i + 1}: each material can be listed only once.`;
    seen.add(l.component);
    if (isNew && d.product && l.component === d.product.id) return "A product cannot be a component of itself.";
    if (!NUM.test(l.quantity.trim()) || Number(l.quantity) <= 0) return `Component ${i + 1}: quantity must be more than 0.`;
    if (!NUM.test(l.scrap.trim()) || Number(l.scrap) >= 100) return `Component ${i + 1}: scrap must be from 0 to under 100 percent.`;
  }
  for (const [i, l] of d.lines.entries()) {
    const subs = new Set<string>();
    for (const sb of l.substitutes) {
      if (sb.product === l.component || subs.has(sb.product)) return `Component ${i + 1}: a substitute cannot repeat the material or another substitute.`;
      subs.add(sb.product);
      if (!NUM.test(sb.ratio.trim()) || Number(sb.ratio) <= 0) return `Component ${i + 1}: the substitute ratio must be more than 0.`;
    }
  }
  const bps = new Set<string>();
  for (const [i, b] of d.byproducts.entries()) {
    if (bps.has(b.product) || (d.product && b.product === d.product.id)) return `By-product ${i + 1}: choose a different product, listed once.`;
    bps.add(b.product);
    if (!NUM.test(b.quantity.trim()) || Number(b.quantity) <= 0) return `By-product ${i + 1}: quantity must be more than 0.`;
  }
  if (d.from && d.to && d.to < d.from) return "The effective end date is before the start date.";
  const seqs = new Set<number>();
  for (const [i, s] of d.steps.entries()) {
    if (!/^\d+$/.test(s.sequence.trim()) || Number(s.sequence) <= 0) return `Step ${i + 1}: the sequence must be a whole number above 0.`;
    if (seqs.has(Number(s.sequence))) return `Step ${i + 1}: sequence ${s.sequence} is used twice.`;
    seqs.add(Number(s.sequence));
    if (!s.work_center) return `Step ${i + 1}: choose the work centre.`;
    if (!NUM.test(s.setup.trim()) || !NUM.test(s.run.trim())) return `Step ${i + 1}: hours must be numbers, or 0.`;
  }
  for (const [i, c] of d.checks.entries()) {
    if (!c.name.trim()) return `Check ${i + 1}: give it a name.`;
    if (c.step && !seqs.has(Number(c.step))) return `Check ${i + 1}: it refers to a step that does not exist.`;
    if (c.lower.trim() && !NUM.test(c.lower.trim())) return `Check ${i + 1}: the lower limit must be a number.`;
    if (c.upper.trim() && !NUM.test(c.upper.trim())) return `Check ${i + 1}: the upper limit must be a number.`;
    if (c.lower.trim() && c.upper.trim() && Number(c.lower) > Number(c.upper)) return `Check ${i + 1}: the lower limit is above the upper limit.`;
  }
  return null;
}

export function bomInput(d: BomDraft, isNew: boolean): BomInput {
  return {
    ...(isNew ? { product: d.product!.id } : {}), name: d.name.trim(), quantity: d.quantity.trim(),
    lines: d.lines.map((l) => ({ component: l.component, quantity: l.quantity.trim(), scrap_percent: l.scrap.trim() || "0", ...(l.substitutes.length ? { substitutes: l.substitutes } : {}) })),
    steps: d.steps.map((s) => ({ sequence: Number(s.sequence), name: s.name.trim(), work_center: s.work_center, setup_hours: s.setup.trim() || "0", run_hours: s.run.trim() || "0" })),
    checks: d.checks.map((c) => ({ name: c.name.trim(), step_sequence: c.step ? Number(c.step) : null, specification: c.spec.trim(), ...(c.lower.trim() ? { lower_limit: c.lower.trim() } : {}), ...(c.upper.trim() ? { upper_limit: c.upper.trim() } : {}) })),
    byproducts: d.byproducts.map((b) => ({ product: b.product, quantity: b.quantity.trim() })),
    effective_from: d.from || null, effective_to: d.to || null,
  };
}

export const draftFromBom = (b: BomDetail): BomDraft => ({
  product: null, name: b.name, quantity: String(Number(b.quantity)),
  lines: b.lines.map((l) => ({ component: l.component, label: l.sku, quantity: String(Number(l.quantity)), scrap: String(Number(l.scrap_percent)), substitutes: l.substitutes.map((x) => ({ ...x })) })),
  steps: b.steps.map((s) => ({ sequence: String(s.sequence), name: s.name, work_center: s.work_center, setup: String(Number(s.setup_hours)), run: String(Number(s.run_hours)) })),
  checks: b.checks.map((c) => ({ name: c.name, step: c.step_sequence === null ? "" : String(c.step_sequence), spec: c.specification, lower: c.lower_limit === null ? "" : String(Number(c.lower_limit)), upper: c.upper_limit === null ? "" : String(Number(c.upper_limit)) })),
  byproducts: (b.byproducts ?? []).map((x) => ({ product: x.product, label: x.sku ?? x.product, quantity: String(Number(x.quantity)) })),
  from: b.effective_from ?? "", to: b.effective_to ?? "",
});

function Editor({ bom, onClose }: { bom: BomDetail | null; onClose: () => void }) {
  const isNew = bom === null;
  const wcs = useListWorkCentersQuery();
  const [create, cs] = useCreateBomMutation();
  const [update, us] = useUpdateBomMutation();
  const [d, setD] = useState<BomDraft>(bom ? draftFromBom(bom) : { product: null, name: "", quantity: "1", lines: [], steps: [], checks: [], byproducts: [], from: "", to: "" });
  const [err, setErr] = useState<string | null>(null);
  const active = (wcs.data?.results ?? []).filter((w) => w.is_active);
  const go = async () => {
    const p = bomProblem(d, isNew);
    if (p) return setErr(p);
    try { if (isNew) await create(bomInput(d, true)).unwrap(); else await update({ id: bom.id, body: bomInput(d, false) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  const upLine = (i: number, k: "quantity" | "scrap", v: string) => setD({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const upStep = (i: number, k: keyof BomStepDraft, v: string) => setD({ ...d, steps: d.steps.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const upCheck = (i: number, k: keyof BomCheckDraft, v: string) => setD({ ...d, checks: d.checks.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  return (
    <Modal title={isNew ? "New bill of materials" : `Edit ${bom.sku} version ${bom.version}`} open onClose={onClose}>
      {isNew && <ProductPicker label="Product made" onChange={(p) => setD((x) => ({ ...x, product: p }))} />}
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Name" htmlFor="bm-name"><input id="bm-name" className={inputClass} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></FormField>
        <FormField label="Quantity produced" htmlFor="bm-qty"><input id="bm-qty" className={inputClass} value={d.quantity} onChange={(e) => setD({ ...d, quantity: e.target.value })} /></FormField>
      </div>
      <h3 className="mt-2 text-sm font-semibold">Components</h3>
      {d.lines.map((l, i) => (
        <div key={i} className="mb-1 flex items-center gap-2 text-sm">
          <span className="w-32 truncate">{l.label}</span>
          <input aria-label={`Quantity of ${l.label}`} className={`${inputClass} w-24`} value={l.quantity} onChange={(e) => upLine(i, "quantity", e.target.value)} />
          <input aria-label={`Scrap % of ${l.label}`} className={`${inputClass} w-20`} value={l.scrap} onChange={(e) => upLine(i, "scrap", e.target.value)} />
          <Button variant="secondary" onClick={() => setD({ ...d, lines: d.lines.filter((_, j) => j !== i) })}>Remove {l.label}</Button>
          <div className="basis-full pl-4">
            {l.substitutes.map((sb, k) => (
              <span key={sb.product} className="mr-3 inline-flex items-center gap-1">
                Substitute {sb.sku ?? sb.product}
                <input aria-label={`Ratio of substitute ${sb.sku ?? sb.product} for ${l.label}`} className={`${inputClass} w-16`} value={sb.ratio} onChange={(e) => setD({ ...d, lines: d.lines.map((x, j) => (j === i ? { ...x, substitutes: x.substitutes.map((y, m) => (m === k ? { ...y, ratio: e.target.value } : y)) } : x)) })} />
                <Button variant="secondary" onClick={() => setD({ ...d, lines: d.lines.map((x, j) => (j === i ? { ...x, substitutes: x.substitutes.filter((_, m) => m !== k) } : x)) })}>Remove substitute {sb.sku ?? sb.product} from {l.label}</Button>
              </span>
            ))}
            <ProductPicker label={`Add substitute for ${l.label}`} onChange={(p) => { if (p) setD((x) => ({ ...x, lines: x.lines.map((y, j) => (j === i ? { ...y, substitutes: [...y.substitutes, { product: p.id, sku: p.sku, ratio: "1" }] } : y)) })); }} />
          </div>
        </div>
      ))}
      <ProductPicker label="Add a component" onChange={(p) => { if (p) setD((x) => ({ ...x, lines: [...x.lines, { component: p.id, label: p.sku, quantity: "1", scrap: "0", substitutes: [] }] })); }} />
      <h3 className="mt-2 text-sm font-semibold">By-products</h3>
      {d.byproducts.map((b, i) => (
        <div key={b.product} className="mb-1 flex items-center gap-2 text-sm">
          <span className="w-32 truncate">{b.label}</span>
          <input aria-label={`Quantity of by-product ${b.label}`} className={`${inputClass} w-24`} value={b.quantity} onChange={(e) => setD({ ...d, byproducts: d.byproducts.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} />
          <Button variant="secondary" onClick={() => setD({ ...d, byproducts: d.byproducts.filter((_, j) => j !== i) })}>Remove by-product {b.label}</Button>
        </div>
      ))}
      <ProductPicker label="Add a by-product" onChange={(p) => { if (p) setD((x) => ({ ...x, byproducts: [...x.byproducts, { product: p.id, label: p.sku, quantity: "1" }] })); }} />
      <h3 className="mt-2 text-sm font-semibold">When it can be used</h3>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Effective from" htmlFor="bm-from"><input id="bm-from" type="date" className={inputClass} value={d.from} onChange={(e) => setD({ ...d, from: e.target.value })} /></FormField>
        <FormField label="Effective until" htmlFor="bm-to"><input id="bm-to" type="date" className={inputClass} value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} /></FormField>
      </div>
      <h3 className="mt-2 text-sm font-semibold">Routing steps</h3>
      {d.steps.map((s, i) => (
        <div key={i} className="mb-1 flex flex-wrap items-center gap-2 text-sm">
          <input aria-label={`Step ${i + 1} sequence`} className={`${inputClass} w-16`} value={s.sequence} onChange={(e) => upStep(i, "sequence", e.target.value)} />
          <input aria-label={`Step ${i + 1} name`} placeholder="Name" className={`${inputClass} w-36`} value={s.name} onChange={(e) => upStep(i, "name", e.target.value)} />
          <select aria-label={`Step ${i + 1} work centre`} className={`${inputClass} w-40`} value={s.work_center} onChange={(e) => upStep(i, "work_center", e.target.value)}><option value="">Work centre…</option>{active.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select>
          <input aria-label={`Step ${i + 1} setup hours`} placeholder="Setup h" className={`${inputClass} w-20`} value={s.setup} onChange={(e) => upStep(i, "setup", e.target.value)} />
          <input aria-label={`Step ${i + 1} run hours`} placeholder="Run h" className={`${inputClass} w-20`} value={s.run} onChange={(e) => upStep(i, "run", e.target.value)} />
          <Button variant="secondary" onClick={() => setD({ ...d, steps: d.steps.filter((_, j) => j !== i) })}>Remove step {i + 1}</Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => setD({ ...d, steps: [...d.steps, { sequence: String((d.steps.length + 1) * 10), name: "", work_center: "", setup: "0", run: "0" }] })}>Add a step</Button>
      <h3 className="mt-2 text-sm font-semibold">Quality checks</h3>
      {d.checks.map((c, i) => (
        <div key={i} className="mb-1 flex flex-wrap items-center gap-2 text-sm">
          <input aria-label={`Check ${i + 1} name`} placeholder="Name" className={`${inputClass} w-36`} value={c.name} onChange={(e) => upCheck(i, "name", e.target.value)} />
          <input aria-label={`Check ${i + 1} step`} placeholder="After step (blank = final)" className={`${inputClass} w-28`} value={c.step} onChange={(e) => upCheck(i, "step", e.target.value)} />
          <input aria-label={`Check ${i + 1} lower limit`} placeholder="Min" className={`${inputClass} w-20`} value={c.lower} onChange={(e) => upCheck(i, "lower", e.target.value)} />
          <input aria-label={`Check ${i + 1} upper limit`} placeholder="Max" className={`${inputClass} w-20`} value={c.upper} onChange={(e) => upCheck(i, "upper", e.target.value)} />
          <Button variant="secondary" onClick={() => setD({ ...d, checks: d.checks.filter((_, j) => j !== i) })}>Remove check {i + 1}</Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => setD({ ...d, checks: [...d.checks, { name: "", step: "", spec: "", lower: "", upper: "" }] })}>Add a check</Button>
      {err && <p role="alert" className="my-2 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={cs.isLoading || us.isLoading} onClick={() => void go()}>Save</Button></div>
    </Modal>
  );
}

function Detail({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (b: BomDetail) => void }) {
  const { can } = useAccess();
  const q = useGetBomQuery(id);
  const [act, st] = useBomActionMutation();
  const [explode, ex] = useLazyGetExplosionQuery();
  const [qty, setQty] = useState("1");
  const [err, setErr] = useState<string | null>(null);
  const b = q.data;
  const manage = can("manufacturing.master.manage");
  const run = async (action: "approve" | "revise" | "archive") => { setErr(null); try { await act({ id, action }).unwrap(); if (action === "revise") onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title={b ? `${b.sku} — version ${b.version}` : "Bill of materials"} open onClose={onClose}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {b && (
        <>
          <p className="mb-2 text-sm"><Badge tone={BOM_STATUS[b.status]?.tone ?? "slate"}>{BOM_STATUS[b.status]?.label ?? b.status}</Badge> · makes {Number(b.quantity)} · standard cost {formatMoney(b.standard_cost)}{b.effective_from ? ` · from ${b.effective_from}` : ""}</p>
          <table className="mb-2 w-full text-sm"><thead><tr className="text-left"><th>Component</th><th className="text-right">Quantity</th><th className="text-right">Scrap</th></tr></thead><tbody>{b.lines.map((l) => <tr key={l.component} className="border-t border-slate-100"><td>{l.sku}{l.substitutes.length > 0 && ` (+${l.substitutes.length} substitute${l.substitutes.length > 1 ? "s" : ""})`}</td><td className="text-right">{Number(l.quantity)}</td><td className="text-right">{Number(l.scrap_percent)}%</td></tr>)}</tbody></table>
          {b.steps.length > 0 && <ol className="mb-2 text-sm">{b.steps.map((s) => <li key={s.sequence}>{s.sequence}. {s.name} — setup {Number(s.setup_hours)} h, run {Number(s.run_hours)} h</li>)}</ol>}
          {b.checks.length > 0 && <ul className="mb-2 text-sm">{b.checks.map((c, i) => <li key={i}>Check: {c.name}{c.lower_limit !== null || c.upper_limit !== null ? ` (${c.lower_limit ?? "…"} to ${c.upper_limit ?? "…"})` : ""}</li>)}</ul>}
          <Card title="Materials needed">
            <div className="flex items-end gap-2">
              <FormField label="For quantity" htmlFor="bx-qty"><input id="bx-qty" className={`${inputClass} w-24`} value={qty} onChange={(e) => setQty(e.target.value)} /></FormField>
              <Button variant="secondary" loading={ex.isFetching} onClick={() => { if (!NUM.test(qty.trim()) || Number(qty) <= 0) return setErr("Quantity must be more than 0."); setErr(null); void explode({ product: b.product, quantity: qty.trim() }); }}>Calculate</Button>
            </div>
            {ex.data && ex.data.requirements.length === 0 && <p className="text-sm">No active bill of materials for this product.</p>}
            {ex.data && ex.data.requirements.length > 0 && <ul className="mt-2 text-sm">{ex.data.requirements.map((r, i) => <li key={i} style={{ paddingLeft: (r.level - 1) * 16 }}>{r.sku}: {formatMoney(r.quantity)}{r.make ? " (made in-house)" : ""}</li>)}</ul>}
          </Card>
          {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {b.status === "DRAFT" && manage && <Button variant="secondary" onClick={() => onEdit(b)}>Edit draft</Button>}
            {b.status === "DRAFT" && can("manufacturing.bom.approve") && <Button loading={st.isLoading} onClick={() => void run("approve")}>Approve</Button>}
            {b.status !== "DRAFT" && manage && <Button variant="secondary" onClick={() => void run("revise")}>Create new version</Button>}
            {b.status !== "ARCHIVED" && manage && <Button variant="danger" onClick={() => void run("archive")}>Archive</Button>}
          </div>
        </>
      )}
    </Modal>
  );
}

export function BomsPage() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListBomsQuery({ cursor, status });
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<BomDetail | "new" | null>(null);
  return (
    <>
      <PageHeader title="Bills of materials" description="What goes into a product and how it is made. A second person approves each version before it can be used." actions={can("manufacturing.master.manage") ? <Button onClick={() => setEdit("new")}>New bill of materials</Button> : undefined} />
      <FormField label="Show" htmlFor="bm-status"><select id="bm-status" className={`${inputClass} w-48`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{Object.entries(BOM_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FormField>
      <Card>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No bills of materials" hint="Create one to define how a product is made." />}
        {q.data && q.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Product</th><th>Version</th><th>Name</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.results.map((b) => <tr key={b.id} className="border-t border-slate-100"><td>{b.sku}</td><td>{b.version}</td><td>{b.name || "—"}</td><td><Badge tone={BOM_STATUS[b.status]?.tone ?? "slate"}>{BOM_STATUS[b.status]?.label ?? b.status}</Badge></td><td><Button variant="secondary" onClick={() => setOpen(b.id)}>Open {b.sku} v{b.version}</Button></td></tr>)}</tbody></table>
        )}
        {q.data?.next && <div className="mt-3 text-right"><Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button></div>}
      </Card>
      {open && !edit && <Detail id={open} onClose={() => setOpen(null)} onEdit={(b) => setEdit(b)} />}
      {edit && <Editor bom={edit === "new" ? null : edit} onClose={() => { setEdit(null); }} />}
    </>
  );
}

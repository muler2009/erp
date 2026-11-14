import { useState } from "react";
import { Link } from "react-router";

import { useListDepartmentsQuery, useListNcrsQuery, useListProductsQuery, useListQualityConfigQuery, useListSuppliersQuery, useRaiseNcrMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { pretty } from "../hr/EmployeeDialogs";

export const NCR_SOURCES = ["INSPECTION", "AUDIT", "PRODUCTION", "PROJECT", "COMPLAINT", "SUPPLIER", "OTHER"];
export const NCR_STATUSES = ["OPEN", "INVESTIGATING", "PENDING_APPROVAL", "APPROVED", "IMPLEMENTING", "VERIFYING", "CLOSED", "REJECTED"];
export const severityTone = (s: string) => (s === "CRITICAL" ? "red" : s === "MAJOR" ? "amber" : "slate") as "red" | "amber" | "slate";
export const ncrTone = (s: string) => (s === "CLOSED" ? "green" : s === "REJECTED" ? "slate" : s === "VERIFYING" || s === "IMPLEMENTING" ? "amber" : "amber") as "green" | "slate" | "amber";

export function validateNcr(f: { title: string; source: string; source_ref_id: string; category: string; severity: string; description: string }): string | null {
  if (!f.title.trim()) return "Give the non-conformance a title.";
  if (!NCR_SOURCES.includes(f.source)) return "Choose where it was found.";
  if (f.source !== "OTHER" && !f.source_ref_id.trim()) return "Name the record it came from, so it can be traced (or choose Other).";
  if (!f.category) return "Choose the category.";
  if (!f.severity) return "Choose the severity.";
  if (!f.description.trim()) return "Describe what is wrong.";
  return null;
}

export function NcrListPage() {
  const { can } = useAccess();
  const report = can("quality.report");
  const [f, setF] = useState({ status: "", severity: "", open: true });
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListNcrsQuery({ status: f.status || undefined, severity: f.severity || undefined, open: f.open && !f.status, cursor });
  const sev = useListQualityConfigQuery("SEVERITY");
  const cats = useListQualityConfigQuery("NCR_CATEGORY");
  const products = useListProductsQuery(undefined, { skip: !report });
  const suppliers = useListSuppliersQuery(undefined, { skip: !report });
  const depts = useListDepartmentsQuery(undefined, { skip: !report });
  const [raise] = useRaiseNcrMutation();
  const [open, setOpen] = useState(false);
  const empty = { title: "", source: "OTHER", source_ref_type: "", source_ref_id: "", category: "", severity: "", description: "", detected_on: "", lot_number: "", product_id: "", supplier_id: "", department_id: "", affected_items: "" };
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateNcr(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { title: n.title.trim(), source: n.source, category: n.category, severity: n.severity, description: n.description.trim() };
    for (const k of ["source_ref_type", "source_ref_id", "detected_on", "lot_number", "product_id", "supplier_id", "department_id", "affected_items"] as const) if (n[k].trim()) body[k] = n[k].trim();
    try { await raise(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Non-conformances" description="Report, investigate, correct and verify what did not meet the requirement." actions={report ? <Button onClick={() => setOpen(true)}>Raise a non-conformance</Button> : undefined} />
      <Card title="Register">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="text-sm">Status <select aria-label="NCR status" className={inputClass} value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setCursor(null); }}><option value="">{f.open ? "Open only" : "All"}</option>{NCR_STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          <label className="text-sm">Severity <select aria-label="NCR severity" className={inputClass} value={f.severity} onChange={(e) => { setF({ ...f, severity: e.target.value }); setCursor(null); }}><option value="">Any</option>{sev.data?.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.open} onChange={(e) => { setF({ ...f, open: e.target.checked }); setCursor(null); }} /> Hide closed and dismissed</label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No non-conformances match" /> : (
          <table className="w-full text-sm"><caption className="sr-only">Non-conformances</caption><thead><tr className="text-left"><th>Number</th><th>Title</th><th>Severity</th><th>Status</th><th>Detected</th><th>Source</th></tr></thead>
            <tbody>{data.results.map((x) => <tr key={x.id} className="border-t border-slate-100"><td><Link className="text-blue-700 underline" to={`/app/quality/ncrs/${x.id}`}>{x.number}</Link></td><td>{x.title}</td><td><Badge tone={severityTone(x.severity)}>{pretty(x.severity)}</Badge></td><td><Badge tone={ncrTone(x.status)}>{pretty(x.status)}</Badge></td><td>{x.detected_on}</td><td>{pretty(x.source)}</td></tr>)}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="Raise a non-conformance" open={open} onClose={() => setOpen(false)}>
        <FormField label="Title" htmlFor="nc-title"><input id="nc-title" className={inputClass} value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Found in" htmlFor="nc-src"><select id="nc-src" className={inputClass} value={n.source} onChange={(e) => setN({ ...n, source: e.target.value })}>{NCR_SOURCES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></FormField>
          <FormField label="Detected on" htmlFor="nc-date"><input id="nc-date" type="date" className={inputClass} value={n.detected_on} onChange={(e) => setN({ ...n, detected_on: e.target.value })} /></FormField>
          {n.source !== "OTHER" && <><FormField label="Source record type" htmlFor="nc-rt"><input id="nc-rt" className={inputClass} placeholder="for example quality.inspection" value={n.source_ref_type} onChange={(e) => setN({ ...n, source_ref_type: e.target.value })} /></FormField><FormField label="Source record ID" htmlFor="nc-rid"><input id="nc-rid" className={inputClass} value={n.source_ref_id} onChange={(e) => setN({ ...n, source_ref_id: e.target.value })} /></FormField></>}
          <FormField label="Category" htmlFor="nc-cat"><select id="nc-cat" className={inputClass} value={n.category} onChange={(e) => setN({ ...n, category: e.target.value })}><option value="">Choose…</option>{cats.data?.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></FormField>
          <FormField label="Severity" htmlFor="nc-sev"><select id="nc-sev" className={inputClass} value={n.severity} onChange={(e) => setN({ ...n, severity: e.target.value })}><option value="">Choose…</option>{sev.data?.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></FormField>
          <FormField label="Product" htmlFor="nc-prod"><select id="nc-prod" className={inputClass} value={n.product_id} onChange={(e) => setN({ ...n, product_id: e.target.value })}><option value="">None</option>{products.data?.results.map((p) => <option key={p.id} value={p.id}>{p.sku} {p.name}</option>)}</select></FormField>
          <FormField label="Lot number" htmlFor="nc-lot"><input id="nc-lot" className={inputClass} value={n.lot_number} onChange={(e) => setN({ ...n, lot_number: e.target.value })} /></FormField>
          <FormField label="Supplier" htmlFor="nc-sup"><select id="nc-sup" className={inputClass} value={n.supplier_id} onChange={(e) => setN({ ...n, supplier_id: e.target.value })}><option value="">None</option>{suppliers.data?.results.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></FormField>
          <FormField label="Department" htmlFor="nc-dep"><select id="nc-dep" className={inputClass} value={n.department_id} onChange={(e) => setN({ ...n, department_id: e.target.value })}><option value="">None</option>{depts.data?.results.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></FormField>
        </div>
        <FormField label="Description" htmlFor="nc-desc"><textarea id="nc-desc" className={inputClass} value={n.description} onChange={(e) => setN({ ...n, description: e.target.value })} /></FormField>
        <FormField label="Affected items" htmlFor="nc-aff"><input id="nc-aff" className={inputClass} value={n.affected_items} onChange={(e) => setN({ ...n, affected_items: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Raise</Button></div>
      </Modal>
    </>
  );
}

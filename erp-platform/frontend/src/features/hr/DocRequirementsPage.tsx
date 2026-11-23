import { useState } from "react";

import { useListDocRequirementsQuery, useSetDocRequirementMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { EMPLOYMENT_TYPES, pretty } from "./EmployeeDialogs";

export function requirementProblem(docType: string, title: string): string | null {
  if (!docType.trim()) return "Enter a document type, for example CONTRACT or ID.";
  if (docType.trim().length > 20) return "The document type can be at most 20 characters.";
  if (!title.trim()) return "Enter a title.";
  return title.trim().length > 120 ? "The title can be at most 120 characters." : null;
}

export function DocRequirementsPage() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListDocRequirementsQuery();
  const [save, { isLoading: saving }] = useSetDocRequirementMutation();
  const [f, setF] = useState({ doc_type: "", title: "", employment_type: "" });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const go = async () => {
    setOk(false);
    const p = requirementProblem(f.doc_type, f.title);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await save({ doc_type: f.doc_type.trim(), title: f.title.trim(), employment_type: f.employment_type }).unwrap(); setF({ doc_type: "", title: "", employment_type: "" }); setOk(true); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Required documents" description="Documents every employee, or every employee of one type, must have on file. Employees who lack one are flagged on their record." />
      <Card title="Current requirements">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No requirements yet" /> : (
          <table className="w-full text-sm"><caption className="sr-only">Required documents</caption><thead><tr className="text-left text-slate-500"><th>Type</th><th>Title</th><th>Applies to</th></tr></thead>
            <tbody>{data.map((r) => <tr key={`${r.doc_type}-${r.employment_type}`} className="border-t border-slate-100"><td>{r.doc_type}</td><td>{r.title}</td><td>{r.employment_type ? pretty(r.employment_type) : "Everyone"}</td></tr>)}</tbody></table>
        )}
      </Card>
      {can("hr.config.manage") && (
        <Card title="Add or change a requirement">
          <p className="mb-2 text-sm text-slate-600">Using the same type and group again changes its title.</p>
          <div className="grid gap-3 md:grid-cols-3">
            <FormField label="Document type" htmlFor="dr-type"><input id="dr-type" className={inputClass} value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })} /></FormField>
            <FormField label="Title" htmlFor="dr-title"><input id="dr-title" className={inputClass} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></FormField>
            <FormField label="Applies to" htmlFor="dr-emp"><select id="dr-emp" className={inputClass} value={f.employment_type} onChange={(e) => setF({ ...f, employment_type: e.target.value })}><option value="">Everyone</option>{EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{pretty(t)}</option>)}</select></FormField>
          </div>
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          {ok && <p role="status" className="mb-2 text-sm text-green-700">Requirement saved.</p>}
          <Button loading={saving} onClick={() => void go()}>Save requirement</Button>
        </Card>
      )}
    </>
  );
}

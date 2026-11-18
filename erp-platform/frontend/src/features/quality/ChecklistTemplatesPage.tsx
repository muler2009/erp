import { useState } from "react";

import { useListChecklistTemplatesQuery, useListQualityConfigQuery, useSaveChecklistTemplateMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { pretty } from "../hr/EmployeeDialogs";

/** One question per line; an optional "STANDARD:clause | " prefix links a requirement. */
export function parseQuestions(text: string): { question: string; requirement?: string }[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf("|");
    if (i > 0) { const req = l.slice(0, i).trim(); const q = l.slice(i + 1).trim(); return q ? { question: q, requirement: req } : { question: l }; }
    return { question: l };
  });
}

export function validateTemplate(name: string, type: string, text: string): string | null {
  if (!name.trim()) return "Name the template.";
  if (!type) return "Choose the audit type.";
  if (!parseQuestions(text).length) return "Add at least one question.";
  return null;
}

export function ChecklistTemplatesPage() {
  const { can } = useAccess();
  const manage = can("quality.audit.manage");
  const { data, isLoading, error, refetch } = useListChecklistTemplatesQuery();
  const types = useListQualityConfigQuery("AUDIT_TYPE", { skip: !manage });
  const [save] = useSaveChecklistTemplateMutation();
  const [open, setOpen] = useState(false);
  const [n, setN] = useState({ name: "", audit_type: "", text: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const m = validateTemplate(n.name, n.audit_type, n.text);
    if (m) { setErr(m); return; }
    setErr(null);
    try { await save({ name: n.name.trim(), audit_type: n.audit_type, questions: parseQuestions(n.text) }).unwrap(); setOpen(false); setN({ name: "", audit_type: "", text: "" }); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Checklist templates" description="Reusable question sets for audits." actions={manage ? <Button onClick={() => setOpen(true)}>New template</Button> : undefined} />
      <Card>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No templates yet" /> : (
          <ul className="text-sm">{data.map((t) => <li key={t.id} className="border-b border-slate-100 py-2"><span className="font-medium">{t.name}</span> <Badge tone="slate">{pretty(t.audit_type)}</Badge> <span className="text-slate-500">{t.questions.length} questions</span>{!t.is_active && <> <Badge tone="amber">Inactive</Badge></>}</li>)}</ul>
        )}
      </Card>
      <Modal title="New checklist template" open={open} onClose={() => setOpen(false)}>
        <FormField label="Name" htmlFor="ct-name"><input id="ct-name" className={inputClass} value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} /></FormField>
        <FormField label="Audit type" htmlFor="ct-type"><select id="ct-type" className={inputClass} value={n.audit_type} onChange={(e) => setN({ ...n, audit_type: e.target.value })}><option value="">Choose…</option>{types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></FormField>
        <FormField label="Questions (one per line)" htmlFor="ct-q"><textarea id="ct-q" rows={6} className={inputClass} value={n.text} onChange={(e) => setN({ ...n, text: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Save template</Button></div>
      </Modal>
    </>
  );
}

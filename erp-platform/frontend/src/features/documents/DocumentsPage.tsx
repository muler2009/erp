import { useState } from "react";
import { Link } from "react-router";

import { useDeleteDocSearchMutation, useListDocSearchesQuery, useSaveDocSearchMutation, useCreateDocumentMutation, useListDocCategoriesQuery, useListDocClassificationsQuery, useListDocFoldersQuery, useListDocumentsQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DocRow } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ActionDialog } from "../hr/ActionDialog";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const DOC_STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate" }> = { DRAFT: { label: "Draft", tone: "slate" }, UNDER_REVIEW: { label: "In review", tone: "amber" }, PUBLISHED: { label: "Published", tone: "green" }, OBSOLETE: { label: "Obsolete", tone: "red" }, ARCHIVED: { label: "Archived", tone: "slate" } };
export const MAX_UPLOAD_MB = 25;
export const statusOf = (s: string) => DOC_STATUS[s] ?? { label: s.replace(/_/g, " ").toLowerCase(), tone: "slate" as const };

/** Problem with a chosen file, or null. The server enforces its own limit too. */
export function fileProblem(f: File | undefined, required: boolean): string | null {
  if (!f) return required ? "Choose a file to upload." : null;
  if (f.size === 0) return "That file is empty.";
  if (f.size > MAX_UPLOAD_MB * 1024 * 1024) return `Files can be at most ${MAX_UPLOAD_MB} MB.`;
  return null;
}

export const flags = (d: Pick<DocRow, "expired" | "review_overdue" | "legal_hold">): string[] => [d.expired && "Expired", d.review_overdue && "Review overdue", d.legal_hold && "Legal hold"].filter(Boolean) as string[];

function NewDocumentDialog({ onClose }: { onClose: () => void }) {
  const cats = useListDocCategoriesQuery();
  const cls = useListDocClassificationsQuery();
  const folders = useListDocFoldersQuery();
  const [create, { isLoading }] = useCreateDocumentMutation();
  const [f, setF] = useState({ title: "", category: "", classification: "", folder: "", description: "", effective_date: "", expiry_date: "" });
  const [file, setFile] = useState<File | undefined>();
  const [err, setErr] = useState<string | null>(null);
  const cat = cats.data?.results.find((c) => c.id === f.category);
  const go = async () => {
    const problem = (!f.title.trim() && "A title is required.") || (!f.category && "Choose a category.") || fileProblem(file, true) || (cat?.requires_expiry && !f.expiry_date && "This kind of document needs an expiry date.") || (f.effective_date && f.expiry_date && f.expiry_date < f.effective_date && "The expiry date cannot be before the effective date.");
    if (problem) { setErr(problem); return; }
    setErr(null);
    const form = new FormData();
    form.append("title", f.title.trim());
    form.append("category", f.category);
    for (const k of ["classification", "folder", "description", "effective_date", "expiry_date"] as const) if (f[k]) form.append(k, f[k]);
    form.append("file", file as File);
    try { await create(form).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New document" open onClose={onClose}>
      <FormField label="Title" htmlFor="nd-title"><input id="nd-title" className={inputClass} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></FormField>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Category" htmlFor="nd-cat"><select id="nd-cat" className={inputClass} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Choose…</option>{(cats.data?.results ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></FormField>
        <FormField label="Who may see it" htmlFor="nd-cls"><select id="nd-cls" className={inputClass} value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })}><option value="">Category default</option>{(cls.data ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></FormField>
        <FormField label="Folder" htmlFor="nd-folder"><select id="nd-folder" className={inputClass} value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })}><option value="">No folder</option>{(folders.data?.results ?? []).filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></FormField>
        <span />
        <FormField label="Effective from" htmlFor="nd-eff"><input id="nd-eff" type="date" className={inputClass} value={f.effective_date} onChange={(e) => setF({ ...f, effective_date: e.target.value })} /></FormField>
        <FormField label="Expires on" htmlFor="nd-exp"><input id="nd-exp" type="date" className={inputClass} value={f.expiry_date} onChange={(e) => setF({ ...f, expiry_date: e.target.value })} /></FormField>
      </div>
      <FormField label="Description" htmlFor="nd-desc"><textarea id="nd-desc" rows={2} className={inputClass} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></FormField>
      <FormField label="File" htmlFor="nd-file"><input id="nd-file" type="file" className={inputClass} onChange={(e) => setFile(e.target.files?.[0])} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Create document</Button></div>
    </Modal>
  );
}

export function DocumentsPage() {
  const { can } = useAccess();
  const [q, setQ] = useState("");
  const [fullText, setFullText] = useState(false);
  const [filters, setFilters] = useState({ status: "", category_code: "", folder: "", expired: false });
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const cats = useListDocCategoriesQuery();
  const folders = useListDocFoldersQuery();
  const { data, isLoading, error, refetch } = useListDocumentsQuery({ cursor, q: q.trim(), full_text: fullText && !!q.trim(), ...filters });
  const reset = () => setCursor(null);
  const searches = useListDocSearchesQuery();
  const [saveSearch] = useSaveDocSearchMutation();
  const [deleteSearch] = useDeleteDocSearchMutation();
  const [saving, setSaving] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const apply = (p: Record<string, string | boolean>) => { setQ(String(p.q ?? "")); setFullText(p.full_text === true); setFilters({ status: String(p.status ?? ""), category_code: String(p.category_code ?? ""), folder: String(p.folder ?? ""), expired: p.expired === true }); reset(); };
  return (
    <>
      <PageHeader title="Documents" description="Controlled documents, their versions and approvals." actions={can("documents.create") ? <Button onClick={() => setCreating(true)}>New document</Button> : undefined} />
      <p className="mb-3 text-sm"><Link className="text-indigo-700 underline" to="/app/documents/acknowledgements">Documents waiting for my acknowledgement</Link> · <Link className="text-indigo-700 underline" to="/app/documents/favourites">My favourites</Link></p>
      <Card title="Saved searches" actions={<Button variant="secondary" onClick={() => setSaving(true)}>Save this search</Button>}>
        {searchErr && <p role="alert" className="mb-2 text-sm text-red-700">{searchErr}</p>}
        {searches.data?.length === 0 && <p className="text-sm text-slate-500">Nothing saved yet. Set up a search above and choose “Save this search”.</p>}
        <ul className="flex flex-wrap gap-2">{searches.data?.map((x) => (
          <li key={x.id} className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-sm">
            <button type="button" className="text-indigo-700 underline" onClick={() => apply(x.params)}>{x.name}</button>
            <button type="button" aria-label={`Delete saved search ${x.name}`} className="text-slate-500" onClick={() => { setSearchErr(null); deleteSearch(x.id).unwrap().catch((e) => setSearchErr(errorMessage(e))); }}>×</button>
          </li>
        ))}</ul>
      </Card>
      {saving && <ActionDialog title="Save this search" cta="Save" open onClose={() => setSaving(false)} fields={[{ name: "name", label: "Name", required: true }]}
        submit={async (v) => { await saveSearch({ name: (v.name ?? "").trim(), params: { q: q.trim(), full_text: fullText, ...filters } }).unwrap(); }} />}
      <Card title="Library">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <FormField label="Search" htmlFor="dl-q"><input id="dl-q" className={inputClass} value={q} placeholder="Title, number or tag" onChange={(e) => { setQ(e.target.value); reset(); }} /></FormField>
          <FormField label="Status" htmlFor="dl-status"><select id="dl-status" className={inputClass} value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); reset(); }}><option value="">All</option>{Object.entries(DOC_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FormField>
          <FormField label="Category" htmlFor="dl-cat"><select id="dl-cat" className={inputClass} value={filters.category_code} onChange={(e) => { setFilters({ ...filters, category_code: e.target.value }); reset(); }}><option value="">All</option>{(cats.data?.results ?? []).map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}</select></FormField>
          <FormField label="Folder" htmlFor="dl-folder"><select id="dl-folder" className={inputClass} value={filters.folder} onChange={(e) => { setFilters({ ...filters, folder: e.target.value }); reset(); }}><option value="">All</option>{(folders.data?.results ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></FormField>
          <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={fullText} onChange={(e) => { setFullText(e.target.checked); reset(); }} />Search inside files</label>
          <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.expired} onChange={(e) => { setFilters({ ...filters, expired: e.target.checked }); reset(); }} />Only expired</label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No documents found" hint="Try clearing a filter." /> : (
          <>
            <table className="min-w-full text-sm"><caption className="sr-only">Documents</caption>
              <thead><tr className="text-left text-slate-500"><th className="py-1">Number</th><th>Title</th><th>Category</th><th>Status</th><th>Version</th><th>Expires</th></tr></thead>
              <tbody>{data.results.map((d) => {
                const st = statusOf(d.status);
                return (
                  <tr key={d.id} className="border-t border-slate-100"><td className="py-1">{d.reference}</td><td><Link className="text-indigo-700 underline" to={`/app/documents/${d.id}`}>{d.title}</Link></td><td>{d.category_name}</td>
                    <td><Badge tone={st.tone}>{st.label}</Badge>{flags(d).map((x) => <Badge key={x} tone="red">{x}</Badge>)}</td><td>{d.current_version?.label ?? "–"}</td><td>{d.expiry_date ?? "–"}</td></tr>
                );
              })}</tbody></table>
            <div className="mt-2 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{data.next && <Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button>}</div>
          </>
        )}
      </Card>
      {creating && <NewDocumentDialog onClose={() => setCreating(false)} />}
    </>
  );
}

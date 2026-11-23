import { useState } from "react";
import { Link } from "react-router";

import { useCreateDocCategoryMutation, useCreateDocFolderMutation, useListDocCategoriesQuery, useListDocClassificationsQuery, useListDepartmentsQuery, useListDocFoldersQuery, useRevokeDocGrantMutation, useUpdateDocCategoryMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DocCategory, DocCategoryInput, DocGrantRow } from "../../shared/api/types";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { useUserOptions } from "../quality/names";
import { ACCESS_ACTIONS, GrantDialog } from "./DocumentTools";

export const DOC_TYPES = ["POLICY", "PROCEDURE", "WORK_INSTRUCTION", "FORM", "TEMPLATE", "MANUAL", "CONTRACT", "REPORT", "DRAWING", "SPECIFICATION", "CERTIFICATE", "INSPECTION_RECORD", "PROJECT_DOCUMENT", "EMPLOYEE_RECORD", "CORRESPONDENCE", "SUBMITTAL", "OTHER"];
export const typeLabel = (t: string) => t.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

const posInt = (v: string): number | null | "bad" => (v.trim() === "" ? null : /^[1-9]\d*$/.test(v.trim()) ? Number(v) : "bad");

export function categoryProblem(code: string | undefined, name: string, prefix: string | undefined, padding: string, review: string, retention: string): string | null {
  if (code !== undefined && !code.trim()) return "Give the category a code.";
  if (!name.trim()) return "Give the category a name.";
  if (prefix !== undefined && !/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(prefix)) return "The number prefix uses capitals, digits and dashes (up to 12).";
  if (!/^[1-8]$/.test(padding)) return "Number length must be 1 to 8.";
  if (posInt(review) === "bad") return "Review interval must be a whole number of days.";
  if (posInt(retention) === "bad") return "Retention must be a whole number of years.";
  return null;
}
export const folderProblem = (name: string): string | null => (!name.trim() ? "Give the folder a name." : name.includes("/") ? "A folder name cannot contain a slash." : null);

function CategoryDialog({ cat, onClose }: { cat: DocCategory | null; onClose: () => void }) {
  const cls = useListDocClassificationsQuery();
  const [create] = useCreateDocCategoryMutation();
  const [update] = useUpdateDocCategoryMutation();
  const [f, setF] = useState({ code: "", name: cat?.name ?? "", prefix: "", doc_type: "OTHER", padding: String(cat?.number_padding ?? 4), controlled: cat?.is_controlled ?? true, expiry: cat?.requires_expiry ?? false, review: cat?.review_interval_days ? String(cat.review_interval_days) : "", retention: cat?.retention_years ? String(cat.retention_years) : "", classification: cat?.default_classification ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = categoryProblem(cat ? undefined : f.code, f.name, cat ? undefined : f.prefix, f.padding, f.review, f.retention);
    if (p) { setErr(p); return; }
    setErr(null);
    const body = { name: f.name.trim(), number_padding: Number(f.padding), is_controlled: f.controlled, requires_expiry: f.expiry, review_interval_days: f.review ? Number(f.review) : null, retention_years: f.retention ? Number(f.retention) : null, ...(f.classification ? { default_classification: f.classification } : {}) };
    try {
      if (cat) await update({ id: cat.id, body }).unwrap();
      else await create({ ...body, code: f.code.trim(), number_prefix: f.prefix, doc_type: f.doc_type } as DocCategoryInput).unwrap();
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={cat ? `Change ${cat.name}` : "Add category"} open onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {!cat && <FormField label="Code" htmlFor="ca-code"><input id="ca-code" className={inputClass} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></FormField>}
        <FormField label="Name" htmlFor="ca-name"><input id="ca-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
        {!cat && <FormField label="Number prefix" htmlFor="ca-prefix"><input id="ca-prefix" className={inputClass} value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value.toUpperCase() })} /></FormField>}
        {!cat && <FormField label="Kind" htmlFor="ca-type"><select id="ca-type" className={inputClass} value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })}>{DOC_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}</select></FormField>}
        <FormField label="Number length" htmlFor="ca-pad"><input id="ca-pad" type="number" className={inputClass} value={f.padding} onChange={(e) => setF({ ...f, padding: e.target.value })} /></FormField>
        <FormField label="Who may see it by default" htmlFor="ca-cls"><select id="ca-cls" className={inputClass} value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })}><option value="">Internal</option>{(cls.data ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></FormField>
        <FormField label="Review every (days)" htmlFor="ca-rev"><input id="ca-rev" inputMode="numeric" className={inputClass} value={f.review} onChange={(e) => setF({ ...f, review: e.target.value })} /></FormField>
        <FormField label="Keep for (years)" htmlFor="ca-ret"><input id="ca-ret" inputMode="numeric" className={inputClass} value={f.retention} onChange={(e) => setF({ ...f, retention: e.target.value })} /></FormField>
      </div>
      <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.controlled} onChange={(e) => setF({ ...f, controlled: e.target.checked })} />Controlled (needs approval to publish)</label>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.checked })} />Needs an expiry date</label>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>{cat ? "Save changes" : "Add category"}</Button></div>
    </Modal>
  );
}

export function DocumentAdminPage() {
  const cats = useListDocCategoriesQuery();
  const folders = useListDocFoldersQuery();
  const [grantFor, setGrantFor] = useState<{ id: string; name: string } | null>(null);
  const [given, setGiven] = useState<DocGrantRow[]>([]);
  const [revokeGrant] = useRevokeDocGrantMutation();
  const people = useUserOptions();
  const depts = useListDepartmentsQuery();
  const who = (type: string, id: string) => (type === "USER" ? people.find(([k]) => k === id)?.[1] : type === "DEPARTMENT" ? depts.data?.results.find((d) => d.id === id)?.name : undefined) ?? id;
  const withdraw = async (id: string) => { setErr(null); try { await revokeGrant(id).unwrap(); setGiven((l) => l.filter((g) => g.id !== id)); } catch (e) { setErr(errorMessage(e)); } };
  const [update] = useUpdateDocCategoryMutation();
  const [createFolder] = useCreateDocFolderMutation();
  const [editing, setEditing] = useState<DocCategory | "new" | null>(null);
  const [fname, setFname] = useState("");
  const [parent, setParent] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const addFolder = async () => {
    const p = folderProblem(fname);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await createFolder({ name: fname.trim(), ...(parent ? { parent } : {}) }).unwrap(); setFname(""); setParent(""); } catch (e) { setErr(errorMessage(e)); }
  };
  const fname_ = (id: string | null) => folders.data?.results.find((x) => x.id === id)?.name;
  return (
    <>
      <PageHeader title="Document setup" description="Categories (numbering, review and retention rules) and folders." />
      <p className="mb-3 text-sm"><Link className="text-indigo-700 underline" to="/app/documents">← All documents</Link></p>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <Card title="Categories" actions={<Button onClick={() => setEditing("new")}>Add category</Button>}>
        {cats.isLoading && <Spinner />}
        {cats.error && <ErrorState error={cats.error} onRetry={cats.refetch} />}
        {cats.data?.results.length === 0 && <EmptyState title="No categories" />}
        <table className="min-w-full text-sm"><caption className="sr-only">Categories</caption>
          <thead><tr className="text-left text-slate-500"><th className="py-1">Name</th><th>Kind</th><th>Prefix</th><th>Review</th><th>Keep</th><th /></tr></thead>
          <tbody>{cats.data?.results.map((c) => (
            <tr key={c.id} className="border-t border-slate-100"><td className="py-1">{c.name} {!c.is_active && <Badge tone="slate">Switched off</Badge>}</td><td>{typeLabel(c.doc_type)}</td><td>{c.number_prefix}</td><td>{c.review_interval_days ? `${c.review_interval_days} days` : "–"}</td><td>{c.retention_years ? `${c.retention_years} years` : "–"}</td>
              <td className="flex justify-end gap-2 py-1"><Button variant="secondary" aria-label={`Change ${c.name}`} onClick={() => setEditing(c)}>Change</Button>
                <Button variant="secondary" aria-label={`${c.is_active ? "Switch off" : "Switch on"} ${c.name}`} onClick={() => { setErr(null); update({ id: c.id, body: { is_active: !c.is_active } }).unwrap().catch((e) => setErr(errorMessage(e))); }}>{c.is_active ? "Switch off" : "Switch on"}</Button></td></tr>
          ))}</tbody></table>
      </Card>
      <Card title="Folders">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <FormField label="New folder name" htmlFor="fo-name"><input id="fo-name" className={inputClass} value={fname} onChange={(e) => setFname(e.target.value)} /></FormField>
          <FormField label="Inside" htmlFor="fo-parent"><select id="fo-parent" className={inputClass} value={parent} onChange={(e) => setParent(e.target.value)}><option value="">Top level</option>{(folders.data?.results ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></FormField>
          <Button className="mb-3" onClick={() => void addFolder()}>Add folder</Button>
        </div>
        {folders.data?.results.length === 0 && <EmptyState title="No folders yet" />}
        <ul className="text-sm">{folders.data?.results.map((x) => <li key={x.id} className="flex items-center justify-between py-1"><span>{x.parent ? `${fname_(x.parent) ?? "…"} / ` : ""}{x.name}</span><Button variant="secondary" aria-label={`Give access to folder ${x.name}`} onClick={() => setGrantFor(x)}>Give access</Button></li>)}</ul>
        {given.length > 0 && (
          <div className="mt-3 border-t border-slate-100 pt-2"><p className="mb-1 text-sm font-medium">Access given in this session</p>
            <ul className="text-sm">{given.map((g) => <li key={g.id} className="flex items-center justify-between py-1"><span>{fname_(g.folder) ?? "Folder"}: {who(g.subject_type, g.subject_id)} ({g.actions.map((a) => ACCESS_ACTIONS.find(([k]) => k === a)?.[1] ?? a).join(", ")}){g.expires_at ? ` until ${g.expires_at.slice(0, 10)}` : ""}</span><Button variant="danger" aria-label={`Withdraw folder access of ${who(g.subject_type, g.subject_id)}`} onClick={() => void withdraw(g.id)}>Withdraw</Button></li>)}</ul>
            <p className="mt-1 text-xs text-slate-500">The server does not list folder access that was given earlier, so only grants made on this page since it opened can be withdrawn here.</p>
          </div>
        )}
      </Card>
      {grantFor && <GrantDialog folder={grantFor} onClose={() => setGrantFor(null)} onGranted={(g) => setGiven((l) => [...l, g])} />}
      {editing && <CategoryDialog key={editing === "new" ? "new" : editing.id} cat={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

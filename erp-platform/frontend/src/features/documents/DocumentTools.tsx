import { useState } from "react";
import { Link, useNavigate } from "react-router";

import {
  useAddDocLinkMutation, useApplyDocTemplateMutation, useDistributeDocumentMutation, useDocArchiveMutation, useDocObsoleteMutation, useDocRetentionMutation, useGrantDocAccessMutation, useListDepartmentsQuery,
  useListDocCategoriesQuery, useListDocFavouritesQuery, useListDocGrantsQuery, useListDocumentsQuery, useListRolesQuery, useRemoveDocLinkMutation, useRequestDocDisposalMutation, useReviewDocumentMutation,
  useRevokeDocGrantMutation, useSetDocFavouriteMutation, useGrantFolderAccessMutation,
} from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DocDetail, DocGrantRow, DocTarget } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, FormField, Modal, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserOptions } from "../quality/names";

export const LINK_TYPES: [string, string][] = [["PROJECT", "Project"], ["TASK", "Project task"], ["SUPPLIER", "Supplier"], ["CUSTOMER", "Customer"], ["EMPLOYEE", "Employee"], ["ASSET", "Asset"], ["PRODUCT", "Product"], ["PROCESS", "Process"], ["LOCATION", "Location"], ["CONTRACT", "Contract"]];
export const ACCESS_ACTIONS: [string, string][] = [["VIEW", "See"], ["DOWNLOAD", "Download"], ["UPLOAD", "Upload"], ["EDIT", "Edit"], ["REVIEW", "Review"], ["PUBLISH", "Publish"], ["ARCHIVE", "Archive"], ["DELETE", "Delete"]];
export const REVIEW_OUTCOMES: [string, string][] = [["NO_CHANGE", "Still correct, no change"], ["REVISION_REQUIRED", "Needs a new revision"], ["OBSOLETE", "No longer needed"]];

export const reviewProblem = (outcome: string, comment: string): string | null => (!outcome ? "Choose the outcome." : outcome !== "NO_CHANGE" && !comment.trim() ? "Say what needs to change." : null);
export const retentionProblem = (until: string, hold: string, current: string | null | undefined): string | null =>
  !until && !hold ? "Set a retention date or change the legal hold." : until && current && until < current ? `The retention period can be extended, not shortened (now ${current}).` : null;
export const grantProblem = (subject: string, actions: string[], expires: string, today: string): string | null =>
  !subject ? "Choose who gets access." : actions.length === 0 ? "Choose at least one thing they may do." : expires && expires <= today ? "The expiry must be in the future." : null;
export const linkProblem = (type: string, ref: string): string | null => (!type ? "Choose what kind of record." : !ref.trim() ? "Give the record's identifier." : null);
export const shareProblem = (targetType: string, target: string): string | null => (!targetType ? "Choose who to send it to." : !target ? "Choose the person, team or role." : null);

/** Type + id pickers for people, departments and roles. */
function TargetPicker({ value, onChange, idPrefix }: { value: DocTarget; onChange: (t: DocTarget) => void; idPrefix: string }) {
  const users = useUserOptions();
  const depts = useListDepartmentsQuery();
  const roles = useListRolesQuery();
  const options: [string, string][] = value.type === "USER" ? users : value.type === "DEPARTMENT" ? (depts.data?.results ?? []).map((d) => [d.id, d.name]) : value.type === "ROLE" ? (roles.data ?? []).map((r) => [r.name, r.display_name]) : [];
  return (
    <div className="grid grid-cols-2 gap-2">
      <FormField label="Send to" htmlFor={`${idPrefix}-type`}><select id={`${idPrefix}-type`} className={inputClass} value={value.type} onChange={(e) => onChange({ type: e.target.value, id: "" })}><option value="">Choose…</option><option value="USER">A person</option><option value="DEPARTMENT">A department</option><option value="ROLE">Everyone with a role</option></select></FormField>
      <FormField label="Who" htmlFor={`${idPrefix}-id`}><select id={`${idPrefix}-id`} className={inputClass} value={value.id} onChange={(e) => onChange({ ...value, id: e.target.value })}><option value="">Choose…</option>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
    </div>
  );
}

function ShareDialog({ doc, onClose }: { doc: DocDetail; onClose: () => void }) {
  const [send] = useDistributeDocumentMutation();
  const [t, setT] = useState<DocTarget>({ type: "", id: "" });
  const [ack, setAck] = useState(false);
  const [due, setDue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const go = async () => {
    const p = shareProblem(t.type, t.id);
    if (p) { setErr(p); return; }
    setErr(null);
    try { const r = await send({ id: doc.id, targets: [t], requires_acknowledgement: ack, ...(due ? { due_date: due } : {}) }).unwrap(); setDone(`Sent to ${r.users} ${r.users === 1 ? "person" : "people"}.`); }
    catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Send to people" open onClose={onClose}>
      <TargetPicker value={t} onChange={setT} idPrefix="sh" />
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />They must confirm they have read it</label>
      {ack && <FormField label="Confirm by" htmlFor="sh-due"><input id="sh-due" type="date" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} /></FormField>}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {done && <p role="status" className="mb-3 text-sm text-green-700">{done}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={() => void go()}>Send</Button></div>
    </Modal>
  );
}

export function GrantDialog({ doc, folder, onClose, onGranted }: { doc?: DocDetail; folder?: { id: string; name: string }; onClose: () => void; onGranted?: (g: DocGrantRow) => void }) {
  const [grantDoc] = useGrantDocAccessMutation();
  const [grantFolder] = useGrantFolderAccessMutation();
  const [t, setT] = useState<DocTarget>({ type: "", id: "" });
  const [acts, setActs] = useState<string[]>(["VIEW"]);
  const [exp, setExp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = shareProblem(t.type, t.id) ? "Choose who gets access." : grantProblem(t.id, acts, exp, new Date().toISOString().slice(0, 10));
    if (p) { setErr(p); return; }
    setErr(null);
    try {
      const body = { subject_type: t.type, subject_id: t.id, actions: acts, ...(exp ? { expires_at: `${exp}T23:59:59Z` } : {}) };
      const g = folder ? await grantFolder({ id: folder.id, body }).unwrap() : await grantDoc({ id: doc!.id, body }).unwrap();
      onGranted?.(g);
      onClose();
    }
    catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={folder ? `Give access to folder ${folder.name}` : "Give access"} open onClose={onClose}>
      <TargetPicker value={t} onChange={setT} idPrefix="gr" />
      <fieldset className="mb-3"><legend className="text-sm font-medium text-slate-700">They may</legend>
        <div className="flex flex-wrap gap-3">{ACCESS_ACTIONS.map(([k, l]) => <label key={k} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={acts.includes(k)} onChange={(e) => setActs(e.target.checked ? [...acts, k] : acts.filter((x) => x !== k))} />{l}</label>)}</div>
      </fieldset>
      <FormField label="Until (optional)" htmlFor="gr-exp"><input id="gr-exp" type="date" className={inputClass} value={exp} onChange={(e) => setExp(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Give access</Button></div>
    </Modal>
  );
}

function Grants({ doc }: { doc: DocDetail }) {
  const q = useListDocGrantsQuery(doc.id);
  const [revoke] = useRevokeDocGrantMutation();
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const users = useUserOptions();
  const depts = useListDepartmentsQuery();
  const label = (type: string, id: string) => (type === "USER" ? users.find(([k]) => k === id)?.[1] : type === "DEPARTMENT" ? depts.data?.results.find((d) => d.id === id)?.name : undefined) ?? id;
  return (
    <Card title="Who has been given access" actions={<Button variant="secondary" onClick={() => setAdding(true)}>Give access</Button>}>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.data?.length === 0 && <p className="text-sm text-slate-500">No special access has been given. Normal visibility rules apply.</p>}
      <ul className="divide-y divide-slate-100 text-sm">
        {q.data?.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-medium">{label(g.subject_type, g.subject_id)}</span><Badge tone="slate">{g.subject_type.toLowerCase()}</Badge>
            <span>{g.actions.map((a) => ACCESS_ACTIONS.find(([k]) => k === a)?.[1] ?? a).join(", ")}</span>
            {g.expires_at && <span className="text-slate-500">until {g.expires_at.slice(0, 10)}</span>}
            <Button variant="danger" aria-label={`Withdraw access of ${label(g.subject_type, g.subject_id)}`} onClick={() => { setErr(null); revoke(g.id).unwrap().catch((e) => setErr(errorMessage(e))); }}>Withdraw</Button>
          </li>
        ))}
      </ul>
      {adding && <GrantDialog doc={doc} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function UseTemplateDialog({ doc, onClose }: { doc: DocDetail; onClose: () => void }) {
  const cats = useListDocCategoriesQuery();
  const [apply] = useApplyDocTemplateMutation();
  const nav = useNavigate();
  const [title, setTitle] = useState("");
  const [cat, setCat] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (!title.trim()) { setErr("A title is required."); return; }
    if (!cat) { setErr("Choose a category."); return; }
    setErr(null);
    try { const d = await apply({ id: doc.id, body: { title: title.trim(), category: cat } }).unwrap(); onClose(); nav(`/app/documents/${d.id}`); }
    catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`New document from ${doc.title}`} open onClose={onClose}>
      <FormField label="Title" htmlFor="tp-title"><input id="tp-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></FormField>
      <FormField label="Category" htmlFor="tp-cat"><select id="tp-cat" className={inputClass} value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Choose…</option>{(cats.data?.results ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Create document</Button></div>
    </Modal>
  );
}

type Dlg = "obsolete" | "archive" | "retention" | "disposal" | "review" | "link" | "share" | "template" | null;

/** Everything on a document beyond reading and versions: lifecycle, links, sharing, review, access, shortcuts. */
export function DocumentTools({ doc }: { doc: DocDetail }) {
  const { can: has } = useAccess();
  const can = doc.can ?? {};
  const [dlg, setDlg] = useState<Dlg>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [obsolete] = useDocObsoleteMutation();
  const [archive] = useDocArchiveMutation();
  const [retain] = useDocRetentionMutation();
  const [dispose] = useRequestDocDisposalMutation();
  const [review] = useReviewDocumentMutation();
  const [addLink] = useAddDocLinkMutation();
  const [removeLink] = useRemoveDocLinkMutation();
  const [fav] = useSetDocFavouriteMutation();
  const favs = useListDocFavouritesQuery();
  const published = useListDocumentsQuery({ status: "PUBLISHED" }, { skip: dlg !== "obsolete" });
  const isFav = !!favs.data?.results.some((d) => d.id === doc.id);
  const done = (text: string) => { setMsg({ ok: true, text }); setDlg(null); };
  const fail = (e: unknown) => setMsg({ ok: false, text: errorMessage(e) });
  const close = () => setDlg(null);
  const pub = doc.status === "PUBLISHED";
  const canShare = pub && (can.edit || can.publish || has("documents.distribute"));
  const canArchive = !!can.archive && (doc.status === "OBSOLETE" || doc.expired);

  return (
    <>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mb-3 text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</p>}
      <Card title="Shortcuts">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => { setMsg(null); fav({ id: doc.id, on: !isFav }).unwrap().catch(fail); }}>{isFav ? "Remove from favourites" : "Add to favourites"}</Button>
          {doc.is_template && pub && has("documents.create") && <Button variant="secondary" onClick={() => setDlg("template")}>Use as template</Button>}
          {canShare && <Button variant="secondary" onClick={() => setDlg("share")}>Send to people</Button>}
          {pub && can.review && <Button variant="secondary" onClick={() => setDlg("review")}>Record a review</Button>}
        </div>
      </Card>

      {(can.publish || can.archive) && (
        <Card title="Lifecycle and retention">
          <p className="mb-2 text-sm text-slate-600">Keep until: {doc.retention_until ?? "not set"}. Legal hold: {doc.legal_hold ? "yes" : "no"}.</p>
          <div className="flex flex-wrap gap-2">
            {pub && can.publish && <Button variant="secondary" onClick={() => setDlg("obsolete")}>Mark obsolete</Button>}
            {canArchive && <Button variant="secondary" onClick={() => setDlg("archive")}>Archive</Button>}
            {can.archive && <Button variant="secondary" onClick={() => setDlg("retention")}>Retention and legal hold</Button>}
            {can.archive && doc.status === "ARCHIVED" && <Button variant="danger" onClick={() => setDlg("disposal")}>Request disposal</Button>}
          </div>
          {has("documents.disposal.approve") && <p className="mt-2 text-sm"><Link className="text-indigo-700 underline" to="/app/documents/disposals">Disposal requests</Link></p>}
        </Card>
      )}

      <Card title="Linked records" actions={can.edit && doc.status !== "ARCHIVED" ? <Button variant="secondary" onClick={() => setDlg("link")}>Add link</Button> : undefined}>
        {doc.links.length === 0 && <p className="text-sm text-slate-500">Not linked to any record.</p>}
        <ul className="text-sm">{doc.links.map((l) => (
          <li key={l.id} className="flex items-center gap-2 py-1"><Badge tone="slate">{LINK_TYPES.find(([k]) => k === l.type)?.[1] ?? l.type}</Badge><span>{l.label || l.ref_id}</span>
            {can.edit && <Button variant="secondary" aria-label={`Remove link ${l.label || l.ref_id}`} onClick={() => { setMsg(null); removeLink(l.id).unwrap().catch(fail); }}>Remove</Button>}</li>
        ))}</ul>
      </Card>

      {has("documents.admin") && <Grants doc={doc} />}

      {dlg === "obsolete" && <ActionDialog title="Mark obsolete" cta="Mark obsolete" open onClose={close} fields={[{ name: "reason", label: "Reason", required: true }, { name: "replaced_by", label: "Replaced by (optional)", options: (published.data?.results ?? []).filter((d) => d.id !== doc.id).map((d) => [d.id, `${d.reference} — ${d.title}`]) }]}
        submit={async (v) => { await obsolete({ id: doc.id, reason: (v.reason ?? "").trim(), ...(v.replaced_by ? { replaced_by: v.replaced_by } : {}) }).unwrap(); done("The document is now obsolete."); }} />}
      {dlg === "archive" && <ActionDialog title="Archive document" cta="Archive" open onClose={close} fields={[{ name: "reason", label: "Reason (optional)" }]} submit={async (v) => { await archive({ id: doc.id, reason: v.reason ?? "" }).unwrap(); done("The document was archived."); }} />}
      {dlg === "disposal" && <ActionDialog title="Request disposal" cta="Request disposal" open onClose={close} fields={[{ name: "reason", label: "Reason", required: true }]} submit={async (v) => { await dispose({ document: doc.id, reason: (v.reason ?? "").trim() }).unwrap(); done("Disposal was requested. Someone else must approve it."); }} />}
      {dlg === "retention" && <ActionDialog title="Retention and legal hold" cta="Save" open onClose={close} fields={[{ name: "until", label: "Keep until", type: "date" }, { name: "hold", label: "Legal hold", options: [["yes", "Place on hold"], ["no", "Release hold"]] }]}
        submit={async (v) => { const p = retentionProblem(v.until ?? "", v.hold ?? "", doc.retention_until); if (p) throw new Error(p); await retain({ id: doc.id, ...(v.until ? { retention_until: v.until } : {}), ...(v.hold ? { legal_hold: v.hold === "yes" } : {}) }).unwrap(); done("Retention settings saved."); }} />}
      {dlg === "review" && <ActionDialog title="Record a review" cta="Record review" open onClose={close} fields={[{ name: "outcome", label: "Outcome", options: REVIEW_OUTCOMES }, { name: "comment", label: "Comment", type: "textarea" }]}
        submit={async (v) => { const p = reviewProblem(v.outcome ?? "", v.comment ?? ""); if (p) throw new Error(p); await review({ id: doc.id, outcome: v.outcome as string, comment: (v.comment ?? "").trim() }).unwrap(); done("Review recorded."); }} />}
      {dlg === "link" && <ActionDialog title="Link to a record" cta="Add link" open onClose={close} fields={[{ name: "type", label: "Kind of record", options: LINK_TYPES }, { name: "ref", label: "Record identifier" }, { name: "label", label: "Label (optional)" }]}
        submit={async (v) => { const p = linkProblem(v.type ?? "", v.ref ?? ""); if (p) throw new Error(p); await addLink({ id: doc.id, type: v.type as string, ref_id: (v.ref ?? "").trim(), label: v.label ?? "" }).unwrap(); done("Link added."); }} />}
      {dlg === "share" && <ShareDialog doc={doc} onClose={close} />}
      {dlg === "template" && <UseTemplateDialog doc={doc} onClose={close} />}
    </>
  );
}

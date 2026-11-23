import { useRef, useState } from "react";
import { Link, useParams } from "react-router";

import { useAddDocCommentMutation, useCreateDocRevisionMutation, useDocVersionActionMutation, useGetDocumentQuery, useListDocCommentsQuery, useResolveDocCommentMutation, useRespondDocCommentMutation, useUploadDocVersionMutation, useAcknowledgeDocumentMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DocDetail, DocVersion } from "../../shared/api/types";
import { downloadFromApi } from "../../shared/lib/fileDownload";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { DocumentTools } from "./DocumentTools";
import { useUserNames } from "../quality/names";
import { fileProblem, flags, statusOf } from "./DocumentsPage";

export const VERSION_STATUS: Record<DocVersion["status"], { label: string; tone: "green" | "red" | "amber" | "slate" }> = { DRAFT: { label: "Draft", tone: "slate" }, UNDER_REVIEW: { label: "Waiting for approval", tone: "amber" }, CHANGES_REQUESTED: { label: "Changes requested", tone: "amber" }, APPROVED: { label: "Approved — not yet published", tone: "amber" }, PUBLISHED: { label: "Published", tone: "green" }, SUPERSEDED: { label: "Replaced", tone: "slate" }, REJECTED: { label: "Rejected", tone: "red" }, WITHDRAWN: { label: "Withdrawn", tone: "slate" } };
export const sizeText = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Which actions the person may take on a version, from its status and what the server says they can do. */
export function versionActions(v: Pick<DocVersion, "status">, can: Record<string, boolean> = {}): ("submit" | "resubmit" | "withdraw" | "publish")[] {
  const out: ("submit" | "resubmit" | "withdraw" | "publish")[] = [];
  if (v.status === "DRAFT" && can.edit) out.push("submit");
  if (v.status === "CHANGES_REQUESTED" && can.edit) out.push("resubmit");
  if (v.status === "UNDER_REVIEW" && can.edit) out.push("withdraw");
  if (v.status === "APPROVED" && can.publish) out.push("publish");
  return out;
}
const ACTION_TEXT = { submit: "Send for approval", resubmit: "Send again", withdraw: "Withdraw", publish: "Publish" } as const;

function UploadDialog({ doc, kind, onClose }: { doc: DocDetail; kind: "version" | "revision"; onClose: () => void }) {
  const [upload, { isLoading: a }] = useUploadDocVersionMutation();
  const [revise, { isLoading: b }] = useCreateDocRevisionMutation();
  const [reason, setReason] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const f = file.current?.files?.[0];
    const problem = fileProblem(f, true) || (!reason.trim() && "Say what changed.");
    if (problem) { setErr(problem); return; }
    setErr(null);
    const form = new FormData();
    form.append("file", f as File);
    form.append("change_reason", reason.trim());
    try { await (kind === "version" ? upload({ id: doc.id, form }) : revise({ id: doc.id, form })).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={kind === "version" ? "Upload a new file" : "Start a new revision"} open onClose={onClose}>
      <FormField label="File" htmlFor="uv-file"><input id="uv-file" ref={file} type="file" className={inputClass} /></FormField>
      <FormField label="What changed" htmlFor="uv-reason"><input id="uv-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={a || b} onClick={() => void go()}>{kind === "version" ? "Upload" : "Start revision"}</Button></div>
    </Modal>
  );
}

function Comments({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useListDocCommentsQuery(id);
  const [add, { isLoading: adding }] = useAddDocCommentMutation();
  const [resolve] = useResolveDocCommentMutation();
  const [respond] = useRespondDocCommentMutation();
  const nameOf = useUserNames();
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Comments">
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No comments yet" /> : (
        <ul className="mb-3 space-y-2 text-sm">{data.map((c) => (
          <li key={c.id} className="rounded border border-slate-200 p-2"><p>{c.comment}</p><p className="text-xs text-slate-500">{nameOf(c.author)} · {new Date(c.at).toLocaleDateString()} · {c.status === "RESOLVED" ? "Resolved" : "Open"}</p>
            {c.response && <p className="mt-1 text-slate-700">Reply: {c.response}</p>}
            {c.status !== "RESOLVED" && <div className="mt-1 flex gap-3 text-xs"><button type="button" className="text-indigo-700 hover:underline" onClick={() => setReplyTo(c.id)}>{`Reply to comment by ${nameOf(c.author)}`}</button><button type="button" className="text-indigo-700 hover:underline" onClick={() => { setErr(null); resolve(c.id).unwrap().catch((e) => setErr(errorMessage(e))); }}>{`Mark resolved: ${c.comment.slice(0, 20)}`}</button></div>}</li>))}</ul>
      )}
      <FormField label="Add a comment" htmlFor="dc-text"><textarea id="dc-text" rows={2} className={inputClass} value={text} onChange={(e) => setText(e.target.value)} /></FormField>
      <Button loading={adding} onClick={() => { if (!text.trim()) { setErr("Write a comment first."); return; } setErr(null); add({ id, comment: text.trim() }).unwrap().then(() => setText("")).catch((e) => setErr(errorMessage(e))); }}>Add comment</Button>
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
      {replyTo && <ActionDialog title="Reply to comment" cta="Send reply" open onClose={() => setReplyTo(null)} fields={[{ name: "response", label: "Your reply", required: true, type: "textarea" }, { name: "resolve", label: "Mark as resolved", options: [["no", "No"], ["yes", "Yes"]] }]} submit={async (v) => { await respond({ id: replyTo, response: v.response!.trim(), resolve: v.resolve === "yes" }).unwrap(); }} />}
    </Card>
  );
}

export function DocumentDetailPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error, refetch } = useGetDocumentQuery(id);
  const [act] = useDocVersionActionMutation();
  const [ack] = useAcknowledgeDocumentMutation();
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"version" | "revision" | null>(null);
  const [pending, setPending] = useState<{ id: string; action: "submit" | "resubmit" | "withdraw" | "publish" } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const st = statusOf(data.status);
  const can = data.can ?? {};
  const download = (v: DocVersion) => { setMsg(null); downloadFromApi(`/api/v1/documents/versions/${v.id}/download`, v.file_name).catch((e) => setMsg({ ok: false, text: errorMessage(e) })); };
  return (
    <>
      <PageHeader title={data.title} description={`${data.reference} · ${data.category_name}`}
        actions={<div className="flex gap-2">{can.upload && <Button variant="secondary" onClick={() => setDlg("version")}>Upload a new file</Button>}{can.edit && data.status === "PUBLISHED" && !data.pending_revision && <Button variant="secondary" onClick={() => setDlg("revision")}>Start a revision</Button>}
          <Button variant="secondary" onClick={() => { setMsg(null); ack(id).unwrap().then(() => setMsg({ ok: true, text: "Thank you — your acknowledgement is recorded." })).catch((e) => setMsg({ ok: false, text: errorMessage(e) })); }}>I have read this</Button></div>} />
      <p className="mb-3 text-sm"><Link className="text-indigo-700 underline" to="/app/documents">← All documents</Link></p>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mb-3 text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</p>}
      <Card title="Details">
        <p className="mb-2"><Badge tone={st.tone}>{st.label}</Badge>{flags(data).map((x) => <Badge key={x} tone="red">{x}</Badge>)}</p>
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div><dt className="text-xs text-slate-500">Owner</dt><dd>{nameOf(data.owner)}</dd></div><div><dt className="text-xs text-slate-500">Who may see it</dt><dd>{data.classification}</dd></div>
          <div><dt className="text-xs text-slate-500">Effective from</dt><dd>{data.effective_date ?? "–"}</dd></div><div><dt className="text-xs text-slate-500">Expires</dt><dd>{data.expiry_date ?? "–"}</dd></div>
          <div><dt className="text-xs text-slate-500">Next review</dt><dd>{data.next_review_date ?? "–"}</dd></div>{data.tags.length > 0 && <div><dt className="text-xs text-slate-500">Tags</dt><dd>{data.tags.join(", ")}</dd></div>}
        </dl>
        {data.description && <p className="mt-2 text-sm text-slate-700">{data.description}</p>}
      </Card>
      <Card title="Versions">
        <table className="min-w-full text-sm"><caption className="sr-only">Versions</caption><thead><tr className="text-left text-slate-500"><th className="py-1">Version</th><th>Status</th><th>File</th><th>What changed</th><th /></tr></thead>
          <tbody>{data.versions.map((v) => (
            <tr key={v.id} className="border-t border-slate-100 align-top"><td className="py-1">{v.label}</td><td><Badge tone={VERSION_STATUS[v.status].tone}>{VERSION_STATUS[v.status].label}</Badge>{v.rejection_note && <p className="text-xs text-red-700">{v.rejection_note}</p>}</td><td>{v.file_name} <span className="text-slate-500">({sizeText(v.size)})</span></td><td>{v.change_reason || "–"}</td>
              <td className="flex justify-end gap-2 py-1"><Button variant="secondary" onClick={() => download(v)}>{`Download ${v.label}`}</Button>{versionActions(v, can).map((a) => <Button key={a} variant={a === "withdraw" ? "secondary" : "primary"} onClick={() => setPending({ id: v.id, action: a })}>{`${ACTION_TEXT[a]} ${v.label}`}</Button>)}</td></tr>))}</tbody></table>
      </Card>
      <DocumentTools doc={data} />
      <Comments id={id} />
      {data.history && data.history.length > 0 && <Card title="History"><ul className="text-sm">{data.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString()} · {h.action.toLowerCase().replace(/_/g, " ")}{h.version && ` ${h.version}`} · {h.by ? nameOf(h.by) : "system"}{h.note && ` — ${h.note}`}</li>)}</ul></Card>}
      {data.related.length > 0 && <Card title="Related documents"><ul className="text-sm">{data.related.map((r) => <li key={r.id}><Link className="text-indigo-700 underline" to={`/app/documents/${r.id}`}>{r.reference} {r.title}</Link></li>)}</ul></Card>}
      {dlg && <UploadDialog doc={data} kind={dlg} onClose={() => setDlg(null)} />}
      {pending && <ActionDialog title={ACTION_TEXT[pending.action]} cta={ACTION_TEXT[pending.action]} open onClose={() => setPending(null)} fields={[{ name: "comment", label: "Comment (optional)" }]} submit={async (v) => { await act({ id: pending.id, action: pending.action, comment: v.comment ?? "" }).unwrap(); }} />}
    </>
  );
}

import { useRef, useState } from "react";
import { Link, useParams } from "react-router";

import { useAddServiceCaseCommentMutation, useAttachServiceCaseFileMutation, useGetServiceCaseQuery, useListEmployeesQuery, useListServiceCaseCommentsQuery, useListServiceCaseFilesQuery, useServiceCaseActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { ServiceCase } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { useAccountNames } from "../../shared/ui/useAccountNames";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames } from "../quality/names";
import { slaText, statusLabel } from "./ServiceCasesPage";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "–");

/** Reads a file as base64 (the API takes the content inside JSON). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("The file could not be read."));
    r.readAsDataURL(file);
  });
}

function CommentsCard({ id, canWrite }: { id: string; canWrite: boolean }) {
  const { data, isLoading, error, refetch } = useListServiceCaseCommentsQuery(id);
  const [add, { isLoading: saving }] = useAddServiceCaseCommentMutation();
  const nameOf = useUserNames();
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!text.trim()) { setErr("Write a comment first."); return; }
    setErr(null);
    try { await add({ id, text: text.trim(), internal }).unwrap(); setText(""); setInternal(false); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="Conversation">
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No comments yet" /> : (
        <ul className="mb-3 space-y-2 text-sm">{data.map((c) => (
          <li key={c.id} className={`rounded border p-2 ${c.internal ? "border-amber-200 bg-amber-50" : "border-slate-200"}`}>
            <div className="text-xs text-slate-500">{nameOf(c.author)} · {when(c.at)} {c.internal && <Badge tone="amber">Internal note</Badge>}</div>
            <div>{c.text}</div>
          </li>))}</ul>
      )}
      {canWrite && (
        <>
          <FormField label="Add a comment" htmlFor="cc-text"><textarea id="cc-text" rows={3} className={inputClass} value={text} onChange={(e) => setText(e.target.value)} /></FormField>
          <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (not shown to the customer)</label>
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          <Button loading={saving} onClick={() => void submit()}>Post comment</Button>
        </>
      )}
    </Card>
  );
}

function FilesCard({ id, canWrite }: { id: string; canWrite: boolean }) {
  const { data, isLoading, error, refetch } = useListServiceCaseFilesQuery(id);
  const [attach, { isLoading: busy }] = useAttachServiceCaseFileMutation();
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const f = input.current?.files?.[0];
    if (!f) { setErr("Choose a file to attach."); return; }
    setErr(null);
    try { await attach({ id, filename: f.name, content_base64: await fileToBase64(f) }).unwrap(); if (input.current) input.current.value = ""; } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="Attachments">
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No attachments" /> : (
        <ul className="mb-3 text-sm">{data.map((f) => <li key={f.id}>{f.name} <span className="text-slate-500">({Math.max(1, Math.round(f.size / 1024))} KB)</span></li>)}</ul>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-end gap-2">
          <FormField label="Attach a file" htmlFor="cf-file"><input id="cf-file" ref={input} type="file" /></FormField>
          <Button variant="secondary" loading={busy} onClick={() => void submit()}>Upload</Button>
        </div>
      )}
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
    </Card>
  );
}

type Dialog = "resolve" | "cancel" | "assign" | "feedback" | null;

function Actions({ c, canManage, canAssign }: { c: ServiceCase; canManage: boolean; canAssign: boolean }) {
  const [act] = useServiceCaseActionMutation();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [err, setErr] = useState<string | null>(null);
  const employees = useListEmployeesQuery({ status: "ACTIVE" }, { skip: dialog !== "assign" });
  const run = (action: string, body?: Record<string, unknown>) => { setErr(null); act({ id: c.id, action, body }).unwrap().catch((e) => setErr(errorMessage(e))); };
  const owners: [string, string][] = (employees.data?.results ?? []).filter((e) => e.user_id).map((e) => [e.user_id as string, `${e.employee_no} ${e.name}`]);
  const open = ["NEW", "OPEN", "PENDING_CUSTOMER"].includes(c.status);
  if (!canManage && !canAssign) return null;
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        {canManage && c.status === "NEW" && <Button onClick={() => run("status", { status: "OPEN" })}>Start working on it</Button>}
        {canManage && c.status === "OPEN" && <Button variant="secondary" onClick={() => run("status", { status: "PENDING_CUSTOMER" })}>Waiting for customer</Button>}
        {canManage && c.status === "PENDING_CUSTOMER" && <Button variant="secondary" onClick={() => run("status", { status: "OPEN" })}>Customer replied</Button>}
        {canManage && c.status === "RESOLVED" && <Button variant="secondary" onClick={() => run("status", { status: "OPEN" })}>Reopen</Button>}
        {canManage && open && <Button onClick={() => setDialog("resolve")}>Resolve</Button>}
        {canManage && c.status === "RESOLVED" && <Button onClick={() => run("close")}>Close case</Button>}
        {canManage && c.status === "RESOLVED" && c.satisfaction === null && <Button variant="secondary" onClick={() => setDialog("feedback")}>Record customer feedback</Button>}
        {canAssign && (open || c.status === "RESOLVED") && <Button variant="secondary" onClick={() => setDialog("assign")}>Assign</Button>}
        {canManage && open && <Button variant="danger" onClick={() => setDialog("cancel")}>Cancel case</Button>}
      </div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {dialog === "resolve" && <ActionDialog title="Resolve case" cta="Resolve" open onClose={() => setDialog(null)} fields={[{ name: "resolution", label: "What was done?", type: "textarea", required: true }]} submit={async (v) => { await act({ id: c.id, action: "resolve", body: { resolution: v.resolution!.trim() } }).unwrap(); }} />}
      {dialog === "cancel" && <ActionDialog title="Cancel case" cta="Cancel case" open onClose={() => setDialog(null)} fields={[{ name: "reason", label: "Reason", required: true }]} submit={async (v) => { await act({ id: c.id, action: "cancel", body: { reason: v.reason!.trim() } }).unwrap(); }} />}
      {dialog === "assign" && <ActionDialog title="Assign case" cta="Assign" open onClose={() => setDialog(null)} initial={{ owner_id: c.owner_id ?? "", team: c.team }} fields={[{ name: "owner_id", label: "Handler", required: true, options: owners, searchUsers: true }, { name: "team", label: "Team" }]} submit={async (v) => { await act({ id: c.id, action: "assign", body: { owner_id: v.owner_id, team: (v.team ?? "").trim() } }).unwrap(); }} />}
      {dialog === "feedback" && <ActionDialog title="Customer feedback" cta="Save feedback" open onClose={() => setDialog(null)} fields={[{ name: "rating", label: "Rating", required: true, options: [["1", "1 - very unhappy"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5 - very happy"]] }, { name: "feedback", label: "Comment" }]} submit={async (v) => { await act({ id: c.id, action: "feedback", body: { rating: Number(v.rating), feedback: v.feedback ?? "" } }).unwrap(); }} />}
    </>
  );
}

export function ServiceCaseDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const { data: c, isLoading, error, refetch } = useGetServiceCaseQuery(id);
  const accountName = useAccountNames();
  const nameOf = useUserNames();
  if (isLoading) return <Spinner />;
  if (error || !c) return <ErrorState error={error} onRetry={refetch} />;
  const sla = slaText(c);
  const fin = c.status === "CLOSED" || c.status === "CANCELLED";
  const fact = (k: string, v: string) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="text-sm">{v || "–"}</dd></div>;
  return (
    <>
      <PageHeader title={`${c.number} · ${c.subject}`} description={statusLabel(c.status)}
        actions={<div className="flex items-center gap-3"><Badge tone={sla.tone}>{sla.text}</Badge><Link className="text-sm text-indigo-700 hover:underline" to="/app/crm/cases">All cases</Link></div>} />
      <Actions c={c} canManage={can("crm.manage")} canAssign={can("crm.assign")} />
      <Card title="Case">
        {c.description && <p className="mb-3 whitespace-pre-wrap text-sm">{c.description}</p>}
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {fact("Customer", accountName(c.account))}{fact("Type", c.kind.toLowerCase())}{fact("Category", c.category)}{fact("Priority", c.priority.toLowerCase())}
          {fact("Severity", c.severity.toLowerCase())}{fact("Handler", c.owner_id ? nameOf(c.owner_id) : "")}{fact("Team", c.team)}{fact("Escalation", c.escalation_level ? `Level ${c.escalation_level}` : "")}
          {fact("First response due", when(c.first_response_due))}{fact("First responded", when(c.first_responded_at))}{fact("Resolve by", when(c.due_at))}{fact("Resolved", when(c.resolved_at))}
        </dl>
        {c.resolution && <p className="mt-3 text-sm"><span className="font-medium">Resolution:</span> {c.resolution}</p>}
        {c.satisfaction !== null && <p className="mt-2 text-sm"><span className="font-medium">Customer rating:</span> {c.satisfaction}/5{c.feedback ? ` — ${c.feedback}` : ""}</p>}
      </Card>
      <CommentsCard id={id} canWrite={can("crm.manage") && !fin} />
      <FilesCard id={id} canWrite={can("crm.manage") && !fin} />
    </>
  );
}

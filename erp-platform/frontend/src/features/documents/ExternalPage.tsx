import { useState } from "react";
import { Link } from "react-router";

import {
  useAnswerDocRfiMutation, useCloseDocRfiMutation, useCreateDocRfiMutation, useCreateDocTransmittalMutation, useListDocCategoriesQuery, useListDocExternalQuery, useListDocRfisQuery, useListDocTransmittalsQuery,
  useListDocumentsQuery, useListProjectsQuery, useMarkDocExternalRespondedMutation, useRegisterDocExternalMutation, useSetDocExternalStatusMutation,
} from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DocExternalRow } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames, useUserOptions } from "../quality/names";
import { fileProblem } from "./DocumentsPage";

export const PARTY_TYPES: [string, string][] = [["SUPPLIER", "Supplier"], ["CONTRACTOR", "Contractor"], ["CONSULTANT", "Consultant"], ["CUSTOMER", "Customer"], ["AUTHORITY", "Authority"], ["OTHER", "Other"]];
export const PURPOSES: [string, string][] = [["FOR_INFORMATION", "For information"], ["FOR_REVIEW", "For review"], ["FOR_APPROVAL", "For approval"], ["FOR_CONSTRUCTION", "For construction"], ["AS_BUILT", "As built"]];
export const SUBMISSION: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate"; next: string[] }> = {
  RECEIVED: { label: "Received", tone: "slate", next: ["UNDER_REVIEW", "ACCEPTED", "REJECTED"] }, SENT: { label: "Sent", tone: "slate", next: ["ACCEPTED", "REJECTED"] },
  UNDER_REVIEW: { label: "Under review", tone: "amber", next: ["ACCEPTED", "REJECTED"] }, ACCEPTED: { label: "Accepted", tone: "green", next: [] }, REJECTED: { label: "Rejected", tone: "red", next: [] },
  RESUBMITTED: { label: "Resubmitted", tone: "amber", next: ["UNDER_REVIEW", "ACCEPTED", "REJECTED"] },
};
const NEXT_LABEL: Record<string, string> = { UNDER_REVIEW: "Start review", ACCEPTED: "Accept", REJECTED: "Reject" };

export function externalProblem(direction: string, partyType: string, partyName: string, title: string, category: string, file: File | undefined): string | null {
  if (!direction) return "Choose incoming or outgoing.";
  if (!partyType) return "Choose the kind of party.";
  if (!partyName.trim()) return "Give the party's name.";
  if (!title.trim()) return "A title is required.";
  if (!category) return "Choose a category.";
  return fileProblem(file, false);
}
export function transmittalProblem(direction: string, party: string, docs: string[]): string | null {
  if (!direction) return "Choose incoming or outgoing.";
  if (!party.trim()) return "Give the party's name.";
  return docs.length === 0 ? "Choose at least one document." : null;
}
export function rfiProblem(project: string, subject: string, question: string, assignee: string): string | null {
  if (!project) return "Choose the project.";
  if (!subject.trim()) return "A subject is required.";
  if (!question.trim()) return "Write the question.";
  return assignee ? null : "Choose who should answer.";
}

function RegisterDialog({ resubmits, onClose }: { resubmits: DocExternalRow | null; onClose: () => void }) {
  const cats = useListDocCategoriesQuery();
  const [register, { isLoading }] = useRegisterDocExternalMutation();
  const [f, setF] = useState({ direction: resubmits?.direction ?? "", party_type: resubmits?.party_type ?? "", party_name: resubmits?.party_name ?? "", title: "", category: "", party_reference: resubmits?.party_reference ?? "", contract_ref: resubmits?.contract_ref ?? "", response_due_on: "" });
  const [file, setFile] = useState<File | undefined>();
  const [err, setErr] = useState<string | null>(null);
  const up = (k: string, v: string) => setF({ ...f, [k]: v });
  const go = async () => {
    const p = externalProblem(f.direction, f.party_type, f.party_name, f.title, f.category, file);
    if (p) { setErr(p); return; }
    setErr(null);
    const form = new FormData();
    for (const [k, v] of Object.entries(f)) if (v) form.append(k, v.trim());
    if (resubmits) form.append("resubmission_of", resubmits.id);
    if (file) form.append("file", file);
    try { await register(form).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={resubmits ? `Resubmit ${resubmits.reference}` : "Register correspondence"} open onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Direction" htmlFor="ex-dir"><select id="ex-dir" className={inputClass} value={f.direction} disabled={!!resubmits} onChange={(e) => up("direction", e.target.value)}><option value="">Choose…</option><option value="INCOMING">Received from them</option><option value="OUTGOING">Sent to them</option></select></FormField>
        <FormField label="Kind of party" htmlFor="ex-pt"><select id="ex-pt" className={inputClass} value={f.party_type} onChange={(e) => up("party_type", e.target.value)}><option value="">Choose…</option>{PARTY_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
        <FormField label="Party name" htmlFor="ex-pn"><input id="ex-pn" className={inputClass} value={f.party_name} onChange={(e) => up("party_name", e.target.value)} /></FormField>
        <FormField label="Their reference" htmlFor="ex-pr"><input id="ex-pr" className={inputClass} value={f.party_reference} onChange={(e) => up("party_reference", e.target.value)} /></FormField>
        <FormField label="Title" htmlFor="ex-title"><input id="ex-title" className={inputClass} value={f.title} onChange={(e) => up("title", e.target.value)} /></FormField>
        <FormField label="Category" htmlFor="ex-cat"><select id="ex-cat" className={inputClass} value={f.category} onChange={(e) => up("category", e.target.value)}><option value="">Choose…</option>{(cats.data?.results ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></FormField>
        <FormField label="Contract reference" htmlFor="ex-cr"><input id="ex-cr" className={inputClass} value={f.contract_ref} onChange={(e) => up("contract_ref", e.target.value)} /></FormField>
        <FormField label="Reply due by" htmlFor="ex-due"><input id="ex-due" type="date" className={inputClass} value={f.response_due_on} onChange={(e) => up("response_due_on", e.target.value)} /></FormField>
      </div>
      <FormField label="File (optional)" htmlFor="ex-file"><input id="ex-file" type="file" className={inputClass} onChange={(e) => setFile(e.target.files?.[0])} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Register</Button></div>
    </Modal>
  );
}

function Correspondence({ manage }: { manage: boolean }) {
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListDocExternalQuery({ cursor, status });
  const [setStat] = useSetDocExternalStatusMutation();
  const [responded] = useMarkDocExternalRespondedMutation();
  const [registering, setRegistering] = useState<DocExternalRow | "new" | null>(null);
  const [rejecting, setRejecting] = useState<DocExternalRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(errorMessage(e));
  return (
    <Card title="Correspondence" actions={manage ? <Button onClick={() => setRegistering("new")}>Register correspondence</Button> : undefined}>
      <FormField label="Status" htmlFor="ex-status"><select id="ex-status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{Object.entries(SUBMISSION).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data?.results.length === 0 && <EmptyState title="No correspondence" />}
      <ul className="divide-y divide-slate-100 text-sm">
        {q.data?.results.map((r) => {
          const st = SUBMISSION[r.submission_status] ?? { label: r.submission_status, tone: "slate" as const, next: [] };
          return (
            <li key={r.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2"><Link className="font-medium text-indigo-700 underline" to={`/app/documents/${r.document}`}>{r.reference}</Link><span>{r.direction === "INCOMING" ? "from" : "to"} {r.party_name}</span><Badge tone={st.tone}>{st.label}</Badge>
                {r.response_due_on && !r.responded_on && <Badge tone="amber">Reply due {r.response_due_on}</Badge>}{r.responded_on && <Badge tone="green">Replied {r.responded_on}</Badge>}</div>
              {manage && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {st.next.map((n) => n === "REJECTED"
                    ? <Button key={n} variant="danger" aria-label={`Reject ${r.reference}`} onClick={() => setRejecting(r)}>Reject</Button>
                    : <Button key={n} variant="secondary" aria-label={`${NEXT_LABEL[n]} ${r.reference}`} onClick={() => { setErr(null); setStat({ id: r.id, status: n, note: "" }).unwrap().catch(fail); }}>{NEXT_LABEL[n]}</Button>)}
                  {r.response_due_on && !r.responded_on && <Button variant="secondary" aria-label={`Mark ${r.reference} as replied`} onClick={() => { setErr(null); responded({ id: r.id }).unwrap().catch(fail); }}>Mark as replied</Button>}
                  {r.submission_status === "REJECTED" && <Button variant="secondary" aria-label={`Resubmit ${r.reference}`} onClick={() => setRegistering(r)}>Resubmit</Button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data?.next ?? null)}>Next page</Button>}</div>
      {registering && <RegisterDialog key={registering === "new" ? "new" : registering.id} resubmits={registering === "new" ? null : registering} onClose={() => setRegistering(null)} />}
      {rejecting && <ActionDialog title={`Reject ${rejecting.reference}`} cta="Reject" open onClose={() => setRejecting(null)} fields={[{ name: "note", label: "Reason", required: true }]} submit={async (v) => { await setStat({ id: rejecting.id, status: "REJECTED", note: (v.note ?? "").trim() }).unwrap(); }} />}
    </Card>
  );
}

function TransmittalDialog({ onClose }: { onClose: () => void }) {
  const docs = useListDocumentsQuery({ status: "PUBLISHED" });
  const projects = useListProjectsQuery({});
  const [create, { isLoading }] = useCreateDocTransmittalMutation();
  const [f, setF] = useState({ direction: "OUTGOING", party_name: "", purpose: "FOR_INFORMATION", project: "", response_due_on: "", notes: "" });
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = transmittalProblem(f.direction, f.party_name, picked);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await create({ direction: f.direction, party_name: f.party_name.trim(), purpose: f.purpose, items: picked.map((document) => ({ document })), ...(f.project ? { project: f.project } : {}), ...(f.response_due_on ? { response_due_on: f.response_due_on } : {}), ...(f.notes.trim() ? { notes: f.notes.trim() } : {}) }).unwrap(); onClose(); }
    catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New transmittal" open onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Direction" htmlFor="tr-dir"><select id="tr-dir" className={inputClass} value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="OUTGOING">Sent to them</option><option value="INCOMING">Received from them</option></select></FormField>
        <FormField label="Party" htmlFor="tr-party"><input id="tr-party" className={inputClass} value={f.party_name} onChange={(e) => setF({ ...f, party_name: e.target.value })} /></FormField>
        <FormField label="Purpose" htmlFor="tr-purpose"><select id="tr-purpose" className={inputClass} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>{PURPOSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
        <FormField label="Project (optional)" htmlFor="tr-project"><select id="tr-project" className={inputClass} value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })}><option value="">None</option>{(projects.data?.results ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select></FormField>
        <FormField label="Reply due by" htmlFor="tr-due"><input id="tr-due" type="date" className={inputClass} value={f.response_due_on} onChange={(e) => setF({ ...f, response_due_on: e.target.value })} /></FormField>
        <FormField label="Notes" htmlFor="tr-notes"><input id="tr-notes" className={inputClass} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></FormField>
      </div>
      <fieldset className="mb-3"><legend className="text-sm font-medium text-slate-700">Documents (current issued version)</legend>
        <div className="max-h-40 overflow-y-auto">{(docs.data?.results ?? []).map((d) => <label key={d.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={picked.includes(d.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))} />{d.reference} — {d.title}</label>)}</div>
      </fieldset>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Create transmittal</Button></div>
    </Modal>
  );
}

function Transmittals({ manage }: { manage: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListDocTransmittalsQuery({ cursor });
  const [adding, setAdding] = useState(false);
  return (
    <Card title="Transmittals" actions={manage ? <Button onClick={() => setAdding(true)}>New transmittal</Button> : undefined}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data?.results.length === 0 && <EmptyState title="No transmittals" />}
      <ul className="divide-y divide-slate-100 text-sm">{q.data?.results.map((t) => (
        <li key={t.id} className="py-3"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{t.number}</span><span>{t.direction === "OUTGOING" ? "to" : "from"} {t.party}</span><Badge tone="slate">{PURPOSES.find(([k]) => k === t.purpose)?.[1] ?? t.purpose}</Badge><span className="text-slate-500">{t.sent_on}</span></div>
          <p className="text-slate-600">{t.items.map((i) => `${i.reference} v${i.version}`).join(", ")}</p></li>
      ))}</ul>
      <div className="mt-3 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data?.next ?? null)}>Next page</Button>}</div>
      {adding && <TransmittalDialog onClose={() => setAdding(false)} />}
    </Card>
  );
}

function RfiDialog({ onClose }: { onClose: () => void }) {
  const projects = useListProjectsQuery({});
  const users = useUserOptions();
  const [create, { isLoading }] = useCreateDocRfiMutation();
  const [f, setF] = useState({ project: "", subject: "", question: "", assigned_to: "", due_date: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = rfiProblem(f.project, f.subject, f.question, f.assigned_to);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await create({ project: f.project, subject: f.subject.trim(), question: f.question.trim(), assigned_to: f.assigned_to, ...(f.due_date ? { due_date: f.due_date } : {}) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Raise a request for information" open onClose={onClose}>
      <FormField label="Project" htmlFor="rf-project"><select id="rf-project" className={inputClass} value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })}><option value="">Choose…</option>{(projects.data?.results ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select></FormField>
      <FormField label="Subject" htmlFor="rf-subject"><input id="rf-subject" className={inputClass} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></FormField>
      <FormField label="Question" htmlFor="rf-q"><textarea id="rf-q" rows={3} className={inputClass} value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} /></FormField>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Who should answer" htmlFor="rf-who"><select id="rf-who" className={inputClass} value={f.assigned_to} onChange={(e) => setF({ ...f, assigned_to: e.target.value })}><option value="">Choose…</option>{users.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
        <FormField label="Answer by" htmlFor="rf-due"><input id="rf-due" type="date" className={inputClass} value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></FormField>
      </div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Raise request</Button></div>
    </Modal>
  );
}

function Rfis({ manage }: { manage: boolean }) {
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListDocRfisQuery({ cursor, status });
  const [answer] = useAnswerDocRfiMutation();
  const [close] = useCloseDocRfiMutation();
  const nameOf = useUserNames();
  const [adding, setAdding] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tone = { OPEN: "amber", ANSWERED: "green", CLOSED: "slate" } as const;
  return (
    <Card title="Requests for information" actions={manage ? <Button onClick={() => setAdding(true)}>Raise request</Button> : undefined}>
      <FormField label="Status" htmlFor="rfi-status"><select id="rfi-status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option><option value="OPEN">Open</option><option value="ANSWERED">Answered</option><option value="CLOSED">Closed</option></select></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data?.results.length === 0 && <EmptyState title="No requests for information" />}
      <ul className="divide-y divide-slate-100 text-sm">{q.data?.results.map((r) => (
        <li key={r.id} className="py-3">
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{r.number}</span><span>{r.subject}</span><Badge tone={tone[r.status as keyof typeof tone] ?? "slate"}>{r.status === "OPEN" ? "Open" : r.status === "ANSWERED" ? "Answered" : "Closed"}</Badge></div>
          <p className="text-slate-600">{r.question}</p><p className="text-xs text-slate-500">Raised by {nameOf(r.raised_by)}, to {nameOf(r.assigned_to)}{r.due_date ? `, due ${r.due_date}` : ""}</p>
          {r.response && <p className="mt-1">Answer: {r.response}</p>}
          <div className="mt-2 flex gap-2">
            {r.status === "OPEN" && <Button variant="secondary" aria-label={`Answer ${r.number}`} onClick={() => setAnswering(r.id)}>Answer</Button>}
            {r.status === "ANSWERED" && <Button variant="secondary" aria-label={`Close ${r.number}`} onClick={() => { setErr(null); close(r.id).unwrap().catch((e) => setErr(errorMessage(e))); }}>Close</Button>}
          </div>
        </li>
      ))}</ul>
      <div className="mt-3 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data?.next ?? null)}>Next page</Button>}</div>
      {adding && <RfiDialog onClose={() => setAdding(false)} />}
      {answering && <ActionDialog title="Answer request" cta="Send answer" open onClose={() => setAnswering(null)} fields={[{ name: "response", label: "Your answer", required: true, type: "textarea" }]} submit={async (v) => { await answer({ id: answering, response: (v.response ?? "").trim() }).unwrap(); }} />}
    </Card>
  );
}

export function ExternalPage() {
  const { can } = useAccess();
  const manage = can("documents.external.manage");
  const [tab, setTab] = useState("mail");
  const tabs: [string, string][] = [["mail", "Correspondence"], ["transmittals", "Transmittals"], ["rfis", "Requests for information"]];
  return (
    <>
      <PageHeader title="External documents" description="Letters and submissions to and from suppliers, contractors, authorities and customers." />
      <p className="mb-3 text-sm"><Link className="text-indigo-700 underline" to="/app/documents">← All documents</Link></p>
      <div role="tablist" aria-label="External document sections" className="mb-4 flex flex-wrap gap-2">
        {tabs.map(([k, l]) => <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 text-sm ${tab === k ? "bg-brand-600 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}>{l}</button>)}
      </div>
      {tab === "mail" && <Correspondence manage={manage} />}
      {tab === "transmittals" && <Transmittals manage={manage} />}
      {tab === "rfis" && <Rfis manage={manage} />}
    </>
  );
}

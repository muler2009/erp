import { useState } from "react";
import { Link, useParams } from "react-router";

import { useAddAuditQuestionMutation, useAnswerAuditQuestionMutation, useGetQualityAuditQuery, useListQualityConfigQuery, useQualityAuditActionMutation, useRaiseAuditFindingMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QChecklistItem, QFinding } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { auditTone } from "./AuditsPage";
import { useUserNames, useUserOptions } from "./names";
import { EvidencePanel, HistoryPanel } from "./panels";

export const RESPONSES = ["CONFORMS", "NONCONFORMS", "OBSERVATION", "NOT_APPLICABLE"];

export function validateAnswer(response: string, note: string): string | null {
  if (!RESPONSES.includes(response)) return "Choose a response.";
  if (["NONCONFORMS", "OBSERVATION"].includes(response) && !note.trim()) return "Describe what was observed.";
  return null;
}

export function validateFinding(type: string, severity: string, description: string): string | null {
  if (!type) return "Choose the finding type.";
  if (!severity) return "Choose the severity.";
  if (!description.trim()) return "Describe the finding.";
  return null;
}

/** Mirrors the server's report checks, in the server's order. */
export function reportBlock(checklist: Pick<QChecklistItem, "id" | "response">[], findings: Pick<QFinding, "checklist_item_id">[], summary: string): string | null {
  const pending = checklist.filter((c) => c.response === "PENDING").length;
  if (pending) return `${pending} checklist question(s) are unanswered.`;
  if (!summary.trim()) return "Write the audit summary.";
  const raised = new Set(findings.map((f) => f.checklist_item_id).filter(Boolean));
  const unraised = checklist.filter((c) => c.response === "NONCONFORMS" && !raised.has(c.id)).length;
  if (unraised) return `${unraised} non-conforming answer(s) have no finding raised.`;
  return null;
}

export function closeBlock(findings: Pick<QFinding, "status">[]): string | null {
  return findings.some((f) => f.status !== "CLOSED") ? "Every finding must be closed before the audit is closed." : null;
}

function Question({ c, canAnswer }: { c: QChecklistItem; canAnswer: boolean }) {
  const [answer] = useAnswerAuditQuestionMutation();
  const [v, setV] = useState({ response: c.response === "PENDING" ? "" : c.response, note: c.note });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const m = validateAnswer(v.response, v.note);
    if (m) { setErr(m); return; }
    setErr(null);
    try { await answer({ id: c.id, body: { response: v.response, note: v.note.trim() } }).unwrap(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <li className="border-b border-slate-100 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="text-slate-500">{c.position}.</span><span className="min-w-48 flex-1">{c.question}</span>
        <Badge tone={c.response === "CONFORMS" ? "green" : c.response === "NONCONFORMS" ? "red" : c.response === "PENDING" ? "slate" : "amber"}>{c.response === "PENDING" ? "Unanswered" : pretty(c.response)}</Badge></div>
      {!canAnswer && c.note && <div className="text-slate-600">{c.note}</div>}
      {canAnswer && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <select aria-label={`Response to question ${c.position}`} className={`${inputClass} w-44`} value={v.response} onChange={(e) => setV({ ...v, response: e.target.value })}><option value="">Choose…</option>{RESPONSES.map((r) => <option key={r} value={r}>{pretty(r)}</option>)}</select>
          <input aria-label={`Note for question ${c.position}`} placeholder="What was observed" className={`${inputClass} w-64`} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
          <Button variant="secondary" aria-label={`Save answer ${c.position}`} onClick={() => void go()}>Save answer</Button>
        </div>
      )}
      {err && <p role="alert" className="mt-1 text-red-700">{err}</p>}
    </li>
  );
}

export function AuditPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.audit.manage");
  const reporter = can("quality.report");
  const { data: a, isLoading, error, refetch } = useGetQualityAuditQuery(id);
  const [act] = useQualityAuditActionMutation();
  const [addQ] = useAddAuditQuestionMutation();
  const [raise] = useRaiseAuditFindingMutation();
  const findingTypes = useListQualityConfigQuery("FINDING_TYPE", { skip: !manage });
  const severities = useListQualityConfigQuery("SEVERITY", { skip: !manage });
  const people = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"question" | "finding" | "report" | "cancel" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !a) return <ErrorState error={error} onRetry={refetch} />;
  const running = a.status === "IN_PROGRESS";
  const run = async (action: "start" | "close") => { setErr(null); try { await act({ id: a.id, action }).unwrap(); } catch (e) { setErr(failure(e)); } };
  const tryReport = () => { const m = reportBlock(a.checklist, a.findings, "x"); if (m) { setErr(m); return; } setErr(null); setDlg("report"); };
  const tryClose = () => { const m = closeBlock(a.findings); if (m) { setErr(m); return; } void run("close"); };
  return (
    <>
      <PageHeader title={`${a.number} · ${a.title}`} description={`${pretty(a.audit_type)} · ${a.planned_start} to ${a.planned_end} · lead ${nameOf(a.lead_auditor_id)}`} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/audits">All audits</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={auditTone(a.status)}>{pretty(a.status)}</Badge>{a.team.map((t) => <Badge key={t.user_id} tone="slate">{`${nameOf(t.user_id)} (${pretty(t.role)})`}</Badge>)}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Scope">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2"><dt className="font-medium">Scope</dt><dd>{a.scope}</dd><dt className="font-medium">Objectives</dt><dd>{a.objectives || "–"}</dd><dt className="font-medium">Criteria</dt><dd>{a.criteria || "–"}</dd>{a.summary && <><dt className="font-medium">Summary</dt><dd>{a.summary}</dd></>}</dl>
          <div className="mt-3 flex flex-wrap gap-2">
            {manage && a.status === "PLANNED" && <Button onClick={() => void run("start")}>Start audit</Button>}
            {manage && running && <Button onClick={() => setDlg("finding")}>Raise a finding</Button>}
            {manage && running && <Button onClick={tryReport}>Report the audit</Button>}
            {manage && a.status === "REPORTED" && <Button onClick={tryClose}>Close audit</Button>}
            {manage && a.status === "PLANNED" && <Button variant="secondary" onClick={() => setDlg("cancel")}>Cancel audit</Button>}
          </div>
        </Card>
        <Card title="Checklist" actions={manage && ["PLANNED", "IN_PROGRESS"].includes(a.status) ? <Button variant="secondary" onClick={() => setDlg("question")}>Add a question</Button> : undefined}>
          {!a.checklist.length ? <EmptyState title="No checklist questions" /> : <ul>{a.checklist.map((c) => <Question key={`${c.id}-${c.response}-${c.note}`} c={c} canAnswer={manage && running} />)}</ul>}
        </Card>
        <Card title="Findings">
          {!a.findings.length ? <EmptyState title="No findings" /> : (
            <ul className="text-sm">{a.findings.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2"><Link className="text-blue-700 underline" to={`/app/quality/findings/${f.id}`}>{f.number}</Link><Badge tone="slate">{pretty(f.finding_type)}</Badge><Badge tone={f.severity === "MAJOR" || f.severity === "CRITICAL" ? "red" : "amber"}>{pretty(f.severity)}</Badge><span className="min-w-40 flex-1">{f.description}</span><Badge tone={f.status === "CLOSED" ? "green" : "amber"}>{pretty(f.status)}</Badge></li>))}</ul>
          )}
        </Card>
        <EvidencePanel record="audit" id={a.id} evidence={a.evidence} canUpload={reporter && ["PLANNED", "IN_PROGRESS", "REPORTED"].includes(a.status)} />
        <HistoryPanel history={a.history} />
      </div>
      <ActionDialog title="Add a checklist question" open={dlg === "question"} onClose={() => setDlg(null)} cta="Add" fields={[{ name: "question", label: "Question", required: true }]} submit={(v) => addQ({ id: a.id, body: { question: (v.question ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Raise a finding" open={dlg === "finding"} onClose={() => setDlg(null)} cta="Raise finding"
        fields={[{ name: "finding_type", label: "Finding type", required: true, options: (findingTypes.data ?? []).map((t) => [t.code, t.name] as [string, string]) }, { name: "severity", label: "Severity", required: true, options: (severities.data ?? []).map((t) => [t.code, t.name] as [string, string]) },
          { name: "description", label: "Description", required: true }, { name: "requirement_ref", label: "Requirement or clause" },
          { name: "checklist_item_id", label: "Checklist question", options: a.checklist.map((c) => [c.id, `${c.position}. ${c.question.slice(0, 60)}`] as [string, string]) },
          { name: "owner_id", label: "Owner", options: people, searchUsers: true }, { name: "due_date", label: "Due date", type: "date" }]}
        submit={async (v) => { const m = validateFinding(v.finding_type ?? "", v.severity ?? "", v.description ?? ""); if (m) throw new Error(m);
          const body: Record<string, unknown> = { finding_type: v.finding_type, severity: v.severity, description: (v.description ?? "").trim() };
          for (const k of ["requirement_ref", "checklist_item_id", "owner_id", "due_date"] as const) if ((v[k] ?? "").trim()) body[k] = (v[k] ?? "").trim();
          await raise({ id: a.id, body }).unwrap(); }} />
      <ActionDialog title="Report the audit" open={dlg === "report"} onClose={() => setDlg(null)} cta="Report" fields={[{ name: "summary", label: "Summary", required: true }]}
        submit={async (v) => { const m = reportBlock(a.checklist, a.findings, v.summary ?? ""); if (m) throw new Error(m); await act({ id: a.id, action: "report", body: { summary: (v.summary ?? "").trim() } }).unwrap(); }} />
      <ActionDialog title="Cancel audit" open={dlg === "cancel"} onClose={() => setDlg(null)} cta="Cancel audit" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => act({ id: a.id, action: "cancel", body: { reason: (v.reason ?? "").trim() } }).unwrap()} />
    </>
  );
}

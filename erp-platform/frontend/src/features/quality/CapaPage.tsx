import { useState } from "react";
import { Link, useParams } from "react-router";

import { useAddCapaRootCauseMutation, useCapaActionMutation, useGetCapaQuery, useListQualityConfigQuery, useUpdateCapaMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { CapaDetail } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { capaTone } from "./CapaListPage";
import { useUserNames } from "./names";
import { ActionsPanel, EvidencePanel, HistoryPanel } from "./panels";

/** Mirrors the server's checks for submitting a CAPA for approval. */
export function validateCapaSubmit(c: Pick<CapaDetail, "analyses" | "corrective" | "preventive" | "actions" | "cycles">): string | null {
  if (!c.analyses.some((a) => a.cycle === c.cycles)) return "Record a root cause analysis first.";
  if (!c.corrective.trim() && !c.preventive.trim()) return "Describe the corrective or preventive action.";
  if (!c.actions.some((a) => ["CORRECTIVE", "PREVENTIVE"].includes(a.action_type) && a.status !== "CANCELLED")) return "Assign at least one corrective or preventive action with an owner and due date.";
  return null;
}

/** Mirrors the server's checks for marking a CAPA implemented. */
export function validateImplemented(c: Pick<CapaDetail, "actions" | "evidence">): string | null {
  if (c.actions.some((a) => a.status === "OPEN")) return "Every action must be completed first.";
  if (!c.evidence.length) return "Attach the evidence of implementation first.";
  return null;
}

export function canResubmitCapa(c: Pick<CapaDetail, "status" | "history">): boolean {
  if (c.status !== "ANALYSIS") return false;
  const last = [...c.history].reverse().find((h) => ["SUBMITTED", "RESUBMITTED", "CHANGES_REQUESTED", "REJECTED", "WITHDRAWN", "APPROVED", "NOT_EFFECTIVE"].includes(h.action));
  return last?.action === "CHANGES_REQUESTED";
}

type Dlg = "rca" | "submit" | "implemented" | "effectiveness" | "cancel" | null;

function PlanEditor({ c, onClose }: { c: CapaDetail | null; onClose: () => void }) {
  const [update] = useUpdateCapaMutation();
  const [f, setF] = useState({ containment: c?.containment ?? "", correction: c?.correction ?? "", corrective: c?.corrective ?? "", preventive: c?.preventive ?? "", justification: c?.justification ?? "", due_date: c?.due_date ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setErr(null);
    if (!f.due_date) { setErr("Enter the due date."); return; }
    try { await update({ id: c!.id, body: f }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  const area = (k: keyof typeof f, label: string) => <FormField label={label} htmlFor={`pl-${k}`}><textarea id={`pl-${k}`} className={inputClass} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></FormField>;
  return (
    <Modal title="Edit plan" open={!!c} onClose={onClose}>
      {area("containment", "Containment")}{area("correction", "Correction")}{area("corrective", "Corrective action")}{area("preventive", "Preventive action")}{area("justification", "Justification")}
      <FormField label="Due date" htmlFor="pl-due"><input id="pl-due" type="date" className={inputClass} value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Save plan</Button></div>
    </Modal>
  );
}

export function CapaPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.capa.manage");
  const verifier = can("quality.capa.verify");
  const reporter = can("quality.report");
  const { data: c, isLoading, error, refetch } = useGetCapaQuery(id);
  const [act] = useCapaActionMutation();
  const [addRca] = useAddCapaRootCauseMutation();
  const methods = useListQualityConfigQuery("ANALYSIS_METHOD");
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !c) return <ErrorState error={error} onRetry={refetch} />;
  const done = c.status === "CLOSED" || c.status === "CANCELLED";
  const run = async (action: Parameters<typeof act>[0]["action"], body?: Record<string, unknown>) => { setErr(null); try { await act({ id: c.id, action, body }).unwrap(); } catch (e) { setErr(failure(e)); } };
  const gate = (check: string | null, next: Dlg) => { if (check) { setErr(check); return; } setErr(null); setDlg(next); };
  return (
    <>
      <PageHeader title={`${c.number} · ${c.title}`} description={`Owner ${nameOf(c.owner_id)} · reviewer ${nameOf(c.reviewer_id)} · due ${c.due_date}`} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/capas">All CAPAs</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={capaTone(c.status)}>{pretty(c.status)}</Badge><Badge tone="slate">{pretty(c.kind)}</Badge>{c.overdue && <Badge tone="red">Overdue</Badge>}{c.cycles > 1 && <Badge tone="amber">{`Cycle ${c.cycles}`}</Badge>}{c.effectiveness_due && <Badge tone="slate">{`Effectiveness review due ${c.effectiveness_due}`}</Badge>}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Plan">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <dt className="font-medium">Problem</dt><dd>{c.problem}</dd>
            <dt className="font-medium">Triggered by</dt><dd>{pretty(c.source_type)}</dd>
            <dt className="font-medium">Containment</dt><dd>{c.containment || "–"}</dd>
            <dt className="font-medium">Correction</dt><dd>{c.correction || "–"}</dd>
            <dt className="font-medium">Corrective action</dt><dd>{c.corrective || "–"}</dd>
            <dt className="font-medium">Preventive action</dt><dd>{c.preventive || "–"}</dd>
            <dt className="font-medium">Justification</dt><dd>{c.justification || "–"}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            {manage && c.status === "ANALYSIS" && <>
              <Button variant="secondary" onClick={() => setEditing(true)}>Edit plan</Button>
              <Button variant="secondary" onClick={() => setDlg("rca")}>Record a root cause analysis</Button>
              <Button onClick={() => gate(validateCapaSubmit(c), "submit")}>Submit for approval</Button>
            </>}
            {manage && canResubmitCapa(c) && <Button onClick={() => void run("resubmit")}>Resubmit for approval</Button>}
            {manage && c.status === "APPROVED" && <Button onClick={() => void run("start")}>Start implementation</Button>}
            {manage && c.status === "IMPLEMENTING" && <Button onClick={() => gate(validateImplemented(c), "implemented")}>Mark implemented</Button>}
            {verifier && c.status === "VERIFYING" && <Button onClick={() => setDlg("effectiveness")}>Verify effectiveness</Button>}
            {manage && !done && <Button variant="secondary" onClick={() => setDlg("cancel")}>Cancel CAPA</Button>}
          </div>
          {c.status === "PENDING_APPROVAL" && <p className="mt-2 text-sm text-slate-600">Waiting for approval. Approvers decide it from their approvals inbox.</p>}
        </Card>
        <Card title="Root cause analysis">
          {!c.analyses.length ? <EmptyState title="No analysis recorded" /> : (
            <ul className="text-sm">{c.analyses.map((a) => <li key={a.id} className="border-b border-slate-100 py-2"><Badge tone="slate">{pretty(a.method)}</Badge> <span className="text-slate-500">cycle {a.cycle}</span><div>{a.conclusion}</div></li>)}</ul>
          )}
        </Card>
        {c.reviews.length > 0 && (
          <Card title="Effectiveness reviews">
            <ul className="text-sm">{c.reviews.map((r, i) => <li key={i} className="border-b border-slate-100 py-2"><Badge tone={r.effective ? "green" : "red"}>{r.effective ? "Effective" : "Not effective"}</Badge> <span className="text-slate-500">{r.verified_on} by {nameOf(r.verified_by)} · cycle {r.cycle}</span><div>{r.notes}</div></li>)}</ul>
          </Card>
        )}
        <ActionsPanel parent="capa" id={c.id} actions={c.actions} canManage={manage} canReport={reporter} open={!done} />
        <EvidencePanel record="capa" id={c.id} evidence={c.evidence} canUpload={reporter && !done} />
        <HistoryPanel history={c.history} />
      </div>
      <PlanEditor key={editing ? `${c.id}-${c.corrective}` : "x"} c={editing ? c : null} onClose={() => setEditing(false)} />
      <ActionDialog title="Record a root cause analysis" open={dlg === "rca"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "method", label: "Method", required: true, options: (methods.data ?? []).map((m) => [m.code, m.name] as [string, string]) }, { name: "conclusion", label: "Conclusion", required: true }]}
        submit={(v) => addRca({ id: c.id, body: { method: v.method, conclusion: (v.conclusion ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Submit CAPA for approval" open={dlg === "submit"} onClose={() => setDlg(null)} cta="Submit" fields={[{ name: "comment", label: "Comment for the approvers" }]} submit={(v) => act({ id: c.id, action: "submit", body: { comment: (v.comment ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Mark implemented" open={dlg === "implemented"} onClose={() => setDlg(null)} cta="Mark implemented" fields={[{ name: "note", label: "Implementation note" }]} submit={(v) => act({ id: c.id, action: "implemented", body: { note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Verify effectiveness" open={dlg === "effectiveness"} onClose={() => setDlg(null)} cta="Record verification" fields={[{ name: "effective", label: "Was it effective?", required: true, options: [["yes", "Yes — close the CAPA"], ["no", "No — send back to analysis"]] }, { name: "notes", label: "Effectiveness evidence", required: true }]}
        submit={(v) => act({ id: c.id, action: "effectiveness", body: { effective: v.effective === "yes", notes: (v.notes ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Cancel CAPA" open={dlg === "cancel"} onClose={() => setDlg(null)} cta="Cancel CAPA" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => act({ id: c.id, action: "cancel", body: { reason: (v.reason ?? "").trim() } }).unwrap()} />
    </>
  );
}

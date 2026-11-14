import { useState } from "react";
import { Link, useParams } from "react-router";

import { useGetNcrQuery, useNcrActionMutation, useUpdateNcrMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { NcrDetail } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";
import { ncrTone, severityTone } from "./NcrListPage";
import { ActionsPanel, CostsPanel, EvidencePanel, HistoryPanel } from "./panels";

/** Mirrors the server's checks so the gap is named before the round trip. */
export function validateSubmission(n: Pick<NcrDetail, "investigator_id" | "root_cause" | "proposed_correction">): string | null {
  if (!n.investigator_id) return "Assign an investigator first.";
  if (!n.root_cause.trim() || !n.proposed_correction.trim()) return "Record the root cause and the proposed correction before submitting.";
  return null;
}

/** Changes were requested when the last approval event on the record is CHANGES_REQUESTED. */
export function canResubmit(n: Pick<NcrDetail, "status" | "history">): boolean {
  if (n.status !== "INVESTIGATING") return false;
  const last = [...n.history].reverse().find((h) => ["SUBMITTED", "RESUBMITTED", "CHANGES_REQUESTED", "REJECTED", "WITHDRAWN", "APPROVED"].includes(h.action));
  return last?.action === "CHANGES_REQUESTED";
}

type Dlg = "contain" | "assign" | "close" | "reopen" | "dismiss" | "capa" | "submit" | null;

function Investigation({ n, onClose }: { n: NcrDetail | null; onClose: () => void }) {
  const [update] = useUpdateNcrMutation();
  const [f, setF] = useState({ root_cause: n?.root_cause ?? "", proposed_correction: n?.proposed_correction ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setErr(null);
    try { await update({ id: n!.id, body: { root_cause: f.root_cause.trim(), proposed_correction: f.proposed_correction.trim() } }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Investigation" open={!!n} onClose={onClose}>
      <FormField label="Root cause" htmlFor="iv-rc"><textarea id="iv-rc" className={inputClass} value={f.root_cause} onChange={(e) => setF({ ...f, root_cause: e.target.value })} /></FormField>
      <FormField label="Proposed correction" htmlFor="iv-pc"><textarea id="iv-pc" className={inputClass} value={f.proposed_correction} onChange={(e) => setF({ ...f, proposed_correction: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Save</Button></div>
    </Modal>
  );
}

export function NcrPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.ncr.manage");
  const capa = can("quality.capa.manage");
  const verifier = can("quality.capa.verify");
  const reporter = can("quality.report");
  const { data: n, isLoading, error, refetch } = useGetNcrQuery(id);
  const [act] = useNcrActionMutation();
  const nameOf = useUserNames();
  const people = useUserOptions(!manage && !capa);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !n) return <ErrorState error={error} onRetry={refetch} />;
  const closed = n.status === "CLOSED" || n.status === "REJECTED";
  const run = async (action: Parameters<typeof act>[0]["action"], body?: Record<string, unknown>) => { setErr(null); try { await act({ id: n.id, action, body }).unwrap(); } catch (e) { setErr(failure(e)); } };
  const trySubmit = () => { const p = validateSubmission(n); if (p) { setErr(p); return; } setDlg("submit"); };
  return (
    <>
      <PageHeader title={`${n.number} · ${n.title}`} description={`Raised ${n.detected_on} by ${nameOf(n.reported_by)}`} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/ncrs">All non-conformances</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={ncrTone(n.status)}>{pretty(n.status)}</Badge><Badge tone={severityTone(n.severity)}>{pretty(n.severity)}</Badge><Badge tone="slate">{pretty(n.category)}</Badge>{n.reopened_count > 0 && <Badge tone="amber">{`Reopened ${n.reopened_count}×`}</Badge>}{n.holds.map((h) => <Badge key={h} tone="red">{`Hold ${h}`}</Badge>)}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Details">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <dt className="font-medium">What is wrong</dt><dd>{n.description}</dd>
            <dt className="font-medium">Affected items</dt><dd>{n.affected_items || "–"}</dd>
            <dt className="font-medium">Found in</dt><dd>{pretty(n.source)}{n.source_ref_id ? ` (${n.source_ref_type} ${n.source_ref_id.slice(0, 8)})` : ""}</dd>
            <dt className="font-medium">Lot</dt><dd>{n.lot_number || "–"}</dd>
            <dt className="font-medium">Investigator</dt><dd>{nameOf(n.investigator_id)}</dd>
            <dt className="font-medium">Containment</dt><dd>{n.containment || "Not yet contained"}</dd>
            <dt className="font-medium">Root cause</dt><dd>{n.root_cause || "–"}</dd>
            <dt className="font-medium">Proposed correction</dt><dd>{n.proposed_correction || "–"}</dd>
            {n.verification_note && <><dt className="font-medium">Verification</dt><dd>{n.verification_note}</dd></>}
            {n.capa_id && <><dt className="font-medium">CAPA</dt><dd><Link className="text-blue-700 underline" to={`/app/quality/capas/${n.capa_id}`}>Open the linked CAPA</Link></dd></>}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            {manage && !closed && ["OPEN", "INVESTIGATING"].includes(n.status) && <>
              <Button variant="secondary" onClick={() => setEditing(true)}>Edit investigation</Button>
              <Button variant="secondary" onClick={() => setDlg("assign")}>Assign investigator</Button>
              <Button onClick={trySubmit}>Submit for approval</Button>
              <Button variant="secondary" onClick={() => setDlg("dismiss")}>Dismiss</Button>
            </>}
            {manage && !closed && <Button variant="secondary" onClick={() => setDlg("contain")}>Record containment</Button>}
            {manage && canResubmit(n) && <Button onClick={() => void run("resubmit")}>Resubmit for approval</Button>}
            {manage && n.status === "APPROVED" && <Button onClick={() => void run("implement")}>Start implementation</Button>}
            {manage && n.status === "IMPLEMENTING" && <Button onClick={() => void run("request-verification")}>Request verification</Button>}
            {capa && !closed && !n.capa_id && <Button variant="secondary" onClick={() => setDlg("capa")}>Raise a CAPA</Button>}
            {verifier && n.status === "VERIFYING" && <Button onClick={() => setDlg("close")}>Verify and close</Button>}
            {verifier && n.status === "CLOSED" && <Button variant="secondary" onClick={() => setDlg("reopen")}>Reopen</Button>}
          </div>
          {n.status === "PENDING_APPROVAL" && <p className="mt-2 text-sm text-slate-600">Waiting for approval. Approvers decide it from their approvals inbox.</p>}
        </Card>
        <ActionsPanel parent="ncr" id={n.id} actions={n.actions} canManage={manage} canReport={reporter} open={!closed} />
        <EvidencePanel record="ncr" id={n.id} evidence={n.evidence} canUpload={reporter && !closed} />
        <CostsPanel refType="ncr" id={n.id} costs={n.costs} canRecord={manage} />
        <HistoryPanel history={n.history} />
      </div>
      <Investigation key={editing ? `${n.id}-${n.root_cause}` : "x"} n={editing ? n : null} onClose={() => setEditing(false)} />
      <ActionDialog title="Record containment" open={dlg === "contain"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "containment", label: "What was done to contain it", required: true }, ...(n.product_id ? [{ name: "hold", label: "Place the product on quality hold?", options: [["", "No"], ["yes", "Yes — hold this product and lot"]] as [string, string][] }] : [])]}
        submit={(v) => act({ id: n.id, action: "contain", body: { containment: (v.containment ?? "").trim(), place_hold: v.hold === "yes" } }).unwrap()} />
      <ActionDialog title="Assign investigator" open={dlg === "assign"} onClose={() => setDlg(null)} cta="Assign" fields={[{ name: "investigator_id", label: "Investigator", required: true, options: people }]} submit={(v) => act({ id: n.id, action: "assign", body: { investigator_id: v.investigator_id } }).unwrap()} />
      <ActionDialog title="Submit for approval" open={dlg === "submit"} onClose={() => setDlg(null)} cta="Submit" fields={[{ name: "comment", label: "Comment for the approvers" }]} submit={(v) => act({ id: n.id, action: "submit", body: { comment: (v.comment ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Dismiss non-conformance" open={dlg === "dismiss"} onClose={() => setDlg(null)} cta="Dismiss" fields={[{ name: "reason", label: "Reason (duplicate, raised in error…)", required: true }]} submit={(v) => act({ id: n.id, action: "dismiss", body: { reason: (v.reason ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Raise a CAPA" open={dlg === "capa"} onClose={() => setDlg(null)} cta="Raise CAPA" fields={[{ name: "kind", label: "Kind", required: true, options: [["CORRECTIVE", "Corrective"], ["PREVENTIVE", "Preventive"]] }, { name: "owner_id", label: "Owner", required: true, options: people }, { name: "reviewer_id", label: "Reviewer", required: true, options: people }, { name: "due_date", label: "Due date", type: "date", required: true }]}
        submit={(v) => { if (v.owner_id === v.reviewer_id) throw new Error("The owner and the reviewer must be different people."); return act({ id: n.id, action: "capa", body: { kind: v.kind, owner_id: v.owner_id, reviewer_id: v.reviewer_id, due_date: v.due_date } }).unwrap(); }} />
      <ActionDialog title="Verify and close" open={dlg === "close"} onClose={() => setDlg(null)} cta="Close non-conformance" fields={[{ name: "note", label: "Verification", required: true }]} submit={(v) => act({ id: n.id, action: "close", body: { note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Reopen non-conformance" open={dlg === "reopen"} onClose={() => setDlg(null)} cta="Reopen" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => act({ id: n.id, action: "reopen", body: { reason: (v.reason ?? "").trim() } }).unwrap()} />
    </>
  );
}

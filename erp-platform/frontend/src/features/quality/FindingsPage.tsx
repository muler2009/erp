import { useState } from "react";
import { Link, useParams } from "react-router";

import { useGetQualityFindingQuery, useListQualityConfigQuery, useListQualityFindingsQuery, useQualityFindingActionMutation } from "../../shared/api/endpoints";
import type { QFinding } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";
import { ActionsPanel } from "./panels";

/** Names what blocks closing a finding. The server also checks the linked CAPA's status. */
export function findingCloseBlock(f: Pick<QFinding, "finding_type" | "capa_id" | "actions">): string | null {
  if (f.finding_type !== "NONCONFORMITY") return null;
  const live = f.actions.filter((a) => a.status !== "CANCELLED");
  if (!f.capa_id && !live.length) return "A non-conformity needs a corrective action or a CAPA before it can be closed.";
  if (live.some((a) => ["OPEN", "DONE"].includes(a.status))) return "Every action on this finding must be verified first.";
  return null;
}

export function FindingsPage() {
  const [f, setF] = useState({ status: "", severity: "", overdue: false });
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityFindingsQuery({ status: f.status || undefined, severity: f.severity || undefined, overdue: f.overdue, cursor });
  const severities = useListQualityConfigQuery("SEVERITY");
  const nameOf = useUserNames();
  const reset = (n: typeof f) => { setF(n); setCursor(null); };
  return (
    <>
      <PageHeader title="Audit findings" description="Every finding stays open until its action is closed." />
      <Card>
        <div className="mb-3 flex flex-wrap gap-3">
          <label className="text-sm">Status <select aria-label="Finding status" className={inputClass} value={f.status} onChange={(e) => reset({ ...f, status: e.target.value })}><option value="">All</option><option value="OPEN">Open</option><option value="ACTION_ASSIGNED">Action assigned</option><option value="CLOSED">Closed</option></select></label>
          <label className="text-sm">Severity <select aria-label="Finding severity" className={inputClass} value={f.severity} onChange={(e) => reset({ ...f, severity: e.target.value })}><option value="">All</option>{severities.data?.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.overdue} onChange={(e) => reset({ ...f, overdue: e.target.checked })} /> Overdue only</label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No findings match" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Type</th><th>Severity</th><th>Description</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>{data.results.map((x) => (
              <tr key={x.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/findings/${x.id}`}>{x.number}</Link></td><td>{pretty(x.finding_type)}</td><td>{pretty(x.severity)}</td><td>{x.description}</td><td>{x.owner_id ? nameOf(x.owner_id) : "–"}</td><td>{x.due_date ?? "–"}</td><td><Badge tone={x.status === "CLOSED" ? "green" : "amber"}>{pretty(x.status)}</Badge></td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
    </>
  );
}

export function FindingPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.audit.manage");
  const actor = can("quality.ncr.manage");
  const { data: f, isLoading, error, refetch } = useGetQualityFindingQuery(id);
  const [act] = useQualityFindingActionMutation();
  const people = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"assign" | "capa" | "close" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !f) return <ErrorState error={error} onRetry={refetch} />;
  const closed = f.status === "CLOSED";
  const tryClose = () => { const m = findingCloseBlock(f); if (m) { setErr(m); return; } setErr(null); setDlg("close"); };
  return (
    <>
      <PageHeader title={`Finding ${f.number}`} description={f.description} actions={<Link className="text-sm text-blue-700 underline" to={`/app/quality/audits/${f.audit_id}`}>Open the audit</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={closed ? "green" : "amber"}>{pretty(f.status)}</Badge><Badge tone="slate">{pretty(f.finding_type)}</Badge><Badge tone="slate">{pretty(f.severity)}</Badge></div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Details">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <dt className="font-medium">Requirement</dt><dd>{f.requirement_ref || "–"}</dd>
            <dt className="font-medium">Owner</dt><dd>{f.owner_id ? nameOf(f.owner_id) : "Not assigned"}</dd>
            <dt className="font-medium">Due</dt><dd>{f.due_date ?? "–"}</dd>
            {f.capa_id && <><dt className="font-medium">CAPA</dt><dd><Link className="text-blue-700 underline" to={`/app/quality/capas/${f.capa_id}`}>Open the linked CAPA</Link></dd></>}
            {f.closure_note && <><dt className="font-medium">Closure</dt><dd>{f.closure_note}</dd></>}
          </dl>
          {manage && !closed && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setDlg("assign")}>Assign owner</Button>
              {!f.capa_id && <Button variant="secondary" onClick={() => setDlg("capa")}>Raise a CAPA</Button>}
              <Button onClick={tryClose}>Verify and close</Button>
            </div>
          )}
        </Card>
        <ActionsPanel parent="finding" id={f.id} actions={f.actions} canManage={actor} canReport={false} open={!closed} />
      </div>
      <ActionDialog title="Assign owner" open={dlg === "assign"} onClose={() => setDlg(null)} cta="Assign" fields={[{ name: "owner_id", label: "Owner", required: true, options: people, searchUsers: true }, { name: "due_date", label: "Due date", type: "date", required: true }]} submit={(v) => act({ id: f.id, action: "assign", body: { owner_id: v.owner_id, due_date: v.due_date } }).unwrap()} />
      <ActionDialog title="Raise a CAPA for this finding" open={dlg === "capa"} onClose={() => setDlg(null)} cta="Raise CAPA"
        fields={[{ name: "kind", label: "Kind", required: true, options: [["CORRECTIVE", "Corrective"], ["PREVENTIVE", "Preventive"]] }, { name: "owner_id", label: "Owner", required: true, options: people, searchUsers: true }, { name: "reviewer_id", label: "Effectiveness reviewer", required: true, options: people, searchUsers: true }, { name: "due_date", label: "Due date", type: "date", required: true }]}
        submit={(v) => { if (v.owner_id === v.reviewer_id) throw new Error("The owner and the reviewer must be different people."); return act({ id: f.id, action: "capa", body: { kind: v.kind, owner_id: v.owner_id, reviewer_id: v.reviewer_id, due_date: v.due_date } }).unwrap(); }} />
      <ActionDialog title="Verify and close finding" open={dlg === "close"} onClose={() => setDlg(null)} cta="Close finding" fields={[{ name: "note", label: "How closure was verified", required: true }]} submit={(v) => act({ id: f.id, action: "close", body: { note: (v.note ?? "").trim() } }).unwrap()} />
    </>
  );
}

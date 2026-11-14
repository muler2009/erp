import { useState } from "react";
import { Link, useParams } from "react-router";

import { useGetQualityInspectionQuery, useGetQualityPlanQuery, useListQualityConfigQuery, useQualityInspectionActionMutation, useRecordQualityDefectMutation, useRecordQualityResultMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QInspectionDetail, QParameter } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { resultTone } from "./InspectionsPage";
import { useUserNames } from "./names";
import { EvidencePanel, HistoryPanel } from "./panels";

const NUM = /^-?\d+(\.\d+)?$/;

/** Mirrors the server: which mandatory parameters still have no current result. */
export function missingResults(params: Pick<QParameter, "id" | "name" | "mandatory">[], results: Pick<QInspectionDetail["results"][number], "parameter_id" | "is_current">[]): string[] {
  const done = new Set(results.filter((r) => r.is_current).map((r) => r.parameter_id));
  return params.filter((p) => p.mandatory && !done.has(p.id)).map((p) => p.name);
}

export function validateResultEntry(p: Pick<QParameter, "kind" | "name">, value: string, text: string, existing: boolean, reason: string): string | null {
  if (p.kind === "NUMERIC" && !NUM.test(value.trim())) return `${p.name}: enter the measured value as a number.`;
  if (p.kind === "BOOLEAN" && !["PASS", "FAIL"].includes(text)) return `${p.name}: choose pass or fail.`;
  if (existing && !reason.trim()) return `${p.name}: a result is already recorded; give the reason for correcting it.`;
  return null;
}

export function validateDefect(code: string, qty: string): string | null {
  if (!code) return "Choose the defect type.";
  if (!NUM.test(qty.trim()) || Number(qty) <= 0) return "The quantity must be positive.";
  return null;
}

export function validateCompletion(missing: string[], accepted: string, rejected: string, conditional: boolean, note: string): string | null {
  if (missing.length) return `Mandatory results missing: ${missing.join(", ")}.`;
  for (const [l, v] of [["accepted", accepted], ["rejected", rejected]] as const) if (v.trim() && (!NUM.test(v.trim()) || Number(v) < 0)) return `The ${l} quantity must be zero or more.`;
  if (conditional && !note.trim()) return "Explain the conditions for accepting.";
  return null;
}

function ResultRow({ p, current, inspectionId, canRecord }: { p: QParameter; current: QInspectionDetail["results"][number] | undefined; inspectionId: string; canRecord: boolean }) {
  const [record] = useRecordQualityResultMutation();
  const [v, setV] = useState({ value: "", text: "", comment: "", reason: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const m = validateResultEntry(p, v.value, v.text, !!current, v.reason);
    if (m) { setErr(m); return; }
    setErr(null);
    const body: Record<string, unknown> = { parameter_id: p.id, comment: v.comment.trim() };
    if (p.kind === "NUMERIC") body.value = v.value.trim(); else body.text = v.text.trim();
    if (current) body.correction_reason = v.reason.trim();
    try { await record({ id: inspectionId, body }).unwrap(); setV({ value: "", text: "", comment: "", reason: "" }); } catch (e) { setErr(errorMessage(e)); }
  };
  const limit = p.kind === "NUMERIC" ? `${p.lower ?? "–"} to ${p.upper ?? "–"} ${p.unit}` : pretty(p.kind);
  return (
    <li className="border-b border-slate-100 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-40 font-medium">{p.name}</span><span className="text-slate-500">{limit}</span>
        {p.critical && <Badge tone="red">Critical</Badge>}
        {current ? <><Badge tone={current.passed ? "green" : "red"}>{current.passed ? "Pass" : "Fail"}</Badge><span>{current.value ?? current.text}</span></> : <Badge tone="slate">Not recorded</Badge>}
      </div>
      {canRecord && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {p.kind === "NUMERIC" && <input aria-label={`Value for ${p.name}`} className={`${inputClass} w-32`} value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} />}
          {p.kind === "BOOLEAN" && <select aria-label={`Outcome for ${p.name}`} className={`${inputClass} w-32`} value={v.text} onChange={(e) => setV({ ...v, text: e.target.value })}><option value="">Choose…</option><option value="PASS">Pass</option><option value="FAIL">Fail</option></select>}
          {p.kind === "TEXT" && <input aria-label={`Text for ${p.name}`} className={`${inputClass} w-48`} value={v.text} onChange={(e) => setV({ ...v, text: e.target.value })} />}
          <input aria-label={`Comment for ${p.name}`} placeholder="Comment" className={`${inputClass} w-48`} value={v.comment} onChange={(e) => setV({ ...v, comment: e.target.value })} />
          {current && <input aria-label={`Correction reason for ${p.name}`} placeholder="Reason for correcting" className={`${inputClass} w-48`} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />}
          <Button variant="secondary" aria-label={`${current ? "Correct" : "Record"} ${p.name}`} onClick={() => void go()}>{current ? "Correct" : "Record"}</Button>
        </div>
      )}
      {err && <p role="alert" className="mt-1 text-red-700">{err}</p>}
    </li>
  );
}

export function InspectionPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const inspect = can("quality.inspect");
  const reporter = can("quality.report");
  const { data: i, isLoading, error, refetch } = useGetQualityInspectionQuery(id);
  const { data: plan } = useGetQualityPlanQuery(i?.plan_id ?? "", { skip: !i });
  const defects = useListQualityConfigQuery("DEFECT_TYPE", { skip: !inspect });
  const [act] = useQualityInspectionActionMutation();
  const [addDefect] = useRecordQualityDefectMutation();
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"complete" | "cancel" | "reinspect" | "defect" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !i) return <ErrorState error={error} onRetry={refetch} />;
  const params = plan?.parameters ?? [];
  const missing = missingResults(params, i.results);
  const current = new Map(i.results.filter((r) => r.is_current).map((r) => [r.parameter_id, r]));
  const running = i.status === "IN_PROGRESS";
  const start = async () => { setErr(null); try { await act({ id: i.id, action: "start" }).unwrap(); } catch (e) { setErr(failure(e)); } };
  const tryComplete = () => { const m = missing.length ? validateCompletion(missing, "", "", false, "") : null; if (m) { setErr(m); return; } setErr(null); setDlg("complete"); };
  return (
    <>
      <PageHeader title={`${i.number} · ${plan?.title ?? "Inspection"}`} description={`${pretty(i.stage)} on ${i.scheduled_for} · inspector ${nameOf(i.inspector_id)}`} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/inspections">All inspections</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone="slate">{pretty(i.status)}</Badge>{i.result && <Badge tone={resultTone(i.result)}>{pretty(i.result)}</Badge>}{i.lot_number && <Badge tone="slate">{`Lot ${i.lot_number}`}</Badge>}{i.holds.map((h) => <Badge key={h} tone="red">{`Hold ${h}`}</Badge>)}{i.ncr_ids.map((n) => <Link key={n} className="text-sm text-blue-700 underline" to={`/app/quality/ncrs/${n}`}>Raised non-conformance</Link>)}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Quantities">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
            <dt className="font-medium">Total</dt><dd>{i.quantity_total}</dd><dt className="font-medium">To inspect</dt><dd>{i.quantity_inspected}</dd>
            <dt className="font-medium">Accepted</dt><dd>{i.quantity_accepted}</dd><dt className="font-medium">Rejected</dt><dd>{i.quantity_rejected}</dd>
          </dl>
          {i.summary && <p className="mt-2 text-sm">{i.summary}</p>}{i.conditional_note && <p className="mt-1 text-sm text-amber-800">{`Accepted on condition: ${i.conditional_note}`}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {inspect && i.status === "SCHEDULED" && <Button onClick={() => void start()}>Start inspection</Button>}
            {inspect && running && <Button onClick={tryComplete}>Complete inspection</Button>}
            {inspect && running && <Button variant="secondary" onClick={() => setDlg("defect")}>Record a defect</Button>}
            {inspect && ["SCHEDULED", "IN_PROGRESS"].includes(i.status) && <Button variant="secondary" onClick={() => setDlg("cancel")}>Cancel inspection</Button>}
            {inspect && i.status === "COMPLETED" && ["FAIL", "CONDITIONAL"].includes(i.result) && <Button variant="secondary" onClick={() => setDlg("reinspect")}>Schedule re-inspection</Button>}
          </div>
        </Card>
        <Card title="Results">
          {!params.length ? <EmptyState title="No parameters on this plan" /> : <ul>{params.map((p) => <ResultRow key={`${p.id}-${current.get(p.id)?.id ?? "n"}`} p={p} current={current.get(p.id)} inspectionId={i.id} canRecord={inspect && running} />)}</ul>}
          {i.results.some((r) => !r.is_current) && (
            <details className="mt-3 text-sm"><summary>Corrected results</summary>
              <ul>{i.results.filter((r) => !r.is_current).map((r) => <li key={r.id} className="text-slate-600">{`${r.parameter}: ${r.value ?? r.text} (${r.passed ? "pass" : "fail"}) — superseded, ${r.correction_reason || "corrected"}`}</li>)}</ul></details>
          )}
        </Card>
        <Card title="Defects">
          {!i.defects.length ? <EmptyState title="No defects recorded" /> : <ul className="text-sm">{i.defects.map((d) => <li key={d.id} className="border-b border-slate-100 py-1">{pretty(d.defect_code)} × {d.quantity}{d.note ? ` — ${d.note}` : ""}</li>)}</ul>}
        </Card>
        <EvidencePanel record="inspection" id={i.id} evidence={i.evidence} canUpload={reporter && i.status !== "CANCELLED"} />
        <HistoryPanel history={i.history} />
      </div>
      <ActionDialog title="Record a defect" open={dlg === "defect"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "defect_code", label: "Defect type", required: true, options: (defects.data ?? []).map((d) => [d.code, d.name] as [string, string]) }, { name: "quantity", label: "Quantity", required: true }, { name: "note", label: "Note" }]}
        submit={async (v) => { const m = validateDefect(v.defect_code ?? "", v.quantity ?? ""); if (m) throw new Error(m); await addDefect({ id: i.id, body: { defect_code: v.defect_code, quantity: (v.quantity ?? "").trim(), note: (v.note ?? "").trim() } }).unwrap(); }} />
      <ActionDialog title="Complete inspection" open={dlg === "complete"} onClose={() => setDlg(null)} cta="Complete"
        fields={[{ name: "quantity_accepted", label: "Accepted quantity" }, { name: "quantity_rejected", label: "Rejected quantity" }, { name: "summary", label: "Summary" }, { name: "conditional", label: "Accept conditionally if it failed?", options: [["", "No"], ["yes", "Yes — accept on condition"]] }, { name: "conditional_note", label: "Conditions" }]}
        submit={async (v) => { const m = validateCompletion(missing, v.quantity_accepted ?? "", v.quantity_rejected ?? "", v.conditional === "yes", v.conditional_note ?? ""); if (m) throw new Error(m);
          const body: Record<string, unknown> = { summary: (v.summary ?? "").trim(), accept_conditionally: v.conditional === "yes", conditional_note: (v.conditional_note ?? "").trim() };
          if ((v.quantity_accepted ?? "").trim()) body.quantity_accepted = (v.quantity_accepted ?? "").trim();
          if ((v.quantity_rejected ?? "").trim()) body.quantity_rejected = (v.quantity_rejected ?? "").trim();
          await act({ id: i.id, action: "complete", body }).unwrap(); }} />
      <ActionDialog title="Cancel inspection" open={dlg === "cancel"} onClose={() => setDlg(null)} cta="Cancel inspection" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => act({ id: i.id, action: "cancel", body: { reason: (v.reason ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Schedule re-inspection" open={dlg === "reinspect"} onClose={() => setDlg(null)} cta="Schedule" fields={[{ name: "scheduled_for", label: "Scheduled for", type: "date", required: true }]} submit={(v) => act({ id: i.id, action: "reinspect", body: { scheduled_for: v.scheduled_for } }).unwrap()} />
    </>
  );
}

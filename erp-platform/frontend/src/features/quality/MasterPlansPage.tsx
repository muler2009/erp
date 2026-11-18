import { useState } from "react";
import { Link, useParams } from "react-router";

import { useAddQualityControlPointMutation, useAddQualityObjectiveMutation, useCreateQualityMasterPlanMutation, useGetQualityMasterPlanQuery, useListQualityMasterPlansQuery, useMeasureQualityObjectiveMutation, useQualityMasterPlanActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QMasterPlanDetail } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserSelect } from "../../shared/ui/UserSelect";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";
import { HistoryPanel } from "./panels";

export const SCOPES = ["DEPARTMENT", "PROJECT", "PRODUCT", "PROCESS", "CONTRACT"];
const NUM = /^-?\d+(\.\d+)?$/;

export function planTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "APPROVED") return "green";
  if (s === "PENDING_APPROVAL") return "amber";
  return "slate";
}

export function validateMasterPlan(f: { title: string; scope_type: string; owner_id: string; valid_from: string; valid_to: string }): string | null {
  if (!f.title.trim()) return "Give the plan a title.";
  if (!SCOPES.includes(f.scope_type)) return "Choose what the plan covers.";
  if (!f.owner_id) return "Choose the owner.";
  if (f.valid_from && f.valid_to && f.valid_to < f.valid_from) return "The plan cannot end before it starts.";
  return null;
}
export function validateObjective(f: { name: string; metric: string; target: string; direction: string; owner_id: string }): string | null {
  if (!f.name.trim()) return "Name the objective.";
  if (!f.metric.trim()) return "Name the metric (for example scrap rate).";
  if (!NUM.test(f.target.trim())) return "The target must be a number.";
  if (!["LOWER", "HIGHER"].includes(f.direction)) return "Say whether lower or higher is better.";
  if (!f.owner_id) return "Choose the owner.";
  return null;
}
export function validateMeasurement(period: string, value: string): string | null {
  if (!period) return "Enter the period measured.";
  if (!NUM.test(value.trim())) return "The value must be a number.";
  return null;
}
/** Mirrors the server: a plan needs at least one objective or control point before it goes for approval. */
export function submitBlock(p: Pick<QMasterPlanDetail, "objectives" | "control_points">): string | null {
  return p.objectives.length || p.control_points.length ? null : "Add at least one objective or control point before submitting.";
}
export function changesRequested(p: Pick<QMasterPlanDetail, "status" | "history">): boolean {
  if (p.status !== "DRAFT") return false;
  const last = [...p.history].reverse().find((h) => ["SUBMITTED", "RESUBMITTED", "CHANGES_REQUESTED", "REJECTED", "WITHDRAWN", "APPROVED", "REVISION_STARTED"].includes(h.action));
  return last?.action === "CHANGES_REQUESTED";
}

export function MasterPlansPage() {
  const { can } = useAccess();
  const manage = can("quality.plan.manage");
  const [f, setF] = useState({ status: "", scope_type: "" });
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityMasterPlansQuery({ status: f.status || undefined, scope_type: f.scope_type || undefined, cursor });
  const [create] = useCreateQualityMasterPlanMutation();
  const nameOf = useUserNames();
  const owners = useUserOptions(!manage);
  const empty = { title: "", scope_type: "", scope_label: "", owner_id: "", valid_from: "", valid_to: "", standards: "" };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateMasterPlan(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { title: n.title.trim(), scope_type: n.scope_type, owner_id: n.owner_id };
    for (const k of ["scope_label", "valid_from", "valid_to", "standards"] as const) if (n[k].trim()) body[k] = n[k].trim();
    try { await create(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setN({ ...n, [k]: e.target.value });
  return (
    <>
      <PageHeader title="Quality plans" description="What quality means for a department, project, product or process: objectives and control points, approved before use." actions={manage ? <Button onClick={() => setOpen(true)}>New quality plan</Button> : undefined} />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-4">
          <label className="text-sm">Status <select aria-label="Plan status" className={inputClass} value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setCursor(null); }}><option value="">All</option>{["DRAFT", "PENDING_APPROVAL", "APPROVED", "SUPERSEDED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          <label className="text-sm">Covers <select aria-label="Plan scope" className={inputClass} value={f.scope_type} onChange={(e) => { setF({ ...f, scope_type: e.target.value }); setCursor(null); }}><option value="">All</option>{SCOPES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No quality plans" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Title</th><th>Covers</th><th>Owner</th><th>Revision</th><th>Status</th></tr></thead>
            <tbody>{data.results.map((p) => (
              <tr key={p.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/plans/${p.id}`}>{p.number}</Link></td><td>{p.title}</td><td>{pretty(p.scope_type)}{p.scope_label ? `: ${p.scope_label}` : ""}</td><td>{nameOf(p.owner_id)}</td><td>{p.revision}</td><td><Badge tone={planTone(p.status)}>{pretty(p.status)}</Badge></td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="New quality plan" open={open} onClose={() => setOpen(false)}>
        <FormField label="Title" htmlFor="mp-title"><input id="mp-title" className={inputClass} value={n.title} onChange={set("title")} /></FormField>
        <FormField label="Covers" htmlFor="mp-scope"><select id="mp-scope" className={inputClass} value={n.scope_type} onChange={set("scope_type")}><option value="">Choose…</option>{SCOPES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></FormField>
        <FormField label="Which one (name)" htmlFor="mp-label"><input id="mp-label" className={inputClass} value={n.scope_label} onChange={set("scope_label")} /></FormField>
        <FormField label="Owner" htmlFor="mp-owner"><UserSelect id="mp-owner" value={n.owner_id} onChange={(x) => setN({ ...n, owner_id: x })} options={owners} placeholder="Choose…" /></FormField>
        <FormField label="Standards applied" htmlFor="mp-std"><input id="mp-std" className={inputClass} value={n.standards} onChange={set("standards")} /></FormField>
        <FormField label="Valid from" htmlFor="mp-from"><input id="mp-from" type="date" className={inputClass} value={n.valid_from} onChange={set("valid_from")} /></FormField>
        <FormField label="Valid to" htmlFor="mp-to"><input id="mp-to" type="date" className={inputClass} value={n.valid_to} onChange={set("valid_to")} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Create</Button></div>
      </Modal>
    </>
  );
}

export function MasterPlanPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.plan.manage");
  const { data: p, isLoading, error, refetch } = useGetQualityMasterPlanQuery(id);
  const [act] = useQualityMasterPlanActionMutation();
  const [addObjective] = useAddQualityObjectiveMutation();
  const [addCp] = useAddQualityControlPointMutation();
  const [measure] = useMeasureQualityObjectiveMutation();
  const owners = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"objective" | "cp" | "submit" | "resubmit" | "revise" | null>(null);
  const [measuring, setMeasuring] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !p) return <ErrorState error={error} onRetry={refetch} />;
  const draft = p.status === "DRAFT";
  const resubmittable = changesRequested(p);
  const gateSubmit = () => { const b = submitBlock(p); if (b) { setErr(b); return; } setErr(null); setDlg("submit"); };
  return (
    <>
      <PageHeader title={`${p.number} ${p.title}`} description={`${pretty(p.scope_type)}${p.scope_label ? `: ${p.scope_label}` : ""}`} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/plans">All plans</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={planTone(p.status)}>{pretty(p.status)}</Badge><Badge tone="slate">{`Revision ${p.revision}`}</Badge>{resubmittable && <Badge tone="amber">Changes requested</Badge>}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Details">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <dt className="font-medium">Owner</dt><dd>{nameOf(p.owner_id)}</dd>
            <dt className="font-medium">Standards</dt><dd>{p.standards || "–"}</dd>
            <dt className="font-medium">Valid</dt><dd>{p.valid_from ?? "–"} to {p.valid_to ?? "–"}</dd>
            {p.approved_at && <><dt className="font-medium">Approved</dt><dd>{p.approved_at.slice(0, 10)}</dd></>}
          </dl>
          {manage && (
            <div className="mt-3 flex flex-wrap gap-2">
              {draft && !resubmittable && <Button onClick={gateSubmit}>Submit for approval</Button>}
              {resubmittable && <Button onClick={() => { setErr(null); setDlg("resubmit"); }}>Resubmit for approval</Button>}
              {p.status === "APPROVED" && <Button variant="secondary" onClick={() => setDlg("revise")}>Start a revision</Button>}
            </div>
          )}
          {p.status === "PENDING_APPROVAL" && <p className="mt-2 text-sm text-slate-600">Waiting for approval in the approvals inbox.</p>}
        </Card>
        <Card title="Objectives" actions={manage && draft ? <Button variant="secondary" onClick={() => setDlg("objective")}>Add an objective</Button> : undefined}>
          {!p.objectives.length ? <EmptyState title="No objectives" /> : (
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Objective</th><th>Metric</th><th>Target</th><th>Latest</th><th>Owner</th><th /></tr></thead>
              <tbody>{p.objectives.map((o) => (
                <tr key={o.id} className="border-t"><td>{o.name}</td><td>{o.metric}</td><td>{o.direction === "LOWER" ? "≤" : "≥"} {o.target} {o.unit}</td>
                  <td>{o.latest_value === null ? "Not measured" : <>{o.latest_value} <span className="text-slate-600">({o.latest_period})</span> <Badge tone={o.met ? "green" : "red"}>{o.met ? "Met" : "Not met"}</Badge></>}</td><td>{nameOf(o.owner_id)}</td>
                  <td>{manage && p.status === "APPROVED" && <Button variant="secondary" onClick={() => setMeasuring(o.id)}>Record a measurement</Button>}</td></tr>))}</tbody></table>
          )}
        </Card>
        <Card title="Control points" actions={manage && draft ? <Button variant="secondary" onClick={() => setDlg("cp")}>Add a control point</Button> : undefined}>
          {!p.control_points.length ? <EmptyState title="No control points" /> : (
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Control point</th><th>Stage</th><th>Frequency</th><th>Acceptance criteria</th><th>Responsible</th></tr></thead>
              <tbody>{p.control_points.map((c) => <tr key={c.id} className="border-t"><td>{c.name}</td><td>{c.stage || "–"}</td><td>{c.frequency || "–"}</td><td>{c.acceptance_criteria || "–"}</td><td>{nameOf(c.responsible_id)}</td></tr>)}</tbody></table>
          )}
        </Card>
        {p.revisions.length > 0 && (
          <Card title="Earlier revisions"><ul className="space-y-1 text-sm">{p.revisions.map((r) => <li key={r.revision}>Revision {r.revision}: {r.reason} ({r.at.slice(0, 10)})</li>)}</ul></Card>
        )}
        <HistoryPanel history={p.history} />
      </div>
      <ActionDialog title="Add an objective" open={dlg === "objective"} onClose={() => setDlg(null)} cta="Add"
        fields={[{ name: "name", label: "Objective", required: true }, { name: "metric", label: "Metric", required: true }, { name: "target", label: "Target", required: true }, { name: "direction", label: "Better when", required: true, options: [["LOWER", "Lower"], ["HIGHER", "Higher"]] }, { name: "unit", label: "Unit" }, { name: "owner_id", label: "Owner", required: true, options: owners, searchUsers: true }]}
        submit={async (v) => { const b = validateObjective({ name: v.name ?? "", metric: v.metric ?? "", target: v.target ?? "", direction: v.direction ?? "", owner_id: v.owner_id ?? "" }); if (b) throw new Error(b); return addObjective({ id: p.id, body: { name: v.name?.trim(), metric: v.metric?.trim(), target: v.target?.trim(), direction: v.direction, unit: (v.unit ?? "").trim(), owner_id: v.owner_id } }).unwrap(); }} />
      <ActionDialog title="Add a control point" open={dlg === "cp"} onClose={() => setDlg(null)} cta="Add"
        fields={[{ name: "name", label: "Control point", required: true }, { name: "stage", label: "Stage" }, { name: "frequency", label: "Frequency" }, { name: "acceptance_criteria", label: "Acceptance criteria" }, { name: "responsible_id", label: "Responsible", required: true, options: owners, searchUsers: true }]}
        submit={(v) => addCp({ id: p.id, body: { name: v.name?.trim(), stage: (v.stage ?? "").trim(), frequency: (v.frequency ?? "").trim(), acceptance_criteria: (v.acceptance_criteria ?? "").trim(), responsible_id: v.responsible_id } }).unwrap()} />
      <ActionDialog title="Submit for approval" open={dlg === "submit"} onClose={() => setDlg(null)} cta="Submit" fields={[{ name: "comment", label: "Comment" }]} submit={(v) => act({ id: p.id, action: "submit", body: { comment: (v.comment ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Resubmit for approval" open={dlg === "resubmit"} onClose={() => setDlg(null)} cta="Resubmit" fields={[{ name: "comment", label: "What changed" }]} submit={(v) => act({ id: p.id, action: "resubmit", body: { comment: (v.comment ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Start a revision" open={dlg === "revise"} onClose={() => setDlg(null)} cta="Start revision" fields={[{ name: "reason", label: "Reason for the revision", required: true }]} submit={(v) => act({ id: p.id, action: "revise", body: { reason: (v.reason ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Record a measurement" open={!!measuring} onClose={() => setMeasuring(null)} cta="Record" fields={[{ name: "period", label: "Period", type: "date", required: true }, { name: "value", label: "Value", required: true }]}
        submit={async (v) => { const b = validateMeasurement(v.period ?? "", v.value ?? ""); if (b) throw new Error(b); return measure({ id: measuring ?? "", body: { period: v.period, value: (v.value ?? "").trim() } }).unwrap(); }} />
    </>
  );
}

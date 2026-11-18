import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { useAddQualityRequirementMutation, useAssessQualityRequirementMutation, useGetQualityComplianceQuery, useGetQualityStandardQuery, useListQualityStandardsQuery, useNewQualityStandardVersionMutation, useSaveQualityStandardMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QRequirement } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";

export const ASSESSMENTS = ["COMPLIANT", "PARTIAL", "NON_COMPLIANT", "NOT_APPLICABLE"];
export const KINDS = ["STANDARD", "REGULATION", "CONTRACT", "INTERNAL"];

export function complianceTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "COMPLIANT") return "green";
  if (s === "NON_COMPLIANT") return "red";
  if (s === "PARTIAL") return "amber";
  return "slate";
}

export function validateStandard(f: { code: string; name: string }): string | null {
  if (!f.code.trim()) return "Enter the standard's code.";
  if (!f.name.trim()) return "Enter the standard's name.";
  return null;
}
export function validateVersion(current: string, f: { version: string; summary: string }): string | null {
  if (!f.version.trim()) return "Enter the new version.";
  if (f.version.trim() === current) return "This is already the current version.";
  if (!f.summary.trim()) return "Summarise what changed.";
  return null;
}
export function validateRequirement(existing: string[], f: { clause: string; text: string; owner_id: string }): string | null {
  if (!f.clause.trim()) return "Enter the clause.";
  if (existing.includes(f.clause.trim())) return "This clause is already recorded.";
  if (!f.text.trim()) return "Enter the requirement text.";
  if (!f.owner_id) return "Choose the owner.";
  return null;
}
export function validateAssessment(status: string, gap: string, notes: string): string | null {
  if (!ASSESSMENTS.includes(status)) return "Choose the assessment.";
  if ((status === "PARTIAL" || status === "NON_COMPLIANT") && !gap.trim()) return "Describe the gap.";
  if (status === "NOT_APPLICABLE" && !notes.trim()) return "Explain why the requirement does not apply.";
  return null;
}

export function StandardsPage() {
  const { can } = useAccess();
  const manage = can("quality.standards.manage");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityStandardsQuery({ cursor });
  const [save] = useSaveQualityStandardMutation();
  const empty = { code: "", name: "", kind: "STANDARD", issuer: "", version: "", effective_from: "" };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setN({ ...n, [k]: e.target.value });
  const go = async () => {
    const p = validateStandard(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { code: n.code.trim(), name: n.name.trim(), kind: n.kind };
    for (const k of ["issuer", "version", "effective_from"] as const) if (n[k].trim()) body[k] = n[k].trim();
    try { await save(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Standards and requirements" description="The standards, regulations and contracts the business must meet, clause by clause." actions={<><Link className="mr-3 text-sm text-blue-700 underline" to="/app/quality/compliance">Compliance summary</Link>{manage && <Button onClick={() => setOpen(true)}>Add a standard</Button>}</>} />
      <Card>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No standards" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Name</th><th>Kind</th><th>Issuer</th><th>Version</th><th>Effective</th></tr></thead>
            <tbody>{data.results.map((s) => <tr key={s.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/standards/${s.id}`}>{s.code}</Link></td><td>{s.name}</td><td>{pretty(s.kind)}</td><td>{s.issuer || "–"}</td><td>{s.version || "–"}</td><td>{s.effective_from ?? "–"}</td></tr>)}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="Add a standard" open={open} onClose={() => setOpen(false)}>
        <FormField label="Code" htmlFor="st-code"><input id="st-code" className={inputClass} value={n.code} onChange={set("code")} /></FormField>
        <FormField label="Name" htmlFor="st-name"><input id="st-name" className={inputClass} value={n.name} onChange={set("name")} /></FormField>
        <FormField label="Kind" htmlFor="st-kind"><select id="st-kind" className={inputClass} value={n.kind} onChange={set("kind")}>{KINDS.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}</select></FormField>
        <FormField label="Issuer" htmlFor="st-iss"><input id="st-iss" className={inputClass} value={n.issuer} onChange={set("issuer")} /></FormField>
        <FormField label="Version" htmlFor="st-ver"><input id="st-ver" className={inputClass} value={n.version} onChange={set("version")} /></FormField>
        <FormField label="Effective from" htmlFor="st-eff"><input id="st-eff" type="date" className={inputClass} value={n.effective_from} onChange={set("effective_from")} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Add</Button></div>
      </Modal>
    </>
  );
}

export function StandardPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.standards.manage");
  const { data: s, isLoading, error, refetch } = useGetQualityStandardQuery(id);
  const [newVersion] = useNewQualityStandardVersionMutation();
  const [addReq] = useAddQualityRequirementMutation();
  const [assess] = useAssessQualityRequirementMutation();
  const owners = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"version" | "requirement" | null>(null);
  const [assessing, setAssessing] = useState<QRequirement | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !s) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <>
      <PageHeader title={`${s.code} ${s.name}`} description={`${pretty(s.kind)}${s.issuer ? ` from ${s.issuer}` : ""}, version ${s.version || "not set"}`} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/standards">All standards</Link>} />
      <div className="grid gap-4">
        {manage && <div className="flex gap-2"><Button variant="secondary" onClick={() => setDlg("version")}>Record a new version</Button><Button onClick={() => setDlg("requirement")}>Add a requirement</Button></div>}
        <Card title="Requirements">
          {!s.requirements.length ? <EmptyState title="No requirements recorded" /> : (
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Clause</th><th>Requirement</th><th>Owner</th><th>Status</th><th>Next review</th><th /></tr></thead>
              <tbody>{s.requirements.map((r) => (
                <tr key={r.id} className="border-t"><td>{r.clause}</td><td>{r.text}{r.last_gap && <div className="text-slate-600">Gap: {r.last_gap}</div>}</td><td>{nameOf(r.owner_id)}</td>
                  <td><Badge tone={complianceTone(r.status)}>{pretty(r.status)}</Badge> {r.needs_review && <Badge tone="amber">Re-assess</Badge>}</td><td>{r.next_review_on ?? "–"}</td>
                  <td>{manage && <Button variant="secondary" onClick={() => setAssessing(r)}>Assess</Button>}</td></tr>))}</tbody></table>
          )}
        </Card>
        <Card title="Version changes">
          {!s.changes.length ? <EmptyState title="No version changes" /> : <ul className="space-y-1 text-sm">{s.changes.map((c, i) => <li key={i}>{c.from_version || "–"} to {c.to_version}: {c.summary}{c.effective_on ? ` (effective ${c.effective_on})` : ""}{c.impact ? `. Impact: ${c.impact}` : ""}</li>)}</ul>}
        </Card>
      </div>
      <ActionDialog title="Record a new version" open={dlg === "version"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "version", label: "New version", required: true }, { name: "summary", label: "What changed", required: true }, { name: "effective_on", label: "Effective on", type: "date" }, { name: "impact", label: "Impact on the business" }]}
        submit={async (v) => { const b = validateVersion(s.version, { version: v.version ?? "", summary: v.summary ?? "" }); if (b) throw new Error(b); const body: Record<string, unknown> = { version: v.version?.trim(), summary: v.summary?.trim() }; if (v.effective_on) body.effective_on = v.effective_on; if (v.impact?.trim()) body.impact = v.impact.trim(); return newVersion({ id: s.id, body }).unwrap(); }} />
      <ActionDialog title="Add a requirement" open={dlg === "requirement"} onClose={() => setDlg(null)} cta="Add" fields={[{ name: "clause", label: "Clause", required: true }, { name: "text", label: "Requirement", required: true }, { name: "owner_id", label: "Owner", required: true, options: owners, searchUsers: true }, { name: "next_review_on", label: "Next review", type: "date" }]}
        submit={async (v) => { const b = validateRequirement(s.requirements.map((r) => r.clause), { clause: v.clause ?? "", text: v.text ?? "", owner_id: v.owner_id ?? "" }); if (b) throw new Error(b); const body: Record<string, unknown> = { clause: v.clause?.trim(), text: v.text?.trim(), owner_id: v.owner_id }; if (v.next_review_on) body.next_review_on = v.next_review_on; return addReq({ id: s.id, body }).unwrap(); }} />
      <ActionDialog title="Assess the requirement" open={!!assessing} onClose={() => setAssessing(null)} cta="Record" fields={[{ name: "status", label: "Assessment", required: true, options: ASSESSMENTS.map((a) => [a, pretty(a)] as [string, string]) }, { name: "gap", label: "Gap" }, { name: "notes", label: "Notes" }, { name: "next_review_on", label: "Next review", type: "date" }]}
        submit={async (v) => { const b = validateAssessment(v.status ?? "", v.gap ?? "", v.notes ?? ""); if (b) throw new Error(b); const body: Record<string, unknown> = { status: v.status }; for (const k of ["gap", "notes", "next_review_on"]) if (v[k]?.trim()) body[k] = v[k].trim(); return assess({ id: assessing?.id ?? "", body }).unwrap(); }} />
    </>
  );
}

export function CompliancePage() {
  const [params, setParams] = useSearchParams();
  const standardId = params.get("standard_id") ?? "";
  const standards = useListQualityStandardsQuery({});
  const { data, isLoading, error, refetch } = useGetQualityComplianceQuery({ standard_id: standardId || undefined });
  const nameOf = useUserNames();
  return (
    <>
      <PageHeader title="Compliance summary" description="How far the business meets each requirement, and the gaps still open." />
      <Card>
        <div className="mb-3"><label className="text-sm">Standard <select aria-label="Standard filter" className={inputClass} value={standardId} onChange={(e) => setParams(e.target.value ? { standard_id: e.target.value } : {})}><option value="">All standards</option>{standards.data?.results.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select></label></div>
        {isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
          <>
            <p className="mb-3 text-lg font-medium">{data.compliance_percent === null ? "No assessed requirements yet" : `${data.compliance_percent}% compliant`} <span className="text-sm font-normal text-slate-600">({data.total} requirements, {data.due_for_review} due for review)</span></p>
            <ul className="mb-4 flex flex-wrap gap-2 text-sm">{Object.entries(data.counts).map(([k, v]) => <li key={k}><Badge tone={complianceTone(k)}>{`${pretty(k)}: ${v}`}</Badge></li>)}</ul>
            <h3 className="mb-2 font-medium">Open gaps</h3>
            {!data.gaps.length ? <EmptyState title="No open gaps" /> : (
              <table className="w-full text-sm"><thead><tr className="text-left"><th>Clause</th><th>Requirement</th><th>Gap</th><th>Owner</th><th>Status</th></tr></thead>
                <tbody>{data.gaps.map((g) => <tr key={g.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/standards/${g.standard_id}`}>{g.clause}</Link></td><td>{g.text}</td><td>{g.last_gap}</td><td>{nameOf(g.owner_id)}</td><td><Badge tone={complianceTone(g.status)}>{pretty(g.status)}</Badge></td></tr>)}</tbody></table>
            )}
          </>
        )}
      </Card>
    </>
  );
}

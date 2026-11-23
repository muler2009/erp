import { useState } from "react";
import { Link } from "react-router";

import { useGetDocReportQuery, useListProjectsQuery } from "../../shared/api/endpoints";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ReportTable } from "../../shared/ui/ReportTable";

type Param = { name: string; label: string; kind: "date" | "number" | "text" | "project" | "check" | "status" };
export const DOC_REPORTS: { code: string; label: string; admin?: boolean; params: Param[] }[] = [
  { code: "register", label: "Document register", params: [] },
  { code: "by-category", label: "Documents by category and department", params: [] },
  { code: "pending-approvals", label: "Waiting for approval", params: [] },
  { code: "revision-history", label: "Revision history", params: [] },
  { code: "overdue-reviews", label: "Reviews overdue", params: [] },
  { code: "expiring", label: "Expiring soon", params: [{ name: "within_days", label: "Within days", kind: "number" }] },
  { code: "obsolete", label: "Obsolete documents", params: [] },
  { code: "archived", label: "Archived documents", params: [] },
  { code: "acknowledgements", label: "Acknowledgements", params: [{ name: "pending_by_user", label: "Only what is still waiting, by person", kind: "check" }] },
  { code: "access", label: "Who opened what", admin: true, params: [{ name: "from", label: "From", kind: "date" }, { name: "to", label: "To", kind: "date" }] },
  { code: "external", label: "External submissions", params: [{ name: "status", label: "Status", kind: "status" }, { name: "party", label: "Party contains", kind: "text" }] },
  { code: "project-register", label: "Project document register", params: [{ name: "project", label: "Project", kind: "project" }] },
  { code: "transmittals", label: "Transmittals", params: [{ name: "project", label: "Project", kind: "project" }] },
  { code: "forms", label: "Forms submitted", params: [] },
];

/** What is wrong with the chosen settings, or null. */
export function docReportProblem(code: string, p: Record<string, string>): string | null {
  const rep = DOC_REPORTS.find((r) => r.code === code);
  if (!rep) return "Choose a report.";
  if (code === "project-register" && !p.project) return "Choose the project.";
  if (p.within_days !== undefined && p.within_days !== "" && !/^[1-9]\d*$/.test(p.within_days)) return "Days must be a whole number above 0.";
  if (p.from && p.to && p.from > p.to) return "The start date is after the end date.";
  return null;
}

export function DocumentReportsPage() {
  const { can } = useAccess();
  const projects = useListProjectsQuery({});
  const list = DOC_REPORTS.filter((r) => !r.admin || can("documents.admin"));
  const [code, setCode] = useState("register");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [args, setArgs] = useState<{ name: string; params: Record<string, string> } | null>(null);
  const q = useGetDocReportQuery(args ?? { name: "", params: {} }, { skip: !args });
  const rep = list.find((r) => r.code === code);
  const run = () => {
    const p = docReportProblem(code, vals);
    setProblem(p);
    if (!p) setArgs({ name: code, params: Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== "" && v !== "false")) });
  };
  return (
    <>
      <PageHeader title="Document reports" description="Only documents you are allowed to see are included." />
      <p className="mb-3 text-sm"><Link className="text-indigo-700 underline" to="/app/documents">← All documents</Link></p>
      <Card title="Choose a report">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Report" htmlFor="dr-code"><select id="dr-code" className={inputClass} value={code} onChange={(e) => { setCode(e.target.value); setVals({}); setArgs(null); setProblem(null); }}>{list.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</select></FormField>
          {rep?.params.map((p) => (
            <FormField key={p.name} label={p.label} htmlFor={`dr-${p.name}`}>
              {p.kind === "project" ? <select id={`dr-${p.name}`} className={inputClass} value={vals[p.name] ?? ""} onChange={(e) => setVals({ ...vals, [p.name]: e.target.value })}><option value="">Choose…</option>{(projects.data?.results ?? []).map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select>
                : p.kind === "status" ? <select id={`dr-${p.name}`} className={inputClass} value={vals[p.name] ?? ""} onChange={(e) => setVals({ ...vals, [p.name]: e.target.value })}><option value="">Any</option>{["RECEIVED", "SENT", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "RESUBMITTED"].map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}</select>
                : p.kind === "check" ? <input id={`dr-${p.name}`} type="checkbox" checked={vals[p.name] === "1"} onChange={(e) => setVals({ ...vals, [p.name]: e.target.checked ? "1" : "" })} />
                : <input id={`dr-${p.name}`} type={p.kind === "number" ? "number" : p.kind} className={inputClass} value={vals[p.name] ?? ""} onChange={(e) => setVals({ ...vals, [p.name]: e.target.value })} />}
            </FormField>
          ))}
          <Button className="mb-3" onClick={run} loading={q.isFetching}>Show report</Button>
        </div>
        {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
      </Card>
      {args && (
        <Card title={rep?.label ?? "Result"}>
          {q.isFetching && <Spinner />}
          {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
          {q.data !== undefined && !q.isFetching && !q.error && <div className="overflow-x-auto"><ReportTable data={q.data} /></div>}
        </Card>
      )}
    </>
  );
}

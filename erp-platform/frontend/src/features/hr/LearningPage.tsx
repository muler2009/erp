import { useState } from "react";

import { useCreateCourseMutation, useGetComplianceQuery, useListCoursesQuery, useListTrainingQuery, useRecordTrainingMutation } from "../../shared/api/endpoints";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "./ActionDialog";
import { EmployeeRequest } from "./EmployeeRequest";

export function validateCourse(f: { code: string; name: string; hours: string; validity: string }): string | null {
  if (!f.code.trim() || !f.name.trim()) return "A course code and name are required.";
  if (!/^\d+(\.\d{1,2})?$/.test(f.hours) || Number(f.hours) <= 0) return "Hours must be greater than zero.";
  if (f.validity && (!/^\d+$/.test(f.validity) || Number(f.validity) < 1)) return "Validity must be a whole number of months.";
  return null;
}

export function LearningPage() {
  const { can } = useAccess();
  const manage = can("hr.learning.manage");
  const courses = useListCoursesQuery();
  const records = useListTrainingQuery({});
  const compliance = useGetComplianceQuery(undefined, { skip: !manage });
  const [createCourse] = useCreateCourseMutation();
  const [record] = useRecordTrainingMutation();
  const [dlg, setDlg] = useState<"course" | "record" | null>(null);
  return (
    <>
      <PageHeader title="Learning" description="Courses, completed training and mandatory-training compliance." actions={manage ? <><Button variant="secondary" onClick={() => setDlg("course")}>New course</Button> <Button onClick={() => setDlg("record")}>Record training</Button></> : undefined} />
      {manage && (
        <Card title="Compliance">
          {compliance.isLoading ? <Spinner /> : compliance.error ? <ErrorState error={compliance.error} onRetry={compliance.refetch} /> : (
            <div className="grid gap-4 md:grid-cols-2">
              <div><h3 className="mb-1 text-sm font-semibold">Missing or expired</h3>{!compliance.data?.gaps.length ? <p className="text-sm text-slate-500">No gaps.</p> : <ul className="text-sm">{compliance.data.gaps.map((g, i) => <li key={i}>{g.name} ({g.employee_no}) — {g.course} <Badge tone="red">{g.reason === "EXPIRED" ? "Expired" : "Missing"}</Badge></li>)}</ul>}</div>
              <div><h3 className="mb-1 text-sm font-semibold">Expiring soon</h3>{!compliance.data?.expiring.length ? <p className="text-sm text-slate-500">Nothing expiring.</p> : <ul className="text-sm">{compliance.data.expiring.map((g, i) => <li key={i}>{g.name} ({g.employee_no}) — {g.course} on {g.expires_on}</li>)}</ul>}</div>
            </div>
          )}
        </Card>
      )}
      <div className="mt-4"><Card title="Courses">
        {courses.isLoading ? <Spinner /> : !courses.data?.length ? <EmptyState title="No courses yet" /> : <ul className="text-sm">{courses.data.map((c) => <li key={c.id} className="border-b border-slate-200 py-1">{c.code} — {c.name} · {c.hours} h{c.validity_months ? ` · valid ${c.validity_months} months` : ""} {c.mandatory && <Badge tone="amber">Mandatory</Badge>}</li>)}</ul>}
      </Card></div>
      <div className="mt-4"><Card title="Training records">
        {records.isLoading ? <Spinner /> : records.error ? <ErrorState error={records.error} onRetry={records.refetch} /> : !records.data?.results.length ? <EmptyState title="No training recorded" /> : <ul className="text-sm">{records.data.results.map((r) => <li key={r.id} className="border-b border-slate-200 py-1">{r.employee_no} — {r.course} completed {r.completed_on}{r.expires_on ? `, expires ${r.expires_on}` : ""}{r.score ? `, score ${r.score}` : ""}</li>)}</ul>}
      </Card></div>
      <ActionDialog title="New course" open={dlg === "course"} onClose={() => setDlg(null)} cta="Create course" fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "provider", label: "Provider" }, { name: "hours", label: "Hours", required: true }, { name: "validity", label: "Valid for (months)" }, { name: "mandatory", label: "Mandatory", options: [["yes", "Yes"], ["no", "No"]] }]}
        submit={async (v) => { const p = validateCourse({ code: v.code ?? "", name: v.name ?? "", hours: v.hours ?? "", validity: v.validity ?? "" }); if (p) throw new Error(p); await createCourse({ code: (v.code ?? "").trim(), name: (v.name ?? "").trim(), provider: v.provider ?? "", hours: v.hours ?? "", ...(v.validity ? { validity_months: Number(v.validity) } : {}), mandatory: v.mandatory === "yes" }).unwrap(); }} />
      <EmployeeRequest title="Record training" open={dlg === "record"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "course", label: "Course", required: true, options: (courses.data ?? []).map((c) => [c.id, `${c.code} — ${c.name}`] as [string, string]) }, { name: "completed_on", label: "Completed on", type: "date", required: true }, { name: "score", label: "Score" }]}
        submit={(emp, v) => record({ employee: emp, course: v.course ?? "", completed_on: v.completed_on ?? "", ...(v.score ? { score: v.score } : {}) }).unwrap()} />
    </>
  );
}

import { useState } from "react";

import { useCreateGradeMutation, useGetHeadcountPlanQuery, useGetOrgChartQuery, useListGradesQuery } from "../../shared/api/endpoints";
import type { OrgNode } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "./ActionDialog";

export function validateGrade(f: { code: string; name: string; min_salary: string; max_salary: string }): string | null {
  if (!f.code.trim() || !f.name.trim()) return "A grade code and name are required.";
  const lo = parseMoney(f.min_salary), hi = parseMoney(f.max_salary);
  if (lo === null || hi === null || lo < 0n) return "Enter the minimum and maximum salary.";
  if (hi < lo) return "The maximum salary must not be below the minimum.";
  return null;
}

function Node({ n }: { n: OrgNode }) {
  return (
    <li>
      <span className="font-medium">{n.name}</span> <span className="text-sm text-slate-500">{n.employee_no}{n.position ? ` · ${n.position}` : ""}{n.department ? ` · ${n.department}` : ""}</span>
      {n.reports.length > 0 && <ul className="ml-5 border-l border-slate-200 pl-3">{n.reports.map((c) => <Node key={c.id} n={c} />)}</ul>}
    </li>
  );
}

export function OrgPage() {
  const { can } = useAccess();
  const chart = useGetOrgChartQuery();
  const grades = useListGradesQuery(undefined, { skip: !can("hr.view") });
  const plan = useGetHeadcountPlanQuery(undefined, { skip: !can("hr.view") });
  const [create] = useCreateGradeMutation();
  const [dlg, setDlg] = useState(false);
  return (
    <>
      <PageHeader title="Organization" description="Reporting lines, job grades and the headcount plan." />
      <Card title="Reporting lines">
        {chart.isLoading ? <Spinner /> : chart.error ? <ErrorState error={chart.error} onRetry={chart.refetch} /> : !chart.data?.length ? <EmptyState title="No reporting lines to show" /> : <ul>{chart.data.map((n) => <Node key={n.id} n={n} />)}</ul>}
      </Card>
      {can("hr.view") && (
        <>
          <div className="mt-4"><Card title="Headcount plan">
            {plan.isLoading ? <Spinner /> : plan.error ? <ErrorState error={plan.error} onRetry={plan.refetch} /> : !plan.data?.length ? <EmptyState title="No positions have a plan yet" /> : (
              <table className="w-full text-sm"><caption className="sr-only">Headcount plan</caption><thead><tr className="text-left"><th>Position</th><th>Department</th><th>Grade</th><th>Approved</th><th>Filled</th><th>Vacant</th></tr></thead>
                <tbody>{plan.data.map((r) => <tr key={r.position_id} className="border-t border-slate-200"><td>{r.position}</td><td>{r.department ?? "–"}</td><td>{r.grade ?? "–"}</td><td>{r.approved}</td><td>{r.occupied}</td><td>{r.vacant}{r.over_headcount > 0 && <> <Badge tone="red">{r.over_headcount} over plan</Badge></>}</td></tr>)}</tbody></table>
            )}
          </Card></div>
          <div className="mt-4"><Card title="Job grades">
            {can("hr.config.manage") && <div className="mb-2"><Button variant="secondary" onClick={() => setDlg(true)}>New grade</Button></div>}
            {grades.isLoading ? <Spinner /> : !grades.data?.length ? <EmptyState title="No job grades yet" /> : <ul className="text-sm">{grades.data.map((g) => <li key={g.id} className="border-b border-slate-200 py-1">{g.code} — {g.name}: {formatMoney(g.min_salary)} to {formatMoney(g.max_salary)}</li>)}</ul>}
          </Card></div>
        </>
      )}
      <ActionDialog title="New job grade" open={dlg} onClose={() => setDlg(false)} cta="Create grade" fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "min_salary", label: "Minimum salary", required: true }, { name: "max_salary", label: "Maximum salary", required: true }]}
        submit={async (v) => { const f = { code: (v.code ?? "").trim(), name: (v.name ?? "").trim(), min_salary: (v.min_salary ?? "").trim(), max_salary: (v.max_salary ?? "").trim() }; const p = validateGrade(f); if (p) throw new Error(p); await create(f).unwrap(); }} />
    </>
  );
}

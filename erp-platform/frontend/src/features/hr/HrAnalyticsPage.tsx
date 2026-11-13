import { useState } from "react";

import { useGetHrDashboardQuery } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { Card, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { pretty } from "./EmployeeDialogs";

function Counts({ data }: { data: Record<string, number> }) {
  return <ul className="text-sm">{Object.entries(data).map(([k, v]) => <li key={k} className="flex justify-between border-b border-slate-100 py-1"><span>{pretty(k)}</span><strong>{v}</strong></li>)}</ul>;
}

export function HrAnalyticsPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const { data, isLoading, error, refetch } = useGetHrDashboardQuery(year);
  return (
    <>
      <PageHeader title="HR analytics" description="Headcount, turnover, tenure, absence, recruitment and payroll cost." />
      <label className="mb-3 block text-sm">Year <select aria-label="Year" className={inputClass} value={year} onChange={(e) => setYear(Number(e.target.value))}>{[thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : data && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Headcount"><p className="mb-2 text-2xl font-semibold">{data.headcount.total}</p><h3 className="text-xs uppercase text-slate-500">By department</h3><Counts data={data.headcount.by_department} /><h3 className="mt-2 text-xs uppercase text-slate-500">By employment type</h3><Counts data={data.headcount.by_employment_type} /></Card>
          <Card title="Turnover"><p className="text-sm">{data.turnover.leavers} leavers · average headcount {data.turnover.average_headcount}</p><p className="text-2xl font-semibold">{data.turnover.turnover_percent === null ? "n/a" : `${data.turnover.turnover_percent}%`}</p><Counts data={data.turnover.by_type} /></Card>
          <Card title="Tenure"><Counts data={data.tenure} /></Card>
          <Card title="Recruitment"><p className="text-sm">{data.recruitment.open_requisitions} open requisition(s)</p><Counts data={data.recruitment.funnel} /></Card>
          <Card title="Leave days by month">{data.absenteeism.length === 0 ? <p className="text-sm text-slate-500">No leave taken.</p> : <ul className="text-sm">{data.absenteeism.map((a) => <li key={a.month} className="flex justify-between border-b border-slate-100 py-1"><span>{a.month}</span><strong>{a.leave_days}</strong></li>)}</ul>}</Card>
          {data.payroll_cost && <Card title="Payroll cost"><table className="w-full text-sm"><caption className="sr-only">Payroll cost by month</caption><thead><tr className="text-left"><th>Month</th><th>Gross</th><th>Employer cost</th><th>Net</th></tr></thead><tbody>{data.payroll_cost.map((r) => <tr key={r.month} className="border-t border-slate-100"><td>{r.month}</td><td>{formatMoney(r.gross)}</td><td>{formatMoney(r.employer_cost)}</td><td>{formatMoney(r.net)}</td></tr>)}</tbody></table></Card>}
        </div>
      )}
    </>
  );
}

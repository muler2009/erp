import { useState } from "react";

import { useAddPayInputMutation, useDecideLoanMutation, useDecidePayInputMutation, useDecideRevisionMutation, useListLoansQuery, useListPayInputsQuery, useListRevisionsQuery, useRequestLoanMutation, useRequestRevisionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { pretty } from "./EmployeeDialogs";
import { EmployeeRequest } from "./EmployeeRequest";

const tone = (s: string) => (s === "APPROVED" || s === "ACTIVE" || s === "COMPLETED" ? "green" : s === "REJECTED" || s === "CANCELLED" ? "red" : "amber") as "green" | "red" | "amber";
export const positive = (v: string) => { const n = parseMoney(v); return n !== null && n > 0n; };
export const firstOfMonth = (d: string) => (d ? `${d.slice(0, 7)}-01` : "");

export function validateLoan(f: { principal: string; installments: string; start: string }): string | null {
  if (!positive(f.principal)) return "Principal must be more than 0.";
  const n = Number(f.installments);
  if (!Number.isInteger(n) || n < 1 || n > 60) return "Installments must be a whole number from 1 to 60.";
  if (!f.start) return "Choose the month deductions start.";
  return null;
}

function Revisions() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListRevisionsQuery({});
  const [request] = useRequestRevisionMutation();
  const [decide] = useDecideRevisionMutation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (id: string, action: "approve" | "reject") => { setErr(null); try { await decide({ id, action, note: action === "reject" ? "Rejected" : undefined }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  return (
    <Card title="Salary revisions">
      {can("hr.compensation.manage") && <div className="mb-3"><Button onClick={() => setOpen(true)}>Request revision</Button></div>}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {data!.results.length === 0 ? <EmptyState title="No salary revisions" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Employee</th><th>Effective</th><th className="text-right">Old</th><th className="text-right">New</th><th>Reason</th><th>Status</th><th /></tr></thead>
          <tbody>{data!.results.map((r) => <tr key={r.id} className="border-t border-slate-100"><td>{r.employee_no}</td><td>{r.effective_date}</td><td className="text-right">{formatMoney(r.old_salary)}</td><td className="text-right">{formatMoney(r.new_salary)}</td><td>{r.reason || "—"}</td><td><Badge tone={tone(r.status)}>{pretty(r.status)}</Badge></td>
            <td>{r.status === "PENDING" && can("hr.compensation.manage") && <div className="flex gap-2"><Button onClick={() => void go(r.id, "approve")}>Approve</Button><Button variant="secondary" onClick={() => void go(r.id, "reject")}>Reject</Button></div>}</td></tr>)}</tbody></table>
      )}
      <EmployeeRequest title="Request salary revision" open={open} onClose={() => setOpen(false)} cta="Submit revision"
        fields={[{ name: "date", label: "Effective date", type: "date", required: true }, { name: "salary", label: "New monthly salary", required: true }, { name: "reason", label: "Reason", required: true }]}
        submit={async (emp, v) => { if (!positive(v.salary!)) throw new Error("New monthly salary must be more than 0."); return request({ employee: emp, effective_date: v.date!, new_salary: v.salary!.trim(), reason: v.reason!.trim() }).unwrap(); }} />
    </Card>
  );
}

function Inputs() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListPayInputsQuery({});
  const [add] = useAddPayInputMutation();
  const [decide] = useDecidePayInputMutation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (id: string, action: "approve" | "reject") => { setErr(null); try { await decide({ id, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  return (
    <Card title="Variable pay (bonuses, commissions, arrears, adjustments, reimbursements)">
      {can("hr.compensation.manage") && <div className="mb-3"><Button onClick={() => setOpen(true)}>Add input</Button></div>}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {data!.results.length === 0 ? <EmptyState title="No payroll inputs" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Employee</th><th>Month</th><th>Kind</th><th className="text-right">Amount</th><th>Description</th><th>Status</th><th /></tr></thead>
          <tbody>{data!.results.map((i) => <tr key={i.id} className="border-t border-slate-100"><td>{i.employee_no}</td><td>{i.month.slice(0, 7)}</td><td>{pretty(i.kind)}</td><td className="text-right">{formatMoney(i.amount)}</td><td>{i.description}</td><td><Badge tone={tone(i.status)}>{pretty(i.status)}</Badge></td>
            <td>{i.status === "PENDING" && can("hr.payroll.approve") && <div className="flex gap-2"><Button onClick={() => void go(i.id, "approve")}>Approve</Button><Button variant="secondary" onClick={() => void go(i.id, "reject")}>Reject</Button></div>}</td></tr>)}</tbody></table>
      )}
      <EmployeeRequest title="Add payroll input" open={open} onClose={() => setOpen(false)} cta="Add input"
        fields={[{ name: "kind", label: "Kind", options: [["BONUS", "Bonus"], ["COMMISSION", "Commission"], ["ARREARS", "Arrears"], ["ADJUSTMENT", "Adjustment (may be negative)"], ["REIMBURSEMENT", "Reimbursement"]], required: true }, { name: "month", label: "Pay month", type: "month", required: true }, { name: "amount", label: "Amount", required: true }, { name: "description", label: "Description", required: true }]}
        submit={async (emp, v) => { const n = parseMoney(v.amount!); if (n === null || n === 0n || (n < 0n && v.kind !== "ADJUSTMENT")) throw new Error("Enter a non-zero amount (negative only for adjustments)."); return add({ employee: emp, kind: v.kind!, month: `${v.month}-01`, amount: v.amount!.trim(), description: v.description!.trim(), taxable: true }).unwrap(); }} />
    </Card>
  );
}

function Loans() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListLoansQuery({});
  const [request] = useRequestLoanMutation();
  const [decide] = useDecideLoanMutation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (id: string, action: "approve" | "reject" | "cancel") => { setErr(null); try { await decide({ id, action, note: action === "reject" ? "Rejected" : undefined }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const hr = can("hr.compensation.manage");
  return (
    <Card title="Loans and salary advances">
      <div className="mb-3"><Button onClick={() => setOpen(true)}>{hr ? "Request loan for an employee" : "Request a loan"}</Button></div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {data!.results.length === 0 ? <EmptyState title="No loans" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Employee</th><th>Kind</th><th className="text-right">Principal</th><th>Installments</th><th>From</th><th>Status</th><th /></tr></thead>
          <tbody>{data!.results.map((l) => <tr key={l.id} className="border-t border-slate-100"><td>{l.employee_no}</td><td>{pretty(l.kind)}</td><td className="text-right">{formatMoney(l.principal)}</td><td>{l.schedule.filter((s) => s.repaid).length}/{l.installments}</td><td>{l.start_month.slice(0, 7)}</td><td><Badge tone={tone(l.status)}>{pretty(l.status)}</Badge></td>
            <td>{hr && <div className="flex gap-2">{l.status === "PENDING" && <><Button onClick={() => void go(l.id, "approve")}>Approve</Button><Button variant="secondary" onClick={() => void go(l.id, "reject")}>Reject</Button></>}{["PENDING", "ACTIVE"].includes(l.status) && <Button variant="secondary" onClick={() => void go(l.id, "cancel")}>Cancel</Button>}</div>}</td></tr>)}</tbody></table>
      )}
      <EmployeeRequest title="Request a loan" open={open} onClose={() => setOpen(false)} cta="Submit request" pickEmployee={hr}
        fields={[{ name: "kind", label: "Kind", options: [["LOAN", "Loan"], ["ADVANCE", "Salary advance"]], required: true }, { name: "principal", label: "Amount", required: true }, { name: "installments", label: "Installments (1–60)", required: true }, { name: "start", label: "First deduction month", type: "month", required: true }, { name: "reason", label: "Reason" }]}
        submit={async (emp, v) => { const problem = validateLoan({ principal: v.principal!, installments: v.installments!, start: v.start! }); if (problem) throw new Error(problem); return request({ ...(emp ? { employee: emp } : {}), kind: v.kind!, principal: v.principal!.trim(), installments: Number(v.installments), start_month: `${v.start}-01`, reason: (v.reason ?? "").trim() }).unwrap(); }} />
    </Card>
  );
}

export function CompensationPage() {
  const { can } = useAccess();
  const tabs: ["revisions" | "inputs" | "loans", string][] = [...(can("hr.compensation.view") ? ([["revisions", "Salary revisions"]] as ["revisions", string][]) : []), ...(can("hr.payroll.view") ? ([["inputs", "Variable pay"]] as ["inputs", string][]) : []), ["loans", "Loans"]];
  const [tab, setTab] = useState(tabs[0]![0]);
  return (
    <>
      <PageHeader title="Compensation" description="Salary changes, variable pay and loans." />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2 border-b border-slate-200">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-indigo-600 font-medium" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "revisions" && <Revisions />}
      {tab === "inputs" && <Inputs />}
      {tab === "loans" && <Loans />}
    </>
  );
}

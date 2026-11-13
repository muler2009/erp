import { useState } from "react";
import { useParams } from "react-router";

import { useListProjectExpensesQuery, useProjectExpenseActionMutation, useSubmitProjectExpenseMutation } from "../../shared/api/endpoints";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { ProjectNav } from "./ProjectFinancePage";

export const EXPENSE_CATEGORIES: [string, string][] = ["MATERIAL", "EQUIPMENT", "SUBCONTRACT", "TRAVEL", "OTHER"].map((c) => [c, pretty(c)]);

export function validateExpense(f: { category: string; description: string; amount: string; incurred_on: string }, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!EXPENSE_CATEGORIES.some(([c]) => c === f.category)) return "Choose a category (labour comes from timesheets).";
  if (!f.description.trim()) return "Describe the expense.";
  const a = parseMoney(f.amount);
  if (a === null || a <= 0n) return "Enter an amount greater than zero.";
  if (!f.incurred_on || f.incurred_on > today) return "The expense date cannot be in the future.";
  return null;
}

export function ProjectExpensesPage() {
  const { id = "" } = useParams();
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListProjectExpensesQuery({ id, cursor });
  const [submit] = useSubmitProjectExpenseMutation();
  const [decide] = useProjectExpenseActionMutation();
  const [dlg, setDlg] = useState(false);
  const [reject, setReject] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(failure(e)); } };
  return (
    <>
      <PageHeader title="Project expenses" description="Non-labour costs. Approved expenses count toward the project's actual cost." actions={<Button onClick={() => setDlg(true)}>New expense</Button>} />
      <ProjectNav id={id} current="expenses" />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <Card title="Expenses">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No expenses" /> : (
          <ul>{data.results.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2">
              <span className="min-w-40 flex-1">{e.description} <span className="text-sm text-slate-500">({pretty(e.category)}, {e.incurred_on})</span></span><span>{formatMoney(e.amount)}</span>
              <Badge tone={e.status === "APPROVED" ? "green" : e.status === "REJECTED" ? "red" : "amber"}>{pretty(e.status)}</Badge>
              {e.decision_note && <span className="text-sm text-slate-500">{e.decision_note}</span>}
              {e.status === "SUBMITTED" && <><Button onClick={() => void run(() => decide({ id: e.id, action: "approve" }).unwrap())}>Approve</Button><Button variant="secondary" onClick={() => setReject(e.id)}>Reject</Button></>}
            </li>))}</ul>
        )}
        {cursor && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(null)}>First page</Button></div>}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <ActionDialog title="New project expense" open={dlg} onClose={() => setDlg(false)} cta="Submit expense" fields={[{ name: "category", label: "Category", required: true, options: EXPENSE_CATEGORIES }, { name: "description", label: "Description", required: true }, { name: "amount", label: "Amount", required: true }, { name: "incurred_on", label: "Date", type: "date", required: true }]}
        submit={async (v) => { const f = { category: v.category ?? "", description: (v.description ?? "").trim(), amount: (v.amount ?? "").trim(), incurred_on: v.incurred_on ?? "" }; const p = validateExpense(f); if (p) throw new Error(p); await submit({ id, ...f }).unwrap(); }} />
      <ActionDialog title="Reject expense" open={!!reject} onClose={() => setReject(null)} cta="Reject expense" fields={[{ name: "note", label: "Reason", required: true }]} submit={(v) => decide({ id: reject!, action: "reject", note: (v.note ?? "").trim() }).unwrap()} />
    </>
  );
}

import { useState } from "react";

import { useClaimActionMutation, useListClaimsQuery, useSubmitClaimMutation } from "../../shared/api/endpoints";
import { parseMoney, formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "./ActionDialog";
import { pretty } from "./EmployeeDialogs";

export function validateClaim(f: { description: string; expense_date: string; amount: string }, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!f.description.trim()) return "Describe the expense.";
  if (!f.expense_date || f.expense_date > today) return "The expense date cannot be in the future.";
  const a = parseMoney(f.amount);
  if (a === null || a <= 0n) return "Enter an amount greater than zero.";
  return null;
}

export function ReimbursementsPage() {
  const { can } = useAccess();
  const approve = can("hr.reimbursement.approve");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListClaimsQuery({ cursor });
  const [submit] = useSubmitClaimMutation();
  const [decide] = useClaimActionMutation();
  const [dlg, setDlg] = useState(false);
  const [reject, setReject] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(failure(e)); } };
  return (
    <>
      <PageHeader title="Reimbursements" description="Expense claims." actions={<Button onClick={() => setDlg(true)}>New claim</Button>} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <Card title="Claims">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No claims" /> : (
          <ul>{data.results.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2">
              <span className="min-w-40 flex-1">{c.description} <span className="text-sm text-slate-500">({c.employee_no}, {c.expense_date})</span></span><span>{formatMoney(c.amount)}</span>
              <Badge tone={c.status === "APPROVED" ? "green" : c.status === "REJECTED" ? "red" : "amber"}>{pretty(c.status)}</Badge>
              {c.decision_note && <span className="text-sm text-slate-500">{c.decision_note}</span>}
              {approve && c.status === "SUBMITTED" && <><Button onClick={() => void run(() => decide({ id: c.id, action: "approve" }).unwrap())}>Approve</Button><Button variant="secondary" onClick={() => setReject(c.id)}>Reject</Button></>}
            </li>))}</ul>
        )}
        {cursor && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(null)}>First page</Button></div>}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <ActionDialog title="New reimbursement claim" open={dlg} onClose={() => setDlg(false)} cta="Submit claim" fields={[{ name: "description", label: "Description", required: true }, { name: "expense_date", label: "Expense date", type: "date", required: true }, { name: "amount", label: "Amount", required: true }]}
        submit={async (v) => { const f = { description: v.description ?? "", expense_date: v.expense_date ?? "", amount: (v.amount ?? "").trim() }; const p = validateClaim(f); if (p) throw new Error(p); await submit({ ...f, description: f.description.trim() }).unwrap(); }} />
      <ActionDialog title="Reject claim" open={!!reject} onClose={() => setReject(null)} cta="Reject claim" fields={[{ name: "note", label: "Reason", required: true }]} submit={(v) => decide({ id: reject!, action: "reject", note: (v.note ?? "").trim() }).unwrap()} />
    </>
  );
}

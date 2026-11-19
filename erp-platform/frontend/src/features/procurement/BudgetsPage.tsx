import { useState } from "react";

import { useCreateProcBudgetMutation, useCreateProcPlanMutation, useGetProcBudgetExecutionQuery, useGetProcPlanReportQuery, useListProcPlansQuery, useProcBudgetActionMutation, useProcPlanActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { PlanLineRow, ProcBudgetRow, ProcPlanRow } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

const DEC = /^\d+(\.\d{1,4})?$/;
const YEAR = /^20\d{2}$/;
export const PLAN_STATUS: Record<ProcPlanRow["status"], { label: string; tone: "green" | "amber" | "slate" }> = { DRAFT: { label: "Waiting for approval", tone: "amber" }, APPROVED: { label: "Approved", tone: "green" }, CLOSED: { label: "Closed", tone: "slate" } };

export function budgetProblem(f: { code: string; name: string; fiscal_year: string; amount: string }): string | null {
  if (!f.code.trim() || !f.name.trim()) return "Give the budget a code and a name.";
  if (!YEAR.test(f.fiscal_year.trim())) return "Enter the year, such as 2026.";
  if (!DEC.test(f.amount.trim())) return "The amount must be a number such as 50000.";
  return null;
}

export interface PlanLineDraft { category: string; description: string; quarter: string; planned_amount: string }
export function planProblem(f: { code?: string; name?: string; fiscal_year?: string }, lines: PlanLineDraft[]): string | null {
  if (f.code !== undefined && (!f.code.trim() || !(f.name ?? "").trim())) return "Give the plan a code and a name.";
  if (f.fiscal_year !== undefined && !YEAR.test(f.fiscal_year.trim())) return "Enter the year, such as 2026.";
  if (lines.length === 0) return "A plan needs at least one line.";
  for (const l of lines) {
    if (!l.category.trim()) return "Every line needs a category.";
    if (!/^[1-4]$/.test(l.quarter.trim())) return "The quarter must be 1, 2, 3 or 4.";
    if (!DEC.test(l.planned_amount.trim())) return "Every planned amount must be a number.";
  }
  return null;
}

const toDraft = (l: PlanLineRow): PlanLineDraft => ({ category: l.category, description: l.description, quarter: String(l.quarter), planned_amount: String(Number(l.planned_amount)) });
const toBody = (l: PlanLineDraft) => ({ category: l.category.trim(), description: l.description.trim(), quarter: Number(l.quarter), planned_amount: l.planned_amount.trim() });

function Lines({ lines, setLines }: { lines: PlanLineDraft[]; setLines: (l: PlanLineDraft[]) => void }) {
  const upd = (n: number, k: keyof PlanLineDraft, v: string) => setLines(lines.map((x, j) => (j === n ? { ...x, [k]: v } : x)));
  return (
    <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Planned purchases</legend>
      {lines.map((l, n) => (
        <div key={n} className="mb-2 flex items-center gap-2">
          <input aria-label={`Category ${n + 1}`} placeholder="Category" className={inputClass} value={l.category} onChange={(e) => upd(n, "category", e.target.value)} />
          <input aria-label={`Quarter ${n + 1}`} placeholder="Qtr" className={`${inputClass} w-16`} value={l.quarter} onChange={(e) => upd(n, "quarter", e.target.value)} />
          <input aria-label={`Amount ${n + 1}`} placeholder="Amount" className={`${inputClass} w-28`} value={l.planned_amount} onChange={(e) => upd(n, "planned_amount", e.target.value)} />
          {lines.length > 1 && <Button variant="secondary" onClick={() => setLines(lines.filter((_, j) => j !== n))}>Remove</Button>}
        </div>
      ))}
      <Button variant="secondary" onClick={() => setLines([...lines, { category: "", description: "", quarter: "1", planned_amount: "" }])}>Add a line</Button>
    </fieldset>
  );
}

function PlanDialog({ plan, onClose }: { plan: ProcPlanRow | null; onClose: () => void }) {
  const [create, c] = useCreateProcPlanMutation();
  const [act, a] = useProcPlanActionMutation();
  const [f, setF] = useState({ code: "", name: "", fiscal_year: String(new Date().getFullYear()), reason: "" });
  const [lines, setLines] = useState<PlanLineDraft[]>(plan ? plan.lines.map(toDraft) : [{ category: "", description: "", quarter: "1", planned_amount: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = planProblem(plan ? {} : f, lines) ?? (plan && !f.reason.trim() ? "Say why the plan is being revised." : null);
    if (p) { setErr(p); return; }
    setErr(null);
    try {
      if (plan) await act({ id: plan.id, action: "revise", body: { reason: f.reason.trim(), lines: lines.map(toBody) } }).unwrap();
      else await create({ code: f.code.trim(), name: f.name.trim(), fiscal_year: Number(f.fiscal_year), lines: lines.map(toBody) }).unwrap();
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={plan ? `Revise plan ${plan.code}` : "New procurement plan"} open onClose={onClose}>
      {plan ? <>
        <p className="mb-3 text-sm text-slate-600">Revising sends the plan back for approval; the earlier version is kept.</p>
        <FormField label="Reason" htmlFor="pl-reason"><input id="pl-reason" className={inputClass} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></FormField>
      </> : <div className="grid grid-cols-3 gap-3">
        <FormField label="Code" htmlFor="pl-code"><input id="pl-code" className={inputClass} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></FormField>
        <FormField label="Name" htmlFor="pl-name"><input id="pl-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
        <FormField label="Year" htmlFor="pl-year"><input id="pl-year" className={inputClass} value={f.fiscal_year} onChange={(e) => setF({ ...f, fiscal_year: e.target.value })} /></FormField>
      </div>}
      <Lines lines={lines} setLines={setLines} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={c.isLoading || a.isLoading} onClick={() => void go()}>{plan ? "Send revision" : "Create plan"}</Button></div>
    </Modal>
  );
}

function PlanReport({ plan, onClose }: { plan: ProcPlanRow; onClose: () => void }) {
  const q = useGetProcPlanReportQuery(plan.id);
  return (
    <Modal title={`${plan.code}: plan against actual`} open onClose={onClose}>
      {q.isLoading ? <Spinner /> : q.isError || !q.data ? <ErrorState error={q.error ?? new Error("Could not load.")} onRetry={() => void q.refetch()} /> : (
        <table className="w-full text-sm"><caption className="sr-only">Plan against actual</caption><thead><tr className="text-left text-slate-500"><th>Category</th><th className="text-right">Planned</th><th className="text-right">Committed</th><th className="text-right">Spent</th><th className="text-right">Left to plan</th></tr></thead>
          <tbody>{q.data.rows.map((r) => <tr key={r.category} className="border-t border-slate-100"><td className="py-1">{r.category}</td><td className="text-right">{formatMoney(r.planned)}</td><td className="text-right">{formatMoney(r.committed)}</td><td className="text-right">{formatMoney(r.actual)}</td><td className={`text-right ${Number(r.variance) < 0 ? "text-red-700" : ""}`}>{formatMoney(r.variance)}</td></tr>)}</tbody></table>
      )}
      <div className="mt-4 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Modal>
  );
}

function Plans() {
  const { can } = useAccess();
  const q = useListProcPlansQuery();
  const [act] = useProcPlanActionMutation();
  const [dlg, setDlg] = useState<{ kind: "new" } | { kind: "revise" | "report"; plan: ProcPlanRow } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const manage = can("procurement.plan.manage"), approve = can("procurement.plan.approve");
  const approveNow = async (id: string) => { setErr(null); try { await act({ id, action: "approve" }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Card title="Procurement plans" actions={manage ? <Button onClick={() => setDlg({ kind: "new" })}>New plan</Button> : undefined}>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="No plans" hint="A plan sets what each category is expected to spend by quarter." /> : (
        <table className="w-full text-sm"><caption className="sr-only">Procurement plans</caption>
          <thead><tr className="text-left text-slate-500"><th>Code</th><th>Name</th><th>Year</th><th>Version</th><th className="text-right">Planned</th><th>Status</th><th /></tr></thead>
          <tbody>{(q.data ?? []).map((p) => (
            <tr key={p.id} className="border-t border-slate-100"><td className="py-1">{p.code}</td><td>{p.name}</td><td>{p.fiscal_year}</td><td>{p.revision}</td><td className="text-right">{formatMoney(p.lines.reduce((t, l) => t + Number(l.planned_amount), 0).toFixed(2))}</td><td><Badge tone={PLAN_STATUS[p.status].tone}>{PLAN_STATUS[p.status].label}</Badge></td>
              <td className="space-x-1 text-right"><Button variant="secondary" onClick={() => setDlg({ kind: "report", plan: p })}>{`Compare ${p.code} with actual`}</Button>
                {p.status === "DRAFT" && approve && <Button variant="secondary" onClick={() => void approveNow(p.id)}>{`Approve ${p.code}`}</Button>}
                {p.status !== "CLOSED" && manage && <Button variant="secondary" onClick={() => setDlg({ kind: "revise", plan: p })}>{`Revise ${p.code}`}</Button>}</td></tr>
          ))}</tbody>
        </table>
      )}
      {dlg?.kind === "new" && <PlanDialog plan={null} onClose={() => setDlg(null)} />}
      {dlg?.kind === "revise" && <PlanDialog plan={dlg.plan} onClose={() => setDlg(null)} />}
      {dlg?.kind === "report" && <PlanReport plan={dlg.plan} onClose={() => setDlg(null)} />}
    </Card>
  );
}

function Budgets() {
  const { can } = useAccess();
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const valid = YEAR.test(year.trim());
  const q = useGetProcBudgetExecutionQuery(Number(year), { skip: !valid });
  const [act] = useProcBudgetActionMutation();
  const [create] = useCreateProcBudgetMutation();
  const [dlg, setDlg] = useState<{ kind: "new" } | { kind: "revise" | "close"; b: ProcBudgetRow } | null>(null);
  const manage = can("procurement.budget.manage");
  const d = q.data;
  return (
    <Card title="Budgets" actions={manage ? <Button onClick={() => setDlg({ kind: "new" })}>New budget</Button> : undefined}>
      <div className="mb-3 max-w-xs"><FormField label="Year" htmlFor="bd-year"><input id="bd-year" className={inputClass} value={year} onChange={(e) => setYear(e.target.value)} /></FormField></div>
      {!valid ? <p role="alert" className="text-sm text-red-700">Enter the year, such as 2026.</p> : q.isLoading ? <Spinner /> : q.isError || !d ? <ErrorState error={q.error ?? new Error("Could not load.")} onRetry={() => void q.refetch()} /> : d.rows.length === 0 ? <EmptyState title={`No budgets for ${d.fiscal_year}`} /> : (
        <table className="w-full text-sm"><caption className="sr-only">Budget use</caption>
          <thead><tr className="text-left text-slate-500"><th>Code</th><th>Name</th><th className="text-right">Budget</th><th className="text-right">Committed</th><th className="text-right">Spent</th><th className="text-right">Available</th><th className="text-right">Used</th><th /></tr></thead>
          <tbody>{d.rows.map((b) => (
            <tr key={b.id} className="border-t border-slate-100"><td className="py-1">{b.code}</td><td>{b.name} {b.status === "CLOSED" && <Badge tone="slate">Closed</Badge>}</td><td className="text-right">{formatMoney(b.budget)}</td><td className="text-right">{formatMoney(b.committed)}</td><td className="text-right">{formatMoney(b.actual)}</td><td className={`text-right ${Number(b.available) < 0 ? "text-red-700" : ""}`}>{formatMoney(b.available)}</td><td className="text-right">{b.utilisation_pct === null ? "–" : `${b.utilisation_pct}%`}</td>
              <td className="space-x-1 text-right">{b.status === "OPEN" && manage && <><Button variant="secondary" onClick={() => setDlg({ kind: "revise", b })}>{`Revise ${b.code}`}</Button><Button variant="danger" onClick={() => setDlg({ kind: "close", b })}>{`Close ${b.code}`}</Button></>}</td></tr>
          ))}</tbody>
          <tfoot><tr className="border-t-2 border-slate-300 font-semibold"><td className="py-1" colSpan={2}>Total</td><td className="text-right">{formatMoney(d.totals.budget)}</td><td className="text-right">{formatMoney(d.totals.committed)}</td><td className="text-right">{formatMoney(d.totals.actual)}</td><td className="text-right">{formatMoney(d.totals.available)}</td><td colSpan={2} /></tr></tfoot>
        </table>
      )}
      {dlg?.kind === "new" && <ActionDialog title="New budget" cta="Create budget" open onClose={() => setDlg(null)} initial={{ fiscal_year: year, enforcement: "BLOCK" }}
        fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "fiscal_year", label: "Year", required: true }, { name: "amount", label: "Amount", required: true }, { name: "category", label: "Category (matches plan lines)" }, { name: "cost_center_ref", label: "Cost centre" }, { name: "enforcement", label: "When it runs out", options: [["BLOCK", "Block new orders"], ["WARN", "Warn only"]] }]}
        submit={async (v) => { const p = budgetProblem({ code: v.code ?? "", name: v.name ?? "", fiscal_year: v.fiscal_year ?? "", amount: v.amount ?? "" }); if (p) throw new Error(p); await create({ code: v.code!.trim(), name: v.name!.trim(), fiscal_year: Number(v.fiscal_year), amount: v.amount!.trim(), category: (v.category ?? "").trim(), cost_center_ref: v.cost_center_ref ?? "", enforcement: v.enforcement || "BLOCK" }).unwrap(); }} />}
      {dlg?.kind === "revise" && <ActionDialog title={`Revise ${dlg.b.code}`} cta="Save revision" open onClose={() => setDlg(null)} initial={{ amount: String(Number(dlg.b.budget)) }}
        fields={[{ name: "amount", label: `New amount (${formatMoney(dlg.b.committed)} is already committed)`, required: true }, { name: "reason", label: "Reason", required: true }]}
        submit={async (v) => { if (!DEC.test((v.amount ?? "").trim())) throw new Error("The amount must be a number such as 50000."); if (Number(v.amount) < Number(dlg.b.committed)) throw new Error(`The new amount cannot be below what is already committed (${formatMoney(dlg.b.committed)}).`); await act({ id: dlg.b.id, action: "revise", body: { amount: v.amount!.trim(), reason: v.reason } }).unwrap(); }} />}
      {dlg?.kind === "close" && <ActionDialog title={`Close ${dlg.b.code}`} cta="Close budget" open onClose={() => setDlg(null)} fields={[]} submit={async () => { await act({ id: dlg.b.id, action: "close" }).unwrap(); }} />}
    </Card>
  );
}

export function BudgetsPage() {
  const [tab, setTab] = useState<"budgets" | "plans">("budgets");
  const tabs: ["budgets" | "plans", string][] = [["budgets", "Budgets"], ["plans", "Plans"]];
  return (
    <div>
      <PageHeader title="Budgets and plans" description="What purchasing may spend, and what it is expected to buy." />
      <div role="tablist" className="mb-4 flex border-b border-slate-200">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={k === tab} onClick={() => setTab(k)} className={`px-3 py-2 text-sm ${k === tab ? "border-b-2 border-indigo-600 font-medium text-indigo-700" : "text-slate-600 hover:text-slate-900"}`}>{l}</button>)}</div>
      {tab === "budgets" ? <Budgets /> : <Plans />}
    </div>
  );
}

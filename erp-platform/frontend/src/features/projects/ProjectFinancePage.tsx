import { useState } from "react";
import { Link, useParams } from "react-router";

import { useCreateProjectBudgetMutation, useGetProjectBillingQuery, useGetProjectCostsQuery, useGetProjectProfitQuery, useListProjectBudgetsQuery, useProjectBudgetActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { BudgetLine, ProjectBudget } from "../../shared/api/types";
import { formatMoney, parseMoney, sumMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export const COST_CATEGORIES = ["LABOR", "MATERIAL", "EQUIPMENT", "SUBCONTRACT", "TRAVEL", "OTHER"];

export function validateLines(lines: BudgetLine[]): string | null {
  if (lines.length === 0) return "Add at least one budget line.";
  for (const [i, l] of lines.entries()) {
    if (!COST_CATEGORIES.includes(l.category)) return `Line ${i + 1}: choose a category.`;
    const a = parseMoney(l.amount);
    if (a === null || a <= 0n) return `Line ${i + 1}: enter an amount greater than zero.`;
  }
  return null;
}
export const linesTotal = (lines: BudgetLine[]) => sumMoney(lines.map((l) => l.amount));

export function ProjectNav({ id, current }: { id: string; current: string }) {
  const items: [string, string][] = [["", "Tasks"], ["schedule", "Schedule"], ["finance", "Budget & costs"], ["billing", "Time & billing"], ["expenses", "Expenses"], ["risks", "Risks & issues"], ["team", "Team"]];
  return (
    <nav aria-label="Project sections" className="mb-4 flex flex-wrap gap-3 text-sm">
      {items.map(([path, label]) => <Link key={label} className={path === current ? "font-semibold underline" : "text-indigo-700 underline"} to={`/app/projects/projects/${id}${path ? `/${path}` : ""}`}>{label}</Link>)}
    </nav>
  );
}

function BudgetDialog({ id, open, onClose, existing, revising }: { id: string; open: boolean; onClose: () => void; existing?: ProjectBudget; revising: boolean }) {
  const [create, cState] = useCreateProjectBudgetMutation();
  const [act, aState] = useProjectBudgetActionMutation();
  const [lines, setLines] = useState<BudgetLine[]>(existing?.lines.length ? existing.lines : [{ category: "LABOR", description: "", amount: "" }]);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const set = (i: number, patch: Partial<BudgetLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const go = async () => {
    const p = validateLines(lines);
    if (p) { setErr(p); return; }
    if (!existing && revising && !reason.trim()) { setErr("Explain why the budget is being revised."); return; }
    setErr(null);
    const clean = lines.map((l) => ({ ...l, amount: l.amount.trim() }));
    try { if (existing) await act({ id: existing.id, action: "lines", lines: clean }).unwrap(); else await create({ id, lines: clean, reason: reason.trim() }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={existing ? "Edit budget lines" : "New budget"} open={open} onClose={onClose}>
      {lines.map((l, i) => (
        <div key={i} className="mb-2 grid grid-cols-12 gap-2">
          <select aria-label={`Category ${i + 1}`} className={`${inputClass} col-span-4`} value={l.category} onChange={(e) => set(i, { category: e.target.value })}>{COST_CATEGORIES.map((c) => <option key={c} value={c}>{pretty(c)}</option>)}</select>
          <input aria-label={`Description ${i + 1}`} className={`${inputClass} col-span-5`} value={l.description} onChange={(e) => set(i, { description: e.target.value })} />
          <input aria-label={`Amount ${i + 1}`} inputMode="decimal" className={`${inputClass} col-span-2`} value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} />
          <button type="button" aria-label={`Remove line ${i + 1}`} className="col-span-1 text-slate-500" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => setLines([...lines, { category: "MATERIAL", description: "", amount: "" }])}>Add line</Button>
      <p className="mt-2 text-sm">Total: <strong>{formatMoney(linesTotal(lines))}</strong></p>
      {!existing && revising && <FormField label="Reason for revising" htmlFor="bd-reason"><input id="bd-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>}
      {err && <p role="alert" className="my-2 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={cState.isLoading || aState.isLoading} onClick={() => void go()}>Save budget</Button></div>
    </Modal>
  );
}

function Budget({ id }: { id: string }) {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListProjectBudgetsQuery(id);
  const [act] = useProjectBudgetActionMutation();
  const [dlg, setDlg] = useState<"new" | "edit" | "reject" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const latest = data?.results[0];
  const pending = data?.results.some((b) => b.status === "DRAFT" || b.status === "SUBMITTED");
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(failure(e)); } };
  return (
    <Card title="Budget">
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : (
        <>
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          {!latest ? <EmptyState title="No budget yet" /> : (
            <>
              <p className="mb-2 text-sm">Revision {latest.revision} <Badge tone={latest.status === "APPROVED" ? "green" : latest.status === "REJECTED" ? "red" : "amber"}>{pretty(latest.status)}</Badge> · total <strong>{formatMoney(latest.total)}</strong>{latest.reason && ` · ${latest.reason}`}</p>
              <ul className="text-sm">{latest.lines.map((l, i) => <li key={i} className="flex justify-between border-b border-slate-100 py-1"><span>{pretty(l.category)}{l.description ? ` — ${l.description}` : ""}</span><span>{formatMoney(l.amount)}</span></li>)}</ul>
              <div className="mt-3 flex flex-wrap gap-2">
                {latest.status === "DRAFT" && <><Button variant="secondary" onClick={() => setDlg("edit")}>Edit lines</Button><Button onClick={() => void run(() => act({ id: latest.id, action: "submit" }).unwrap())}>Submit for approval</Button></>}
                {latest.status === "SUBMITTED" && can("projects.budget.approve") && <><Button onClick={() => void run(() => act({ id: latest.id, action: "approve" }).unwrap())}>Approve</Button><Button variant="secondary" onClick={() => setDlg("reject")}>Reject</Button></>}
              </div>
            </>
          )}
          {!pending && <div className="mt-3"><Button variant="secondary" onClick={() => setDlg("new")}>{latest ? "Revise budget" : "Create budget"}</Button></div>}
          {dlg === "new" && <BudgetDialog key="new" id={id} open onClose={() => setDlg(null)} revising={!!latest} />}
          {dlg === "edit" && latest && <BudgetDialog key={latest.id} id={id} open onClose={() => setDlg(null)} existing={latest} revising={false} />}
          {latest && <ActionDialog title="Reject budget" open={dlg === "reject"} onClose={() => setDlg(null)} cta="Reject budget" fields={[{ name: "note", label: "Reason", required: true }]} submit={(v) => act({ id: latest.id, action: "reject", note: (v.note ?? "").trim() }).unwrap()} />}
        </>
      )}
    </Card>
  );
}

function Costs({ id }: { id: string }) {
  const costs = useGetProjectCostsQuery(id);
  if (costs.isLoading) return <Spinner />;
  if (costs.error || !costs.data) return <ErrorState error={costs.error} onRetry={costs.refetch} />;
  const c = costs.data, ev = c.earned_value;
  return (
    <Card title="Cost report">
      {!c.has_approved_budget && <p className="mb-2 text-sm text-amber-700">There is no approved budget, so variances are not meaningful yet.</p>}
      <table className="w-full text-sm"><caption className="sr-only">Cost by category</caption><thead><tr className="text-left"><th>Category</th><th className="text-right">Budget</th><th className="text-right">Actual</th><th className="text-right">Variance</th></tr></thead>
        <tbody>{c.rows.map((r) => <tr key={r.category} className="border-t border-slate-100"><td>{pretty(r.category)} {r.over_budget && <Badge tone="red">Over budget</Badge>}</td><td className="text-right">{formatMoney(r.budget)}</td><td className="text-right">{formatMoney(r.actual)}</td><td className="text-right">{formatMoney(r.variance)}</td></tr>)}
          <tr className="border-t border-slate-300 font-semibold"><td>Total</td><td className="text-right">{formatMoney(c.totals.budget)}</td><td className="text-right">{formatMoney(c.totals.actual)}</td><td className="text-right">{formatMoney(c.totals.variance)}</td></tr></tbody></table>
      <p className="mt-2 text-sm text-slate-600">Pending expenses {formatMoney(c.pending_expenses)} · {c.hours} hours logged{Number(c.unmatched_hours) > 0 ? ` (${c.unmatched_hours} hours have no cost rate)` : ""}</p>
      <p className="mt-2 text-sm">Complete {ev.percent_complete}% (planned {ev.planned_percent}%) · CPI {ev.cpi ?? "n/a"} · SPI {ev.spi ?? "n/a"} · forecast at completion {ev.eac === null ? "n/a" : formatMoney(ev.eac)}</p>
    </Card>
  );
}

function Profit({ id }: { id: string }) {
  const profit = useGetProjectProfitQuery(id);
  const billing = useGetProjectBillingQuery(id);
  if (profit.isLoading || billing.isLoading) return <Spinner />;
  if (profit.error || !profit.data) return <ErrorState error={profit.error} onRetry={profit.refetch} />;
  const p = profit.data, b = billing.data;
  return (
    <Card title="Profitability and billing">
      <p className="text-sm">Revenue recognised {formatMoney(p.revenue_recognized)} · billed {formatMoney(p.billed)} · cost {formatMoney(p.actual_cost)}</p>
      <p className="text-lg font-semibold">Margin {formatMoney(p.margin)}{p.margin_percent !== null && ` (${p.margin_percent}%)`}</p>
      <p className="text-sm text-slate-600">Forecast: revenue {formatMoney(p.forecast.revenue)}, cost {formatMoney(p.forecast.cost)}, margin {formatMoney(p.forecast.margin)}{p.under_billed !== null && ` · under-billed ${formatMoney(p.under_billed)}`}</p>
      {b && <><p className="mt-2 text-sm">Paid {formatMoney(b.paid)}{b.remaining !== null && ` · remaining to bill ${formatMoney(b.remaining)}`}</p>
        {b.rows.length > 0 && <ul className="mt-1 text-sm">{b.rows.map((r) => <li key={r.invoice_id}>{pretty(r.kind)} {formatMoney(r.amount)} — {pretty(r.invoice_status)}{r.description ? `: ${r.description}` : ""}</li>)}</ul>}</>}
    </Card>
  );
}

export function ProjectFinancePage() {
  const { id = "" } = useParams();
  return (
    <>
      <PageHeader title="Project budget and costs" description="Approved budget, actual cost, earned value and margin." />
      <ProjectNav id={id} current="finance" />
      <div className="grid gap-4"><Budget id={id} /><Costs id={id} /><Profit id={id} /></div>
    </>
  );
}

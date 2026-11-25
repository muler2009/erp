import { useState } from "react";

import { useDecideCapexBudgetMutation, useDecideReplacementMutation, useGetAssetDashboardQuery, useGetCapexReportQuery, useGetReplacementCandidatesQuery, useListAssetCategoriesQuery, useListCapexBudgetsQuery, useListFixedAssetsQuery, useListReplacementPlanQuery, usePlanReplacementMutation, useProposeCapexBudgetMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

const DEC = /^\d+(\.\d{1,4})?$/;
const YEAR = new Date().getFullYear();

export function validateReplacement(f: { asset: string; planned_year: string; estimated_cost: string; reason: string }): string | null {
  if (!f.asset) return "Choose the asset.";
  if (!/^\d{4}$/.test(f.planned_year)) return "Enter the year as four digits.";
  if (!DEC.test(f.estimated_cost.trim()) || Number(f.estimated_cost) <= 0) return "The estimated cost must be a positive number.";
  if (!f.reason.trim()) return "Give the reason for replacing it.";
  return null;
}
export function validateBudget(year: string, amount: string): string | null {
  if (!/^\d{4}$/.test(year)) return "Enter the year as four digits.";
  if (!DEC.test(amount.trim()) || Number(amount) <= 0) return "The budget must be a positive number.";
  return null;
}

function Tile({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return <div className={`rounded border p-3 ${warn ? "border-amber-400 bg-amber-50" : "border-slate-200"}`}><div className="text-xs text-slate-500">{label}</div><div className="text-xl font-semibold">{value}</div></div>;
}

function Dashboard() {
  const { data: d, isLoading, error, refetch } = useGetAssetDashboardQuery();
  if (isLoading) return <Spinner />;
  if (error || !d) return <ErrorState error={error} onRetry={refetch} />;
  const n = (k: number) => k > 0;
  return (
    <div className="grid gap-4">
      <Card title="Value">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Tile label="Cost" value={formatMoney(d.value.gross_value)} /><Tile label="Accumulated depreciation" value={formatMoney(d.value.accumulated_depreciation)} /><Tile label="Impairment" value={formatMoney(d.value.impairment)} /><Tile label="Net book value" value={formatMoney(d.value.net_book_value)} /></div>
        <p className="mt-2 text-sm">{d.reconciled ? <Badge tone="green">Register matches the ledger</Badge> : <Badge tone="red">Register does not match the ledger</Badge>}</p>
      </Card>
      <Card title="Needs attention">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Open work orders" value={d.maintenance.open_work_orders ?? 0} />
          <Tile label="Overdue work orders" value={d.maintenance.overdue ?? 0} warn={n(d.maintenance.overdue ?? 0)} />
          <Tile label="Overdue inspections" value={d.inspections.overdue} warn={n(d.inspections.overdue)} />
          <Tile label="Open findings" value={d.inspections.open_findings} warn={n(d.inspections.open_findings)} />
          <Tile label="Uninsured (required)" value={d.uninsured_required} warn={n(d.uninsured_required)} />
          <Tile label="Expiring in 30 days" value={d.expiring_30_days.warranties + d.expiring_30_days.policies + d.expiring_30_days.vehicles} warn={n(d.expiring_30_days.warranties + d.expiring_30_days.policies + d.expiring_30_days.vehicles)} />
          <Tile label="Unreturned custody" value={d.custody.unreturned} warn={n(d.custody.unreturned)} />
          <Tile label="Unacknowledged custody" value={d.custody.unacknowledged} warn={n(d.custody.unacknowledged)} />
          <Tile label="Idle (30 days)" value={d.utilization_30d.idle} />
          <Tile label="Underused (30 days)" value={d.utilization_30d.underutilized} />
          <Tile label="Open disposals" value={d.open_disposals} />
          <Tile label="Open counts" value={d.open_counts} />
          <Tile label="Replacement candidates" value={d.replacement_candidates} warn={n(d.replacement_candidates)} />
        </div>
      </Card>
      <Card title="Assets by status">
        {!Object.keys(d.assets_by_status).length ? <EmptyState title="No assets yet" /> : <ul className="grid grid-cols-2 gap-1 text-sm md:grid-cols-4">{Object.entries(d.assets_by_status).map(([s, c]) => <li key={s}>{pretty(s)}: <strong>{c}</strong></li>)}</ul>}
      </Card>
    </div>
  );
}

function Replacement() {
  const { can } = useAccess();
  const manage = can("assets.valuation.manage");
  const approve = can("assets.valuation.approve");
  const cand = useGetReplacementCandidatesQuery();
  const plan = useListReplacementPlanQuery({});
  const assets = useListFixedAssetsQuery({}, { skip: !manage });
  const [create] = usePlanReplacementMutation();
  const [decide] = useDecideReplacementMutation();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ asset: "", planned_year: String(YEAR + 1), estimated_cost: "", reason: "" });
  const [ferr, setFerr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateReplacement(f);
    if (p) { setFerr(p); return; }
    setFerr(null);
    try { await create({ asset: f.asset, planned_year: Number(f.planned_year), estimated_cost: f.estimated_cost.trim(), reason: f.reason.trim() }).unwrap(); setOpen(false); setF({ asset: "", planned_year: String(YEAR + 1), estimated_cost: "", reason: "" }); } catch (e) { setFerr(errorMessage(e)); }
  };
  const assetId = (number: string) => assets.data?.results.find((a) => a.number === number)?.id ?? "";
  return (
    <div className="grid gap-4">
      <Card title="Replacement candidates">
        {cand.isLoading ? <Spinner /> : cand.error ? <ErrorState error={cand.error} onRetry={cand.refetch} /> : !cand.data?.length ? <EmptyState title="No asset meets the replacement rules" /> : (
          <ul className="text-sm">{cand.data.map((c) => (
            <li key={c.asset} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2">
              <span className="font-medium">{c.asset} {c.name}</span><span className="text-slate-500">{c.category}</span>{c.reasons.map((r) => <Badge key={r} tone="amber">{pretty(r)}</Badge>)}
              <span className="text-slate-600">12-month upkeep {formatMoney(c.maintenance_cost_12m)} · {c.breakdowns_12m} breakdown(s)</span>
              {c.already_planned ? <Badge tone="slate">In plan</Badge> : manage && <Button variant="secondary" onClick={() => { setF({ asset: assetId(c.asset), planned_year: String(YEAR + 1), estimated_cost: c.gross_value, reason: c.reasons.map(pretty).join(", ") }); setOpen(true); }}>{`Plan replacement of ${c.asset}`}</Button>}
            </li>))}</ul>
        )}
      </Card>
      <Card title="Replacement plan">
        {manage && <div className="mb-2"><Button onClick={() => setOpen(true)}>Add to the plan</Button></div>}
        {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
        {plan.isLoading ? <Spinner /> : plan.error ? <ErrorState error={plan.error} onRetry={plan.refetch} /> : !plan.data?.results.length ? <EmptyState title="Nothing planned" /> : (
          <ul className="text-sm">{plan.data.results.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2">
              <span className="font-medium">{r.asset.number}</span><span>{r.planned_year}</span><span>{formatMoney(r.estimated_cost)}</span><Badge tone={r.status === "APPROVED" ? "green" : r.status === "REJECTED" ? "red" : "amber"}>{pretty(r.status)}</Badge><span className="text-slate-500">{r.reason}</span>
              {r.status === "PLANNED" && approve && <><Button onClick={async () => { setErr(null); try { await decide({ id: r.id, action: "approve" }).unwrap(); } catch (e) { setErr(failure(e)); } }}>{`Approve ${r.asset.number} replacement`}</Button><Button variant="secondary" onClick={() => setRejecting(r.id)}>{`Reject ${r.asset.number} replacement`}</Button></>}
            </li>))}</ul>
        )}
      </Card>
      <Modal title="Plan a replacement" open={open} onClose={() => setOpen(false)}>
        <FormField label="Asset" htmlFor="rp-asset"><select id="rp-asset" className={inputClass} value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}><option value="">Choose…</option>{assets.data?.results.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Planned year" htmlFor="rp-year"><input id="rp-year" className={inputClass} value={f.planned_year} onChange={(e) => setF({ ...f, planned_year: e.target.value })} /></FormField>
          <FormField label="Estimated cost" htmlFor="rp-cost"><input id="rp-cost" className={inputClass} value={f.estimated_cost} onChange={(e) => setF({ ...f, estimated_cost: e.target.value })} /></FormField>
        </div>
        <FormField label="Reason" htmlFor="rp-reason"><textarea id="rp-reason" className={inputClass} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></FormField>
        {ferr && <p role="alert" className="mb-3 text-sm text-red-700">{ferr}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Add to the plan</Button></div>
      </Modal>
      <ActionDialog key={`rj${rejecting}`} title="Reject replacement" open={!!rejecting} onClose={() => setRejecting(null)} cta="Reject" fields={[{ name: "note", label: "Reason", required: true }]} submit={(v) => decide({ id: rejecting!, action: "reject", note: (v.note ?? "").trim() }).unwrap()} />
    </div>
  );
}

function Capex() {
  const { can } = useAccess();
  const manage = can("assets.valuation.manage");
  const approve = can("assets.valuation.approve");
  const [year, setYear] = useState(YEAR);
  const budgets = useListCapexBudgetsQuery({});
  const report = useGetCapexReportQuery(year);
  const cats = useListAssetCategoriesQuery();
  const [propose] = useProposeCapexBudgetMutation();
  const [decide] = useDecideCapexBudgetMutation();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ year: String(YEAR), category: "", amount: "", notes: "" });
  const [ferr, setFerr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const code = (id: string | null) => (id ? cats.data?.results.find((c) => c.id === id)?.code ?? id : "All categories");
  const go = async () => {
    const p = validateBudget(f.year, f.amount);
    if (p) { setFerr(p); return; }
    setFerr(null);
    try { await propose({ year: Number(f.year), amount: f.amount.trim(), notes: f.notes.trim(), ...(f.category ? { category: f.category } : {}) }).unwrap(); setOpen(false); } catch (e) { setFerr(errorMessage(e)); }
  };
  return (
    <div className="grid gap-4">
      <Card title="Capital budgets">
        {manage && <div className="mb-2"><Button onClick={() => setOpen(true)}>Propose a budget</Button></div>}
        {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
        {budgets.isLoading ? <Spinner /> : budgets.error ? <ErrorState error={budgets.error} onRetry={budgets.refetch} /> : !budgets.data?.results.length ? <EmptyState title="No budgets yet" /> : (
          <ul className="text-sm">{budgets.data.results.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2">
              <span className="font-medium">{b.year}</span><span>{code(b.category)}</span><span>{formatMoney(b.amount)}</span><Badge tone={b.status === "APPROVED" ? "green" : b.status === "REJECTED" ? "red" : "amber"}>{pretty(b.status)}</Badge>{b.notes && <span className="text-slate-500">{b.notes}</span>}
              {b.status === "PROPOSED" && approve && <><Button onClick={async () => { setErr(null); try { await decide({ id: b.id, action: "approve" }).unwrap(); } catch (e) { setErr(failure(e)); } }}>{`Approve ${b.year} ${code(b.category)} budget`}</Button><Button variant="secondary" onClick={() => setRejecting(b.id)}>{`Reject ${b.year} ${code(b.category)} budget`}</Button></>}
            </li>))}</ul>
        )}
      </Card>
      <Card title="Budget against spend">
        <label className="mb-2 block text-sm">Year <select aria-label="Budget year" className={inputClass} value={year} onChange={(e) => setYear(Number(e.target.value))}>{[YEAR + 1, YEAR, YEAR - 1, YEAR - 2].map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
        {report.isLoading ? <Spinner /> : report.error || !report.data ? <ErrorState error={report.error} onRetry={report.refetch} /> : !report.data.rows.length ? <EmptyState title="No budget or spend in this year" /> : (
          <table className="w-full text-sm"><caption className="sr-only">Capex against budget</caption><thead><tr className="text-left"><th>Category</th><th className="text-right">Budget</th><th className="text-right">Spent</th><th className="text-right">Planned replacements</th><th className="text-right">Remaining</th><th></th></tr></thead>
            <tbody>{report.data.rows.map((r) => <tr key={r.category} className="border-t border-slate-100"><td>{r.category}</td><td className="text-right">{formatMoney(r.budget)}</td><td className="text-right">{formatMoney(r.actual)}</td><td className="text-right">{formatMoney(r.planned_replacements)}</td><td className="text-right">{formatMoney(r.remaining)}</td><td>{r.over_budget ? <Badge tone="red">Over budget</Badge> : null}</td></tr>)}</tbody></table>
        )}
      </Card>
      <Modal title="Propose a capital budget" open={open} onClose={() => setOpen(false)}>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Year" htmlFor="cb-year"><input id="cb-year" className={inputClass} value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} /></FormField>
          <FormField label="Amount" htmlFor="cb-amt"><input id="cb-amt" className={inputClass} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></FormField>
        </div>
        <FormField label="Category" htmlFor="cb-cat"><select id="cb-cat" className={inputClass} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All categories</option>{cats.data?.results.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></FormField>
        <FormField label="Notes" htmlFor="cb-notes"><input id="cb-notes" className={inputClass} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></FormField>
        {ferr && <p role="alert" className="mb-3 text-sm text-red-700">{ferr}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Propose</Button></div>
      </Modal>
      <ActionDialog key={`bj${rejecting}`} title="Reject budget" open={!!rejecting} onClose={() => setRejecting(null)} cta="Reject" fields={[{ name: "note", label: "Reason", required: true }]} submit={(v) => decide({ id: rejecting!, action: "reject", note: (v.note ?? "").trim() }).unwrap()} />
    </div>
  );
}

const TABS = [["dashboard", "Dashboard"], ["replacement", "Replacement"], ["capex", "Capital budget"]] as const;

export function PlanningPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("dashboard");
  return (
    <>
      <PageHeader title="Asset planning" description="Where the asset base needs attention, what to replace, and the capital budget." />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2 border-b border-slate-200">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-slate-900 font-semibold" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "dashboard" && <Dashboard />}
      {tab === "replacement" && <Replacement />}
      {tab === "capex" && <Capex />}
    </>
  );
}

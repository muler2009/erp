import { useState } from "react";

import { useDecideValueAdjustmentMutation, useGetAssetReconciliationQuery, useGetAssetValuationQuery, useListAssetCategoriesQuery, useListDepRunsQuery, useListValueAdjustmentsQuery, useReverseDepRunMutation, useRunDepreciationMutation } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export function validatePeriod(year: string, month: string): string | null {
  if (!/^\d{4}$/.test(year) || Number(year) < 2000 || Number(year) > 2100) return "Enter a four-digit year.";
  if (!/^\d{1,2}$/.test(month) || Number(month) < 1 || Number(month) > 12) return "The month must be from 1 to 12.";
  return null;
}

function Runs() {
  const { can } = useAccess();
  const run = can("assets.depreciation.run");
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const { data, isLoading, error, refetch } = useListDepRunsQuery(year);
  const [start] = useRunDepreciationMutation();
  const [reverse] = useReverseDepRunMutation();
  const [dlg, setDlg] = useState<"run" | { id: string; period: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const rev = dlg && dlg !== "run" ? dlg : null;
  return (
    <Card title="Depreciation runs">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <label className="text-sm">Year <select aria-label="Run year" className={inputClass} value={year} onChange={(e) => setYear(Number(e.target.value))}>{[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
        {run && <Button onClick={() => setDlg("run")}>Run depreciation</Button>}
      </div>
      {msg && <p role="status" className="mb-2 text-sm text-green-700">{msg}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No runs in this year" /> : (
        <ul>{data.results.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2 text-sm">
            <span className="w-20 font-mono">{r.period}</span><span className="flex-1">{r.assets} asset(s) · {formatMoney(r.total)}</span><Badge tone={r.status === "POSTED" ? "green" : "slate"}>{pretty(r.status)}</Badge>
            {run && r.status === "POSTED" && <Button variant="secondary" onClick={() => setDlg({ id: r.id, period: r.period })}>{`Reverse ${r.period}`}</Button>}
          </li>))}</ul>
      )}
      <ActionDialog title="Run depreciation" open={dlg === "run"} onClose={() => setDlg(null)} cta="Post run" fields={[{ name: "year", label: "Year", required: true }, { name: "month", label: "Month (1-12)", required: true }]}
        submit={async (v) => { const p = validatePeriod((v.year ?? "").trim(), (v.month ?? "").trim()); if (p) throw new Error(p); const r = await start({ year: Number(v.year), month: Number(v.month) }).unwrap(); setMsg(`Posted ${r.period}: ${formatMoney(r.total)} across ${r.assets} asset(s).`); setYear(Number(v.year)); }} />
      <ActionDialog key={rev?.id} title={rev ? `Reverse ${rev.period}` : "Reverse run"} open={!!rev} onClose={() => setDlg(null)} cta="Reverse run" fields={[{ name: "reason", label: "Reason", required: true }]}
        submit={async (v) => { await reverse({ id: rev!.id, reason: (v.reason ?? "").trim() }).unwrap(); setMsg(`Reversed ${rev!.period}.`); }} />
    </Card>
  );
}

function ValuationCard() {
  const cats = useListAssetCategoriesQuery();
  const [f, setF] = useState({ as_of: "", category: "" });
  const { data, isLoading, error, refetch } = useGetAssetValuationQuery({ as_of: f.as_of || undefined, category: f.category || undefined });
  return (
    <Card title="Valuation">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <FormField label="As of" htmlFor="vl-asof"><input id="vl-asof" type="date" className={inputClass} value={f.as_of} onChange={(e) => setF({ ...f, as_of: e.target.value })} /></FormField>
        <FormField label="Category" htmlFor="vl-cat"><select id="vl-cat" className={inputClass} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All</option>{cats.data?.results.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></FormField>
      </div>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.rows.length ? <EmptyState title="Nothing capitalised yet" /> : (
        <table className="w-full text-sm"><caption className="sr-only">Asset valuation</caption><thead><tr className="text-left"><th>Asset</th><th>Category</th><th className="text-right">Cost</th><th className="text-right">Depreciation</th><th className="text-right">Impairment</th><th className="text-right">Net book value</th></tr></thead>
          <tbody>{data.rows.map((r) => <tr key={r.asset} className="border-t border-slate-100"><td>{r.asset} {r.name}</td><td>{r.category}</td><td className="text-right">{formatMoney(r.gross_value)}</td><td className="text-right">{formatMoney(r.accumulated_depreciation)}</td><td className="text-right">{formatMoney(r.impairment)}</td><td className="text-right">{formatMoney(r.net_book_value)}</td></tr>)}
            <tr className="border-t border-slate-300 font-semibold"><td colSpan={2}>Total</td><td className="text-right">{formatMoney(data.totals.gross_value)}</td><td className="text-right">{formatMoney(data.totals.accumulated_depreciation)}</td><td className="text-right">{formatMoney(data.totals.impairment)}</td><td className="text-right">{formatMoney(data.totals.net_book_value)}</td></tr></tbody></table>
      )}
    </Card>
  );
}

function ReconciliationCard() {
  const { data, isLoading, error, refetch } = useGetAssetReconciliationQuery();
  return (
    <Card title="Register vs ledger">
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : data && (
        <>
          <p className="mb-2">{data.reconciled ? <Badge tone="green">Reconciled</Badge> : <Badge tone="red">Does not reconcile</Badge>}</p>
          <table className="w-full text-sm"><caption className="sr-only">Reconciliation</caption><thead><tr className="text-left"><th></th><th className="text-right">Register</th><th className="text-right">Ledger</th><th className="text-right">Difference</th></tr></thead>
            <tbody><tr><td>Cost</td><td className="text-right">{formatMoney(data.register_cost)}</td><td className="text-right">{formatMoney(data.ledger_cost)}</td><td className="text-right">{formatMoney(data.cost_difference)}</td></tr>
              <tr><td>Accumulated depreciation</td><td className="text-right">{formatMoney(data.register_accumulated)}</td><td className="text-right">{formatMoney(data.ledger_accumulated)}</td><td className="text-right">{formatMoney(data.accumulated_difference)}</td></tr></tbody></table>
        </>
      )}
    </Card>
  );
}

function Adjustments() {
  const { can } = useAccess();
  const [status, setStatus] = useState("REQUESTED");
  const { data, isLoading, error, refetch } = useListValueAdjustmentsQuery(status || undefined);
  const [decide] = useDecideValueAdjustmentMutation();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Value adjustments">
      <label className="mb-2 block text-sm">Status <select aria-label="Adjustment status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["REQUESTED", "APPROVED", "REJECTED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No adjustments" /> : (
        <ul>{data.results.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2 text-sm">
            <span className="min-w-40 flex-1">{a.asset} · {pretty(a.kind)} {formatMoney(a.amount)} from {a.effective_date}{a.extend_life_months ? `, +${a.extend_life_months} months` : ""} — {a.reason}</span>
            <Badge tone={a.status === "APPROVED" ? "green" : a.status === "REJECTED" ? "red" : "amber"}>{pretty(a.status)}</Badge>{a.decision_note && <span className="text-slate-500">{a.decision_note}</span>}
            {a.status === "REQUESTED" && can("assets.valuation.approve") && <><Button onClick={async () => { setErr(null); try { await decide({ id: a.id, action: "approve" }).unwrap(); } catch (e) { setErr(failure(e)); } }}>{`Approve ${a.asset} ${pretty(a.kind)}`}</Button><Button variant="secondary" onClick={() => setRejecting(a.id)}>{`Reject ${a.asset} ${pretty(a.kind)}`}</Button></>}
          </li>))}</ul>
      )}
      <ActionDialog title="Reject adjustment" open={!!rejecting} onClose={() => setRejecting(null)} cta="Reject" fields={[{ name: "note", label: "Reason", required: true }]} submit={(v) => decide({ id: rejecting!, action: "reject", note: (v.note ?? "").trim() }).unwrap()} />
    </Card>
  );
}

export function DepreciationPage() {
  return (
    <>
      <PageHeader title="Depreciation and valuation" description="Monthly runs, net book value, value adjustments and the check against the ledger." />
      <div className="grid gap-4"><Runs /><ReconciliationCard /><ValuationCard /><Adjustments /></div>
    </>
  );
}

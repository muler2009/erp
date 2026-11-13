import { useState } from "react";

import { useCreateComponentMutation, useGetTaxBracketsQuery, useListComponentsQuery, useSetTaxBracketsMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { TaxBracket } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "./ActionDialog";
import { pretty } from "./EmployeeDialogs";

/** Brackets must start at 0, rise strictly, and have rates from 0 to 100 (the server checks the same). */
export function validateBrackets(rows: TaxBracket[]): string | null {
  if (rows.length === 0) return "Add at least one bracket.";
  let prev: bigint | null = null;
  for (const [i, r] of rows.entries()) {
    const lb = parseMoney(r.lower_bound), rate = parseMoney(r.rate);
    if (lb === null || rate === null) return `Row ${i + 1}: enter numbers.`;
    if (i === 0 && lb !== 0n) return "The first bracket must start at 0.";
    if (prev !== null && lb <= prev) return `Row ${i + 1}: lower bounds must rise.`;
    if (rate < 0n || rate > 1000000n) return `Row ${i + 1}: the rate must be between 0 and 100.`;
    prev = lb;
  }
  return null;
}

function Components() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListComponentsQuery();
  const [create] = useCreateComponentMutation();
  const [open, setOpen] = useState(false);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  return (
    <Card title="Allowances and deductions">
      {can("hr.compensation.manage") && <div className="mb-3"><Button onClick={() => setOpen(true)}>New component</Button></div>}
      {data!.length === 0 ? <EmptyState title="No components yet" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Name</th><th>Kind</th><th>Calculation</th><th className="text-right">Value</th><th>Taxable</th></tr></thead>
          <tbody>{data!.map((c) => <tr key={c.id} className="border-t border-slate-100"><td>{c.code}</td><td>{c.name}</td><td>{pretty(c.kind)}</td><td>{pretty(c.calc)}</td><td className="text-right">{formatMoney(c.value)}{c.calc === "PERCENT_OF_BASIC" ? "%" : ""}</td><td>{c.taxable ? <Badge tone="amber">Taxable</Badge> : "No"}</td></tr>)}</tbody></table>
      )}
      <ActionDialog title="New pay component" open={open} onClose={() => setOpen(false)} cta="Create"
        fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "kind", label: "Kind", options: [["ALLOWANCE", "Allowance"], ["DEDUCTION", "Deduction"]], required: true }, { name: "calc", label: "Calculation", options: [["FIXED", "Fixed amount"], ["PERCENT_OF_BASIC", "Percent of basic"]], required: true }, { name: "value", label: "Value", required: true }, { name: "taxable", label: "Taxable", options: [["yes", "Taxable"], ["no", "Not taxable"]], required: true }]}
        submit={async (v) => { const n = parseMoney(v.value!); if (n === null || n < 0n) throw new Error("Value must be a number of 0 or more."); return create({ code: v.code!.trim().toUpperCase(), name: v.name!.trim(), kind: v.kind!, calc: v.calc!, value: v.value!.trim(), taxable: v.taxable === "yes" }).unwrap(); }} />
    </Card>
  );
}

function Brackets() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useGetTaxBracketsQuery();
  const [save, state] = useSetTaxBracketsMutation();
  const [rows, setRows] = useState<TaxBracket[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const edit = can("hr.compensation.manage");
  const cur = rows ?? data!;
  const set = (i: number, p: Partial<TaxBracket>) => { setSaved(false); setRows(cur.map((r, j) => (j === i ? { ...r, ...p } : r))); };
  const go = async () => {
    const problem = validateBrackets(cur);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await save(cur.map((r) => ({ lower_bound: r.lower_bound.trim(), rate: r.rate.trim() }))).unwrap(); setRows(null); setSaved(true); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="Income tax brackets (monthly taxable income, rate in %)">
      {cur.map((r, i) => (
        <div key={i} className="mb-2 flex items-center gap-2 text-sm">
          <span>From</span><input aria-label={`Bracket ${i + 1} from`} disabled={!edit} inputMode="decimal" className={`${inputClass} w-32 text-right`} value={r.lower_bound} onChange={(e) => set(i, { lower_bound: e.target.value })} />
          <span>rate</span><input aria-label={`Bracket ${i + 1} rate`} disabled={!edit} inputMode="decimal" className={`${inputClass} w-24 text-right`} value={r.rate} onChange={(e) => set(i, { rate: e.target.value })} /><span>%</span>
          {edit && cur.length > 1 && <Button variant="secondary" aria-label={`Remove bracket ${i + 1}`} onClick={() => { setSaved(false); setRows(cur.filter((_, j) => j !== i)); }}>×</Button>}
        </div>
      ))}
      {edit && <div className="mt-2 flex gap-2"><Button variant="secondary" onClick={() => { setSaved(false); setRows([...cur, { lower_bound: "", rate: "" }]); }}>Add bracket</Button><Button loading={state.isLoading} onClick={() => void go()}>Save brackets</Button></div>}
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
      {saved && <p role="status" className="mt-2 text-sm text-green-700">Brackets saved. They apply to payroll runs calculated from now on.</p>}
    </Card>
  );
}

export function PaySetupPage() {
  const [tab, setTab] = useState<"components" | "brackets">("components");
  return (
    <>
      <PageHeader title="Pay setup" description="Allowance and deduction components, and income tax brackets." />
      <div role="tablist" className="mb-4 flex gap-2 border-b border-slate-200">
        {([["components", "Components"], ["brackets", "Tax brackets"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-indigo-600 font-medium" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "components" ? <Components /> : <Brackets />}
    </>
  );
}

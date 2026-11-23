import { useState } from "react";

import { useAssignCommissionPlanMutation, useCalculateCommissionMutation, useCommissionActionMutation, useCreateCommissionPlanMutation, useGetAttainmentQuery, useGetTeamAttainmentQuery, useListCommissionPlansQuery, useListCommissionStatementsQuery, useSetSalesTargetMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { CommissionPlanRow, CommissionStatementRow, CommissionTier } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames, useUserOptions } from "../quality/names";

const DEC = /^\d+(\.\d{1,4})?$/;
export const STATEMENT_STATUS: Record<CommissionStatementRow["status"], { label: string; tone: "green" | "amber" | "slate" | "red" }> = { DRAFT: { label: "Draft", tone: "amber" }, APPROVED: { label: "Approved", tone: "green" }, TRANSFERRED: { label: "Sent to payroll", tone: "green" }, CANCELLED: { label: "Cancelled", tone: "slate" } };

export const monthRange = (today = new Date()): { from: string; to: string } => {
  const f = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1)), t = new Date(Date.UTC(today.getFullYear(), today.getMonth() + 1, 0));
  return { from: f.toISOString().slice(0, 10), to: t.toISOString().slice(0, 10) };
};

/** "0:2" per line: sales from this amount upwards earn this percentage. */
export function parseTiers(text: string): { tiers: CommissionTier[] } | { problem: string } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { problem: "Add at least one tier." };
  const tiers: CommissionTier[] = [];
  let last = -1;
  for (const l of lines) {
    const [from = "", rate = "", ...rest] = l.split(":").map((x) => x.trim());
    if (rest.length || !DEC.test(from) || !DEC.test(rate)) return { problem: `"${l}" should look like 10000:3 (sales from this amount earn this percent).` };
    if (Number(rate) > 100) return { problem: `"${l}": a rate cannot be more than 100%.` };
    if (Number(from) <= last) return { problem: "Each tier must start at a higher amount than the one before." };
    last = Number(from);
    tiers.push({ from, rate });
  }
  return Number(tiers[0]?.from) === 0 ? { tiers } : { problem: "The first tier must start at 0." };
}

/** "Category:rate" per line; blank is fine. */
export function parseCategoryRates(text: string): { rates: Record<string, string> } | { problem: string } {
  const rates: Record<string, string> = {};
  for (const l of text.split("\n").map((x) => x.trim()).filter(Boolean)) {
    const i = l.lastIndexOf(":");
    const name = l.slice(0, i).trim(), rate = l.slice(i + 1).trim();
    if (i < 1 || !name || !DEC.test(rate) || Number(rate) > 100) return { problem: `"${l}" should look like Accessories:5.` };
    if (name in rates) return { problem: `"${name}" is listed twice.` };
    rates[name] = rate;
  }
  return { rates };
}

function Range({ range, setRange, id }: { range: { from: string; to: string }; setRange: (r: { from: string; to: string }) => void; id: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-3">
      <FormField label="From" htmlFor={`${id}-from`}><input id={`${id}-from`} type="date" className={inputClass} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></FormField>
      <FormField label="To" htmlFor={`${id}-to`}><input id={`${id}-to`} type="date" className={inputClass} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></FormField>
    </div>
  );
}
const rangeBad = (r: { from: string; to: string }) => !r.from || !r.to || r.to < r.from;
const BAD = <p role="alert" className="text-sm text-red-700">Choose a start date and an end date that is not before it.</p>;

function Results() {
  const [range, setRange] = useState(monthRange());
  const bad = rangeBad(range);
  const { data, isFetching, error, refetch } = useGetAttainmentQuery(range, { skip: bad });
  return (
    <Card title="My results">
      <Range range={range} setRange={setRange} id="mr" />
      {bad ? BAD : isFetching && !data ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div><dt className="text-xs text-slate-500">Net sales</dt><dd className="text-lg">{formatMoney(data.net_sales)}</dd></div>
          <div><dt className="text-xs text-slate-500">Target</dt><dd className="text-lg">{data.target ? formatMoney(data.target) : "None set"}</dd></div>
          <div><dt className="text-xs text-slate-500">Reached</dt><dd className="text-lg">{data.attainment_percent === null ? "–" : `${data.attainment_percent}%`}</dd></div>
          <div><dt className="text-xs text-slate-500">Still to go</dt><dd className="text-lg">{data.remaining === null ? "–" : formatMoney(data.remaining)}</dd></div>
        </dl>
      )}
    </Card>
  );
}

function Team() {
  const [range, setRange] = useState(monthRange());
  const bad = rangeBad(range);
  const { data, isFetching, error, refetch } = useGetTeamAttainmentQuery(range, { skip: bad });
  const [setTarget] = useSetSalesTargetMutation();
  const nameOf = useUserNames();
  const people = useUserOptions(false);
  const [open, setOpen] = useState(false);
  return (
    <Card title="Team against target" actions={<Button onClick={() => setOpen(true)} disabled={bad}>Set a target</Button>}>
      <Range range={range} setRange={setRange} id="tm" />
      {bad ? BAD : isFetching && !data ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : !data.length ? <EmptyState title="No targets set for this period" hint="Use “Set a target” for each salesperson." /> : (
        <table className="min-w-full text-sm"><caption className="sr-only">Team attainment</caption><thead><tr className="text-left text-slate-500"><th className="py-1">Salesperson</th><th className="text-right">Net sales</th><th className="text-right">Target</th><th className="text-right">Reached</th><th className="text-right">Still to go</th></tr></thead>
          <tbody>{data.map((r) => <tr key={r.owner_id} className="border-t border-slate-100"><td className="py-1">{nameOf(r.owner_id)}</td><td className="text-right">{formatMoney(r.net_sales)}</td><td className="text-right">{r.target ? formatMoney(r.target) : "–"}</td><td className="text-right">{r.attainment_percent === null ? "–" : `${r.attainment_percent}%`}</td><td className="text-right">{r.remaining ? formatMoney(r.remaining) : "–"}</td></tr>)}</tbody></table>
      )}
      {open && (
        <ActionDialog title="Set a target" cta="Save target" open onClose={() => setOpen(false)} fields={[{ name: "owner_id", label: "Salesperson", required: true, options: people }, { name: "amount", label: "Target (net sales)", required: true }]}
          submit={async (v) => { if (!DEC.test((v.amount ?? "").trim()) || Number(v.amount) <= 0) throw new Error("The target must be a number above zero."); await setTarget({ owner_id: v.owner_id!, period_start: range.from, period_end: range.to, amount: v.amount!.trim() }).unwrap(); }} />
      )}
    </Card>
  );
}

function Plans() {
  const { data, isLoading, error, refetch } = useListCommissionPlansQuery();
  const [create] = useCreateCommissionPlanMutation();
  const [assign] = useAssignCommissionPlanMutation();
  const people = useUserOptions(false);
  const [dlg, setDlg] = useState<"new" | "assign" | null>(null);
  const [editing, setEditing] = useState<CommissionPlanRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const toggle = (p: CommissionPlanRow) => { setErr(null); create({ name: p.name, tiers: p.tiers, category_rates: p.category_rates, is_active: !p.is_active }).unwrap().catch((e) => setErr(errorMessage(e))); };
  return (
    <Card title="Commission plans" actions={<div className="flex gap-2"><Button variant="secondary" onClick={() => setDlg("assign")}>Give someone a plan</Button><Button onClick={() => setDlg("new")}>New plan</Button></div>}>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No commission plans yet" /> : (
        <ul className="space-y-3 text-sm">{data.map((p) => (
          <li key={p.id} className="rounded border border-slate-200 p-3"><p className="font-medium">{p.name} {!p.is_active && <Badge tone="slate">Inactive</Badge>}</p>
            <p className="text-slate-600">{p.tiers.map((t, i) => { const next = p.tiers[i + 1]; return `${formatMoney(t.from)}${next ? ` to ${formatMoney(next.from)}` : " and above"}: ${Number(t.rate)}%`; }).join(" · ")}</p>
            {Object.keys(p.category_rates).length > 0 && <p className="text-slate-600">Special rates: {Object.entries(p.category_rates).map(([k, v]) => `${k} ${Number(v)}%`).join(", ")}</p>}
            <div className="mt-2 flex gap-2"><Button variant="secondary" onClick={() => setEditing(p)}>{`Edit ${p.name}`}</Button><Button variant="secondary" onClick={() => toggle(p)}>{`${p.is_active ? "Deactivate" : "Activate"} ${p.name}`}</Button></div></li>))}</ul>
      )}
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
      {editing && (
        <ActionDialog title={`Edit plan: ${editing.name}`} cta="Save plan" open onClose={() => setEditing(null)}
          initial={{ tiers: editing.tiers.map((t) => `${Number(t.from)}:${Number(t.rate)}`).join("\n"), cats: Object.entries(editing.category_rates).map(([k, v]) => `${k}:${Number(v)}`).join("\n") }}
          fields={[{ name: "tiers", label: "Tiers — one per line as “sales from:percent”", required: true, type: "textarea" }, { name: "cats", label: "Special rates by product category — one per line as “Category:percent” (optional)", type: "textarea" }]}
          submit={async (v) => {
            const t = parseTiers(v.tiers ?? ""); if ("problem" in t) throw new Error(t.problem);
            const c = parseCategoryRates(v.cats ?? ""); if ("problem" in c) throw new Error(c.problem);
            await create({ name: editing.name, tiers: t.tiers, category_rates: c.rates, is_active: editing.is_active }).unwrap();
          }} />
      )}
      {dlg === "new" && (
        <ActionDialog title="New commission plan" cta="Create plan" open onClose={() => setDlg(null)}
          fields={[{ name: "name", label: "Name", required: true }, { name: "tiers", label: "Tiers — one per line as “sales from:percent”, e.g. 0:2 then 50000:3", required: true, type: "textarea" }, { name: "cats", label: "Special rates by product category — one per line as “Category:percent” (optional)", type: "textarea" }]}
          initial={{ tiers: "0:2" }}
          submit={async (v) => {
            const t = parseTiers(v.tiers ?? ""); if ("problem" in t) throw new Error(t.problem);
            const c = parseCategoryRates(v.cats ?? ""); if ("problem" in c) throw new Error(c.problem);
            if ((data ?? []).some((x) => x.name.toLowerCase() === v.name!.trim().toLowerCase())) throw new Error("A plan with this name already exists. Use Edit on that plan instead.");
            await create({ name: v.name!.trim(), tiers: t.tiers, category_rates: c.rates, is_active: true }).unwrap();
          }} />
      )}
      {dlg === "assign" && (
        <ActionDialog title="Give someone a plan" cta="Assign plan" open onClose={() => setDlg(null)} fields={[{ name: "owner_id", label: "Salesperson", required: true, options: people }, { name: "plan", label: "Plan", required: true, options: (data ?? []).filter((p) => p.is_active).map((p) => [p.id, p.name] as [string, string]) }]}
          submit={async (v) => { await assign({ owner_id: v.owner_id!, plan: v.plan! }).unwrap(); }} />
      )}
    </Card>
  );
}

function StatementDetail({ s, canManage, onClose }: { s: CommissionStatementRow; canManage: boolean; onClose: () => void }) {
  const [act] = useCommissionActionMutation();
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = (action: "approve" | "cancel") => { setErr(null); act({ id: s.id, action }).unwrap().then(onClose).catch((e) => setErr(errorMessage(e))); };
  return (
    <Modal title={`Commission for ${nameOf(s.owner_id)}`} open onClose={onClose}>
      <p className="mb-2 text-sm">{s.period_start} to {s.period_end} · plan {s.plan} · <Badge tone={STATEMENT_STATUS[s.status].tone}>{STATEMENT_STATUS[s.status].label}</Badge></p>
      <dl className="mb-3 grid grid-cols-3 gap-3 text-sm"><div><dt className="text-xs text-slate-500">Sales</dt><dd>{formatMoney(s.sales_amount)}</dd></div><div><dt className="text-xs text-slate-500">Returns</dt><dd>{formatMoney(s.returns_amount)}</dd></div><div><dt className="text-xs text-slate-500">Commission</dt><dd className="text-lg">{formatMoney(s.commission)}</dd></div></dl>
      <table className="mb-3 w-full text-sm"><caption className="sr-only">How it was worked out</caption><thead><tr className="text-left text-slate-500"><th>Part</th><th className="text-right">Net sales</th><th className="text-right">Rate</th><th className="text-right">Commission</th></tr></thead>
        <tbody>{Object.entries(s.details).map(([k, d]) => <tr key={k} className="border-t border-slate-100"><td className="py-1">{k === "_tiered" ? "Sales on the tiers" : k}</td><td className="text-right">{formatMoney(d.net)}</td><td className="text-right">{d.rate ? `${Number(d.rate)}%` : "tiers"}</td><td className="text-right">{formatMoney(d.commission)}</td></tr>)}</tbody></table>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {canManage && s.status === "DRAFT" && <><Button onClick={() => run("approve")}>Approve</Button><Button variant="danger" onClick={() => run("cancel")}>Cancel statement</Button></>}
        {canManage && s.status === "APPROVED" && <Button onClick={() => setDlg(true)}>Send to payroll</Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
      {dlg && <ActionDialog title="Send to payroll" cta="Send to payroll" open onClose={() => setDlg(false)} fields={[{ name: "month", label: "Pay in month starting (blank = month after the period)", type: "date" }]} submit={async (v) => { await act({ id: s.id, action: "transfer", month: v.month || undefined }).unwrap(); onClose(); }} />}
    </Modal>
  );
}

function Statements({ canManage }: { canManage: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListCommissionStatementsQuery({ cursor });
  const [calc] = useCalculateCommissionMutation();
  const nameOf = useUserNames();
  const people = useUserOptions(!canManage);
  const [openId, setOpenId] = useState<string | null>(null);
  const [calcOpen, setCalcOpen] = useState(false);
  const open = data?.results.find((s) => s.id === openId) ?? null;
  const r = monthRange();
  return (
    <Card title="Commission statements" actions={canManage ? <Button onClick={() => setCalcOpen(true)}>Work out a statement</Button> : undefined}>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No statements yet" /> : (
        <>
          <table className="min-w-full text-sm"><caption className="sr-only">Statements</caption><thead><tr className="text-left text-slate-500"><th className="py-1">Salesperson</th><th>Period</th><th className="text-right">Commission</th><th>Status</th></tr></thead>
            <tbody>{data.results.map((s) => <tr key={s.id} className="border-t border-slate-100"><td className="py-1"><button type="button" className="text-indigo-700 underline" onClick={() => setOpenId(s.id)}>{nameOf(s.owner_id)}</button></td><td>{s.period_start} to {s.period_end}</td><td className="text-right">{formatMoney(s.commission)}</td><td><Badge tone={STATEMENT_STATUS[s.status].tone}>{STATEMENT_STATUS[s.status].label}</Badge></td></tr>)}</tbody></table>
          <div className="mt-2 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{data.next && <Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button>}</div>
        </>
      )}
      {open && <StatementDetail s={open} canManage={canManage} onClose={() => setOpenId(null)} />}
      {calcOpen && (
        <ActionDialog title="Work out a statement" cta="Work out" open onClose={() => setCalcOpen(false)} initial={{ period_start: r.from, period_end: r.to }}
          fields={[{ name: "owner_id", label: "Salesperson", required: true, options: people }, { name: "period_start", label: "From", type: "date", required: true }, { name: "period_end", label: "To", type: "date", required: true }]}
          submit={async (v) => { if (v.period_end! < v.period_start!) throw new Error("The end date cannot be before the start date."); await calc({ owner_id: v.owner_id!, period_start: v.period_start!, period_end: v.period_end! }).unwrap(); }} />
      )}
    </Card>
  );
}

const TABS = ["My results", "Team", "Plans", "Statements"] as const;
export function CommissionsPage() {
  const { can } = useAccess();
  const manage = can("crm.assign");
  const tabs = TABS.filter((t) => manage || t === "My results" || t === "Statements");
  const [tab, setTab] = useState<(typeof TABS)[number]>("My results");
  return (
    <>
      <PageHeader title="Targets and commission" description="Sales against target and what has been earned." />
      <div role="tablist" aria-label="Targets and commission" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map((t) => <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)} className={`px-3 py-2 text-sm ${t === tab ? "border-b-2 border-indigo-600 font-medium text-indigo-700" : "text-slate-600 hover:text-slate-900"}`}>{t}</button>)}
      </div>
      {tab === "My results" && <Results />}{tab === "Team" && manage && <Team />}{tab === "Plans" && manage && <Plans />}{tab === "Statements" && <Statements canManage={manage} />}
    </>
  );
}

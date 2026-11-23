import { useState } from "react";

import { useGetAccountCreditQuery, useGetAccountStatementQuery, useListCrmAccountsQuery } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export function statementProblem(account: string, from: string, to: string): string | null {
  if (!account) return "Choose a customer.";
  if (!from || !to) return "Choose both dates.";
  return from > to ? "The start date is after the end date." : null;
}

const CREDIT_TONE: Record<string, "green" | "red" | "amber" | "slate"> = { OK: "green", ON_HOLD: "red", BLOCKED: "red", WARNING: "amber" };

function Credit({ id }: { id: string }) {
  const q = useGetAccountCreditQuery(id);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (!q.data) return null;
  const c = q.data;
  return (
    <Card title="Credit position" actions={<Badge tone={CREDIT_TONE[c.credit_status] ?? "slate"}>{c.credit_status.replace(/_/g, " ").toLowerCase()}</Badge>}>
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
        <div><dt className="text-xs text-slate-500">Credit limit</dt><dd>{c.credit_limit !== null ? formatMoney(c.credit_limit) : "No limit"}</dd></div>
        <div><dt className="text-xs text-slate-500">Owed to us</dt><dd>{formatMoney(c.receivables)}</dd></div>
        <div><dt className="text-xs text-slate-500">Open orders</dt><dd>{formatMoney(c.open_orders)}</dd></div>
        <div><dt className="text-xs text-slate-500">Total exposure</dt><dd>{formatMoney(c.exposure)}</dd></div>
        <div><dt className="text-xs text-slate-500">Still available</dt><dd>{c.available_credit !== null ? formatMoney(c.available_credit) : "—"}</dd></div>
      </dl>
    </Card>
  );
}

export function CustomerStatementPage() {
  const accounts = useListCrmAccountsQuery({});
  const today = new Date().toISOString().slice(0, 10);
  const [account, setAccount] = useState("");
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [currency, setCurrency] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [args, setArgs] = useState<{ id: string; from: string; to: string; currency?: string } | null>(null);
  const q = useGetAccountStatementQuery(args ?? { id: "", from: "", to: "" }, { skip: !args });
  const show = () => {
    const p = statementProblem(account, from, to);
    setProblem(p);
    if (!p) setArgs({ id: account, from, to, ...(currency.trim() ? { currency: currency.trim().toUpperCase() } : {}) });
  };
  return (
    <>
      <PageHeader title="Customer statements" description="What a customer was invoiced, credited and paid over a period, and how much credit is left." />
      <Card title="Choose a customer">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Customer" htmlFor="st-acct"><select id="st-acct" className={inputClass} value={account} onChange={(e) => { setAccount(e.target.value); setArgs(null); }}><option value="">Choose…</option>{(accounts.data?.results ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></FormField>
          <FormField label="From" htmlFor="st-from"><input id="st-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label="To" htmlFor="st-to"><input id="st-to" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
          <FormField label="Currency (optional)" htmlFor="st-cur"><input id="st-cur" maxLength={3} className={`${inputClass} w-24`} value={currency} onChange={(e) => setCurrency(e.target.value)} /></FormField>
          <Button className="mb-3" onClick={show} loading={q.isFetching}>Show statement</Button>
        </div>
        {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
      </Card>
      {args && <Credit id={args.id} />}
      {args && (
        <Card title={q.data ? `Statement for ${q.data.customer} (${q.data.currency})` : "Statement"}>
          {q.isFetching && <Spinner />}
          {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
          {q.data && !q.isFetching && (
            <>
              <p className="mb-2 text-sm">Opening balance {formatMoney(q.data.opening_balance)}</p>
              {q.data.lines.length === 0 ? <EmptyState title="No activity in this period" /> : (
                <table className="w-full text-sm"><caption className="sr-only">Statement lines</caption>
                  <thead><tr className="text-left text-slate-500"><th>Date</th><th>Type</th><th>Reference</th><th className="text-right">Amount</th><th className="text-right">Balance</th><th>Due</th></tr></thead>
                  <tbody>{q.data.lines.map((l, i) => <tr key={i} className="border-t border-slate-100"><td>{l.date}</td><td>{l.type.replace(/_/g, " ").toLowerCase()}</td><td>{l.reference}</td><td className="text-right">{formatMoney(l.amount)}</td><td className="text-right">{formatMoney(l.balance)}</td><td>{l.due ?? ""}</td></tr>)}</tbody></table>
              )}
              <p className="mt-2 text-sm font-semibold">Closing balance {formatMoney(q.data.closing_balance)}</p>
            </>
          )}
        </Card>
      )}
    </>
  );
}

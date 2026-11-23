import { useState } from "react";

import { useGetAccountDetailQuery, useGetLedgerQuery, useListAccountsQuery, useUpdateAccountMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney } from "../../shared/lib/money";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export function AccountEditDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useGetAccountDetailQuery(id);
  const [update, { isLoading }] = useUpdateAccountMutation();
  const [name, setName] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const a = q.data;
  const run = async (body: { name?: string; is_active?: boolean }, done: string) => {
    setErr(null); setOk(null);
    try { await update({ id, ...body }).unwrap(); setName(null); setOk(done); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={a ? `Account ${a.code}` : "Account"} open onClose={onClose}>
      {q.isLoading ? <Spinner /> : q.error || !a ? <ErrorState error={q.error} onRetry={q.refetch} /> : (
        <>
          <p className="mb-3 text-sm text-slate-600">{a.type.toLowerCase()} account, {a.is_postable ? "postable" : "header"}. Balance {formatMoney(a.balance)}. <Badge tone={a.is_active ? "green" : "slate"}>{a.is_active ? "Active" : "Inactive"}</Badge></p>
          <FormField label="Name" htmlFor="ae-name"><input id="ae-name" className={inputClass} value={name ?? a.name} onChange={(e) => setName(e.target.value)} /></FormField>
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          {ok && <p role="status" className="mb-2 text-sm text-green-700">{ok}</p>}
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant={a.is_active ? "danger" : "secondary"} loading={isLoading} onClick={() => void run({ is_active: !a.is_active }, a.is_active ? "Account deactivated." : "Account reactivated.")}>{a.is_active ? "Deactivate account" : "Reactivate account"}</Button>
            <div className="flex gap-2"><Button variant="secondary" onClick={onClose}>Close</Button>
              <Button loading={isLoading} disabled={name === null || name.trim() === "" || name.trim() === a.name} onClick={() => void run({ name: (name ?? "").trim() }, "Name saved.")}>Save name</Button></div>
          </div>
          <p className="mt-2 text-xs text-slate-500">System and control accounts, and accounts with a balance, cannot be deactivated.</p>
        </>
      )}
    </Modal>
  );
}

export function ledgerProblem(account: string, from: string, to: string): string | null {
  if (!account.trim()) return "Enter an account code.";
  return from && to && from > to ? "The start date is after the end date." : null;
}

export function LedgerPage() {
  const accounts = useListAccountsQuery();
  const [code, setCode] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [args, setArgs] = useState<{ account: string; from?: string; to?: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const q = useGetLedgerQuery(args ?? { account: "" }, { skip: !args });
  const show = () => {
    const p = ledgerProblem(code, from, to);
    setProblem(p);
    if (!p) setArgs({ account: code.trim(), ...(from ? { from } : {}), ...(to ? { to } : {}) });
  };
  return (
    <>
      <PageHeader title="General ledger" description="Every posted line on one account, with a running balance." />
      <Card title="Choose an account">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Account code" htmlFor="gl-code"><input id="gl-code" list="gl-codes" className={inputClass} value={code} onChange={(e) => { setCode(e.target.value); setArgs(null); }} /></FormField>
          <datalist id="gl-codes">{(accounts.data?.results ?? []).filter((a) => a.is_postable).map((a) => <option key={a.id} value={a.code}>{a.name}</option>)}</datalist>
          <FormField label="From (optional)" htmlFor="gl-from"><input id="gl-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label="To (optional)" htmlFor="gl-to"><input id="gl-to" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
          <Button className="mb-3" loading={q.isFetching} onClick={show}>Show ledger</Button>
        </div>
        {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
      </Card>
      {args && (q.isFetching ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : q.data && (
        <Card title={`${q.data.account} — ${q.data.name}`}>
          <p className="mb-2 text-sm">Opening balance {formatMoney(q.data.opening_balance)}</p>
          {q.data.rows.length === 0 ? <EmptyState title="No postings in this period" /> : (
            <table className="w-full text-sm"><caption className="sr-only">Ledger lines</caption>
              <thead><tr className="text-left text-slate-500"><th>Date</th><th>Entry</th><th>Description</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Balance</th></tr></thead>
              <tbody>{q.data.rows.map((r, i) => <tr key={i} className="border-t border-slate-100"><td>{r.date}</td><td>{r.entry}</td><td>{r.description}</td><td className="text-right">{Number(r.debit) ? formatMoney(r.debit) : ""}</td><td className="text-right">{Number(r.credit) ? formatMoney(r.credit) : ""}</td><td className="text-right">{formatMoney(r.balance)}</td></tr>)}</tbody></table>
          )}
          <p className="mt-2 text-sm font-semibold">Closing balance {formatMoney(q.data.closing_balance)}</p>
        </Card>
      ))}
    </>
  );
}

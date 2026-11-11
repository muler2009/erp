import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link, useParams } from "react-router";

import { useGetBankStatementQuery, useListBankStatementsQuery, useListStatementCandidatesQuery, useMatchBankLineMutation, useReconcileStatementMutation, useUnmatchBankLineMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { BankStatement, BankStatementLine } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, Card, ErrorState, Modal, PageHeader, Spinner } from "../../shared/ui/primitives";
import { NewStatementDialog } from "./NewStatementDialog";

const columns: ColumnDef<BankStatement>[] = [
  { header: "Statement", cell: ({ row }) => <Link className="text-indigo-700 underline" to={`/app/finance/reconciliation/${row.original.id}`}>{row.original.bank_account_name} · {row.original.statement_date}</Link> },
  { header: "Closing balance", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.closing_balance)} {row.original.currency}</span> },
  { header: "Status", cell: ({ row }) => <Badge tone={row.original.status === "RECONCILED" ? "green" : "amber"}>{row.original.status === "RECONCILED" ? "Reconciled" : "Open"}</Badge> },
];

export function StatementsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListBankStatementsQuery({ cursor });
  return (
    <>
      <PageHeader title="Bank reconciliation" description="Match each bank statement line to a posted ledger line, then reconcile the statement." actions={can("finance.bank.reconcile") ? <Button onClick={() => setCreating(true)}>New statement</Button> : undefined} />
      <DataTable caption="Bank statements" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No bank statements yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <NewStatementDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function MatchDialog({ statementId, line, open, onClose }: { statementId: string; line: BankStatementLine; open: boolean; onClose: () => void }) {
  const { data, isFetching, error } = useListStatementCandidatesQuery({ id: statementId, amount: line.amount }, { skip: !open });
  const [match, state] = useMatchBankLineMutation();
  const [err, setErr] = useState<string | null>(null);
  const pick = async (journalLine: string) => {
    setErr(null);
    try { await match({ id: statementId, lineId: line.id, journalLine }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Match line ${line.line_no}`} open={open} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">{line.date} · {line.description || "No description"} · {formatMoney(line.amount)}</p>
      {isFetching && <Spinner />}
      {error && <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>}
      {data && data.results.length === 0 && <p className="text-sm text-slate-600">No unmatched ledger lines with exactly this amount. Check that the receipt or payment has been posted.</p>}
      <ul className="divide-y divide-slate-100">
        {data?.results.map((c) => (
          <li key={c.id} className="flex items-center justify-between py-2 text-sm">
            <span>{c.entry} · {c.date} · {c.description}</span>
            <Button loading={state.isLoading} onClick={() => void pick(c.id)} aria-label={`Match ${c.entry}`}>Match</Button>
          </li>
        ))}
      </ul>
      {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
    </Modal>
  );
}

export function StatementPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error, refetch } = useGetBankStatementQuery(id, { skip: !id });
  const [unmatch] = useUnmatchBankLineMutation();
  const [reconcile, rState] = useReconcileStatementMutation();
  const [matching, setMatching] = useState<BankStatementLine | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const canWork = can("finance.bank.reconcile");

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const lines = data.lines ?? [];
  const open = data.status === "OPEN";
  const unmatched = lines.filter((l) => !l.matched).length;
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <>
      <PageHeader title={`${data.bank_account_name} · ${data.statement_date}`} description={`Opening ${formatMoney(data.opening_balance)} · closing ${formatMoney(data.closing_balance)} ${data.currency}`} actions={<Link className="text-sm text-indigo-700 underline" to="/app/finance/reconciliation">All statements</Link>} />
      <Card>
        <p className="mb-3 text-sm">{open ? <Badge tone="amber">Open</Badge> : <Badge tone="green">Reconciled</Badge>} <span className="ml-2">{lines.length - unmatched} of {lines.length} lines matched</span></p>
        <table className="min-w-full text-sm">
          <caption className="sr-only">Statement lines</caption>
          <thead><tr><th scope="col" className="px-2 py-1 text-left">Date</th><th scope="col" className="px-2 py-1 text-left">Description</th><th scope="col" className="px-2 py-1 text-right">Amount</th><th scope="col" className="px-2 py-1 text-left">Ledger entry</th><th scope="col" className="px-2 py-1" /></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-2 py-1">{l.date}</td><td className="px-2 py-1">{l.description}</td>
                <td className="px-2 py-1 text-right">{formatMoney(l.amount)}</td>
                <td className="px-2 py-1">{l.ledger_entry ?? <span className="text-slate-500">Not matched</span>}</td>
                <td className="px-2 py-1 text-right">
                  {open && canWork && (l.matched
                    ? <Button variant="secondary" aria-label={`Unmatch line ${l.line_no}`} onClick={() => void run(() => unmatch({ id, lineId: l.id }).unwrap())}>Unmatch</Button>
                    : <Button variant="secondary" aria-label={`Match line ${l.line_no}`} onClick={() => setMatching(l)}>Match…</Button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
        {open && canWork && (
          <div className="mt-4 flex items-center justify-end gap-3">
            {unmatched > 0 && <span className="text-sm text-slate-600">{unmatched} line(s) still need a match.</span>}
            <Button disabled={unmatched > 0} loading={rState.isLoading} onClick={() => void run(() => reconcile(id).unwrap())}>Reconcile statement</Button>
          </div>
        )}
      </Card>
      {matching && <MatchDialog statementId={id} line={matching} open onClose={() => setMatching(null)} />}
    </>
  );
}

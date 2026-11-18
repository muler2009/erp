import { useState } from "react";

import { useCloseFiscalPeriodMutation, useCreateFiscalYearMutation, useListFiscalYearsQuery, useReopenFiscalPeriodMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { Badge, Button, Card, EmptyState, ErrorState, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export function FiscalTab({ canManage, canClose }: { canManage: boolean; canClose: boolean }) {
  const { data, isLoading, error, refetch } = useListFiscalYearsQuery();
  const [create] = useCreateFiscalYearMutation();
  const [close] = useCloseFiscalPeriodMutation();
  const [reopen] = useReopenFiscalPeriodMutation();
  const [openNew, setOpenNew] = useState(false);
  const [reopenId, setReopenId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <div className="mb-3 flex justify-end">{canManage && <Button onClick={() => setOpenNew(true)}>Add fiscal year</Button>}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data || data.length === 0 ? <EmptyState title="No fiscal years yet" hint="Add one to get its twelve periods." /> : data.map((y) => (
        <Card key={y.id} title={`${y.name} (${y.start_date} to ${y.end_date})`}>
          <table className="min-w-full text-sm">
            <caption className="sr-only">{`Periods of ${y.name}`}</caption>
            <thead><tr className="text-left text-slate-500"><th className="py-1">Period</th><th>From</th><th>To</th><th>Status</th><th /></tr></thead>
            <tbody>{y.periods.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="py-1">{p.name}</td><td>{p.start_date}</td><td>{p.end_date}</td>
                <td><Badge tone={p.status === "OPEN" ? "green" : "slate"}>{p.status === "OPEN" ? "Open" : "Closed"}</Badge></td>
                <td className="text-right">{canClose && (p.status === "OPEN"
                  ? <Button variant="secondary" onClick={() => { setErr(null); close(p.id).unwrap().catch((e) => setErr(errorMessage(e))); }}>{`Close ${p.name}`}</Button>
                  : <Button variant="secondary" onClick={() => setReopenId(p.id)}>{`Reopen ${p.name}`}</Button>)}</td>
              </tr>))}</tbody>
          </table>
        </Card>
      ))}
      <ActionDialog title="Add fiscal year" cta="Create year" open={openNew} onClose={() => setOpenNew(false)}
        fields={[{ name: "name", label: "Name", required: true }, { name: "start_date", label: "Starts on", type: "date", required: true }]}
        submit={async (v) => { await create({ name: v.name!.trim(), start_date: v.start_date! }).unwrap(); }} />
      <ActionDialog title="Reopen period" cta="Reopen" open={reopenId !== null} onClose={() => setReopenId(null)}
        fields={[{ name: "reason", label: "Why is it being reopened?", required: true }]}
        submit={async (v) => { await reopen({ id: reopenId!, reason: v.reason!.trim() }).unwrap(); }} />
    </>
  );
}

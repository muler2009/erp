import { useState } from "react";
import { Link } from "react-router";

import { useAcknowledgeDocumentMutation, useListMyAcknowledgementsQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";

export const isOverdue = (due: string | null, today = new Date().toISOString().slice(0, 10)): boolean => !!due && due < today;

export function AcknowledgementsPage() {
  const { data, isLoading, error, refetch } = useListMyAcknowledgementsQuery();
  const [ack] = useAcknowledgeDocumentMutation();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Documents to acknowledge" description="Confirm you have read these documents." />
      <Card title="Waiting for you">
        {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="Nothing to acknowledge" hint="You are up to date." /> : (
          <ul className="divide-y divide-slate-100 text-sm">{data.map((a) => (
            <li key={`${a.document}-${a.version}`} className="flex items-center justify-between gap-3 py-2"><span><Link className="text-indigo-700 underline" to={`/app/documents/${a.document}`}>{a.reference} {a.title}</Link> · version {a.version}{a.due_date && <span className={isOverdue(a.due_date) ? " text-red-700" : " text-slate-500"}> · due {a.due_date}</span>}</span>
              <Button variant="secondary" onClick={() => { setErr(null); ack(a.document).unwrap().catch((e) => setErr(errorMessage(e))); }}>{`Acknowledge ${a.reference}`}</Button></li>))}</ul>
        )}
      </Card>
    </>
  );
}

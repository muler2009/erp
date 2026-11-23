import { useState } from "react";
import { Link } from "react-router";

import { useDecideDocDisposalMutation, useExecuteDocDisposalMutation, useListDocDisposalsQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DocDisposalRow } from "../../shared/api/types";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames } from "../quality/names";

const TONE: Record<string, "green" | "red" | "amber" | "slate"> = { PENDING: "amber", APPROVED: "green", REJECTED: "red", DONE: "slate" };
const LABEL: Record<string, string> = { PENDING: "Waiting for a decision", APPROVED: "Approved", REJECTED: "Rejected", DONE: "Carried out" };

export function DisposalPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListDocDisposalsQuery({ cursor });
  const [decide] = useDecideDocDisposalMutation();
  const [execute] = useExecuteDocDisposalMutation();
  const nameOf = useUserNames();
  const [rejecting, setRejecting] = useState<DocDisposalRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(errorMessage(e));
  const act = (p: Promise<unknown>, text: string) => { setErr(null); setNote(null); p.then(() => setNote(text)).catch(fail); };
  return (
    <>
      <PageHeader title="Document disposal" description="Archived documents past their retention period can be destroyed once a second person approves." />
      <p className="mb-3 text-sm"><Link className="text-indigo-700 underline" to="/app/documents">← All documents</Link></p>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {note && <p role="status" className="mb-3 text-sm text-green-700">{note}</p>}
      <Card title="Requests">
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data?.results.length === 0 && <EmptyState title="No disposal requests" />}
        <ul className="divide-y divide-slate-100 text-sm">
          {q.data?.results.map((r) => (
            <li key={r.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2"><Link className="font-medium text-indigo-700 underline" to={`/app/documents/${r.document}`}>{r.reference}</Link><Badge tone={TONE[r.status] ?? "slate"}>{LABEL[r.status] ?? r.status}</Badge></div>
              <p className="text-slate-600">{r.reason} — asked by {nameOf(r.requested_by)}</p>
              {r.decision_note && <p className="text-slate-600">Decision note: {r.decision_note}</p>}
              <div className="mt-2 flex gap-2">
                {r.status === "PENDING" && <><Button aria-label={`Approve disposal of ${r.reference}`} onClick={() => act(decide({ id: r.id, approve: true, note: "" }).unwrap(), `Disposal of ${r.reference} approved.`)}>Approve</Button>
                  <Button variant="danger" aria-label={`Reject disposal of ${r.reference}`} onClick={() => setRejecting(r)}>Reject</Button></>}
                {r.status === "APPROVED" && <Button variant="danger" aria-label={`Carry out disposal of ${r.reference}`} onClick={() => act(execute(r.id).unwrap(), `${r.reference} was disposed of.`)}>Dispose now</Button>}
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data?.next ?? null)}>Next page</Button>}</div>
      </Card>
      {rejecting && <ActionDialog title={`Reject disposal of ${rejecting.reference}`} cta="Reject" open onClose={() => setRejecting(null)} fields={[{ name: "note", label: "Why not", required: true }]}
        submit={async (v) => { await decide({ id: rejecting.id, approve: false, note: (v.note ?? "").trim() }).unwrap(); setNote(`Disposal of ${rejecting.reference} rejected.`); }} />}
    </>
  );
}

import { useState } from "react";

import { useCapitalizationActionMutation, useListCapitalizationsQuery } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export function CapitalizationsPage() {
  const { can } = useAccess();
  const [status, setStatus] = useState("REQUESTED");
  const { data, isLoading, error, refetch } = useListCapitalizationsQuery(status || undefined);
  const [act] = useCapitalizationActionMutation();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Capitalisation requests" description="Approve turning an acquired asset into a depreciating fixed asset." />
      <label className="mb-3 block text-sm">Status <select aria-label="Request status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["REQUESTED", "APPROVED", "REJECTED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <Card title="Requests">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No requests" /> : (
          <ul>{data.results.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2 text-sm">
              <span className="min-w-40 flex-1">{r.number} · {r.asset} — total cost {formatMoney(r.total_cost)}, depreciable base {formatMoney(r.base_amount)}, from {r.capitalization_date}{!r.capitalize && " (expensed, below the category threshold)"}</span>
              <Badge tone={r.status === "APPROVED" ? "green" : r.status === "REJECTED" ? "red" : "amber"}>{pretty(r.status)}</Badge>
              {r.decision_note && <span className="text-slate-500">{r.decision_note}</span>}
              {r.status === "REQUESTED" && can("assets.capitalization.approve") && <><Button onClick={async () => { setErr(null); try { await act({ id: r.id, action: "approve" }).unwrap(); } catch (e) { setErr(failure(e)); } }}>{`Approve ${r.number}`}</Button><Button variant="secondary" onClick={() => setRejecting(r.id)}>{`Reject ${r.number}`}</Button></>}
            </li>))}</ul>
        )}
      </Card>
      <ActionDialog title="Reject capitalisation" open={!!rejecting} onClose={() => setRejecting(null)} cta="Reject" fields={[{ name: "note", label: "Reason", required: true }]} submit={(v) => act({ id: rejecting!, action: "reject", note: (v.note ?? "").trim() }).unwrap()} />
    </>
  );
}

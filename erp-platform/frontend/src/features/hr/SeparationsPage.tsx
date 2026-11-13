import { useState } from "react";

import { useDecideSeparationMutation, useListSeparationsQuery, useRecordSettlementMutation, useSubmitResignationMutation, useWithdrawResignationMutation } from "../../shared/api/endpoints";
import type { Separation } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "./ActionDialog";
import { pretty } from "./EmployeeDialogs";
import { useEmployeeNames } from "./names";

export function validateResignation(f: { last_working_date: string; reason: string }, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!f.reason.trim()) return "Give a reason for resigning.";
  if (!f.last_working_date || f.last_working_date < today) return "Your last working day cannot be in the past.";
  return null;
}
export function validateSettlement(amount: string): string | null {
  const a = parseMoney(amount);
  return a === null || a < 0n ? "Enter the settlement amount (zero or more)." : null;
}
const tone = (s: string) => (s === "ACCEPTED" || s === "COMPLETED" ? "green" : s === "REJECTED" || s === "WITHDRAWN" ? "red" : "amber") as "green" | "red" | "amber";

export function SeparationsPage() {
  const { can } = useAccess();
  const manage = can("hr.employee.manage");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useListSeparationsQuery({ status: status || undefined, cursor }, { skip: !manage });
  const name = useEmployeeNames();
  const [decide] = useDecideSeparationMutation();
  const [settle] = useRecordSettlementMutation();
  const [resign] = useSubmitResignationMutation();
  const [withdraw] = useWithdrawResignationMutation();
  const [dlg, setDlg] = useState<"resign" | "reject" | "settle" | null>(null);
  const [target, setTarget] = useState<Separation | null>(null);
  const [mine, setMine] = useState<Separation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(failure(e)); } };
  return (
    <>
      <PageHeader title="Separations" description="Resignations and offboarding." actions={<Button variant="secondary" onClick={() => setDlg("resign")}>Submit my resignation</Button>} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {mine && (
        <Card title="My resignation"><p className="text-sm">Last working day {mine.last_working_date} — <Badge tone={tone(mine.status)}>{pretty(mine.status)}</Badge></p>
          {mine.status === "REQUESTED" && <div className="mt-2"><Button variant="secondary" onClick={() => void run(async () => { setMine(await withdraw(mine.id).unwrap()); })}>Withdraw resignation</Button></div>}
        </Card>
      )}
      {manage && (
        <div className="mt-4"><Card title="All separations">
          <label className="mb-2 block text-sm">Status <select aria-label="Status filter" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{["REQUESTED", "ACCEPTED", "REJECTED", "WITHDRAWN", "COMPLETED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          {list.isLoading ? <Spinner /> : list.error ? <ErrorState error={list.error} onRetry={list.refetch} /> : !list.data?.results.length ? <EmptyState title="No separations" /> : (
            <ul>{list.data.results.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2">
                <span className="min-w-40 flex-1">{name(s.employee)} — {pretty(s.kind)}, last day {s.last_working_date}</span><Badge tone={tone(s.status)}>{pretty(s.status)}</Badge>
                {s.reason && <span className="text-sm text-slate-500">{s.reason}</span>}
                {s.status === "REQUESTED" && <><Button onClick={() => void run(() => decide({ id: s.id, decision: "accept" }).unwrap())}>Accept</Button><Button variant="secondary" onClick={() => { setTarget(s); setDlg("reject"); }}>Reject</Button></>}
                {s.status === "ACCEPTED" && !s.settlement_recorded && <Button variant="secondary" onClick={() => { setTarget(s); setDlg("settle"); }}>Record settlement</Button>}
                {s.settlement_recorded && <span className="text-sm">Settled {formatMoney(s.settlement_amount)}</span>}
              </li>))}</ul>
          )}
          {cursor && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(null)}>First page</Button></div>}
          {list.data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(list.data!.next)}>Next page</Button></div>}
        </Card></div>
      )}
      <ActionDialog title="Submit resignation" open={dlg === "resign"} onClose={() => setDlg(null)} cta="Submit resignation" fields={[{ name: "last_working_date", label: "Last working day", type: "date", required: true }, { name: "reason", label: "Reason", required: true }]}
        submit={async (v) => { const f = { last_working_date: v.last_working_date ?? "", reason: (v.reason ?? "").trim() }; const p = validateResignation(f); if (p) throw new Error(p); setMine(await resign(f).unwrap()); }} />
      <ActionDialog title="Reject resignation" open={dlg === "reject"} onClose={() => setDlg(null)} cta="Reject" fields={[{ name: "note", label: "Note", required: true }]} submit={(v) => decide({ id: target!.id, decision: "reject", note: (v.note ?? "").trim() }).unwrap()} />
      <ActionDialog title="Record settlement" open={dlg === "settle"} onClose={() => setDlg(null)} cta="Record settlement" fields={[{ name: "amount", label: "Amount", required: true }, { name: "notes", label: "Notes" }]}
        submit={async (v) => { const p = validateSettlement((v.amount ?? "").trim()); if (p) throw new Error(p); await settle({ id: target!.employee, amount: (v.amount ?? "").trim(), notes: v.notes ?? "" }).unwrap(); }} />
    </>
  );
}

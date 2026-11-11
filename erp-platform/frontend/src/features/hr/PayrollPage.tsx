import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useCreatePayrollRunMutation, useGetPayrollRunQuery, useListPayrollRunsQuery, usePayrollActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { PayrollRun } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const runTone = (s: string) => (s === "PAID" || s === "POSTED" || s === "APPROVED" ? "green" : s === "CANCELLED" ? "red" : s === "PENDING_APPROVAL" ? "amber" : "slate") as "green" | "red" | "amber" | "slate";
export const runLabel = (s: string) => (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, " ");

export function validatePeriod(start: string, end: string): string | null {
  if (!start || !end) return "Enter the first and last day of the pay period.";
  if (end < start) return "The period must end on or after it starts.";
  return null;
}

function NewRunDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, state] = useCreatePayrollRunMutation();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    const problem = validatePeriod(start, end);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await create({ period_start: start, period_end: end }).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New payroll run" open={open} onClose={close}>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Period start" htmlFor="pr-start"><input id="pr-start" type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} /></FormField>
        <FormField label="Period end" htmlFor="pr-end"><input id="pr-end" type="date" className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} /></FormField>
      </div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Calculate run</Button></div>
    </Modal>
  );
}

function RunDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isFetching, error } = useGetPayrollRunQuery(id ?? "", { skip: !id });
  const [act, state] = usePayrollActionMutation();
  const [note, setNote] = useState("");
  const [payDate, setPayDate] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const run = async (action: "recalculate" | "submit" | "cancel" | "approve" | "reject" | "post" | "pay") => {
    if (action === "reject" && !note.trim()) { setErr("A note is required to send a run back."); return; }
    setErr(null);
    try { await act({ id: id!, action, body: action === "reject" ? { note: note.trim() } : action === "pay" && payDate ? { payment_date: payDate } : {} }).unwrap(); setNote(""); } catch (e) { setErr(errorMessage(e)); }
  };
  const process = can("hr.payroll.process"), approve = can("hr.payroll.approve"), pay = can("hr.payroll.pay");
  return (
    <Modal title={data ? `Payroll ${data.number}` : "Payroll run"} open={!!id} onClose={onClose}>
      {isFetching && !data && <Spinner />}
      {error && <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>}
      {data && (
        <>
          <p className="mb-2 text-sm text-slate-600">{data.period_start} to {data.period_end} · <Badge tone={runTone(data.status)}>{runLabel(data.status)}</Badge></p>
          <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            {([["Gross", data.gross_total], ["Income tax", data.tax_total], ["Pension (employee)", data.pension_employee_total], ["Pension (employer)", data.pension_employer_total], ["Other deductions", data.deduction_total], ["Net pay", data.net_total]] as const).map(([k, v]) => <div key={k} className="flex justify-between"><dt>{k}</dt><dd className="font-medium">{formatMoney(v)}</dd></div>)}
          </dl>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-sm"><thead><tr><th className="text-left">Employee</th><th className="text-right">Gross</th><th className="text-right">Tax</th><th className="text-right">Net</th></tr></thead>
              <tbody>{data.payslips.map((p) => <tr key={p.id} className="border-t border-slate-100"><td>{p.employee_no}</td><td className="text-right">{formatMoney(p.gross)}</td><td className="text-right">{formatMoney(p.income_tax)}</td><td className="text-right">{formatMoney(p.net)}</td></tr>)}</tbody></table>
          </div>
          {data.status === "PENDING_APPROVAL" && data.workflow_instance_id && <p className="mt-3 text-sm text-slate-600">This run is governed by an approval workflow; decide it in the approval inbox.</p>}
          {data.status === "PENDING_APPROVAL" && !data.workflow_instance_id && approve && <div className="mt-3"><FormField label="Note (required to send back)" htmlFor="pr-note"><input id="pr-note" maxLength={300} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></FormField></div>}
          {data.status === "POSTED" && pay && <div className="mt-3"><FormField label="Payment date (optional)" htmlFor="pr-pay"><input id="pr-pay" type="date" className={inputClass} value={payDate} onChange={(e) => setPayDate(e.target.value)} /></FormField></div>}
          {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {data.status === "DRAFT" && process && <Button variant="secondary" loading={state.isLoading} onClick={() => void run("recalculate")}>Recalculate</Button>}
            {data.status === "DRAFT" && process && <Button loading={state.isLoading} onClick={() => void run("submit")}>Submit for approval</Button>}
            {data.status === "PENDING_APPROVAL" && !data.workflow_instance_id && approve && <Button loading={state.isLoading} onClick={() => void run("approve")}>Approve</Button>}
            {data.status === "PENDING_APPROVAL" && !data.workflow_instance_id && approve && <Button variant="secondary" loading={state.isLoading} onClick={() => void run("reject")}>Send back</Button>}
            {data.status === "APPROVED" && process && <Button loading={state.isLoading} onClick={() => void run("post")}>Post to ledger</Button>}
            {data.status === "POSTED" && pay && <Button loading={state.isLoading} onClick={() => void run("pay")}>Record payment</Button>}
            {["DRAFT", "PENDING_APPROVAL"].includes(data.status) && process && <Button variant="danger" loading={state.isLoading} onClick={() => void run("cancel")}>Cancel run</Button>}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function PayrollPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListPayrollRunsQuery({ cursor });
  const columns: ColumnDef<PayrollRun>[] = [
    { header: "Run", cell: ({ row }) => <button className="text-indigo-700 underline" onClick={() => setOpenId(row.original.id)}>{row.original.number}</button> },
    { header: "Period", cell: ({ row }) => `${row.original.period_start} to ${row.original.period_end}` },
    { header: "Gross", cell: ({ row }) => formatMoney(row.original.gross_total) },
    { header: "Net", cell: ({ row }) => formatMoney(row.original.net_total) },
    { header: "Status", cell: ({ row }) => <Badge tone={runTone(row.original.status)}>{runLabel(row.original.status)}</Badge> },
  ];
  return (
    <>
      <PageHeader title="Payroll" description="Calculate, approve, post and pay each period's payroll." actions={can("hr.payroll.process") ? <Button onClick={() => setCreating(true)}>New run</Button> : undefined} />
      <DataTable caption="Payroll runs" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No payroll runs yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <RunDetail id={openId} onClose={() => setOpenId(null)} />
      <NewRunDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

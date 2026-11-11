import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useListMyPayslipsQuery } from "../../shared/api/endpoints";
import type { Payslip } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { DataTable } from "../../shared/ui/DataTable";
import { Button, Modal, PageHeader } from "../../shared/ui/primitives";

/** My own payslips; the server returns only approved, posted or paid runs for the signed-in employee. */
export function PayslipsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<Payslip | null>(null);
  const { data, isLoading, error, refetch } = useListMyPayslipsQuery({ cursor });
  const columns: ColumnDef<Payslip>[] = [
    { header: "Period", cell: ({ row }) => `${row.original.period_start} to ${row.original.period_end}` },
    { header: "Gross", cell: ({ row }) => formatMoney(row.original.gross) },
    { header: "Tax", cell: ({ row }) => formatMoney(row.original.income_tax) },
    { header: "Net pay", cell: ({ row }) => <strong>{formatMoney(row.original.net)}</strong> },
    { header: "", id: "a", cell: ({ row }) => <Button variant="secondary" onClick={() => setOpen(row.original)}>View payslip</Button> },
  ];
  const lines = open?.lines ?? [];
  return (
    <>
      <PageHeader title="My payslips" description="Your pay for each approved payroll period." />
      <DataTable caption="My payslips" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No payslips yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <Modal title={open ? `Payslip ${open.period_start} to ${open.period_end}` : "Payslip"} open={!!open} onClose={() => setOpen(null)}>
        {open && (
          <>
            <p className="mb-2 text-sm text-slate-600">Paid days {open.payable_days} of {open.working_days}{Number(open.unpaid_leave_days) > 0 ? ` (unpaid leave ${open.unpaid_leave_days})` : ""}</p>
            <table className="w-full text-sm"><tbody>
              {lines.length > 0 ? lines.map((l) => <tr key={`${l.code}${l.name}`} className="border-t border-slate-100"><td>{l.name}</td><td className="text-slate-500">{l.kind.toLowerCase()}</td><td className="text-right">{formatMoney(l.amount)}</td></tr>) : <>
                <tr><td>Basic</td><td className="text-right">{formatMoney(open.basic)}</td></tr>
                <tr><td>Allowances</td><td className="text-right">{formatMoney(open.allowances)}</td></tr>
                <tr><td>Overtime</td><td className="text-right">{formatMoney(open.overtime_pay)}</td></tr>
              </>}
              <tr className="border-t border-slate-300"><td>Gross</td><td /><td className="text-right">{formatMoney(open.gross)}</td></tr>
              <tr><td>Income tax</td><td /><td className="text-right">{formatMoney(open.income_tax)}</td></tr>
              <tr><td>Pension (employee)</td><td /><td className="text-right">{formatMoney(open.pension_employee)}</td></tr>
              <tr><td>Other deductions</td><td /><td className="text-right">{formatMoney(open.other_deductions)}</td></tr>
              <tr className="border-t border-slate-300 font-semibold"><td>Net pay</td><td /><td className="text-right">{formatMoney(open.net)}</td></tr>
            </tbody></table>
          </>
        )}
      </Modal>
    </>
  );
}

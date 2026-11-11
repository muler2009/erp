import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { useGetInvoiceQuery, useInvoiceActionMutation, useListInvoicesQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Invoice, InvoiceStatus } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { NewInvoiceDialog } from "./NewInvoiceDialog";
import { ApplyCreditDialog } from "./ApplyCreditDialog";
import { PaymentDialog } from "./PaymentDialog";
import { parseMoney } from "../../shared/lib/money";

const tone = (s: InvoiceStatus) => (s === "PAID" || s === "POSTED" ? "green" : s === "VOID" ? "red" : s === "DRAFT" ? "slate" : "amber");
const KINDS = ["CUSTOMER_INVOICE", "SUPPLIER_INVOICE", "CUSTOMER_CREDIT_NOTE", "SUPPLIER_CREDIT_NOTE"];
const label = (s: string) => s.toLowerCase().replace(/_/g, " ");

function InvoiceDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isFetching, error } = useGetInvoiceQuery(id ?? "", { skip: !id });
  const [act, state] = useInvoiceActionMutation();
  const [err, setErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [applying, setApplying] = useState(false);
  const { can } = useAccess();
  const run = async (action: "submit" | "approve" | "post" | "void") => {
    setErr(null);
    try { await act({ id: id!, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); }
  };
  // Buttons follow the workflow state and the user's permission; the server enforces both again (and separation of duties).
  const actions: { action: "submit" | "approve" | "post" | "void"; text: string; show: boolean; variant?: "danger" }[] = data
    ? [
        { action: "submit", text: "Submit for approval", show: data.status === "DRAFT" && can("finance.invoice.create") },
        { action: "approve", text: "Approve", show: data.status === "SUBMITTED" && can("finance.invoice.approve") },
        { action: "post", text: "Post to ledger", show: data.status === "APPROVED" && can("finance.invoice.approve") },
        { action: "void", text: "Void", show: (data.status === "DRAFT" || data.status === "SUBMITTED") && can("finance.invoice.create"), variant: "danger" },
      ]
    : [];
  const isInvoice = !!data && !data.kind.endsWith("CREDIT_NOTE");
  const open = !!data && data.status === "POSTED" && (parseMoney(data.outstanding) ?? 0n) > 0n;
  return (
    <Modal title={data ? `Invoice ${data.number}` : "Invoice"} open={!!id} onClose={onClose}>
      {isFetching && !data && <Spinner />}
      {error && <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>}
      {data && (
        <>
          <p className="mb-2 text-sm text-slate-600">{data.partner.name} · {label(data.kind)} · <Badge tone={tone(data.status)}>{data.status}</Badge></p>
          <table className="w-full text-sm">
            <thead><tr><th className="text-left">Description</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-right">Total</th></tr></thead>
            <tbody>
              {data.lines?.map((l) => (
                <tr key={l.line_no} className="border-t border-slate-100"><td>{l.description}</td><td className="text-right">{l.quantity}</td><td className="text-right">{formatMoney(l.unit_price)}</td><td className="text-right">{formatMoney(l.line_total)}</td></tr>
              ))}
            </tbody>
          </table>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatMoney(data.subtotal)} {data.currency}</dd></div>
            <div className="flex justify-between"><dt>Tax</dt><dd>{formatMoney(data.tax_total)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{formatMoney(data.total)}</dd></div>
            <div className="flex justify-between"><dt>Outstanding</dt><dd>{formatMoney(data.outstanding)}</dd></div>
          </dl>
          {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {actions.filter((a) => a.show).map((a) => (
              <Button key={a.action} variant={a.variant ?? "primary"} loading={state.isLoading} onClick={() => void run(a.action)}>{a.text}</Button>
            ))}
            {data.status === "DRAFT" && can("finance.invoice.create") && <Button variant="secondary" onClick={() => setEditing(true)}>Edit draft</Button>}
            {isInvoice && open && can("finance.payment.release") && <Button onClick={() => setPaying(true)}>{data.kind === "CUSTOMER_INVOICE" ? "Record receipt" : "Release payment"}</Button>}
            {isInvoice && data.status === "POSTED" && can("finance.invoice.create") && <Button variant="secondary" onClick={() => setCrediting(true)}>Issue credit note</Button>}
            {!isInvoice && open && can("finance.invoice.approve") && <Button onClick={() => setApplying(true)}>Apply to invoice</Button>}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
          {isInvoice && <PaymentDialog invoice={data} open={paying} onClose={() => setPaying(false)} />}
          {crediting && <NewInvoiceDialog creditFor={data} open onClose={() => setCrediting(false)} />}
          {editing && <NewInvoiceDialog editing={data} open onClose={() => setEditing(false)} />}
          {!isInvoice && <ApplyCreditDialog credit={data} open={applying} onClose={() => setApplying(false)} />}
        </>
      )}
    </Modal>
  );
}

export function InvoicesPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useListInvoicesQuery({ cursor, kind, status });
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  const columns = useMemo<ColumnDef<Invoice>[]>(
    () => [
      { header: "Number", cell: ({ row }) => <button type="button" className="text-brand-700 underline" onClick={() => setOpenId(row.original.id)}>{row.original.number}</button> },
      { header: "Type", cell: ({ row }) => label(row.original.kind) },
      { header: "Partner", cell: ({ row }) => row.original.partner.name },
      { header: "Date", accessorKey: "invoice_date" },
      { header: "Total", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.total)} {row.original.currency}</span> },
      { header: "Outstanding", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.outstanding)}</span> },
      { header: "Status", cell: ({ row }) => <Badge tone={tone(row.original.status)}>{row.original.status}</Badge> },
    ],
    [],
  );
  const reset = (fn: (v: string) => void) => (e: React.ChangeEvent<HTMLSelectElement>) => { fn(e.target.value); setCursor(null); };
  return (
    <>
      <PageHeader title="Invoices" description="Customer and supplier invoices and credit notes." actions={can("finance.invoice.create") ? <Button onClick={() => setCreating(true)}>New invoice</Button> : undefined} />
      <div className="mb-3 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">Type
          <select className={`${inputClass} w-auto`} value={kind} onChange={reset(setKind)}><option value="">All</option>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select>
        </label>
        <label className="flex items-center gap-2">Status
          <select className={`${inputClass} w-auto`} value={status} onChange={reset(setStatus)}><option value="">All</option>{["DRAFT", "SUBMITTED", "APPROVED", "POSTED", "PAID", "VOID"].map((s) => <option key={s}>{s}</option>)}</select>
        </label>
      </div>
      <DataTable caption="Invoices" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No invoices" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <InvoiceDetail id={openId} onClose={() => setOpenId(null)} />
      <NewInvoiceDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { useDecideQuotationMutation, useGetQuotationQuery, useListQuoteRevisionsQuery, useListQuotationsQuery, useQuotationActionMutation, useReviseQuotationMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Quotation } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { openFromApi } from "../../shared/lib/fileDownload";
import { DataTable } from "../../shared/ui/DataTable";
import { useAccountNames } from "../../shared/ui/useAccountNames";
import { Badge, Button, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames } from "../quality/names";
import { QuotationDialog } from "./QuotationEditor";

const STATUSES = ["DRAFT", "PENDING_APPROVAL", "SENT", "ACCEPTED", "REJECTED", "CONVERTED", "EXPIRED"];
const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ");
export const quoteTone = (s: string) => (s === "ACCEPTED" || s === "CONVERTED" ? "green" : s === "REJECTED" || s === "EXPIRED" ? "red" : s === "DRAFT" ? "slate" : "amber");

type Action = "send" | "accept" | "reject" | "convert";

/** Actions that make sense for each state. Permissions and the real rules are enforced by the server. */
export function quoteActions(status: string, can: (p: string) => boolean): { action: Action; text: string; variant?: "danger" | "secondary" }[] {
  const q = can("sales.quote.create");
  const o = can("sales.order.create");
  const out: { action: Action; text: string; variant?: "danger" | "secondary" }[] = [];
  if (status === "DRAFT" && q) out.push({ action: "send", text: "Send to customer" });
  if (status === "SENT" && q) out.push({ action: "accept", text: "Mark accepted" }, { action: "reject", text: "Mark rejected", variant: "danger" });
  if (status === "ACCEPTED" && o) out.push({ action: "convert", text: "Convert to order" });
  return out;
}

function Detail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isFetching, error } = useGetQuotationQuery(id ?? "", { skip: !id });
  const [act, state] = useQuotationActionMutation();
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const [decide] = useDecideQuotationMutation();
  const [revise] = useReviseQuotationMutation();
  const [dlg, setDlg] = useState<"edit" | "revise" | "return" | null>(null);
  const [showHist, setShowHist] = useState(false);
  const revs = useListQuoteRevisionsQuery(id ?? "", { skip: !id || !showHist });
  const nameOf = useUserNames();
  const approve = async () => { setErr(null); try { await decide({ id: id!, action: "approve" }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const printable = async () => { setErr(null); try { await openFromApi(`/api/v1/sales/quotations/${id}/document`); } catch (e) { setErr(e instanceof Error ? e.message : errorMessage(e)); } };
  const run = async (action: Action) => { setErr(null); try { await act({ id: id!, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title={data ? `Quotation ${data.number}` : "Quotation"} open={!!id} onClose={onClose}>
      {isFetching && !data && <Spinner />}
      {error && <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>}
      {data && (
        <>
          <p className="mb-2 text-sm text-slate-600"><Badge tone={quoteTone(data.status)}>{pretty(data.status)}</Badge> · version {data.version}{data.valid_until && ` · valid until ${data.valid_until}`}</p>
          <table className="w-full text-sm">
            <thead><tr><th className="text-left">Item</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-right">Disc. %</th><th className="text-right">Total</th></tr></thead>
            <tbody>{data.lines?.map((l) => <tr key={l.id} className="border-t border-slate-100"><td>{l.description}</td><td className="text-right">{formatMoney(l.quantity)}</td><td className="text-right">{formatMoney(l.unit_price)}</td><td className="text-right">{formatMoney(l.discount_percent)}</td><td className="text-right">{formatMoney(l.line_total)}</td></tr>)}</tbody>
          </table>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatMoney(data.subtotal)}</dd></div>
            <div className="flex justify-between"><dt>Tax</dt><dd>{formatMoney(data.tax_total)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>Total ({data.currency})</dt><dd>{formatMoney(data.total)}</dd></div>
          </dl>
          {data.status === "PENDING_APPROVAL" && <p className="mt-2 text-sm text-slate-600">Waiting for discount approval.</p>}
          {(data.payment_terms || data.delivery_terms || data.terms) && <p className="mt-2 text-sm text-slate-600">{[data.payment_terms && `Payment: ${data.payment_terms}`, data.delivery_terms && `Delivery: ${data.delivery_terms}`, data.terms].filter(Boolean).join(" · ")}</p>}
          <button type="button" className="mt-2 text-sm text-brand-700 underline" onClick={() => setShowHist(!showHist)}>{showHist ? "Hide history" : "Show history"}</button>
          {showHist && (
            <ul aria-label="Quotation history" className="mt-1 space-y-1 text-sm text-slate-600">
              {revs.isFetching && <li>Loading…</li>}
              {revs.data?.length === 0 && <li>No earlier versions.</li>}
              {revs.data?.map((r, i) => <li key={i}>Version {r.version}: {r.event.toLowerCase().replace(/_/g, " ")} by {nameOf(r.created_by ?? "")} on {r.created_at.slice(0, 10)}</li>)}
            </ul>
          )}
          {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => void printable()}>Printable copy</Button>
            {data.status === "DRAFT" && can("sales.quote.create") && <Button variant="secondary" onClick={() => setDlg("edit")}>Edit</Button>}
            {data.status === "PENDING_APPROVAL" && can("sales.order.approve") && <><Button onClick={() => void approve()}>Approve discounts</Button><Button variant="danger" onClick={() => setDlg("return")}>Send back</Button></>}
            {["SENT", "REJECTED", "EXPIRED", "PENDING_APPROVAL"].includes(data.status) && can("sales.quote.create") && <Button variant="secondary" onClick={() => setDlg("revise")}>Revise</Button>}
            {quoteActions(data.status, can).map((a) => <Button key={a.action} variant={a.variant ?? "primary"} loading={state.isLoading} onClick={() => void run(a.action)}>{a.text}</Button>)}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
      {dlg === "edit" && data && <QuotationDialog existing={data} onClose={() => setDlg(null)} />}
      {dlg === "revise" && <ActionDialog title="Revise quotation" cta="Revise" open onClose={() => setDlg(null)} fields={[{ name: "reason", label: "Reason", required: true }]} submit={async (v) => { await revise({ id: id!, reason: (v.reason ?? "").trim() }).unwrap(); }} />}
      {dlg === "return" && <ActionDialog title="Send quotation back" cta="Send back" open onClose={() => setDlg(null)} fields={[{ name: "reason", label: "Reason", required: true }]} submit={async (v) => { await decide({ id: id!, action: "return", reason: (v.reason ?? "").trim() }).unwrap(); }} />}
    </Modal>
  );
}

export function QuotationsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useListQuotationsQuery({ cursor, status });
  const name = useAccountNames();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  const columns = useMemo<ColumnDef<Quotation>[]>(() => [
    { header: "Number", cell: ({ row }) => <button type="button" className="text-brand-700 underline" onClick={() => setOpenId(row.original.id)}>{row.original.number}</button> },
    { header: "Customer", cell: ({ row }) => name(row.original.account) },
    { header: "Valid until", cell: ({ row }) => row.original.valid_until ?? "—" },
    { header: "Total", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.total)} {row.original.currency}</span> },
    { header: "Status", cell: ({ row }) => <Badge tone={quoteTone(row.original.status)}>{pretty(row.original.status)}</Badge> },
  ], [name]);
  return (
    <>
      <PageHeader title="Quotations" description="Offers sent to customers." actions={can("sales.quote.create") ? <Button onClick={() => setCreating(true)}>New quotation</Button> : undefined} />
      <label className="mb-3 flex items-center gap-2 text-sm">Status
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}>
          <option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
        </select>
      </label>
      <DataTable caption="Quotations" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No quotations" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <Detail id={openId} onClose={() => setOpenId(null)} />
      {creating && <QuotationDialog onClose={() => setCreating(false)} onSaved={(q) => setOpenId(q.id)} />}
    </>
  );
}

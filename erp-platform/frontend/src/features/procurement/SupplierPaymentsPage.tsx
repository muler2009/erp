import { useRef, useState } from "react";

import { useGetAgeingQuery, useGetWhtReportQuery, useListBankAccountsQuery, useListDueInvoicesQuery, usePaySupplierInvoiceMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { DueInvoice, SupplierPaymentResult } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DebitNoteDialog } from "./ProcurementTools";

const today = () => new Date().toISOString().slice(0, 10);
const yearStart = () => `${new Date().getFullYear()}-01-01`;

/** Estimated net cash out from the figures the server listed for the due date. The server recalculates for the payment date. */
export function netEstimate(row: Pick<DueInvoice, "outstanding" | "discount_available" | "wht">, takeDiscount: boolean, withhold: boolean): bigint {
  const out = parseMoney(row.outstanding) ?? 0n;
  return out - (takeDiscount ? parseMoney(row.discount_available) ?? 0n : 0n) - (withhold ? parseMoney(row.wht) ?? 0n : 0n);
}

function PayDialog({ row, open, onClose }: { row: DueInvoice; open: boolean; onClose: () => void }) {
  const banks = useListBankAccountsQuery(undefined, { skip: !open });
  const [pay, state] = usePaySupplierInvoiceMutation();
  const [bank, setBank] = useState("");
  const [date, setDate] = useState(today);
  const hasDiscount = (parseMoney(row.discount_available) ?? 0n) > 0n;
  const hasWht = (parseMoney(row.wht) ?? 0n) > 0n;
  const [takeDiscount, setTakeDiscount] = useState(true);
  const [withhold, setWithhold] = useState(true);
  const [memo, setMemo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<SupplierPaymentResult | null>(null);
  const key = useRef(crypto.randomUUID()); // one key per dialog: a double click or retry replays the same payment
  const options = banks.data?.results.filter((b) => b.is_active && b.currency === row.currency) ?? [];

  const close = () => { setErr(null); setDone(null); onClose(); };
  const go = async () => {
    if (!bank) { setErr("Choose the bank or cash account to pay from."); return; }
    if (!date) { setErr("Payment date is required."); return; }
    setErr(null);
    try { setDone(await pay({ invoice: row.invoice, idempotencyKey: key.current, bank_account: bank, payment_date: date, take_discount: takeDiscount, withhold, memo: memo.trim() }).unwrap()); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Pay ${row.number}`} open={open} onClose={close}>
      {done ? (
        <>
          <p role="status" className="mb-3 text-sm">{done.replayed ? "This payment was already recorded: " : "Payment recorded: "}<strong>{done.payment}</strong> for {formatMoney(done.amount)} {row.currency}.</p>
          <div className="flex justify-end"><Button onClick={close}>Close</Button></div>
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-600">{row.supplier} · outstanding {formatMoney(row.outstanding)} {row.currency} · due {row.due_date}</p>
          <FormField label="Pay from" htmlFor="sp-bank"><select id="sp-bank" className={inputClass} value={bank} onChange={(e) => setBank(e.target.value)}><option value="">Choose…</option>{options.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></FormField>
          <FormField label="Payment date" htmlFor="sp-date"><input id="sp-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
          {hasDiscount && <label className="mb-2 block text-sm"><input type="checkbox" checked={takeDiscount} onChange={(e) => setTakeDiscount(e.target.checked)} /> Take the early-payment discount ({formatMoney(row.discount_available)})</label>}
          {hasWht && <label className="mb-2 block text-sm"><input type="checkbox" checked={withhold} onChange={(e) => setWithhold(e.target.checked)} /> Withhold tax ({formatMoney(row.wht)})</label>}
          <FormField label="Memo (optional)" htmlFor="sp-memo"><input id="sp-memo" maxLength={300} className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} /></FormField>
          <p className="mb-3 text-sm">Estimated cash out: <strong>{formatMoney(netEstimate(row, takeDiscount, withhold))} {row.currency}</strong> <span className="text-slate-500">(the server recalculates discount and withholding for the payment date)</span></p>
          {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Release payment</Button></div>
        </>
      )}
    </Modal>
  );
}

function DueSection() {
  const [asOf, setAsOf] = useState(today);
  const [within, setWithin] = useState("7");
  const [paying, setPaying] = useState<DueInvoice | null>(null);
  const [debiting, setDebiting] = useState<DueInvoice | null>(null);
  const { can } = useAccess();
  const days = /^\d{1,3}$/.test(within) ? Number(within) : null;
  const { data, isFetching, error, refetch } = useListDueInvoicesQuery({ asOf, withinDays: days ?? 0 }, { skip: !asOf || days === null });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">As of <input type="date" className={`${inputClass} w-auto`} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        <label className="flex items-center gap-2">Due within (days) <input inputMode="numeric" className={`${inputClass} w-20`} value={within} onChange={(e) => setWithin(e.target.value)} /></label>
      </div>
      {days === null && <p role="alert" className="text-sm text-red-700">Enter whole days, 0 to 999.</p>}
      {isFetching && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && !isFetching && (data.results.length === 0 ? <EmptyState title="Nothing due" /> : (
        <Card>
          <table className="min-w-full text-sm">
            <caption className="sr-only">Supplier invoices due</caption>
            <thead><tr>{["Supplier", "Invoice", "Due", "Outstanding", "Discount", "Withholding", ""].map((h) => <th key={h} scope="col" className={`px-2 py-1 ${["Outstanding", "Discount", "Withholding"].includes(h) ? "text-right" : "text-left"}`}>{h}</th>)}</tr></thead>
            <tbody>
              {data.results.map((r) => (
                <tr key={r.invoice} className="border-t border-slate-100">
                  <td className="px-2 py-1">{r.supplier}{r.standing !== "GOOD" && <> <Badge tone="red">{r.standing.toLowerCase()}</Badge></>}</td>
                  <td className="px-2 py-1">{r.number}{r.supplier_ref ? ` (${r.supplier_ref})` : ""}</td>
                  <td className="px-2 py-1">{r.due_date}{r.days_overdue > 0 && <> <Badge tone="red">{r.days_overdue} days late</Badge></>}</td>
                  <td className="px-2 py-1 text-right">{formatMoney(r.outstanding)} {r.currency}</td>
                  <td className="px-2 py-1 text-right">{formatMoney(r.discount_available)}</td>
                  <td className="px-2 py-1 text-right">{formatMoney(r.wht)}</td>
                  <td className="px-2 py-1 text-right">
                    {can("procurement.debit_note.create") && <Button variant="secondary" aria-label={`Debit note for ${r.number}`} onClick={() => setDebiting(r)}>Debit note</Button>}{" "}
                    {!r.payable ? <span className="text-xs text-slate-600">No verified bank account</span> : r.standing === "BLACKLISTED" ? <span className="text-xs text-slate-600">Blacklisted</span> : <Button aria-label={`Pay ${r.number}`} onClick={() => setPaying(r)}>Pay…</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
      {paying && <PayDialog row={paying} open onClose={() => setPaying(null)} />}
      {debiting && <DebitNoteDialog row={debiting} onClose={() => setDebiting(null)} />}
    </>
  );
}

const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
function AgeingSection() {
  const [asOf, setAsOf] = useState(today);
  const { data, isFetching, error, refetch } = useGetAgeingQuery({ asOf }, { skip: !asOf });
  return (
    <>
      <label className="mb-4 flex items-center gap-2 text-sm">As of <input type="date" className={`${inputClass} w-auto`} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
      {isFetching && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && !isFetching && (data.results.length === 0 ? <EmptyState title="No open supplier balances" /> : (
        <Card>
          <table className="min-w-full text-sm">
            <caption className="sr-only">Payables ageing</caption>
            <thead><tr><th scope="col" className="px-2 py-1 text-left">Supplier</th><th scope="col" className="px-2 py-1 text-left">Currency</th>{BUCKETS.map((b) => <th scope="col" key={b} className="px-2 py-1 text-right">{b === "current" ? "Not yet due" : `${b} days`}</th>)}<th scope="col" className="px-2 py-1 text-right">Total</th></tr></thead>
            <tbody>{data.results.map((r) => <tr key={`${r.supplier}${r.currency}`} className="border-t border-slate-100"><td className="px-2 py-1">{r.supplier}</td><td className="px-2 py-1">{r.currency}</td>{BUCKETS.map((b) => <td key={b} className="px-2 py-1 text-right">{formatMoney(r[b])}</td>)}<td className="px-2 py-1 text-right font-semibold">{formatMoney(r.total)}</td></tr>)}</tbody>
          </table>
        </Card>
      ))}
    </>
  );
}

function WhtSection() {
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(today);
  const invalid = !from || !to || from > to;
  const { data, isFetching, error, refetch } = useGetWhtReportQuery({ from, to }, { skip: invalid });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">From <input type="date" className={`${inputClass} w-auto`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="flex items-center gap-2">To <input type="date" className={`${inputClass} w-auto`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {invalid && <p role="alert" className="text-sm text-red-700">Choose a start date that is on or before the end date.</p>}
      {isFetching && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && !isFetching && !invalid && (data.results.length === 0 ? <EmptyState title="No tax withheld in this period" /> : (
        <Card>
          <table className="min-w-full text-sm">
            <caption className="sr-only">Withholding tax report</caption>
            <thead><tr><th scope="col" className="px-2 py-1 text-left">Supplier</th><th scope="col" className="px-2 py-1 text-left">Tax ID</th><th scope="col" className="px-2 py-1 text-left">Currency</th><th scope="col" className="px-2 py-1 text-right">Withheld</th></tr></thead>
            <tbody>{data.results.map((r) => <tr key={`${r.supplier}${r.currency}`} className="border-t border-slate-100"><td className="px-2 py-1">{r.supplier}</td><td className="px-2 py-1">{r.tax_id}</td><td className="px-2 py-1">{r.currency}</td><td className="px-2 py-1 text-right">{formatMoney(r.withheld)}</td></tr>)}</tbody>
          </table>
        </Card>
      ))}
    </>
  );
}

const TABS = [{ id: "due", label: "Due for payment" }, { id: "ageing", label: "Ageing" }, { id: "wht", label: "Withholding tax" }] as const;
export function SupplierPaymentsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("due");
  return (
    <>
      <PageHeader title="Supplier payments" description="Pay posted supplier invoices, review ageing and withholding tax." />
      <div role="tablist" aria-label="Supplier payment views" className="mb-4 flex gap-2">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`rounded px-3 py-1 text-sm ${tab === t.id ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-800"}`}>{t.label}</button>)}
      </div>
      {tab === "due" && <DueSection />}
      {tab === "ageing" && <AgeingSection />}
      {tab === "wht" && <WhtSection />}
    </>
  );
}

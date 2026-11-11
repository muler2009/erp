import { useRef, useState } from "react";

import { useListBankAccountsQuery, useRecordPaymentMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { BankAccount, Invoice } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";

/** Returns an error message, or null when the payment may be sent. The server re-checks everything. */
export function validatePayment(inv: Pick<Invoice, "outstanding" | "currency">, f: { bank: BankAccount | undefined; date: string; amount: string }): string | null {
  if (!f.bank) return "Choose a bank or cash account.";
  if (f.bank.currency !== inv.currency) return `The account is in ${f.bank.currency} but the invoice is in ${inv.currency}.`;
  if (!f.date) return "Payment date is required.";
  const amt = parseMoney(f.amount);
  if (amt === null || amt <= 0n) return "Enter an amount greater than 0.";
  if (amt > (parseMoney(inv.outstanding) ?? 0n)) return `The amount cannot exceed the outstanding ${formatMoney(inv.outstanding)}.`;
  return null;
}

export function PaymentDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const banks = useListBankAccountsQuery(undefined, { skip: !open });
  const [record, state] = useRecordPaymentMutation();
  const [bankId, setBankId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(invoice.outstanding.replace(/\.?0+$/, "") || invoice.outstanding);
  const [memo, setMemo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // One key per dialog: a double click or a retry after a timeout replays the same payment instead of paying twice.
  const key = useRef(crypto.randomUUID());
  const options = banks.data?.results.filter((b) => b.is_active && b.currency === invoice.currency) ?? [];
  const customer = invoice.kind === "CUSTOMER_INVOICE";

  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    const bank = banks.data?.results.find((b) => b.id === bankId);
    const problem = validatePayment(invoice, { bank, date, amount });
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      await record({ idempotencyKey: key.current, body: { kind: customer ? "RECEIPT" : "DISBURSEMENT", partner: invoice.partner.id, bank_account: bankId, payment_date: date, memo: memo.trim(), allocations: [{ invoice: invoice.id, amount: amount.trim() }] } }).unwrap();
      key.current = crypto.randomUUID();
      close();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={customer ? "Record customer receipt" : "Release supplier payment"} open={open} onClose={close}>
      <p className="mb-3 text-sm text-slate-600">{invoice.number} · {invoice.partner.name} · outstanding {formatMoney(invoice.outstanding)} {invoice.currency}</p>
      <FormField label="Bank or cash account" htmlFor="pay-bank">
        <select id="pay-bank" className={inputClass} value={bankId} onChange={(e) => setBankId(e.target.value)}><option value="">Choose…</option>{options.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      </FormField>
      <FormField label="Payment date" htmlFor="pay-date"><input id="pay-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
      <FormField label="Amount" htmlFor="pay-amount"><input id="pay-amount" inputMode="decimal" className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} /></FormField>
      <FormField label="Memo (optional)" htmlFor="pay-memo"><input id="pay-memo" className={inputClass} maxLength={300} value={memo} onChange={(e) => setMemo(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>{customer ? "Record receipt" : "Release payment"}</Button></div>
    </Modal>
  );
}

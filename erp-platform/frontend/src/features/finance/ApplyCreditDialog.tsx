import { useState } from "react";

import { useApplyCreditMutation, useListInvoicesQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Invoice } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";

/** The most that can be applied: the smaller of the two outstanding balances. Returns an error message or null. */
export function validateCredit(credit: Pick<Invoice, "outstanding">, target: Pick<Invoice, "outstanding"> | undefined, amount: string): string | null {
  if (!target) return "Choose the invoice to settle.";
  const amt = parseMoney(amount);
  if (amt === null || amt <= 0n) return "Enter an amount greater than 0.";
  const limit = [parseMoney(credit.outstanding) ?? 0n, parseMoney(target.outstanding) ?? 0n].reduce((a, b) => (a < b ? a : b));
  if (amt > limit) return `The amount cannot exceed ${formatMoney(limit)}, the smaller of the two outstanding balances.`;
  return null;
}

export function ApplyCreditDialog({ credit, open, onClose }: { credit: Invoice; open: boolean; onClose: () => void }) {
  const customer = credit.kind === "CUSTOMER_CREDIT_NOTE";
  const { data } = useListInvoicesQuery({ kind: customer ? "CUSTOMER_INVOICE" : "SUPPLIER_INVOICE", status: "POSTED" }, { skip: !open });
  const [apply, state] = useApplyCreditMutation();
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const candidates = data?.results.filter((i) => i.partner.id === credit.partner.id && i.currency === credit.currency && (parseMoney(i.outstanding) ?? 0n) > 0n) ?? [];
  const chosen = candidates.find((i) => i.id === target);

  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    const problem = validateCredit(credit, chosen, amount);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await apply({ creditNoteId: credit.id, invoice: target, amount: amount.trim() }).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Apply ${credit.number}`} open={open} onClose={close}>
      <p className="mb-3 text-sm text-slate-600">{credit.partner.name} · credit available {formatMoney(credit.outstanding)} {credit.currency}</p>
      <FormField label="Invoice to settle" htmlFor="cr-target">
        <select id="cr-target" className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose…</option>
          {candidates.map((i) => <option key={i.id} value={i.id}>{i.number} (outstanding {formatMoney(i.outstanding)})</option>)}
        </select>
      </FormField>
      {data && candidates.length === 0 && <p className="mb-3 text-sm text-slate-600">No open posted invoices for this partner in {credit.currency}.</p>}
      {data?.next && <p className="mb-3 text-xs text-slate-500">Only the first page of invoices is listed.</p>}
      <FormField label="Amount" htmlFor="cr-amount"><input id="cr-amount" inputMode="decimal" className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Apply credit</Button></div>
    </Modal>
  );
}

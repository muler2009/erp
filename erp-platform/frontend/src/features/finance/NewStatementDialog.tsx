import { useState } from "react";

import { useCreateBankStatementMutation, useListBankAccountsQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney, parseMoney, sumMoney } from "../../shared/lib/money";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";
import { parseStatementCsv } from "./statementCsv";

/** Returns an error message or null. The server repeats every check. */
export function validateStatement(f: { bank: string; date: string; opening: string; closing: string; lines: { amount: string }[] }): string | null {
  if (!f.bank) return "Choose the bank account.";
  if (!f.date) return "Statement date is required.";
  const opening = parseMoney(f.opening), closing = parseMoney(f.closing);
  if (opening === null) return "Opening balance must be a number with up to 4 decimals.";
  if (closing === null) return "Closing balance must be a number with up to 4 decimals.";
  if (f.lines.length === 0) return "Add at least one statement line.";
  if (opening + sumMoney(f.lines.map((l) => l.amount)) !== closing) return "Opening balance plus the lines does not equal the closing balance.";
  return null;
}

export function NewStatementDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const banks = useListBankAccountsQuery(undefined, { skip: !open });
  const [create, state] = useCreateBankStatementMutation();
  const [bank, setBank] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [opening, setOpening] = useState("0");
  const [closing, setClosing] = useState("0");
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const parsed = parseStatementCsv(text);
  const sum = sumMoney(parsed.lines.map((l) => l.amount));

  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    if (parsed.errors.length) { setErr(parsed.errors[0] ?? null); return; }
    const problem = validateStatement({ bank, date, opening, closing, lines: parsed.lines });
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      await create({ bank_account: bank, statement_date: date, opening_balance: opening.trim(), closing_balance: closing.trim(), lines: parsed.lines }).unwrap();
      setText(""); close();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New bank statement" open={open} onClose={close}>
      <FormField label="Bank account" htmlFor="st-bank"><select id="st-bank" className={inputClass} value={bank} onChange={(e) => setBank(e.target.value)}><option value="">Choose…</option>{banks.data?.results.filter((b) => b.is_active).map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>)}</select></FormField>
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Statement date" htmlFor="st-date"><input id="st-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
        <FormField label="Opening balance" htmlFor="st-open"><input id="st-open" inputMode="decimal" className={inputClass} value={opening} onChange={(e) => setOpening(e.target.value)} /></FormField>
        <FormField label="Closing balance" htmlFor="st-close"><input id="st-close" inputMode="decimal" className={inputClass} value={closing} onChange={(e) => setClosing(e.target.value)} /></FormField>
      </div>
      <FormField label="Lines (date,description,amount — money in positive, money out negative)" htmlFor="st-lines">
        <textarea id="st-lines" rows={8} className={`${inputClass} font-mono`} placeholder={"2026-03-16,Acme payment,40.00\n2026-03-17,Bank fee,-2.50"} value={text} onChange={(e) => setText(e.target.value)} />
      </FormField>
      <p className="mb-3 text-xs text-slate-600">{parsed.lines.length} line(s) read, net {formatMoney(sum)}. Opening + lines should equal closing.</p>
      {parsed.errors.length > 0 && <p role="alert" className="mb-3 text-sm text-red-700">{parsed.errors[0]}{parsed.errors.length > 1 ? ` (and ${parsed.errors.length - 1} more)` : ""}</p>}
      {err && !parsed.errors.length && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Save statement</Button></div>
    </Modal>
  );
}

import { useState } from "react";

import { useListInvoicesQuery, useListMatchExceptionsQuery, useMatchInvoiceMutation, useOverrideMatchMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { MatchResult, PurchaseOrder } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const PROBLEM_LABEL: Record<string, string> = {
  duplicate_invoice: "Possible duplicate invoice",
  not_received: "More invoiced than received",
  not_ordered: "More invoiced than ordered",
  inspection_pending: "Goods still awaiting inspection",
};
export const problemLabel = (key: string) => PROBLEM_LABEL[key] ?? key.replace(/_/g, " ");

export function ProblemList({ problems }: { problems: Record<string, string> }) {
  const keys = Object.keys(problems);
  if (keys.length === 0) return null;
  return <ul className="list-disc pl-5 text-sm text-red-800">{keys.map((k) => <li key={k}><strong>{problemLabel(k)}:</strong> {problems[k]}</li>)}</ul>;
}

function ResultPanel({ result }: { result: MatchResult }) {
  const d = result.detail;
  return (
    <div className="mt-3 rounded border border-slate-200 p-3 text-sm" role="region" aria-label="Match result">
      <p className="mb-2"><Badge tone={result.status === "MATCHED" ? "green" : "red"}>{result.status === "MATCHED" ? "Matched" : "Exception"}</Badge> <span className="ml-2 text-slate-600">{d.mode === "THREE_WAY" ? "Three-way" : "Two-way"} match, tolerance {d.tolerance_percent}%</span></p>
      <dl className="mb-2 grid grid-cols-2 gap-x-4">
        <dt>Ordered value</dt><dd className="text-right">{formatMoney(d.ordered_value)}</dd>
        <dt>Received value</dt><dd className="text-right">{formatMoney(d.received_value)}</dd>
        <dt>Invoiced before</dt><dd className="text-right">{formatMoney(d.previously_invoiced)}</dd>
        <dt>This invoice (goods)</dt><dd className="text-right">{formatMoney(d.invoice_goods_value)}</dd>
      </dl>
      <ProblemList problems={d.problems} />
      {d.possible_duplicates.length > 0 && <p className="mt-2 text-amber-800">Similar invoices already recorded: {d.possible_duplicates.join(", ")}</p>}
      {result.status === "EXCEPTION" && <p className="mt-2 text-slate-600">The invoice cannot be posted until the receipts or the invoice change and the match is re-run, or someone with override authority accepts it from Match exceptions.</p>}
    </div>
  );
}

export function MatchInvoiceDialog({ order, open, onClose }: { order: PurchaseOrder; open: boolean; onClose: () => void }) {
  const { data } = useListInvoicesQuery({ kind: "SUPPLIER_INVOICE" }, { skip: !open });
  const [run, state] = useMatchInvoiceMutation();
  const [invoice, setInvoice] = useState("");
  const [mode, setMode] = useState<"THREE_WAY" | "TWO_WAY">("THREE_WAY");
  const [result, setResult] = useState<MatchResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const candidates = data?.results.filter((i) => ["DRAFT", "SUBMITTED", "APPROVED"].includes(i.status) && i.currency === order.currency) ?? [];
  const close = () => { setErr(null); setResult(null); onClose(); };
  const go = async () => {
    if (!invoice) { setErr("Choose the supplier invoice to match."); return; }
    setErr(null); setResult(null);
    try { setResult(await run({ orderId: order.id, invoice, mode }).unwrap()); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Match an invoice to ${order.number}`} open={open} onClose={close}>
      <FormField label="Supplier invoice (unposted, same currency)" htmlFor="mt-inv">
        <select id="mt-inv" className={inputClass} value={invoice} onChange={(e) => setInvoice(e.target.value)}>
          <option value="">Choose…</option>
          {candidates.map((i) => <option key={i.id} value={i.id}>{i.number} · {i.partner.name}{i.supplier_ref ? ` · ref ${i.supplier_ref}` : ""} · {formatMoney(i.total)}</option>)}
        </select>
      </FormField>
      {data && candidates.length === 0 && <p className="mb-3 text-sm text-slate-600">No unposted supplier invoices in {order.currency}. Record the invoice first, with the received goods on the goods-received line.</p>}
      <FormField label="Match type" htmlFor="mt-mode"><select id="mt-mode" className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as "THREE_WAY" | "TWO_WAY")}><option value="THREE_WAY">Three-way (order, receipt, invoice)</option><option value="TWO_WAY">Two-way (order, invoice)</option></select></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {result && <ResultPanel result={result} />}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={close}>Close</Button><Button loading={state.isLoading} onClick={() => void go()}>Run match</Button></div>
    </Modal>
  );
}

export function MatchExceptionsPage() {
  const { data, isLoading, error, refetch } = useListMatchExceptionsQuery();
  const [override, state] = useOverrideMatchMutation();
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  const close = () => { setTarget(null); setReason(""); setErr(null); };
  const go = async () => {
    if (!reason.trim()) { setErr("A reason is required."); return; }
    try { await override({ match: target!, reason: reason.trim() }).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Match exceptions" description="Supplier invoices that failed matching and cannot be posted yet." />
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && data.results.length === 0 && <EmptyState title="No open match exceptions" />}
      <div className="space-y-3">
        {data?.results.map((x) => (
          <Card key={x.match}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{x.invoice_number}{x.supplier_ref ? ` · supplier ref ${x.supplier_ref}` : ""} → {x.po}</p>
                <p className="mb-2 text-sm text-slate-600">Goods value {formatMoney(x.goods_value)}</p>
                <ProblemList problems={x.problems} />
              </div>
              {can("procurement.invoice.override") && (
                "duplicate_invoice" in x.problems
                  ? <span className="text-xs text-slate-600">Duplicates cannot be overridden; void the invoice.</span>
                  : <Button variant="secondary" aria-label={`Override ${x.invoice_number}`} onClick={() => setTarget(x.match)}>Override…</Button>
              )}
            </div>
          </Card>
        ))}
      </div>
      <Modal title="Override failed match" open={target !== null} onClose={close}>
        <p className="mb-3 text-sm text-slate-600">Accepting this invoice is recorded with your name and reason. Someone other than the person who ran the match must do this.</p>
        <FormField label="Reason" htmlFor="ov-reason"><textarea id="ov-reason" rows={3} maxLength={300} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Accept invoice</Button></div>
      </Modal>
    </>
  );
}

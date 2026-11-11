import { useState } from "react";
import { Link, useParams } from "react-router";

import { useAwardRfqMutation, useGetRfqComparisonQuery, useGetRfqQuery, useRecordQuotationMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { RfqComparison, RfqDetail } from "../../shared/api/types";
import { formatMoney, multiplyMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { rfqTone } from "./RfqsPage";

/** Returns an error message or null; the server repeats every check. */
export function validateQuotation(f: { supplier: string; currency: string; lead: string; prices: Record<string, string> }, lineIds: string[]): string | null {
  if (!f.supplier) return "Choose the supplier.";
  if (!/^[A-Za-z]{3}$/.test(f.currency.trim())) return "Use a 3-letter currency code.";
  if (!/^\d{1,4}$/.test(f.lead.trim())) return "Lead time must be a whole number of days.";
  for (const id of lineIds) {
    const p = parseMoney(f.prices[id]);
    if (p === null || p < 0n) return "Enter a unit price (0 or more, up to 4 decimals) for every line.";
  }
  return null;
}

function QuotationDialog({ rfq, open, onClose }: { rfq: RfqDetail; open: boolean; onClose: () => void }) {
  const [record, state] = useRecordQuotationMutation();
  const [supplier, setSupplier] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [lead, setLead] = useState("0");
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const quoted = new Set(rfq.quotations.map((q) => q.supplier.id));
  const options = rfq.suppliers.filter((s) => !quoted.has(s.id));
  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    const problem = validateQuotation({ supplier, currency, lead, prices }, rfq.lines.map((l) => l.id));
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      await record({ rfqId: rfq.id, supplier, currency: currency.trim().toUpperCase(), lead_time_days: Number(lead), prices: Object.fromEntries(rfq.lines.map((l) => [l.id, (prices[l.id] ?? "").trim()])) }).unwrap();
      close();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Record a supplier quotation" open={open} onClose={close}>
      <FormField label="Supplier" htmlFor="q-supplier"><select id="q-supplier" className={inputClass} value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">Choose…</option>{options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Currency" htmlFor="q-cur"><input id="q-cur" maxLength={3} className={inputClass} value={currency} onChange={(e) => setCurrency(e.target.value)} /></FormField>
        <FormField label="Lead time (days)" htmlFor="q-lead"><input id="q-lead" inputMode="numeric" className={inputClass} value={lead} onChange={(e) => setLead(e.target.value)} /></FormField>
      </div>
      {rfq.lines.map((l) => (
        <FormField key={l.id} label={`Unit price: ${l.description} (qty ${formatMoney(l.quantity)})`} htmlFor={`q-price-${l.id}`}>
          <input id={`q-price-${l.id}`} inputMode="decimal" className={inputClass} value={prices[l.id] ?? ""} onChange={(e) => setPrices((p) => ({ ...p, [l.id]: e.target.value }))} />
        </FormField>
      ))}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Save quotation</Button></div>
    </Modal>
  );
}

function AwardDialog({ rfq, quotationId, recommended, open, onClose }: { rfq: RfqDetail; quotationId: string; recommended: string | null; open: boolean; onClose: () => void }) {
  const [award, state] = useAwardRfqMutation();
  const [why, setWhy] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const q = rfq.quotations.find((x) => x.id === quotationId);
  const needsWhy = recommended !== null && recommended !== quotationId;
  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    if (needsWhy && !why.trim()) { setErr("This is not the lowest bid, so a written justification is required."); return; }
    setErr(null);
    try { await award({ rfqId: rfq.id, quotation: quotationId, justification: why.trim() }).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Award to ${q?.supplier.name ?? "supplier"}`} open={open} onClose={close}>
      <p className="mb-3 text-sm text-slate-600">Awarding creates a draft purchase order from this quotation and closes the RFQ.</p>
      <FormField label={needsWhy ? "Justification (required: not the lowest bid)" : "Justification (optional)"} htmlFor="aw-why"><textarea id="aw-why" rows={3} maxLength={500} className={inputClass} value={why} onChange={(e) => setWhy(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Award and create order</Button></div>
    </Modal>
  );
}

function Matrix({ rfq, cmp, onAward }: { rfq: RfqDetail; cmp: RfqComparison | undefined; onAward: (q: string) => void }) {
  const { can } = useAccess();
  const total = (id: string) => cmp?.quotations.find((x) => x.quotation === id)?.total_base;
  const canAward = can("procurement.tender.award") && (rfq.status === "OPEN" || rfq.status === "EVALUATING");
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <caption className="sr-only">Quotation comparison</caption>
        <thead>
          <tr><th scope="col" className="px-2 py-1 text-left">Line</th><th scope="col" className="px-2 py-1 text-right">Qty</th>
            {rfq.quotations.map((q) => (
              <th scope="col" key={q.id} className="px-2 py-1 text-right">{q.supplier.name} <span className="font-normal text-slate-500">({q.currency})</span>
                {q.is_awarded && <> <Badge tone="green">Awarded</Badge></>}{q.disqualified && <> <Badge tone="red">Disqualified</Badge></>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rfq.lines.map((l) => (
            <tr key={l.id} className="border-t border-slate-100">
              <td className="px-2 py-1">{l.description}</td><td className="px-2 py-1 text-right">{formatMoney(l.quantity)}</td>
              {rfq.quotations.map((q) => {
                const best = cmp?.best_per_line[l.id]?.quotation === q.id;
                return <td key={q.id} className={`px-2 py-1 text-right ${best ? "font-semibold text-green-800" : ""}`}>{formatMoney(q.prices[l.id])}{best && <span className="sr-only"> (lowest)</span>}</td>;
              })}
            </tr>
          ))}
          <tr className="border-t-2 border-slate-300 font-semibold">
            <th scope="row" className="px-2 py-1 text-left" colSpan={2}>Total in company currency</th>
            {rfq.quotations.map((q) => <td key={q.id} className="px-2 py-1 text-right">{total(q.id) ? formatMoney(total(q.id)) : formatMoney(rfq.lines.reduce((s, l) => s + multiplyMoney(l.quantity, q.prices[l.id] ?? "0"), 0n))}{cmp?.lowest_total === q.id && <> <Badge tone="green">Lowest</Badge></>}</td>)}
          </tr>
          <tr className="border-t border-slate-100"><th scope="row" className="px-2 py-1 text-left" colSpan={2}>Lead time</th>{rfq.quotations.map((q) => <td key={q.id} className="px-2 py-1 text-right">{q.lead_time_days} days</td>)}</tr>
          {canAward && (
            <tr><td colSpan={2} />{rfq.quotations.map((q) => <td key={q.id} className="px-2 py-2 text-right">{!q.disqualified && <Button aria-label={`Award ${q.supplier.name}`} onClick={() => onAward(q.id)}>Award</Button>}</td>)}</tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function RfqDetailPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error, refetch } = useGetRfqQuery(id, { skip: !id });
  const showCmp = !!data && !data.sealed && data.quotations.length > 0;
  const cmp = useGetRfqComparisonQuery(id, { skip: !showCmp });
  const [recording, setRecording] = useState(false);
  const [awarding, setAwarding] = useState<string | null>(null);
  const { can } = useAccess();
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const canRecord = can("procurement.rfq.manage") && data.status === "OPEN" && data.suppliers.some((s) => !data.quotations.some((q) => q.supplier.id === s.id));
  return (
    <>
      <PageHeader title={`${data.number} · ${data.title}`} description={`${data.kind === "TENDER" ? "Tender" : "RFQ"} · invited: ${data.suppliers.map((s) => s.name).join(", ") || "any qualified supplier"}`}
        actions={<Link className="text-sm text-indigo-700 underline" to="/app/procurement/rfqs">All RFQs</Link>} />
      <Card>
        <p className="mb-3 text-sm"><Badge tone={rfqTone(data.status)}>{data.status}</Badge> <span className="ml-2">{data.quotation_count} quotation(s) received</span></p>
        {data.kind === "TENDER" && <p className="mb-3 text-sm text-slate-600">Tender opening, scoring and committee evaluation are not available in these screens yet.</p>}
        {data.sealed ? (
          <p role="status" className="text-sm text-slate-700">The bids are sealed until the tender committee opens them.</p>
        ) : data.quotations.length === 0 ? (
          <p className="text-sm text-slate-600">No quotations yet.</p>
        ) : (
          <Matrix rfq={data} cmp={cmp.data} onAward={setAwarding} />
        )}
        {cmp.error && <p role="alert" className="mt-2 text-sm text-red-700">{errorMessage(cmp.error)}</p>}
        {canRecord && <div className="mt-4 text-right"><Button onClick={() => setRecording(true)}>Record quotation</Button></div>}
      </Card>
      <QuotationDialog key={`q-${data.quotation_count}`} rfq={data} open={recording} onClose={() => setRecording(false)} />
      {awarding && <AwardDialog rfq={data} quotationId={awarding} recommended={cmp.data?.lowest_total ?? null} open onClose={() => setAwarding(null)} />}
    </>
  );
}

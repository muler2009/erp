import { useState } from "react";

import { useDisposalActionMutation, useGetDisposalCertificateQuery, useGetDisposalReportQuery, useListDisposalsQuery, useListFixedAssetsQuery, useRequestDisposalMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export const DISPOSAL_METHODS = ["SALE", "SCRAP", "DONATION", "WRITE_OFF"];
const DEC = /^\d+(\.\d{1,4})?$/;
const tone = (s: string) => (s === "COMPLETED" ? "green" : s === "REJECTED" || s === "CANCELLED" ? "red" : "amber") as "green" | "red" | "amber";

export function validateDisposal(f: { asset: string; method: string; reason: string; expected_proceeds: string; buyer: string }): string | null {
  if (!f.asset) return "Choose the asset.";
  if (!DISPOSAL_METHODS.includes(f.method)) return "Choose how the asset will be disposed of.";
  if (!f.reason.trim()) return "Give the reason for the disposal.";
  if (f.expected_proceeds.trim() && !DEC.test(f.expected_proceeds.trim())) return "Expected proceeds must be a number.";
  if (f.method === "SALE" && !f.buyer.trim()) return "Name the buyer for a sale.";
  return null;
}
export function validateExecution(proceeds: string, method: string): string | null {
  if (!DEC.test(proceeds.trim())) return "Proceeds must be zero or more.";
  if (method !== "SALE" && Number(proceeds) > 0) return "Only a sale can bring in proceeds.";
  return null;
}

function Certificate({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading, error, refetch } = useGetDisposalCertificateQuery(id ?? "", { skip: !id });
  return (
    <Modal title="Disposal certificate" open={!!id} onClose={onClose}>
      {isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt>Certificate</dt><dd>{data.number}</dd><dt>Asset</dt><dd>{data.asset} {data.name}</dd><dt>Serial number</dt><dd>{data.serial_number || "–"}</dd>
          <dt>Method</dt><dd>{pretty(data.method)}</dd><dt>Disposed on</dt><dd>{data.executed_on}</dd><dt>Buyer</dt><dd>{data.buyer || "–"}</dd>
          <dt>Net book value</dt><dd>{formatMoney(data.net_book_value)}</dd><dt>Proceeds</dt><dd>{formatMoney(data.proceeds)}</dd><dt>Gain / loss</dt><dd>{formatMoney(data.gain_loss)}</dd><dt>Reason</dt><dd>{data.reason}</dd>
        </dl>
      )}
      <div className="mt-3 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Modal>
  );
}

function List() {
  const { can } = useAccess();
  const manage = can("assets.disposal.manage");
  const approve = can("assets.disposal.approve");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListDisposalsQuery({ status: status || undefined, cursor });
  const assets = useListFixedAssetsQuery({}, { skip: !manage });
  const [request] = useRequestDisposalMutation();
  const [act] = useDisposalActionMutation();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ asset: "", method: "SALE", reason: "", expected_proceeds: "", buyer: "", proposed_on: "" });
  const [ferr, setFerr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<{ id: string; number: string; method: string; kind: "reject" | "execute" } | null>(null);
  const [cert, setCert] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const p = validateDisposal(f);
    if (p) { setFerr(p); return; }
    setFerr(null);
    try { await request({ asset: f.asset, method: f.method, reason: f.reason.trim(), ...(f.expected_proceeds.trim() ? { expected_proceeds: f.expected_proceeds.trim() } : {}), ...(f.buyer.trim() ? { buyer: f.buyer.trim() } : {}), ...(f.proposed_on ? { proposed_on: f.proposed_on } : {}) }).unwrap(); setOpen(false); setF({ asset: "", method: "SALE", reason: "", expected_proceeds: "", buyer: "", proposed_on: "" }); } catch (e) { setFerr(errorMessage(e)); }
  };
  const quick = async (id: string, action: "approve" | "cancel") => { setErr(null); try { await act({ id, action }).unwrap(); } catch (e) { setErr(failure(e)); } };
  return (
    <Card title="Disposals">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <label className="text-sm">Status <select aria-label="Disposal status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{["REQUESTED", "APPROVED", "COMPLETED", "REJECTED", "CANCELLED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        {manage && <Button onClick={() => setOpen(true)}>Request a disposal</Button>}
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No disposals" /> : (
        <ul>{data.results.map((d) => (
          <li key={d.id} className="border-b border-slate-200 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono">{d.number}</span><span className="font-medium">{d.asset.number}</span><Badge tone={tone(d.status)}>{pretty(d.status)}</Badge><Badge tone="slate">{pretty(d.method)}</Badge><span className="text-slate-500">proposed {d.proposed_on}</span></div>
            <p className="mt-1">{d.reason}</p>
            <p className="text-slate-600">{d.status === "COMPLETED" ? `Disposed ${d.executed_on} · NBV ${formatMoney(d.nbv_at_disposal ?? "0")} · proceeds ${formatMoney(d.proceeds)} · gain/loss ${formatMoney(d.gain_loss ?? "0")}` : `Expected proceeds ${formatMoney(d.expected_proceeds)}${d.buyer ? ` · buyer ${d.buyer}` : ""}`}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {d.status === "REQUESTED" && approve && <><Button onClick={() => void quick(d.id, "approve")}>{`Approve ${d.number}`}</Button><Button variant="secondary" onClick={() => setDlg({ id: d.id, number: d.number, method: d.method, kind: "reject" })}>{`Reject ${d.number}`}</Button></>}
              {d.status === "APPROVED" && manage && <Button onClick={() => setDlg({ id: d.id, number: d.number, method: d.method, kind: "execute" })}>{`Execute ${d.number}`}</Button>}
              {["REQUESTED", "APPROVED"].includes(d.status) && manage && <Button variant="secondary" onClick={() => void quick(d.id, "cancel")}>{`Cancel ${d.number}`}</Button>}
              {d.status === "COMPLETED" && <Button variant="secondary" onClick={() => setCert(d.id)}>{`Certificate ${d.number}`}</Button>}
            </div>
          </li>))}</ul>
      )}
      {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      <Modal title="Request a disposal" open={open} onClose={() => setOpen(false)}>
        <FormField label="Asset" htmlFor="dp-asset"><select id="dp-asset" className={inputClass} value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}><option value="">Choose…</option>{assets.data?.results.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Method" htmlFor="dp-method"><select id="dp-method" className={inputClass} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{DISPOSAL_METHODS.map((m) => <option key={m} value={m}>{pretty(m)}</option>)}</select></FormField>
          <FormField label="Proposed on" htmlFor="dp-date"><input id="dp-date" type="date" className={inputClass} value={f.proposed_on} onChange={(e) => setF({ ...f, proposed_on: e.target.value })} /></FormField>
          <FormField label="Expected proceeds" htmlFor="dp-exp"><input id="dp-exp" className={inputClass} value={f.expected_proceeds} onChange={(e) => setF({ ...f, expected_proceeds: e.target.value })} /></FormField>
          <FormField label="Buyer" htmlFor="dp-buyer"><input id="dp-buyer" className={inputClass} value={f.buyer} onChange={(e) => setF({ ...f, buyer: e.target.value })} /></FormField>
        </div>
        <FormField label="Reason" htmlFor="dp-reason"><textarea id="dp-reason" className={inputClass} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></FormField>
        {ferr && <p role="alert" className="mb-3 text-sm text-red-700">{ferr}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void submit()}>Submit for approval</Button></div>
      </Modal>
      <ActionDialog key={`rj${dlg?.id}`} title="Reject disposal" open={dlg?.kind === "reject"} onClose={() => setDlg(null)} cta="Reject" fields={[{ name: "note", label: "Reason", required: true }]} submit={(v) => act({ id: dlg!.id, action: "reject", body: { note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog key={`ex${dlg?.id}`} title="Execute disposal" open={dlg?.kind === "execute"} onClose={() => setDlg(null)} cta="Execute" fields={[{ name: "executed_on", label: "Disposed on", type: "date" }, { name: "proceeds", label: "Proceeds received", required: true }]}
        submit={async (v) => { const p = validateExecution(v.proceeds ?? "", dlg!.method); if (p) throw new Error(p); await act({ id: dlg!.id, action: "execute", body: { proceeds: (v.proceeds ?? "").trim(), ...(v.executed_on ? { executed_on: v.executed_on } : {}) } }).unwrap(); }} />
      <Certificate id={cert} onClose={() => setCert(null)} />
    </Card>
  );
}

function Report() {
  const today = new Date().toISOString().slice(0, 10);
  const [p, setP] = useState({ from: `${today.slice(0, 4)}-01-01`, to: today });
  const bad = !p.from || !p.to ? "Choose both dates." : p.to < p.from ? "The end date must be on or after the start date." : null;
  const { data, isLoading, error, refetch } = useGetDisposalReportQuery(p, { skip: !!bad });
  return (
    <Card title="Disposal report">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <FormField label="From" htmlFor="dr-from"><input id="dr-from" type="date" className={inputClass} value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} /></FormField>
        <FormField label="To" htmlFor="dr-to"><input id="dr-to" type="date" className={inputClass} value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} /></FormField>
      </div>
      {bad ? <p role="alert" className="text-sm text-red-700">{bad}</p> : isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : !data.rows.length ? <EmptyState title="No disposals in this period" /> : (
        <table className="w-full text-sm"><caption className="sr-only">Disposals</caption><thead><tr className="text-left"><th>Disposal</th><th>Asset</th><th>Method</th><th>Date</th><th className="text-right">NBV</th><th className="text-right">Proceeds</th><th className="text-right">Gain / loss</th></tr></thead>
          <tbody>{data.rows.map((r) => <tr key={r.number} className="border-t border-slate-100"><td>{r.number}</td><td>{r.asset}</td><td>{pretty(r.method)}</td><td>{r.executed_on}</td><td className="text-right">{formatMoney(r.nbv)}</td><td className="text-right">{formatMoney(r.proceeds)}</td><td className="text-right">{formatMoney(r.gain_loss)}</td></tr>)}
            <tr className="border-t border-slate-300 font-semibold"><td colSpan={4}>Total</td><td className="text-right">{formatMoney(data.totals.nbv)}</td><td className="text-right">{formatMoney(data.totals.proceeds)}</td><td className="text-right">{formatMoney(data.totals.gain_loss)}</td></tr></tbody></table>
      )}
    </Card>
  );
}

export function DisposalsPage() {
  const [tab, setTab] = useState<"list" | "report">("list");
  return (
    <>
      <PageHeader title="Asset disposals" description="Sell, scrap, donate or write off assets with approval, and keep the certificate." />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2 border-b border-slate-200">
        {([["list", "Disposals"], ["report", "Report"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-slate-900 font-semibold" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "list" ? <List /> : <Report />}
    </>
  );
}

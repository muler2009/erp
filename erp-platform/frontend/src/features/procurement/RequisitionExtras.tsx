import { useRef, useState } from "react";
import { Link } from "react-router";

import { useAttachRequisitionFileMutation, useCreateConsolidatedRfqMutation, useGenerateReplenishmentMutation, useGetRequisitionStockCheckQuery, useListSuppliersQuery, usePreviewConsolidationMutation, useStopRecurringRequisitionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { ConsolidatedLine, Requisition, StockCheckRow } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, FormField, Modal, Spinner, inputClass } from "../../shared/ui/primitives";

export const SOURCING_STATUSES = ["APPROVED", "PARTIALLY_ORDERED"];
export const ADVICE: Record<StockCheckRow["recommendation"], { label: string; tone: "green" | "amber" | "slate" }> = { ISSUE_FROM_STOCK: { label: "Enough in stock — issue instead of buying", tone: "green" }, PARTIAL_FROM_STOCK: { label: "Part in stock — buy the shortfall", tone: "amber" }, PURCHASE: { label: "Buy", tone: "slate" } };

/** "Every 30 days" and so on, for a recurring requisition. */
export const recurrenceText = (days: number | null | undefined): string | null => (days ? (days === 1 ? "Repeats every day" : `Repeats every ${days} days`) : null);

export function GenerateButton() {
  const [gen, { isLoading }] = useGenerateReplenishmentMutation();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setMsg(null);
    try { const r = await gen().unwrap(); setMsg({ ok: true, text: r.number ? `Created draft ${r.number} for items at or below their reorder level.` : "Nothing needs reordering right now." }); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); }
  };
  return <span className="inline-flex items-center gap-2"><Button variant="secondary" loading={isLoading} onClick={() => void run()}>Generate replenishment</Button>{msg && <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</span>}</span>;
}

export function ConsolidateDialog({ candidates, onClose }: { candidates: Requisition[]; onClose: () => void }) {
  const suppliers = useListSuppliersQuery({});
  const [preview, pv] = usePreviewConsolidationMutation();
  const [createRfq, cr] = useCreateConsolidatedRfqMutation();
  const [picked, setPicked] = useState<string[]>([]);
  const [lines, setLines] = useState<ConsolidatedLine[] | null>(null);
  const [sup, setSup] = useState<string[]>([]);
  const [f, setF] = useState({ title: "Consolidated sourcing", due_date: "" });
  const [done, setDone] = useState<{ rfq: string; number: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => { set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]); setLines(null); };
  const doPreview = async () => {
    if (picked.length === 0) { setErr("Choose at least one requisition."); return; }
    setErr(null);
    try { setLines((await preview(picked).unwrap()).lines); } catch (e) { setErr(errorMessage(e)); }
  };
  const doCreate = async () => {
    if (!lines || lines.length === 0) { setErr("Preview the combined items first."); return; }
    if (sup.length === 0) { setErr("Choose at least one supplier to invite."); return; }
    if (!f.title.trim()) { setErr("Give the request for quotation a title."); return; }
    setErr(null);
    try { setDone(await createRfq({ requisitions: picked, suppliers: sup, title: f.title.trim(), ...(f.due_date ? { due_date: f.due_date } : {}) }).unwrap()); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Consolidate requisitions for sourcing" open onClose={onClose}>
      {done ? (
        <>
          <p role="status" className="mb-3 text-sm text-green-700">Created request for quotation {done.number}.</p>
          <div className="flex justify-end gap-2"><Link className="text-sm text-blue-700 underline" to={`/app/procurement/rfqs/${done.rfq}`}>Open it</Link><Button variant="secondary" onClick={onClose}>Close</Button></div>
        </>
      ) : (
        <>
          <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Approved requisitions</legend>
            {candidates.length === 0 ? <p className="text-sm text-slate-600">No approved requisitions are waiting to be sourced.</p> : candidates.map((r) => <label key={r.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={picked.includes(r.id)} onChange={() => toggle(picked, setPicked, r.id)} />{r.number} — {r.title}</label>)}
          </fieldset>
          <Button variant="secondary" loading={pv.isLoading} onClick={() => void doPreview()}>Combine items</Button>
          {lines && (lines.length === 0 ? <p className="mt-3 text-sm text-slate-600">Nothing is outstanding on these requisitions.</p> : (
            <>
              <table className="mt-3 w-full text-sm"><caption className="sr-only">Combined items</caption><thead><tr className="text-left text-slate-500"><th>Item</th><th className="text-right">Total quantity</th><th>From</th></tr></thead>
                <tbody>{lines.map((l, n) => <tr key={n} className="border-t border-slate-100"><td className="py-1">{l.description}</td><td className="text-right">{Number(l.quantity)}</td><td>{l.sources.map((x) => `${x.requisition} (${Number(x.quantity)})`).join(", ")}</td></tr>)}</tbody></table>
              <fieldset className="my-3"><legend className="mb-1 text-sm font-medium">Invite suppliers</legend>
                {(suppliers.data?.results ?? []).map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sup.includes(s.id)} onChange={() => setSup(sup.includes(s.id) ? sup.filter((x) => x !== s.id) : [...sup, s.id])} />{s.name}</label>)}
              </fieldset>
              <FormField label="Title" htmlFor="cs-title"><input id="cs-title" className={inputClass} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></FormField>
              <FormField label="Quotes due by (optional)" htmlFor="cs-due"><input id="cs-due" type="date" className={inputClass} value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></FormField>
            </>
          ))}
          {err && <p role="alert" className="my-3 text-sm text-red-700">{err}</p>}
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button>{lines && lines.length > 0 && <Button loading={cr.isLoading} onClick={() => void doCreate()}>Create request for quotation</Button>}</div>
        </>
      )}
    </Modal>
  );
}

/** Stock check, recurrence and attachments for one requisition. */
export function RequisitionExtras({ req }: { req: Requisition }) {
  const { can } = useAccess();
  const create = can("procurement.requisition.create");
  const [checking, setChecking] = useState(false);
  const check = useGetRequisitionStockCheckQuery(req.id, { skip: !checking });
  const [stop] = useStopRecurringRequisitionMutation();
  const [attach] = useAttachRequisitionFileMutation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const rec = recurrenceText(req.recurring_every_days);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setMsg(null);
    try { const r = await attach({ id: req.id, file }).unwrap(); setMsg({ ok: true, text: `Attached ${r.name}.` }); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); }
    if (fileRef.current) fileRef.current.value = "";
  };
  const stopNow = async () => { setMsg(null); try { await stop(req.id).unwrap(); setMsg({ ok: true, text: "Recurrence stopped." }); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); } };
  return (
    <section className="mt-4 space-y-3 border-t border-slate-200 pt-3 text-sm" aria-label="More about this requisition">
      {(req.priority === "EMERGENCY" || req.project_ref || req.cost_center_ref || req.source === "REORDER") && (
        <p className="text-slate-600">{req.priority === "EMERGENCY" && <Badge tone="red">Emergency</Badge>} {req.source === "REORDER" ? "Raised automatically from reorder levels. " : ""}{req.project_ref ? `Project ${req.project_ref}. ` : ""}{req.cost_center_ref ? `Cost centre ${req.cost_center_ref}.` : ""}</p>
      )}
      {rec && <p className="flex items-center justify-between"><span>{rec}.</span>{create && <Button variant="secondary" onClick={() => void stopNow()}>Stop repeating</Button>}</p>}
      <div>
        <div className="flex items-center justify-between"><h3 className="font-medium">Is it already in stock?</h3>{!checking && <Button variant="secondary" onClick={() => setChecking(true)}>Check stock</Button>}</div>
        {checking && (check.isLoading ? <Spinner /> : check.isError ? <p role="alert" className="text-red-700">{errorMessage(check.error)}</p> : (
          <ul>{(check.data ?? []).map((r) => <li key={r.line} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-1"><span>{r.description}{r.stock_item ? ` — need ${Number(r.needed)}, ${Number(r.available)} available` : ""}</span><Badge tone={ADVICE[r.recommendation].tone}>{ADVICE[r.recommendation].label}</Badge></li>)}</ul>
        ))}
      </div>
      {create && (
        <div className="flex items-center justify-between"><h3 className="font-medium">Supporting document</h3>
          <input ref={fileRef} type="file" className="sr-only" aria-label="Requisition attachment" onChange={(e) => void upload(e.target.files?.[0])} />
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>Attach a file</Button></div>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-green-700" : "text-red-700"}>{msg.text}</p>}
    </section>
  );
}

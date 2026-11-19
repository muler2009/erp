import { useState } from "react";

import { useAwardRfqMutation, useCreateTenderMutation, useDisqualifyQuotationMutation, useGetTenderEvaluationQuery, useGetTenderResultsQuery, useListSuppliersQuery, useListTendersQuery, useScoreQuotationMutation, useTenderActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { TenderCriterion, TenderEvalRow, TenderInput, TenderRow } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserOptions } from "../quality/names";

export const TENDER_STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "slate" }> = {
  DRAFT: { label: "Draft", tone: "slate" },
  OPEN: { label: "Open for bids", tone: "amber" },
  CLOSED: { label: "Bidding closed", tone: "slate" },
  AWARDED: { label: "Awarded", tone: "green" },
  CANCELLED: { label: "Cancelled", tone: "red" },
};

export interface TenderDraft { title: string; closing_at: string; committee: string[]; open_to_all: boolean; suppliers: string[]; lines: { description: string; quantity: string }[]; criteria: { name: string; type: "FINANCIAL" | "TECHNICAL"; weight: string }[]; min_technical_score: string }

/** Client-side hints only; the server repeats every rule (weights, sealed bids, committee). */
export function tenderProblem(d: TenderDraft): string | null {
  if (!d.title.trim()) return "Give the tender a title.";
  if (!d.closing_at) return "Choose the closing date and time.";
  if (new Date(d.closing_at).getTime() <= Date.now()) return "The closing time must be in the future.";
  if (new Set(d.committee).size < 2) return "Choose at least two committee members.";
  if (!d.open_to_all && d.suppliers.length === 0) return "Invite suppliers or open the tender to all qualified suppliers.";
  if (d.lines.length === 0) return "Add at least one line.";
  for (const [i, l] of d.lines.entries()) {
    if (!l.description.trim()) return `Line ${i + 1}: describe the item.`;
    if (!/^\d+(\.\d+)?$/.test(l.quantity.trim()) || Number(l.quantity) <= 0) return `Line ${i + 1}: quantity must be more than 0.`;
  }
  if (d.criteria.some((c) => !c.name.trim())) return "Every criterion needs a name.";
  if (d.criteria.some((c) => !/^\d+(\.\d+)?$/.test(c.weight.trim()))) return "Every weight must be a number.";
  if (d.criteria.filter((c) => c.type === "FINANCIAL").length !== 1) return "Use exactly one financial (price) criterion.";
  const total = d.criteria.reduce((s, c) => s + Number(c.weight), 0);
  if (Math.abs(total - 100) > 0.001) return `Weights must add up to 100 (now ${total}).`;
  if (d.min_technical_score.trim() && (!/^\d+$/.test(d.min_technical_score.trim()) || Number(d.min_technical_score) > 100)) return "The minimum technical score must be between 0 and 100.";
  return null;
}

export function tenderInput(d: TenderDraft): TenderInput {
  const criteria: TenderCriterion[] = d.criteria.map((c) => ({ name: c.name.trim(), type: c.type, weight: Number(c.weight) }));
  return {
    title: d.title.trim(), closing_at: new Date(d.closing_at).toISOString(), committee: d.committee, criteria,
    lines: d.lines.map((l) => ({ description: l.description.trim(), quantity: l.quantity.trim() })),
    ...(d.open_to_all ? { open_to_all: true } : { suppliers: d.suppliers }),
    ...(d.min_technical_score.trim() ? { min_technical_score: Number(d.min_technical_score) } : {}),
  };
}

export function scoresProblem(criteria: TenderCriterion[], v: Record<string, string>): string | null {
  for (const c of criteria.filter((x) => x.type === "TECHNICAL")) {
    const raw = (v[c.name] ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) > 100) return `Score "${c.name}" from 0 to 100.`;
  }
  return null;
}

const blank = (): TenderDraft => ({ title: "", closing_at: "", committee: [], open_to_all: false, suppliers: [], lines: [{ description: "", quantity: "1" }], criteria: [{ name: "Price", type: "FINANCIAL", weight: "60" }, { name: "Technical", type: "TECHNICAL", weight: "40" }], min_technical_score: "" });

function NewTender({ open, onClose }: { open: boolean; onClose: () => void }) {
  const suppliers = useListSuppliersQuery({ status: "QUALIFIED" }, { skip: !open });
  const users = useUserOptions(!open);
  const [create, st] = useCreateTenderMutation();
  const [d, setD] = useState<TenderDraft>(blank);
  const [err, setErr] = useState<string | null>(null);
  const toggle = (k: "committee" | "suppliers", id: string) => setD((x) => ({ ...x, [k]: x[k].includes(id) ? x[k].filter((i) => i !== id) : [...x[k], id] }));
  const submit = async () => {
    const p = tenderProblem(d);
    if (p) return setErr(p);
    try { await create(tenderInput(d)).unwrap(); setD(blank()); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New tender" open={open} onClose={onClose}>
      <FormField label="Title" htmlFor="t-title"><input id="t-title" className={inputClass} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></FormField>
      <FormField label="Closing date and time" htmlFor="t-close"><input id="t-close" type="datetime-local" className={inputClass} value={d.closing_at} onChange={(e) => setD({ ...d, closing_at: e.target.value })} /></FormField>
      <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Evaluation committee (at least two)</legend>
        {users.map(([id, label]) => (<label key={id} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={d.committee.includes(id)} onChange={() => toggle("committee", id)} />{label}</label>))}
      </fieldset>
      <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={d.open_to_all} onChange={(e) => setD({ ...d, open_to_all: e.target.checked })} />Open to all qualified suppliers</label>
      {!d.open_to_all && (
        <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Invited suppliers</legend>
          {(suppliers.data?.results ?? []).map((s) => (<label key={s.id} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={d.suppliers.includes(s.id)} onChange={() => toggle("suppliers", s.id)} />{s.name}</label>))}
        </fieldset>
      )}
      <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">What you are buying</legend>
        {d.lines.map((l, n) => (
          <div key={n} className="mb-2 flex gap-2">
            <input aria-label={`Item ${n + 1}`} placeholder="Item" className={inputClass} value={l.description} onChange={(e) => setD({ ...d, lines: d.lines.map((x, j) => (j === n ? { ...x, description: e.target.value } : x)) })} />
            <input aria-label={`Quantity ${n + 1}`} className={`${inputClass} w-24`} value={l.quantity} onChange={(e) => setD({ ...d, lines: d.lines.map((x, j) => (j === n ? { ...x, quantity: e.target.value } : x)) })} />
            {d.lines.length > 1 && <Button variant="secondary" onClick={() => setD({ ...d, lines: d.lines.filter((_, j) => j !== n) })}>Remove</Button>}
          </div>
        ))}
        <Button variant="secondary" onClick={() => setD({ ...d, lines: [...d.lines, { description: "", quantity: "1" }] })}>Add an item</Button>
      </fieldset>
      <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Scoring criteria (weights add up to 100)</legend>
        {d.criteria.map((c, n) => (
          <div key={n} className="mb-2 flex gap-2">
            <input aria-label={`Criterion ${n + 1}`} className={inputClass} value={c.name} onChange={(e) => setD({ ...d, criteria: d.criteria.map((x, j) => (j === n ? { ...x, name: e.target.value } : x)) })} />
            <select aria-label={`Criterion type ${n + 1}`} className={`${inputClass} w-32`} value={c.type} onChange={(e) => setD({ ...d, criteria: d.criteria.map((x, j) => (j === n ? { ...x, type: e.target.value as "FINANCIAL" | "TECHNICAL" } : x)) })}><option value="FINANCIAL">Price</option><option value="TECHNICAL">Technical</option></select>
            <input aria-label={`Weight ${n + 1}`} className={`${inputClass} w-20`} value={c.weight} onChange={(e) => setD({ ...d, criteria: d.criteria.map((x, j) => (j === n ? { ...x, weight: e.target.value } : x)) })} />
            {d.criteria.length > 2 && <Button variant="secondary" onClick={() => setD({ ...d, criteria: d.criteria.filter((_, j) => j !== n) })}>Remove</Button>}
          </div>
        ))}
        <Button variant="secondary" onClick={() => setD({ ...d, criteria: [...d.criteria, { name: "", type: "TECHNICAL", weight: "0" }] })}>Add a criterion</Button>
      </fieldset>
      <FormField label="Minimum technical score (optional)" htmlFor="t-min"><input id="t-min" className={inputClass} value={d.min_technical_score} onChange={(e) => setD({ ...d, min_technical_score: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={submit}>Create tender</Button></div>
    </Modal>
  );
}

function Results({ id }: { id: string }) {
  const q = useGetTenderResultsQuery(id);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const rows = q.data ?? [];
  return (
    <Card title="Bidder results">
      <table className="w-full text-sm"><thead><tr className="text-left"><th>Supplier</th><th>Outcome</th><th>Rank</th><th>Score</th><th>Reason</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.supplier}><td>{r.supplier}</td><td><Badge tone={r.outcome === "AWARDED" ? "green" : r.outcome === "DISQUALIFIED" ? "red" : "slate"}>{r.outcome === "AWARDED" ? "Awarded" : r.outcome === "DISQUALIFIED" ? "Disqualified" : "Not selected"}</Badge></td><td>{r.rank ?? "—"}</td><td>{r.weighted_score ?? "—"}</td><td>{r.reason || "—"}</td></tr>))}</tbody></table>
    </Card>
  );
}

function Evaluation({ tender, onClose }: { tender: TenderRow; onClose: () => void }) {
  const { can } = useAccess();
  const q = useGetTenderEvaluationQuery(tender.id, { skip: !tender.bids_visible });
  const [score] = useScoreQuotationMutation();
  const [dq] = useDisqualifyQuotationMutation();
  const [award] = useAwardRfqMutation();
  const [scoring, setScoring] = useState<TenderEvalRow | null>(null);
  const [dqRow, setDqRow] = useState<TenderEvalRow | null>(null);
  const [awardRow, setAwardRow] = useState<TenderEvalRow | null>(null);
  const evaluate = can("procurement.tender.evaluate");
  const canAward = can("procurement.tender.award") && tender.status === "CLOSED";
  const techs = (q.data?.criteria ?? []).filter((c) => c.type === "TECHNICAL");
  return (
    <Modal title={`${tender.number} — ${tender.title}`} open onClose={onClose}>
      {tender.status === "AWARDED" && <Results id={tender.id} />}
      {tender.status !== "AWARDED" && !tender.bids_visible && <p className="text-sm">Bids are sealed. They stay hidden until the committee opens them after the closing time.</p>}
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.results.length === 0 && <EmptyState title="No bids received" hint="No supplier has submitted a bid." />}
      {q.data && q.data.results.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Rank</th><th>Supplier</th><th>Price</th><th>Score</th><th>Checks</th><th /></tr></thead>
          <tbody>{q.data.results.map((r) => (
            <tr key={r.quotation}>
              <td>{r.rank ?? "—"}</td><td>{r.supplier}{q.data?.recommended === r.quotation && <> <Badge tone="green">Recommended</Badge></>}</td><td>{r.total_base}</td><td>{r.weighted_score ?? "Not scored"}</td>
              <td>{r.compliant ? "Compliant" : r.issues.join("; ")}</td>
              <td className="flex gap-1">
                {evaluate && tender.status === "CLOSED" && <Button variant="secondary" onClick={() => setScoring(r)}>Score {r.supplier}</Button>}
                {evaluate && tender.status === "CLOSED" && <Button variant="danger" onClick={() => setDqRow(r)}>Disqualify {r.supplier}</Button>}
                {canAward && <Button onClick={() => setAwardRow(r)}>Award {r.supplier}</Button>}
              </td>
            </tr>))}</tbody></table>
      )}
      <ActionDialog title="Score technical criteria" open={!!scoring} onClose={() => setScoring(null)} cta="Save scores"
        fields={[...techs.map((c) => ({ name: c.name, label: `${c.name} (0–100)` })), { name: "comment", label: "Comment" }]}
        submit={async (v) => {
          const p = scoresProblem(q.data?.criteria ?? [], v);
          if (p) throw new Error(p);
          const scores: Record<string, number> = {};
          techs.forEach((c) => { scores[c.name] = Number(v[c.name]); });
          await score({ id: scoring!.quotation, scores, comment: v.comment ?? "" }).unwrap();
        }} />
      <ActionDialog title="Disqualify bid" open={!!dqRow} onClose={() => setDqRow(null)} cta="Disqualify"
        fields={[{ name: "reason", label: "Reason" }]}
        submit={async (v) => { if (!v.reason?.trim()) throw new Error("A reason is required."); await dq({ id: dqRow!.quotation, reason: v.reason.trim() }).unwrap(); }} />
      <ActionDialog title="Award the tender" open={!!awardRow} onClose={() => setAwardRow(null)} cta="Award and create PO"
        fields={[{ name: "justification", label: awardRow && q.data?.recommended !== awardRow.quotation ? "Justification (required: not the recommended bid)" : "Justification" }]}
        submit={async (v) => {
          if (awardRow && (q.data?.recommended !== awardRow.quotation || !awardRow.compliant) && !v.justification?.trim()) throw new Error("Explain why this bid is awarded.");
          await award({ rfqId: tender.id, quotation: awardRow!.quotation, justification: (v.justification ?? "").trim() }).unwrap();
        }} />
    </Modal>
  );
}

export default function TendersPage() {
  const { can } = useAccess();
  const q = useListTendersQuery();
  const [act, st] = useTenderActionMutation();
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<TenderRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (id: string, action: "publish" | "close" | "open") => { setErr(null); try { await act({ id, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <div>
      <PageHeader title="Tenders" description="Formal bidding with sealed bids, a committee and weighted scoring." actions={can("procurement.rfq.manage") ? <Button onClick={() => setCreating(true)}>New tender</Button> : undefined} />
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.length === 0 && <EmptyState title="No tenders yet" hint="Create a tender to invite sealed bids." />}
      {q.data && q.data.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Title</th><th>Status</th><th>Closes</th><th /></tr></thead>
          <tbody>{q.data.map((t) => {
            const s = TENDER_STATUS[t.status] ?? { label: t.status, tone: "slate" as const };
            return (
              <tr key={t.id}><td>{t.number}</td><td>{t.title}</td><td><Badge tone={s.tone}>{s.label}</Badge></td><td>{t.closing_at ? new Date(t.closing_at).toLocaleString() : "—"}</td>
                <td className="flex gap-1">
                  {can("procurement.rfq.manage") && t.status === "DRAFT" && <Button loading={st.isLoading} onClick={() => run(t.id, "publish")}>Publish {t.number}</Button>}
                  {can("procurement.rfq.manage") && t.status === "OPEN" && <Button variant="secondary" onClick={() => run(t.id, "close")}>Close bidding {t.number}</Button>}
                  {can("procurement.tender.evaluate") && t.status === "CLOSED" && !t.opened_at && <Button onClick={() => run(t.id, "open")}>Open bids {t.number}</Button>}
                  <Button variant="secondary" onClick={() => setView(t)}>View {t.number}</Button>
                </td></tr>);
          })}</tbody></table>
      )}
      <NewTender open={creating} onClose={() => setCreating(false)} />
      {view && <Evaluation tender={view} onClose={() => setView(null)} />}
    </div>
  );
}

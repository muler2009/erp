import { useState } from "react";
import { Link, useParams } from "react-router";

import { useGetQualityRiskMatrixQuery, useGetQualityRiskQuery, useListQualityConfigQuery, useListQualityRisksQuery, useQualityRiskActionMutation, useRegisterQualityRiskMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QRisk, QRiskDetail } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserSelect } from "../../shared/ui/UserSelect";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";
import { ActionsPanel, HistoryPanel } from "./panels";

export const HIGH = 15;
export const MEDIUM = 8;

export function riskLevel(score: number): "HIGH" | "MEDIUM" | "LOW" {
  return score >= HIGH ? "HIGH" : score >= MEDIUM ? "MEDIUM" : "LOW";
}
export function levelTone(level: string): "red" | "amber" | "green" {
  return level === "HIGH" ? "red" : level === "MEDIUM" ? "amber" : "green";
}
export function scaleError(label: string, v: string): string | null {
  return /^[1-5]$/.test(v.trim()) ? null : `The ${label} must be a whole number from 1 to 5.`;
}

export function validateRisk(f: { title: string; area: string; likelihood: string; impact: string; owner_id: string }): string | null {
  if (!f.title.trim()) return "Give the risk a title.";
  if (!f.area.trim()) return "Name the area it affects.";
  return scaleError("likelihood", f.likelihood) ?? scaleError("impact", f.impact) ?? (f.owner_id ? null : "Choose the owner.");
}

/** Mirrors the server's rules for changing a risk's status, in the server's order. */
export function riskStatusBlock(r: Pick<QRiskDetail, "score" | "residual_score" | "actions">, status: string, note: string): string | null {
  const live = r.actions.filter((a) => ["OPEN", "DONE"].includes(a.status));
  if (status === "ACCEPTED") {
    if (r.score >= HIGH) return "A high risk cannot be accepted; mitigate it first.";
    if (!note.trim()) return "Record the reason for accepting the risk.";
  }
  if (status === "MITIGATING" && !r.actions.some((a) => a.action_type === "MITIGATION" && ["OPEN", "DONE"].includes(a.status))) return "Assign a mitigation action first.";
  if (status === "CLOSED") {
    if (live.length) return "Every mitigation action must be verified first.";
    if (r.residual_score == null) return "Record the residual risk before closing.";
  }
  return null;
}

const CELL_BG: Record<string, string> = { HIGH: "bg-red-200", MEDIUM: "bg-amber-200", LOW: "bg-green-200" };

export function RiskMatrix({ grid }: { grid: Record<string, number> }) {
  return (
    <table className="text-center text-sm" aria-label="Risk matrix">
      <thead><tr><th className="p-1 text-left text-xs font-normal text-slate-500">Likelihood ↓ / Impact →</th>{[1, 2, 3, 4, 5].map((i) => <th key={i} className="p-1">{i}</th>)}</tr></thead>
      <tbody>{[5, 4, 3, 2, 1].map((l) => (
        <tr key={l}><th className="p-1">{l}</th>{[1, 2, 3, 4, 5].map((i) => { const n = grid[`${l}x${i}`] ?? 0; const lv = riskLevel(l * i); return <td key={i} className={`h-10 w-14 border border-white ${CELL_BG[lv]}`} aria-label={`Likelihood ${l}, impact ${i}, ${pretty(lv)}: ${n} risks`}>{n || ""}</td>; })}</tr>))}</tbody>
    </table>
  );
}

export function RisksPage() {
  const { can } = useAccess();
  const manage = can("quality.risk.manage");
  const [f, setF] = useState({ status: "", level: "" });
  const { data, isLoading, error, refetch } = useListQualityRisksQuery({ status: f.status || undefined, level: f.level || undefined });
  const matrix = useGetQualityRiskMatrixQuery();
  const categories = useListQualityConfigQuery("RISK_CATEGORY", { skip: !manage });
  const people = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [register] = useRegisterQualityRiskMutation();
  const empty = { title: "", area: "", category: "", likelihood: "", impact: "", owner_id: "", causes: "", consequences: "" };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateRisk(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { title: n.title.trim(), area: n.area.trim(), likelihood: Number(n.likelihood), impact: Number(n.impact), owner_id: n.owner_id };
    for (const k of ["category", "causes", "consequences"] as const) if (n[k].trim()) body[k] = n[k].trim();
    try { await register(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  const score = Number(n.likelihood) * Number(n.impact);
  return (
    <>
      <PageHeader title="Quality risks" description="Score is likelihood times impact: 15 and above is high, 8 and above is medium." actions={manage ? <Button onClick={() => setOpen(true)}>Register a risk</Button> : undefined} />
      <div className="grid gap-4">
        <Card title="Open risks by score">{matrix.data ? <RiskMatrix grid={matrix.data} /> : <Spinner />}</Card>
        <Card>
          <div className="mb-3 flex flex-wrap gap-3">
            <label className="text-sm">Status <select aria-label="Risk status" className={inputClass} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option>{["IDENTIFIED", "MITIGATING", "ACCEPTED", "CLOSED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
            <label className="text-sm">Level <select aria-label="Risk level" className={inputClass} value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}><option value="">All</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></select></label>
          </div>
          {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No risks match" /> : (
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Title</th><th>Area</th><th>Score</th><th>Residual</th><th>Owner</th><th>Review by</th><th>Status</th></tr></thead>
              <tbody>{data.map((r: QRisk) => (
                <tr key={r.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/risks/${r.id}`}>{r.number}</Link></td><td>{r.title}</td><td>{r.area}</td>
                  <td><Badge tone={levelTone(r.level)}>{`${r.score} ${pretty(r.level)}`}</Badge></td><td>{r.residual_score != null ? `${r.residual_score} ${pretty(r.residual_level ?? "")}` : "–"}</td><td>{nameOf(r.owner_id)}</td><td>{r.next_review_on ?? "–"}</td><td>{pretty(r.status)}</td></tr>))}</tbody></table>
          )}
        </Card>
      </div>
      <Modal title="Register a risk" open={open} onClose={() => setOpen(false)}>
        <div className="grid grid-cols-1 gap-x-3 md:grid-cols-2">
          <FormField label="Title" htmlFor="rk-title"><input id="rk-title" className={inputClass} value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} /></FormField>
          <FormField label="Area" htmlFor="rk-area"><input id="rk-area" className={inputClass} placeholder="for example supplier, process, product" value={n.area} onChange={(e) => setN({ ...n, area: e.target.value })} /></FormField>
          <FormField label="Category" htmlFor="rk-cat"><select id="rk-cat" className={inputClass} value={n.category} onChange={(e) => setN({ ...n, category: e.target.value })}><option value="">None</option>{categories.data?.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></FormField>
          <FormField label="Owner" htmlFor="rk-own"><UserSelect id="rk-own" value={n.owner_id} onChange={(x) => setN({ ...n, owner_id: x })} options={people} placeholder="Choose…" /></FormField>
          <FormField label="Likelihood (1–5)" htmlFor="rk-lik"><input id="rk-lik" className={inputClass} value={n.likelihood} onChange={(e) => setN({ ...n, likelihood: e.target.value })} /></FormField>
          <FormField label="Impact (1–5)" htmlFor="rk-imp"><input id="rk-imp" className={inputClass} value={n.impact} onChange={(e) => setN({ ...n, impact: e.target.value })} /></FormField>
        </div>
        {!scaleError("likelihood", n.likelihood) && !scaleError("impact", n.impact) && <p className="mb-2 text-sm">Score {score}: <Badge tone={levelTone(riskLevel(score))}>{pretty(riskLevel(score))}</Badge></p>}
        <FormField label="Causes" htmlFor="rk-cause"><textarea id="rk-cause" className={inputClass} value={n.causes} onChange={(e) => setN({ ...n, causes: e.target.value })} /></FormField>
        <FormField label="Consequences" htmlFor="rk-cons"><textarea id="rk-cons" className={inputClass} value={n.consequences} onChange={(e) => setN({ ...n, consequences: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Register</Button></div>
      </Modal>
    </>
  );
}

export function RiskPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.risk.manage");
  const actor = can("quality.ncr.manage");
  const { data: r, isLoading, error, refetch } = useGetQualityRiskQuery(id);
  const [act] = useQualityRiskActionMutation();
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"reassess" | "residual" | "mitigating" | "accepted" | "closed" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !r) return <ErrorState error={error} onRetry={refetch} />;
  const closed = r.status === "CLOSED";
  const gate = (status: string, next: typeof dlg) => { const m = riskStatusBlock(r, status, "x"); if (m) { setErr(m); return; } setErr(null); setDlg(next); };
  const scaleFields = [{ name: "likelihood", label: "Likelihood (1–5)", required: true }, { name: "impact", label: "Impact (1–5)", required: true }, { name: "note", label: "Note" }];
  const reassess = (residual: boolean) => async (v: Record<string, string>) => {
    const m = scaleError("likelihood", v.likelihood ?? "") ?? scaleError("impact", v.impact ?? ""); if (m) throw new Error(m);
    await act({ id: r.id, action: "reassess", body: { likelihood: Number(v.likelihood), impact: Number(v.impact), note: (v.note ?? "").trim(), residual } }).unwrap();
  };
  return (
    <>
      <PageHeader title={`${r.number} · ${r.title}`} description={`${r.area} · owner ${nameOf(r.owner_id)}`} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/risks">All risks</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone="slate">{pretty(r.status)}</Badge><Badge tone={levelTone(r.level)}>{`Score ${r.score} (${r.likelihood}×${r.impact}) ${pretty(r.level)}`}</Badge>{r.residual_score != null && <Badge tone={levelTone(r.residual_level ?? "LOW")}>{`Residual ${r.residual_score} ${pretty(r.residual_level ?? "")}`}</Badge>}{r.next_review_on && <Badge tone="slate">{`Review by ${r.next_review_on}`}</Badge>}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Risk">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2"><dt className="font-medium">Causes</dt><dd>{r.causes || "–"}</dd><dt className="font-medium">Consequences</dt><dd>{r.consequences || "–"}</dd></dl>
          {manage && !closed && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setDlg("reassess")}>Reassess</Button>
              <Button variant="secondary" onClick={() => setDlg("residual")}>Record residual risk</Button>
              {r.status !== "MITIGATING" && <Button variant="secondary" onClick={() => gate("MITIGATING", "mitigating")}>Start mitigation</Button>}
              <Button variant="secondary" onClick={() => setDlg("accepted")}>Accept the risk</Button>
              <Button onClick={() => gate("CLOSED", "closed")}>Close the risk</Button>
            </div>
          )}
        </Card>
        <ActionsPanel parent="risk" id={r.id} actions={r.actions} canManage={actor} canReport={false} open={!closed} />
        <HistoryPanel history={r.history} />
      </div>
      <ActionDialog title="Reassess risk" open={dlg === "reassess"} onClose={() => setDlg(null)} cta="Reassess" fields={scaleFields} submit={reassess(false)} />
      <ActionDialog title="Record residual risk" open={dlg === "residual"} onClose={() => setDlg(null)} cta="Record" fields={scaleFields} submit={reassess(true)} />
      <ActionDialog title="Start mitigation" open={dlg === "mitigating"} onClose={() => setDlg(null)} cta="Start" fields={[{ name: "note", label: "Note" }]} submit={(v) => act({ id: r.id, action: "status", body: { status: "MITIGATING", note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Accept the risk" open={dlg === "accepted"} onClose={() => setDlg(null)} cta="Accept" fields={[{ name: "note", label: "Reason for accepting", required: true }]}
        submit={async (v) => { const m = riskStatusBlock(r, "ACCEPTED", v.note ?? ""); if (m) throw new Error(m); await act({ id: r.id, action: "status", body: { status: "ACCEPTED", note: (v.note ?? "").trim() } }).unwrap(); }} />
      <ActionDialog title="Close the risk" open={dlg === "closed"} onClose={() => setDlg(null)} cta="Close" fields={[{ name: "note", label: "Note" }]} submit={(v) => act({ id: r.id, action: "status", body: { status: "CLOSED", note: (v.note ?? "").trim() } }).unwrap()} />
    </>
  );
}

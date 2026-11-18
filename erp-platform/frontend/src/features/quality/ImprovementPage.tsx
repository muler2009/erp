import { useState } from "react";
import { Link, useParams } from "react-router";

import { useCreateQualityInitiativeMutation, useDecideQualitySuggestionMutation, useGetQualityInitiativeQuery, useListQualityConfigQuery, useListQualityInitiativesQuery, useListQualitySuggestionsQuery, useSetQualityInitiativeStatusMutation, useSubmitQualitySuggestionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QInitiativeDetail } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserSelect } from "../../shared/ui/UserSelect";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";
import { ActionsPanel, HistoryPanel } from "./panels";

const NUM = /^-?\d+(\.\d+)?$/;

export function validateSuggestion(title: string, description: string): string | null {
  if (!title.trim()) return "Give the suggestion a title.";
  if (!description.trim()) return "Describe the improvement.";
  return null;
}

export function validateInitiative(f: { title: string; owner_id: string; target_date: string; baseline_value: string; target_value: string }): string | null {
  if (!f.title.trim()) return "Give the initiative a title.";
  if (!f.owner_id) return "Choose the owner.";
  if (!f.target_date) return "Enter the target date.";
  for (const [l, v] of [["baseline", f.baseline_value], ["target", f.target_value]] as const) if (v.trim() && !NUM.test(v.trim())) return `The ${l} value must be a number.`;
  return null;
}

/** Mirrors the server's rules for moving an initiative on. */
export function initiativeBlock(i: Pick<QInitiativeDetail, "actions">, status: string, result: string, lessons: string, progress: string): string | null {
  if (progress.trim() && (!/^\d+$/.test(progress.trim()) || Number(progress) > 100)) return "Progress must be a whole number from 0 to 100.";
  if (status === "COMPLETED") {
    if (i.actions.some((a) => ["OPEN", "DONE"].includes(a.status))) return "Every action must be verified first.";
    if (!result.trim() || !lessons.trim()) return "Record the result and the lessons learned.";
    if (!NUM.test(result.trim())) return "The result must be a number.";
  }
  return null;
}

export function ImprovementPage() {
  const { can } = useAccess();
  const reporter = can("quality.report");
  const manage = can("quality.improvement.manage");
  const sug = useListQualitySuggestionsQuery({});
  const ini = useListQualityInitiativesQuery({});
  const categories = useListQualityConfigQuery("IMPROVEMENT_CATEGORY", { skip: !reporter });
  const people = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [submit] = useSubmitQualitySuggestionMutation();
  const [decide] = useDecideQualitySuggestionMutation();
  const [create] = useCreateQualityInitiativeMutation();
  const [dlg, setDlg] = useState<"suggest" | "initiative" | null>(null);
  const [target, setTarget] = useState<{ id: string; accept: boolean } | null>(null);
  const [s, setS] = useState({ title: "", description: "", category: "" });
  const empty = { title: "", description: "", owner_id: "", target_date: "", suggestion_id: "", metric: "", baseline_value: "", target_value: "" };
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const sendSuggestion = async () => {
    const m = validateSuggestion(s.title, s.description);
    if (m) { setErr(m); return; }
    setErr(null);
    try { await submit({ title: s.title.trim(), description: s.description.trim(), ...(s.category ? { category: s.category } : {}) }).unwrap(); setDlg(null); setS({ title: "", description: "", category: "" }); } catch (e) { setErr(errorMessage(e)); }
  };
  const sendInitiative = async () => {
    const m = validateInitiative(n);
    if (m) { setErr(m); return; }
    setErr(null);
    const body: Record<string, unknown> = { title: n.title.trim(), owner_id: n.owner_id, target_date: n.target_date };
    for (const k of ["description", "suggestion_id", "metric", "baseline_value", "target_value"] as const) if (n[k].trim()) body[k] = n[k].trim();
    try { await create(body).unwrap(); setDlg(null); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  const accepted = sug.data?.results.filter((x) => x.status === "ACCEPTED") ?? [];
  return (
    <>
      <PageHeader title="Continuous improvement" description="Suggestions from anyone, and the initiatives that act on them." />
      <div className="grid gap-4">
        <Card title="Suggestions" actions={reporter ? <Button variant="secondary" onClick={() => { setErr(null); setDlg("suggest"); }}>Make a suggestion</Button> : undefined}>
          {sug.isLoading ? <Spinner /> : sug.error ? <ErrorState error={sug.error} onRetry={sug.refetch} /> : !sug.data?.results.length ? <EmptyState title="No suggestions yet" /> : (
            <ul className="text-sm">{sug.data.results.map((x) => (
              <li key={x.id} className="border-b border-slate-100 py-2"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{x.number}</span><span className="min-w-40 flex-1">{x.title}</span><span className="text-slate-500">{nameOf(x.submitted_by)}</span><Badge tone={x.status === "ACCEPTED" || x.status === "CONVERTED" ? "green" : x.status === "REJECTED" ? "red" : "amber"}>{pretty(x.status)}</Badge>
                {manage && x.status === "SUBMITTED" && <><Button variant="secondary" aria-label={`Accept ${x.number}`} onClick={() => setTarget({ id: x.id, accept: true })}>Accept</Button><Button variant="secondary" aria-label={`Decline ${x.number}`} onClick={() => setTarget({ id: x.id, accept: false })}>Decline</Button></>}</div>
                <div className="text-slate-600">{x.description}</div>{x.decision_note && <div className="text-slate-500">{`Decision: ${x.decision_note}`}</div>}</li>))}</ul>
          )}
        </Card>
        <Card title="Initiatives" actions={manage ? <Button variant="secondary" onClick={() => { setErr(null); setDlg("initiative"); }}>Start an initiative</Button> : undefined}>
          {ini.isLoading ? <Spinner /> : ini.error ? <ErrorState error={ini.error} onRetry={ini.refetch} /> : !ini.data?.results.length ? <EmptyState title="No initiatives yet" /> : (
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Title</th><th>Owner</th><th>Target date</th><th>Progress</th><th>Status</th></tr></thead>
              <tbody>{ini.data.results.map((i) => <tr key={i.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/initiatives/${i.id}`}>{i.number}</Link></td><td>{i.title}</td><td>{nameOf(i.owner_id)}</td><td>{i.target_date}</td><td>{i.progress}%</td><td>{pretty(i.status)}</td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
      <Modal title="Make a suggestion" open={dlg === "suggest"} onClose={() => setDlg(null)}>
        <FormField label="Title" htmlFor="sg-title"><input id="sg-title" className={inputClass} value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} /></FormField>
        <FormField label="Category" htmlFor="sg-cat"><select id="sg-cat" className={inputClass} value={s.category} onChange={(e) => setS({ ...s, category: e.target.value })}><option value="">None</option>{categories.data?.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></FormField>
        <FormField label="Description" htmlFor="sg-desc"><textarea id="sg-desc" className={inputClass} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button onClick={() => void sendSuggestion()}>Send suggestion</Button></div>
      </Modal>
      <Modal title="Start an initiative" open={dlg === "initiative"} onClose={() => setDlg(null)}>
        <div className="grid grid-cols-1 gap-x-3 md:grid-cols-2">
          <FormField label="Title" htmlFor="in-title"><input id="in-title" className={inputClass} value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} /></FormField>
          <FormField label="From an accepted suggestion" htmlFor="in-sug"><select id="in-sug" className={inputClass} value={n.suggestion_id} onChange={(e) => setN({ ...n, suggestion_id: e.target.value })}><option value="">None</option>{accepted.map((x) => <option key={x.id} value={x.id}>{x.number} {x.title}</option>)}</select></FormField>
          <FormField label="Owner" htmlFor="in-own"><UserSelect id="in-own" value={n.owner_id} onChange={(x) => setN({ ...n, owner_id: x })} options={people} placeholder="Choose…" /></FormField>
          <FormField label="Target date" htmlFor="in-date"><input id="in-date" type="date" className={inputClass} value={n.target_date} onChange={(e) => setN({ ...n, target_date: e.target.value })} /></FormField>
          <FormField label="Measure" htmlFor="in-met"><input id="in-met" className={inputClass} placeholder="for example scrap rate %" value={n.metric} onChange={(e) => setN({ ...n, metric: e.target.value })} /></FormField>
          <FormField label="Baseline value" htmlFor="in-base"><input id="in-base" className={inputClass} value={n.baseline_value} onChange={(e) => setN({ ...n, baseline_value: e.target.value })} /></FormField>
          <FormField label="Target value" htmlFor="in-tv"><input id="in-tv" className={inputClass} value={n.target_value} onChange={(e) => setN({ ...n, target_value: e.target.value })} /></FormField>
        </div>
        <FormField label="Description" htmlFor="in-desc"><textarea id="in-desc" className={inputClass} value={n.description} onChange={(e) => setN({ ...n, description: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button onClick={() => void sendInitiative()}>Start initiative</Button></div>
      </Modal>
      <ActionDialog title={target?.accept ? "Accept suggestion" : "Decline suggestion"} open={!!target} onClose={() => setTarget(null)} cta={target?.accept ? "Accept" : "Decline"} fields={[{ name: "note", label: "Reason for the decision", required: true }]}
        submit={(v) => decide({ id: target!.id, body: { accept: target!.accept, note: (v.note ?? "").trim() } }).unwrap()} />
    </>
  );
}

export function InitiativePage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.improvement.manage");
  const actor = can("quality.ncr.manage");
  const { data: i, isLoading, error, refetch } = useGetQualityInitiativeQuery(id);
  const [setStatus] = useSetQualityInitiativeStatusMutation();
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"APPROVED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !i) return <ErrorState error={error} onRetry={refetch} />;
  const done = ["COMPLETED", "CANCELLED"].includes(i.status);
  const send = (status: string, extra: Record<string, unknown>) => setStatus({ id: i.id, body: { status, ...extra } }).unwrap();
  return (
    <>
      <PageHeader title={`${i.number} · ${i.title}`} description={i.description || undefined} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/improvement">All improvement work</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={i.status === "COMPLETED" ? "green" : i.status === "CANCELLED" ? "slate" : "amber"}>{pretty(i.status)}</Badge><Badge tone="slate">{`${i.progress}% complete`}</Badge><Badge tone="slate">{`Owner ${nameOf(i.owner_id)}`}</Badge><Badge tone="slate">{`Target date ${i.target_date}`}</Badge></div>
      <div className="grid gap-4">
        <Card title="Result">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4"><dt className="font-medium">Measure</dt><dd>{i.metric || "–"}</dd><dt className="font-medium">Baseline</dt><dd>{i.baseline_value ?? "–"}</dd><dt className="font-medium">Target</dt><dd>{i.target_value ?? "–"}</dd><dt className="font-medium">Result</dt><dd>{i.result_value ?? "–"}</dd></dl>
          {i.lessons_learned && <p className="mt-2 text-sm">{`Lessons learned: ${i.lessons_learned}`}</p>}
          {manage && !done && (
            <div className="mt-3 flex flex-wrap gap-2">
              {i.status === "PROPOSED" && <Button onClick={() => setDlg("APPROVED")}>Approve</Button>}
              {["PROPOSED", "APPROVED"].includes(i.status) && <Button variant="secondary" onClick={() => setDlg("IN_PROGRESS")}>Start work</Button>}
              {i.status !== "PROPOSED" && <Button onClick={() => setDlg("COMPLETED")}>Complete</Button>}
              <Button variant="secondary" onClick={() => setDlg("CANCELLED")}>Cancel initiative</Button>
            </div>
          )}
        </Card>
        <ActionsPanel parent="initiative" id={i.id} actions={i.actions} canManage={actor} canReport={false} open={!done} />
        <HistoryPanel history={i.history} />
      </div>
      <ActionDialog title="Approve initiative" open={dlg === "APPROVED"} onClose={() => setDlg(null)} cta="Approve" fields={[{ name: "note", label: "Note" }]} submit={(v) => send("APPROVED", { note: (v.note ?? "").trim() })} />
      <ActionDialog title="Start work" open={dlg === "IN_PROGRESS"} onClose={() => setDlg(null)} cta="Start" fields={[{ name: "progress", label: "Progress (0–100)" }]}
        submit={async (v) => { const m = initiativeBlock(i, "IN_PROGRESS", "", "", v.progress ?? ""); if (m) throw new Error(m); await send("IN_PROGRESS", (v.progress ?? "").trim() ? { progress: Number(v.progress) } : {}); }} />
      <ActionDialog title="Complete initiative" open={dlg === "COMPLETED"} onClose={() => setDlg(null)} cta="Complete" fields={[{ name: "result_value", label: "Result achieved", required: true }, { name: "lessons_learned", label: "Lessons learned", required: true }]}
        submit={async (v) => { const m = initiativeBlock(i, "COMPLETED", v.result_value ?? "", v.lessons_learned ?? "", ""); if (m) throw new Error(m); await send("COMPLETED", { result_value: (v.result_value ?? "").trim(), lessons_learned: (v.lessons_learned ?? "").trim() }); }} />
      <ActionDialog title="Cancel initiative" open={dlg === "CANCELLED"} onClose={() => setDlg(null)} cta="Cancel initiative" fields={[{ name: "note", label: "Reason", required: true }]} submit={(v) => send("CANCELLED", { note: (v.note ?? "").trim() })} />
    </>
  );
}

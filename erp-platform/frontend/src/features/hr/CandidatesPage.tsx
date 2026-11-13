import { useState } from "react";
import { Link, useParams } from "react-router";

import { useAddCandidateMutation, useCreateOfferMutation, useGetScorecardQuery, useHireCandidateMutation, useInterviewFeedbackMutation, useListCandidatesQuery, useListMyInterviewsQuery, useMoveCandidateMutation, useOfferActionMutation, useScheduleInterviewMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Candidate, Interview } from "../../shared/api/types";
import { parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserPicker } from "../../shared/ui/UserPicker";
import { ActionDialog, failure } from "./ActionDialog";
import { toIsoWithZone } from "./AttendanceAdminPage";
import { pretty } from "./EmployeeDialogs";

export function validateOffer(f: { monthly_salary: string; currency: string; start_date: string }, today = new Date().toISOString().slice(0, 10)): string | null {
  const s = parseMoney(f.monthly_salary);
  if (s === null || s <= 0n) return "Enter a monthly salary greater than zero.";
  if (!/^[A-Z]{3}$/.test(f.currency)) return "Currency must be a 3-letter code such as USD.";
  if (!f.start_date || f.start_date < today) return "Choose a start date that is today or later.";
  return null;
}

export function validateFeedback(f: { score: string; recommendation: string }): string | null {
  if (!/^[1-5]$/.test(f.score)) return "Score must be a whole number from 1 to 5.";
  if (!["HIRE", "NO_HIRE"].includes(f.recommendation)) return "Choose a recommendation.";
  return null;
}

const NEXT_STAGE: Record<string, string> = { APPLIED: "SCREENING", SCREENING: "INTERVIEW" };

function Scorecard({ id }: { id: string }) {
  const { data, isLoading } = useGetScorecardQuery(id);
  if (isLoading) return <Spinner />;
  if (!data) return null;
  return <p className="text-sm text-slate-600">{data.interviews} interview(s) done · average {data.average_score ?? "n/a"} · {data.hire_votes} hire / {data.no_hire_votes} no-hire</p>;
}

function ScheduleDialog({ candidate, onClose }: { candidate: Candidate | null; onClose: () => void }) {
  const [schedule, state] = useScheduleInterviewMutation();
  const [who, setWho] = useState<string | null>(null);
  const [at, setAt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (!who) { setErr("Choose an interviewer."); return; }
    if (!at) { setErr("Choose a date and time."); return; }
    try { await schedule({ id: candidate!.id, interviewer: who, scheduled_at: toIsoWithZone(at) }).unwrap(); setWho(null); setAt(""); setErr(null); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Schedule interview" open={!!candidate} onClose={onClose}>
      <UserPicker label="Interviewer" onChange={(u) => setWho(u?.id ?? null)} />
      <FormField label="Date and time" htmlFor="iv-at"><input id="iv-at" type="datetime-local" className={inputClass} value={at} onChange={(e) => setAt(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Schedule</Button></div>
    </Modal>
  );
}

function CandidateRow({ c, onSchedule }: { c: Candidate; onSchedule: (c: Candidate) => void }) {
  const [move] = useMoveCandidateMutation();
  const [hire, hiring] = useHireCandidateMutation();
  const [offerAct] = useOfferActionMutation();
  const [create] = useCreateOfferMutation();
  const { can } = useAccess();
  const [err, setErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<"reject" | "withdraw" | "offer" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const open = !["HIRED", "REJECTED", "WITHDRAWN"].includes(c.stage);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(failure(e)); } };
  const offer = c.offer;
  const next = NEXT_STAGE[c.stage];
  return (
    <li className="border-b border-slate-200 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <strong>{c.name}</strong><span className="text-sm text-slate-500">{c.email}</span><Badge tone={c.stage === "HIRED" ? "green" : c.stage === "REJECTED" || c.stage === "WITHDRAWN" ? "red" : "slate"}>{pretty(c.stage)}</Badge>
        {c.reason && <span className="text-sm text-slate-500">Reason: {c.reason}</span>}
      </div>
      {c.interviews.length > 0 && <ul className="mt-1 text-sm text-slate-600">{c.interviews.map((i) => <li key={i.id}>Interview {new Date(i.scheduled_at).toLocaleString()} — {pretty(i.status)}{i.score ? ` · ${i.score}/5 ${pretty(i.recommendation)}` : ""}</li>)}</ul>}
      {c.stage === "INTERVIEW" && <Scorecard id={c.id} />}
      {offer && <p className="mt-1 text-sm">Offer: {offer.monthly_salary} {offer.currency} from {offer.start_date} — <Badge tone={offer.status === "ACCEPTED" ? "green" : offer.status === "DECLINED" || offer.status === "WITHDRAWN" ? "red" : "amber"}>{pretty(offer.status)}</Badge></p>}
      {done && <p role="status" className="mt-1 text-sm text-green-700">{done}</p>}
      {err && <p role="alert" className="mt-1 text-sm text-red-700">{err}</p>}
      {open && (
        <div className="mt-2 flex flex-wrap gap-2">
          {next && <Button variant="secondary" onClick={() => void run(() => move({ id: c.id, stage: next }).unwrap())}>Move to {pretty(next)}</Button>}
          {c.stage === "INTERVIEW" && <Button variant="secondary" onClick={() => onSchedule(c)}>Schedule interview</Button>}
          {c.stage === "INTERVIEW" && !offer && <Button variant="secondary" onClick={() => setDlg("offer")}>Make offer</Button>}
          {offer?.status === "DRAFT" && can("hr.recruitment.approve") && <Button onClick={() => void run(() => offerAct({ id: offer.id, action: "approve" }).unwrap())}>Approve offer</Button>}
          {offer?.status === "APPROVED" && <><Button onClick={() => void run(() => offerAct({ id: offer.id, action: "accept" }).unwrap())}>Offer accepted</Button><Button variant="secondary" onClick={() => void run(() => offerAct({ id: offer.id, action: "decline" }).unwrap())}>Offer declined</Button></>}
          {offer?.status === "ACCEPTED" && <Button loading={hiring.isLoading} onClick={() => void run(async () => { const r = await hire(c.id).unwrap(); setDone(`Hired as employee ${r.employee_no}.`); })}>Hire</Button>}
          <Button variant="secondary" onClick={() => setDlg("reject")}>Reject</Button>
          <Button variant="secondary" onClick={() => setDlg("withdraw")}>Withdrawn</Button>
        </div>
      )}
      <ActionDialog title={`Reject ${c.name}`} open={dlg === "reject"} onClose={() => setDlg(null)} cta="Reject candidate" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => move({ id: c.id, stage: "REJECTED", reason: (v.reason ?? "") }).unwrap()} />
      <ActionDialog title={`Withdraw ${c.name}`} open={dlg === "withdraw"} onClose={() => setDlg(null)} cta="Mark withdrawn" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => move({ id: c.id, stage: "WITHDRAWN", reason: (v.reason ?? "") }).unwrap()} />
      <ActionDialog title={`Offer for ${c.name}`} open={dlg === "offer"} onClose={() => setDlg(null)} cta="Create offer" fields={[{ name: "monthly_salary", label: "Monthly salary", required: true }, { name: "currency", label: "Currency", required: true }, { name: "start_date", label: "Start date", type: "date", required: true }]}
        submit={async (v) => { const p = validateOffer({ monthly_salary: (v.monthly_salary ?? ""), currency: (v.currency ?? "").toUpperCase(), start_date: (v.start_date ?? "") }); if (p) throw new Error(p); await create({ id: c.id, monthly_salary: (v.monthly_salary ?? "").trim(), currency: (v.currency ?? "").toUpperCase(), start_date: (v.start_date ?? "") }).unwrap(); }} />
    </li>
  );
}

export function CandidatesPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error, refetch } = useListCandidatesQuery(id);
  const [adding, setAdding] = useState(false);
  const [add] = useAddCandidateMutation();
  const [sched, setSched] = useState<Candidate | null>(null);
  return (
    <>
      <PageHeader title="Candidates" description="Move candidates through screening and interview, then offer and hire." actions={<><Link className="mr-3 text-sm underline" to="/app/hr/recruitment">Back to requisitions</Link><Button onClick={() => setAdding(true)}>Add candidate</Button></>} />
      <Card title="Pipeline">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No candidates yet" /> : <ul>{data.results.map((c) => <CandidateRow key={c.id} c={c} onSchedule={setSched} />)}</ul>}
      </Card>
      <ActionDialog title="Add candidate" open={adding} onClose={() => setAdding(false)} cta="Add" fields={[{ name: "name", label: "Name", required: true }, { name: "email", label: "Email", type: "email", required: true }, { name: "phone", label: "Phone" }, { name: "source", label: "Source" }]}
        submit={(v) => add({ req: id, body: { name: (v.name ?? "").trim(), email: (v.email ?? "").trim(), phone: v.phone ?? "", source: v.source ?? "" } }).unwrap()} />
      <ScheduleDialog candidate={sched} onClose={() => setSched(null)} />
    </>
  );
}

function FeedbackDialog({ interview, onClose }: { interview: Interview | null; onClose: () => void }) {
  const [send] = useInterviewFeedbackMutation();
  return (
    <ActionDialog title={`Feedback: ${interview?.candidate_name ?? ""}`} open={!!interview} onClose={onClose} cta="Submit feedback"
      fields={[{ name: "score", label: "Score (1-5)", required: true }, { name: "recommendation", label: "Recommendation", required: true, options: [["HIRE", "Hire"], ["NO_HIRE", "Do not hire"]] }, { name: "feedback", label: "Comments" }]}
      submit={async (v) => { const p = validateFeedback({ score: (v.score ?? ""), recommendation: (v.recommendation ?? "") }); if (p) throw new Error(p); await send({ id: interview!.id, score: Number((v.score ?? "")), recommendation: (v.recommendation ?? ""), feedback: v.feedback ?? "" }).unwrap(); }} />
  );
}

export function MyInterviewsPage() {
  const { data, isLoading, error, refetch } = useListMyInterviewsQuery();
  const [fb, setFb] = useState<Interview | null>(null);
  return (
    <>
      <PageHeader title="My interviews" description="Interviews assigned to you that still need feedback." />
      <Card title="Scheduled">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No interviews waiting for feedback" /> : (
          <ul>{data.map((i) => <li key={i.id} className="flex items-center justify-between border-b border-slate-200 py-2"><span>{i.candidate_name} — {new Date(i.scheduled_at).toLocaleString()}</span><Button onClick={() => setFb(i)}>Give feedback</Button></li>)}</ul>
        )}
      </Card>
      <FeedbackDialog interview={fb} onClose={() => setFb(null)} />
    </>
  );
}

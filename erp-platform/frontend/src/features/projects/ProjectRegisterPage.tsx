import { useState } from "react";
import { useParams } from "react-router";

import { useListProjectIssuesQuery, useListProjectRisksQuery, useRaiseProjectIssueMutation, useRaiseProjectRiskMutation, useUpdateProjectIssueMutation, useUpdateProjectRiskMutation } from "../../shared/api/endpoints";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { ProjectNav } from "./ProjectFinancePage";

export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const ISSUE_NEXT: Record<string, string[]> = { OPEN: ["IN_PROGRESS", "RESOLVED"], IN_PROGRESS: ["OPEN", "RESOLVED"], RESOLVED: ["IN_PROGRESS", "CLOSED"] };
const RISK_NEXT: Record<string, string[]> = { OPEN: ["MITIGATING", "OCCURRED", "CLOSED"], MITIGATING: ["OPEN", "OCCURRED", "CLOSED"], OCCURRED: ["CLOSED"] };

export function validateScale(v: string): boolean { return /^[1-5]$/.test(v); }
export function scoreTone(score: number): "red" | "amber" | "green" { return score >= 15 ? "red" : score >= 8 ? "amber" : "green"; }

export function ProjectRegisterPage() {
  const { id = "" } = useParams();
  const risks = useListProjectRisksQuery(id);
  const issues = useListProjectIssuesQuery(id);
  const [raiseRisk] = useRaiseProjectRiskMutation();
  const [raiseIssue] = useRaiseProjectIssueMutation();
  const [updRisk] = useUpdateProjectRiskMutation();
  const [updIssue] = useUpdateProjectIssueMutation();
  const [dlg, setDlg] = useState<"risk" | "issue" | null>(null);
  const [step, setStep] = useState<{ kind: "risk" | "issue"; id: string; to: string } | null>(null);
  const needsNote = step && ((step.kind === "risk" && step.to === "CLOSED") || (step.kind === "risk" && step.to === "MITIGATING") || (step.kind === "issue" && step.to === "RESOLVED"));
  return (
    <>
      <PageHeader title="Risks and issues" description="What might go wrong, and what already has." actions={<><Button variant="secondary" onClick={() => setDlg("risk")}>Raise risk</Button> <Button onClick={() => setDlg("issue")}>Raise issue</Button></>} />
      <ProjectNav id={id} current="risks" />
      <Card title="Risks">
        {risks.isLoading ? <Spinner /> : risks.error ? <ErrorState error={risks.error} onRetry={risks.refetch} /> : !risks.data?.results.length ? <EmptyState title="No risks recorded" /> : (
          <ul>{risks.data.results.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2">
              <span className="min-w-40 flex-1">{r.title}</span><Badge tone={scoreTone(r.score)}>Score {r.score} ({r.probability}×{r.impact})</Badge><Badge tone="slate">{pretty(r.status)}</Badge>
              {(RISK_NEXT[r.status] ?? []).map((s) => <Button key={s} variant="secondary" onClick={() => setStep({ kind: "risk", id: r.id, to: s })}>{`Mark ${pretty(s)}`}</Button>)}
            </li>))}</ul>
        )}
      </Card>
      <div className="mt-4"><Card title="Issues">
        {issues.isLoading ? <Spinner /> : issues.error ? <ErrorState error={issues.error} onRetry={issues.refetch} /> : !issues.data?.results.length ? <EmptyState title="No issues recorded" /> : (
          <ul>{issues.data.results.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2">
              <span className="min-w-40 flex-1">{i.title}</span><Badge tone={i.severity === "CRITICAL" || i.severity === "HIGH" ? "red" : "amber"}>{pretty(i.severity)}</Badge><Badge tone="slate">{pretty(i.status)}</Badge>
              {i.resolution && <span className="text-sm text-slate-500">{i.resolution}</span>}
              {(ISSUE_NEXT[i.status] ?? []).map((s) => <Button key={s} variant="secondary" onClick={() => setStep({ kind: "issue", id: i.id, to: s })}>{`Mark ${pretty(s)}`}</Button>)}
            </li>))}</ul>
        )}
      </Card></div>
      <ActionDialog title="Raise risk" open={dlg === "risk"} onClose={() => setDlg(null)} cta="Raise risk" fields={[{ name: "title", label: "Title", required: true }, { name: "probability", label: "Probability (1-5)", required: true }, { name: "impact", label: "Impact (1-5)", required: true }, { name: "description", label: "Description" }, { name: "mitigation", label: "Mitigation plan" }]}
        submit={async (v) => { if (!validateScale(v.probability ?? "") || !validateScale(v.impact ?? "")) throw new Error("Probability and impact are whole numbers from 1 to 5."); await raiseRisk({ id, title: (v.title ?? "").trim(), probability: Number(v.probability), impact: Number(v.impact), description: v.description ?? "", mitigation: v.mitigation ?? "" }).unwrap(); }} />
      <ActionDialog title="Raise issue" open={dlg === "issue"} onClose={() => setDlg(null)} cta="Raise issue" fields={[{ name: "title", label: "Title", required: true }, { name: "severity", label: "Severity", required: true, options: SEVERITIES.map((s) => [s, pretty(s)] as [string, string]) }, { name: "description", label: "Description" }]}
        submit={(v) => raiseIssue({ id, title: (v.title ?? "").trim(), severity: v.severity ?? "MEDIUM", description: v.description ?? "" }).unwrap()} />
      <ActionDialog key={step ? `${step.kind}-${step.id}-${step.to}` : "none"} title={step ? `Mark ${step.kind} ${pretty(step.to)}` : "Update"} open={!!step} onClose={() => setStep(null)} cta="Confirm"
        fields={needsNote ? [{ name: "note", label: step!.kind === "risk" && step!.to === "MITIGATING" ? "Mitigation plan" : step!.kind === "risk" ? "Why is it closed?" : "Resolution", required: true }] : []}
        submit={async (v) => {
          const s = step!;
          if (s.kind === "risk") await updRisk({ id: s.id, status: s.to, ...(s.to === "MITIGATING" ? { mitigation: (v.note ?? "").trim() } : { note: (v.note ?? "").trim() }) }).unwrap();
          else await updIssue({ id: s.id, status: s.to, resolution: (v.note ?? "").trim() }).unwrap();
        }} />
    </>
  );
}

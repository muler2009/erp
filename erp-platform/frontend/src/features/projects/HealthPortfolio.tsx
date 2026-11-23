import { Link } from "react-router";

import { useGetProjectHealthQuery, useGetProjectPortfolioQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney } from "../../shared/lib/money";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { useUserNames } from "../quality/names";
import { pretty } from "./ProjectsPage";

export const REASON: Record<string, string> = {
  COST_OVERRUN: "Costs are well over plan", BEHIND_SCHEDULE: "Well behind schedule", CRITICAL_ISSUE: "A critical issue is open", MILESTONE_OVERDUE: "A milestone is overdue", PAST_END_DATE: "Past its end date",
  COST_PRESSURE: "Costs are running over plan", SCHEDULE_PRESSURE: "Slipping behind schedule", OVERDUE_TASKS: "Some tasks are overdue", OPEN_HIGH_RISK_OR_ISSUE: "A high risk or issue is open",
};
export const reasonText = (r: string) => REASON[r] ?? pretty(r);
export const ragTone = (rag: string | null): "green" | "red" | "amber" | "slate" => (rag === "RED" ? "red" : rag === "AMBER" ? "amber" : rag === "GREEN" ? "green" : "slate");
export const ragLabel = (rag: string | null) => (rag === "RED" ? "Off track" : rag === "AMBER" ? "At risk" : rag === "GREEN" ? "On track" : "Not rated");
const idx = (v: string | null) => (v === null ? "–" : Number(v).toFixed(2));

export function HealthCard({ id }: { id: string }) {
  const q = useGetProjectHealthQuery(id);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p role="alert" className="mb-3 text-sm text-slate-600">Health could not be shown: {errorMessage(q.error)}</p>;
  const h = q.data;
  return (
    <div className="mb-4"><Card title="Health">
      <p className="mb-2 text-sm"><Badge tone={ragTone(h.rag)}>{ragLabel(h.rag)}</Badge> · {Number(h.percent_complete).toFixed(0)}% complete · {h.overdue_tasks} overdue task{h.overdue_tasks === 1 ? "" : "s"}</p>
      {h.reasons.length > 0 && <ul className="mb-2 list-disc pl-5 text-sm text-slate-700">{h.reasons.map((r) => <li key={r}>{reasonText(r)}</li>)}</ul>}
      <p className="text-xs text-slate-500">Cost index {idx(h.cpi)} · Schedule index {idx(h.spi)} (1.00 is on plan) · {h.open_risks} open risks ({h.high_risks} high) · {h.open_issues} open issues ({h.critical_issues} critical)</p>
    </Card></div>
  );
}

export function PortfolioPage() {
  const q = useGetProjectPortfolioQuery();
  const name = useUserNames();
  const d = q.data;
  const showMargin = !!d?.projects.some((p) => p.margin !== undefined);
  return (
    <>
      <PageHeader title="Project portfolio" description="Every project you can see, with its health." />
      {q.isLoading ? <Spinner /> : q.error || !d ? <ErrorState error={q.error} onRetry={q.refetch} /> : d.projects.length === 0 ? <EmptyState title="No projects" /> : (
        <>
          <div className="mb-3 grid gap-3 sm:grid-cols-3">
            {(["GREEN", "AMBER", "RED"] as const).map((k) => <Card key={k} title={ragLabel(k)}><p className="text-2xl font-semibold">{d.rag[k]}</p></Card>)}
          </div>
          <p className="mb-3 text-sm text-slate-600">{Object.entries(d.by_status).map(([s, n]) => `${n} ${pretty(s).toLowerCase()}`).join(" · ")}</p>
          <Card>
            <table className="w-full text-sm"><caption className="sr-only">Portfolio</caption>
              <thead><tr className="text-left text-slate-500"><th>Project</th><th>Status</th><th>Health</th><th>Why</th><th className="text-right">Done</th>{showMargin && <th className="text-right">Margin</th>}<th>Manager</th></tr></thead>
              <tbody>{d.projects.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td><Link className="text-indigo-700 underline" to={`/app/projects/projects/${p.id}`}>{p.code}</Link> {p.name}</td>
                  <td>{pretty(p.status)}</td>
                  <td><Badge tone={ragTone(p.rag)}>{ragLabel(p.rag)}</Badge></td>
                  <td className="text-xs text-slate-600">{p.reasons.map(reasonText).join("; ") || "–"}</td>
                  <td className="text-right">{Number(p.percent_complete).toFixed(0)}%</td>
                  {showMargin && <td className="text-right">{p.margin !== undefined ? formatMoney(p.margin) : "–"}</td>}
                  <td>{name(p.manager_id)}</td>
                </tr>))}</tbody></table>
          </Card>
        </>
      )}
    </>
  );
}

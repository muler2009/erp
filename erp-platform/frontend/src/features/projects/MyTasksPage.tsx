import { useState } from "react";

import { useListMyTasksQuery } from "../../shared/api/endpoints";
import type { ProjectTask } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { Button, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ProgressDialog } from "./ProjectPage";
import { pretty } from "./ProjectsPage";

/** Open tasks assigned to me on active projects, soonest due first (server order). */
export function MyTasksPage() {
  const { data, isLoading, error, refetch } = useListMyTasksQuery();
  const [open, setOpen] = useState<ProjectTask | null>(null);
  return (
    <>
      <PageHeader title="My tasks" description="Open tasks assigned to you on active projects." />
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={() => void refetch()} /> : data!.results.length === 0 ? <EmptyState title="Nothing assigned to you" /> : (
        <table className="w-full text-sm">
          <thead><tr className="text-left"><th>Project</th><th>Task</th><th>Due</th><th className="text-right">Done</th><th>Status</th><th /></tr></thead>
          <tbody>{data!.results.map((t) => <tr key={t.id} className="border-t border-slate-100"><td>{t.project}</td><td>{t.milestone ? "◆ " : ""}{t.name}</td><td>{t.planned_end}</td><td className="text-right">{formatMoney(t.percent_complete)}%</td><td>{pretty(t.status)}</td><td><Button variant="secondary" onClick={() => setOpen(t)}>Update progress</Button></td></tr>)}</tbody>
        </table>
      )}
      {open && <ProgressDialog key={open.id} task={open} onClose={() => setOpen(null)} />}
    </>
  );
}

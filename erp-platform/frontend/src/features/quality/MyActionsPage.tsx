import { useState } from "react";

import { useListMyQualityActionsQuery, useQualityActionDecisionMutation } from "../../shared/api/endpoints";
import type { QAction } from "../../shared/api/types";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export function MyActionsPage() {
  const { data, isLoading, error, refetch } = useListMyQualityActionsQuery();
  const [decide] = useQualityActionDecisionMutation();
  const [target, setTarget] = useState<QAction | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <>
      <PageHeader title="My quality actions" description="Actions assigned to you across quality records." />
      <Card>
        {data.length === 0 ? <EmptyState title="Nothing assigned to you" /> : (
          <ul className="divide-y">
            {data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <div className="font-medium">{a.description}</div>
                  <div className="text-slate-600">{pretty(a.action_type)} · due {a.due_date} · on {pretty(a.parent_type)}</div>
                </div>
                <div className="flex items-center gap-2">
                  {a.overdue && <Badge tone="red">Overdue</Badge>}
                  <Badge tone="slate">{pretty(a.status)}</Badge>
                  {a.status === "OPEN" && <Button variant="secondary" onClick={() => setTarget(a)} aria-label={`Complete: ${a.description}`}>Complete</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ActionDialog title="Complete action" open={!!target} onClose={() => setTarget(null)} cta="Mark done" fields={[{ name: "note", label: "What was done", required: true }]}
        submit={(v) => decide({ id: target!.id, action: "done", body: { note: (v.note ?? "").trim() } }).unwrap()} />
    </>
  );
}

import { useState } from "react";

import { AddWidgetDialog, DashboardDialog } from "../analytics/DashboardEditor";
import { errorMessage } from "../../shared/api/errors";

import { useDeleteBiWidgetMutation, useGetDashboardQuery, useListDashboardsQuery, useSeedDashboardsMutation, useUpdateBiWidgetMutation } from "../../shared/api/endpoints";
import type { KpiView, WidgetData } from "../../shared/api/types";
import { formatNumber } from "../../shared/lib/format";
import { Can } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";

const statusTone = { GOOD: "green", WARN: "amber", CRITICAL: "red", NO_DATA: "slate", NO_TARGET: "slate" } as const;

function Kpi({ kpi }: { kpi: KpiView }) {
  const status = kpi.latest?.status ?? "NO_DATA";
  return (
    <div>
      <p className="text-3xl font-semibold text-slate-900">
        {kpi.latest?.value != null ? formatNumber(kpi.latest.value) : "—"} <span className="text-base font-normal text-slate-500">{kpi.unit}</span>
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Badge tone={statusTone[status]}>{status.replace("_", " ")}</Badge>
        {kpi.change_pct != null && <span className="text-xs text-slate-500">{kpi.change_pct}% vs previous</span>}
      </div>
    </div>
  );
}

function Widget({ w }: { w: WidgetData }) {
  if (w.restricted || w.data == null) {
    return (
      <p className="text-sm text-slate-500">{w.restricted ? "You do not have access to this data." : "No data available."}</p>
    );
  }
  if (w.kind === "KPI") return <Kpi kpi={w.data} />;
  if (w.kind === "TREND") {
    return (
      <div>
        <Kpi kpi={w.data.kpi} />
        <ol className="mt-3 space-y-1 text-xs text-slate-600" aria-label="Recent values">
          {w.data.series.slice(-6).map((s) => (
            <li key={s.as_of} className="flex justify-between">
              <span>{s.as_of}</span>
              <span>{s.value != null ? formatNumber(s.value) : "—"}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  const rows = w.data.rows;
  if (rows.length === 0) return <p className="text-sm text-slate-500">No rows.</p>;
  const cols = Object.keys(rows[0] ?? {});
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} scope="col" className="px-2 py-1 text-left font-medium text-slate-600">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 10).map((r, i) => (
            <tr key={i} className="border-t border-slate-100">
              {cols.map((c) => (
                <td key={c} className="px-2 py-1">
                  {String(r[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPage() {
  const list = useListDashboardsQuery();
  const [picked, setPicked] = useState<string | null>(null);
  const activeId = picked ?? list.data?.[0]?.id ?? null;
  const view = useGetDashboardQuery(activeId ?? "", { skip: !activeId });
  const [seed, seeding] = useSeedDashboardsMutation();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [moveWidget] = useUpdateBiWidgetMutation();
  const [removeWidget] = useDeleteBiWidgetMutation();
  const [editErr, setEditErr] = useState<string | null>(null);
  const failed = (e: unknown) => setEditErr(errorMessage(e));
  const active = list.data?.find((d) => d.id === activeId) ?? null;

  return (
    <>
      <PageHeader title="Dashboard" description="Key figures you are allowed to see." actions={<Can permission="analytics.dashboard.manage"><Button onClick={() => setCreating(true)}>New dashboard</Button></Can>} />
      {creating && <DashboardDialog dashboard={null} open onClose={() => setCreating(false)} onSaved={(id) => setPicked(id)} />}
      {list.isLoading && <Spinner />}
      {list.error && <ErrorState error={list.error} onRetry={list.refetch} />}
      {list.data && list.data.length === 0 && (
        <Card>
          <EmptyState title="No dashboards yet" hint="Default dashboards can be created for this workspace." />
          <Can permission="analytics.dashboard.manage">
            <div className="text-center">
              <Button loading={seeding.isLoading} onClick={() => void seed()}>
                Create default dashboards
              </Button>
            </div>
          </Can>
        </Card>
      )}
      {list.data && list.data.length > 0 && (
        <>
          <div role="tablist" aria-label="Dashboards" className="mb-4 flex flex-wrap gap-2">
            {list.data.map((d) => (
              <button
                key={d.id}
                role="tab"
                type="button"
                aria-selected={d.id === activeId}
                onClick={() => setPicked(d.id)}
                className={`rounded-md px-3 py-1.5 text-sm ${d.id === activeId ? "bg-brand-600 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}
              >
                {d.name}
              </button>
            ))}
          </div>
          <Can permission="analytics.dashboard.manage">
            <div className="mb-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setAdding(true)}>Add widget</Button>
              <Button variant="secondary" onClick={() => setEditing(true)}>Change dashboard</Button>
            </div>
            {editErr && <p role="alert" className="mb-2 text-sm text-red-700">{editErr}</p>}
            {adding && activeId && <AddWidgetDialog dashboard={activeId} open onClose={() => setAdding(false)} />}
            {editing && active && <DashboardDialog key={active.id} dashboard={active} open onClose={() => setEditing(false)} onSaved={() => setPicked(null)} />}
          </Can>
          {view.isFetching && <Spinner />}
          {view.error && <ErrorState error={view.error} onRetry={view.refetch} />}
          {view.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {[...view.data.widgets]
                .sort((a, b) => a.position - b.position)
                .map((w) => (
                  <Card key={w.id} title={w.title}>
                    <Widget w={w} />
                    <Can permission="analytics.dashboard.manage">
                      <div className="mt-3 flex gap-2 border-t border-slate-100 pt-2">
                        <Button variant="secondary" aria-label={`Move ${w.title} earlier`} onClick={() => { const s = [...(view.data?.widgets ?? [])].sort((a, b) => a.position - b.position); const i = s.findIndex((x) => x.id === w.id); const o = s[i - 1]; if (o) { setEditErr(null); Promise.all([moveWidget({ id: w.id, body: { position: o.position } }).unwrap(), moveWidget({ id: o.id, body: { position: w.position } }).unwrap()]).catch(failed); } }}>Earlier</Button>
                        <Button variant="secondary" aria-label={`Move ${w.title} later`} onClick={() => { const s = [...(view.data?.widgets ?? [])].sort((a, b) => a.position - b.position); const i = s.findIndex((x) => x.id === w.id); const o = s[i + 1]; if (o) { setEditErr(null); Promise.all([moveWidget({ id: w.id, body: { position: o.position } }).unwrap(), moveWidget({ id: o.id, body: { position: w.position } }).unwrap()]).catch(failed); } }}>Later</Button>
                        <Button variant="danger" aria-label={`Remove ${w.title}`} onClick={() => { setEditErr(null); removeWidget(w.id).unwrap().catch(failed); }}>Remove</Button>
                      </div>
                    </Can>
                  </Card>
                ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

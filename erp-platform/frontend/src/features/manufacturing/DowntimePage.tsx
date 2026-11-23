import { useState } from "react";

import { useEndDowntimeMutation, useListDowntimesQuery, useListWorkCentersQuery, useRecordDowntimeMutation, useRequestMaintenanceMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ActionDialog } from "../hr/ActionDialog";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";

export const CATEGORY: Record<string, string> = { BREAKDOWN: "Breakdown", MAINTENANCE: "Maintenance", SETUP: "Set-up", NO_MATERIAL: "No material", NO_OPERATOR: "No operator", OTHER: "Other" };
export const SEVERITY: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" };
export const downtimeProblem = (wc: string, category: string, reason: string): string | null =>
  !wc ? "Choose the work centre." : !category ? "Choose the kind of stoppage." : !reason.trim() ? "Say why it stopped." : null;
export const maintenanceProblem = (wc: string, symptoms: string): string | null => (!wc ? "Choose the work centre." : !symptoms.trim() ? "Describe what is wrong." : null);

type Dlg = "stop" | "maintenance" | null;

export function DowntimePage() {
  const { can } = useAccess();
  const manage = can("manufacturing.downtime.manage");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListDowntimesQuery({ cursor });
  const wcs = useListWorkCentersQuery();
  const [record] = useRecordDowntimeMutation();
  const [end] = useEndDowntimeMutation();
  const [request] = useRequestMaintenanceMutation();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const centres = (wcs.data?.results ?? []).filter((w) => w.is_active !== false).map((w) => [w.id, `${w.code} — ${w.name}`] as [string, string]);
  const close = () => setDlg(null);
  const rows = q.data?.results ?? [];
  return (
    <div>
      <PageHeader title="Downtime" description="Machine and work-centre stoppages. A maintenance request also raises a breakdown with Asset Management."
        actions={manage ? <div className="flex gap-2"><Button onClick={() => setDlg("stop")}>Record stoppage</Button><Button variant="secondary" onClick={() => setDlg("maintenance")}>Request maintenance</Button></div> : undefined} />
      {notice && <p role="status" className="mb-2 rounded bg-green-50 p-2 text-sm text-green-800">{notice}</p>}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <Card title="Stoppages">
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && rows.length === 0 && <EmptyState title="No downtime recorded" hint="Stoppages you record will appear here." />}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead><tr className="text-left"><th>Work centre</th><th>Kind</th><th>Reason</th><th>Started</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>{d.work_center}</td><td>{CATEGORY[d.category] ?? d.category}</td><td>{d.reason}</td><td>{d.started_at.slice(0, 16).replace("T", " ")}</td>
                  <td>{d.ended_at ? <Badge tone="slate">{d.minutes ?? 0} min</Badge> : <Badge tone="red">Still stopped</Badge>}{d.breakdown_id ? " · breakdown raised" : ""}</td>
                  <td>{manage && !d.ended_at && <Button variant="secondary" onClick={async () => { setErr(null); try { await end(d.id).unwrap(); } catch (e) { setErr(errorMessage(e)); } }}>End stoppage {d.work_center}</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-2 flex gap-2">
          {cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}
          {q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button>}
        </div>
      </Card>
      <ActionDialog title="Record stoppage" open={dlg === "stop"} onClose={close} cta="Record"
        fields={[{ name: "work_center", label: "Work centre", type: "select", options: centres }, { name: "category", label: "Kind", type: "select", options: Object.entries(CATEGORY) }, { name: "reason", label: "Reason" }]}
        submit={async (v) => { const p = downtimeProblem(v.work_center ?? "", v.category ?? "", v.reason ?? ""); if (p) throw new Error(p); await record({ work_center: v.work_center!, category: v.category!, reason: v.reason!.trim() }).unwrap(); }} />
      <ActionDialog title="Request maintenance" open={dlg === "maintenance"} onClose={close} cta="Send request"
        fields={[{ name: "work_center", label: "Work centre", type: "select", options: centres }, { name: "symptoms", label: "What is wrong" }, { name: "severity", label: "Severity", type: "select", options: Object.entries(SEVERITY) }]}
        submit={async (v) => {
          const p = maintenanceProblem(v.work_center ?? "", v.symptoms ?? ""); if (p) throw new Error(p);
          const r = await request({ work_center: v.work_center!, symptoms: v.symptoms!.trim(), severity: v.severity || "MEDIUM" }).unwrap();
          setNotice(r.affected_orders.length ? `Maintenance requested. Orders affected: ${r.affected_orders.join(", ")}.` : "Maintenance requested. No open orders are affected.");
        }} />
    </div>
  );
}
export default DowntimePage;

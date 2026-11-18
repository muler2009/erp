import { useState } from "react";
import { Link } from "react-router";

import { useListQualityInspectionsQuery, useListQualityPlansQuery, useScheduleQualityInspectionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { UserSelect } from "../../shared/ui/UserSelect";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";
import { STAGES } from "./InspectionPlansPage";

export const INSPECTION_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];

export function resultTone(r: string): "green" | "red" | "amber" | "slate" {
  if (r === "PASS") return "green";
  if (r === "FAIL") return "red";
  if (r === "CONDITIONAL") return "amber";
  return "slate";
}

export function validateSchedule(f: { plan_id: string; scheduled_for: string; inspector_id: string; quantity_total: string }): string | null {
  if (!f.plan_id) return "Choose the inspection plan.";
  if (!f.scheduled_for) return "Enter the date.";
  if (!f.inspector_id) return "Choose the inspector.";
  if (f.quantity_total.trim() && (!/^\d+(\.\d+)?$/.test(f.quantity_total.trim()))) return "The quantity must be zero or more.";
  return null;
}

export function InspectionsPage() {
  const { can } = useAccess();
  const inspect = can("quality.inspect");
  const [f, setF] = useState({ status: "", result: "", stage: "" });
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityInspectionsQuery({ status: f.status || undefined, result: f.result || undefined, stage: f.stage || undefined, cursor });
  const plans = useListQualityPlansQuery({ status: "ACTIVE" }, { skip: !inspect });
  const people = useUserOptions(!inspect);
  const nameOf = useUserNames();
  const [schedule] = useScheduleQualityInspectionMutation();
  const empty = { plan_id: "", scheduled_for: "", inspector_id: "", lot_number: "", quantity_total: "" };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateSchedule(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { plan_id: n.plan_id, scheduled_for: n.scheduled_for, inspector_id: n.inspector_id };
    if (n.lot_number.trim()) body.lot_number = n.lot_number.trim();
    if (n.quantity_total.trim()) body.quantity_total = n.quantity_total.trim();
    try { await schedule(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Inspections" description="Scheduled, in progress and completed inspections." actions={inspect ? <Button onClick={() => setOpen(true)}>Schedule an inspection</Button> : undefined} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-3">
          <label className="text-sm">Status <select aria-label="Inspection status" className={inputClass} value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setCursor(null); }}><option value="">All</option>{INSPECTION_STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          <label className="text-sm">Result <select aria-label="Inspection result" className={inputClass} value={f.result} onChange={(e) => { setF({ ...f, result: e.target.value }); setCursor(null); }}><option value="">Any</option><option value="PASS">Pass</option><option value="CONDITIONAL">Conditional</option><option value="FAIL">Fail</option></select></label>
          <label className="text-sm">Stage <select aria-label="Inspection stage" className={inputClass} value={f.stage} onChange={(e) => { setF({ ...f, stage: e.target.value }); setCursor(null); }}><option value="">All</option>{STAGES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No inspections match" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Stage</th><th>Date</th><th>Inspector</th><th>Lot</th><th>Status</th><th>Result</th></tr></thead>
            <tbody>{data.results.map((i) => (
              <tr key={i.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/inspections/${i.id}`}>{i.number}</Link></td><td>{pretty(i.stage)}</td><td>{i.scheduled_for}</td><td>{nameOf(i.inspector_id)}</td><td>{i.lot_number || "–"}</td>
                <td>{pretty(i.status)}</td><td>{i.result ? <Badge tone={resultTone(i.result)}>{pretty(i.result)}</Badge> : "–"}</td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="Schedule an inspection" open={open} onClose={() => setOpen(false)}>
        <div className="grid grid-cols-1 gap-x-3 md:grid-cols-2">
          <FormField label="Inspection plan" htmlFor="si-plan"><select id="si-plan" className={inputClass} value={n.plan_id} onChange={(e) => setN({ ...n, plan_id: e.target.value })}><option value="">Choose…</option>{plans.data?.results.map((p) => <option key={p.id} value={p.id}>{p.number} {p.title}</option>)}</select></FormField>
          <FormField label="Scheduled for" htmlFor="si-date"><input id="si-date" type="date" className={inputClass} value={n.scheduled_for} onChange={(e) => setN({ ...n, scheduled_for: e.target.value })} /></FormField>
          <FormField label="Inspector" htmlFor="si-who"><UserSelect id="si-who" value={n.inspector_id} onChange={(x) => setN({ ...n, inspector_id: x })} options={people} placeholder="Choose…" /></FormField>
          <FormField label="Lot number" htmlFor="si-lot"><input id="si-lot" className={inputClass} value={n.lot_number} onChange={(e) => setN({ ...n, lot_number: e.target.value })} /></FormField>
          <FormField label="Quantity to inspect from" htmlFor="si-qty"><input id="si-qty" className={inputClass} value={n.quantity_total} onChange={(e) => setN({ ...n, quantity_total: e.target.value })} /></FormField>
        </div>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Schedule</Button></div>
      </Modal>
    </>
  );
}

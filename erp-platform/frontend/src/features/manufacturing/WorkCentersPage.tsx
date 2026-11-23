import { useState } from "react";

import { useCreateWorkCenterMutation, useListWorkCentersQuery, useUpdateWorkCenterMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { WorkCenterInput, WorkCenterRow } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const NUM = /^\d+(\.\d{1,4})?$/;
export interface WcDraft { code: string; name: string; capacity: string; efficiency: string; labor: string; machine: string; overhead: string }
export function workCenterProblem(d: WcDraft, isNew: boolean): string | null {
  if (isNew && !d.code.trim()) return "Give the work centre a code.";
  if (!d.name.trim()) return "Give the work centre a name.";
  if (!NUM.test(d.capacity.trim()) || Number(d.capacity) <= 0 || Number(d.capacity) > 24) return "Capacity must be between 0 and 24 hours a day.";
  if (!NUM.test(d.efficiency.trim()) || Number(d.efficiency) <= 0) return "Efficiency must be more than 0 percent.";
  for (const [label, v] of [["Labour", d.labor], ["Machine", d.machine], ["Overhead", d.overhead]] as const) if (!NUM.test(v.trim())) return `${label} rate must be a number, or 0.`;
  return null;
}
export const workCenterInput = (d: WcDraft, isNew: boolean): WorkCenterInput => ({ ...(isNew ? { code: d.code.trim() } : {}), name: d.name.trim(), capacity_hours_per_day: d.capacity.trim(), efficiency_percent: d.efficiency.trim(), labor_rate: d.labor.trim(), machine_rate: d.machine.trim(), overhead_rate: d.overhead.trim() });
const fromRow = (w: WorkCenterRow): WcDraft => ({ code: w.code, name: w.name, capacity: String(Number(w.capacity_hours_per_day)), efficiency: String(Number(w.efficiency_percent)), labor: String(Number(w.labor_rate)), machine: String(Number(w.machine_rate)), overhead: String(Number(w.overhead_rate)) });
const blank: WcDraft = { code: "", name: "", capacity: "8", efficiency: "100", labor: "0", machine: "0", overhead: "0" };

function Editor({ row, onClose }: { row: WorkCenterRow | "new"; onClose: () => void }) {
  const isNew = row === "new";
  const [create, cs] = useCreateWorkCenterMutation();
  const [update, us] = useUpdateWorkCenterMutation();
  const [d, setD] = useState<WcDraft>(isNew ? blank : fromRow(row));
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof WcDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const go = async () => {
    const p = workCenterProblem(d, isNew);
    if (p) return setErr(p);
    try { if (isNew) await create(workCenterInput(d, true)).unwrap(); else await update({ id: row.id, body: workCenterInput(d, false) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={isNew ? "New work centre" : `Edit ${row.code}`} open onClose={onClose}>
      {isNew && <FormField label="Code" htmlFor="wc-code"><input id="wc-code" className={inputClass} value={d.code} onChange={set("code")} /></FormField>}
      <FormField label="Name" htmlFor="wc-name"><input id="wc-name" className={inputClass} value={d.name} onChange={set("name")} /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Hours per day" htmlFor="wc-cap"><input id="wc-cap" className={inputClass} value={d.capacity} onChange={set("capacity")} /></FormField>
        <FormField label="Efficiency %" htmlFor="wc-eff"><input id="wc-eff" className={inputClass} value={d.efficiency} onChange={set("efficiency")} /></FormField>
        <FormField label="Labour rate per hour" htmlFor="wc-lab"><input id="wc-lab" className={inputClass} value={d.labor} onChange={set("labor")} /></FormField>
        <FormField label="Machine rate per hour" htmlFor="wc-mac"><input id="wc-mac" className={inputClass} value={d.machine} onChange={set("machine")} /></FormField>
        <FormField label="Overhead rate per hour" htmlFor="wc-ovh"><input id="wc-ovh" className={inputClass} value={d.overhead} onChange={set("overhead")} /></FormField>
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={cs.isLoading || us.isLoading} onClick={() => void go()}>Save</Button></div>
    </Modal>
  );
}

export function WorkCentersPage() {
  const { can } = useAccess();
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListWorkCentersQuery({ cursor });
  const [update] = useUpdateWorkCenterMutation();
  const [edit, setEdit] = useState<WorkCenterRow | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const manage = can("manufacturing.master.manage");
  const toggle = async (w: WorkCenterRow) => { setErr(null); try { await update({ id: w.id, body: { is_active: !w.is_active } }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <>
      <PageHeader title="Work centres" description="Places where production work happens, with their capacity and hourly rates." actions={manage ? <Button onClick={() => setEdit("new")}>New work centre</Button> : undefined} />
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <Card>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No work centres" hint="Add the machines or stations used in production." />}
        {q.data && q.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Name</th><th className="text-right">Hours/day</th><th className="text-right">Efficiency</th><th className="text-right">Labour</th><th className="text-right">Machine</th><th className="text-right">Overhead</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.results.map((w) => <tr key={w.id} className="border-t border-slate-100"><td>{w.code}</td><td>{w.name}</td><td className="text-right">{Number(w.capacity_hours_per_day)}</td><td className="text-right">{Number(w.efficiency_percent)}%</td><td className="text-right">{Number(w.labor_rate)}</td><td className="text-right">{Number(w.machine_rate)}</td><td className="text-right">{Number(w.overhead_rate)}</td><td><Badge tone={w.is_active ? "green" : "slate"}>{w.is_active ? "Active" : "Inactive"}</Badge></td>
              <td className="flex gap-1">{manage && <><Button variant="secondary" onClick={() => setEdit(w)}>Edit {w.code}</Button><Button variant="secondary" onClick={() => void toggle(w)}>{w.is_active ? "Deactivate" : "Activate"} {w.code}</Button></>}</td></tr>)}</tbody></table>
        )}
        {q.data?.next && <div className="mt-3 text-right"><Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button></div>}
      </Card>
      {edit && <Editor row={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

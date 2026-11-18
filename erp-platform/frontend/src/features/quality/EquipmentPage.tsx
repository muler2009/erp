import { useRef, useState } from "react";
import { Link, useParams } from "react-router";

import { useAssessQualityImpactMutation, useGetQualityEquipmentQuery, useListQualityEquipmentQuery, useRecordQualityCalibrationMutation, useRegisterQualityEquipmentMutation, useRetireQualityEquipmentMutation, useReturnQualityEquipmentMutation, useScheduleQualityCalibrationMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QCalibration, QEquipmentDetail } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserSelect } from "../../shared/ui/UserSelect";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";
import { HistoryPanel } from "./panels";

export const CAL_RESULTS = ["PASS", "FAIL", "ADJUSTED"];

export function equipmentTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "ACTIVE") return "green";
  if (s === "ON_HOLD") return "red";
  return "slate";
}

export function validateEquipment(f: { tag: string; name: string; responsible_id: string; interval_days: string; last_calibrated_on: string }, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!f.tag.trim()) return "Enter the equipment tag.";
  if (!f.name.trim()) return "Enter the equipment name.";
  if (!f.responsible_id) return "Choose who is responsible.";
  if (!/^\d+$/.test(f.interval_days.trim()) || Number(f.interval_days) <= 0) return "The calibration interval must be a positive number of days.";
  if (f.last_calibrated_on && f.last_calibrated_on > today) return "The last calibration date cannot be in the future.";
  return null;
}

export function validateRecord(f: { performed_on: string; performed_by: string; result: string; certificate_ref: string; as_found: string }, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!f.performed_on) return "Enter the calibration date.";
  if (f.performed_on > today) return "The calibration date cannot be in the future.";
  if (!f.performed_by.trim()) return "Record who calibrated it.";
  if (!CAL_RESULTS.includes(f.result)) return "Choose the result.";
  if (!f.certificate_ref.trim()) return "Enter the certificate reference.";
  if (f.result === "FAIL" && !f.as_found.trim()) return "Record the as-found condition for a failed calibration.";
  return null;
}

/** Why the equipment cannot go back into service yet, mirroring the server. */
export function returnBlock(e: Pick<QEquipmentDetail, "status" | "calibrations">): { block: string | null; calibrationId: string | null } {
  if (e.status !== "ON_HOLD") return { block: "The equipment is not on hold.", calibrationId: null };
  const good = e.calibrations.filter((c) => c.status === "DONE" && c.result !== "FAIL" && !c.out_of_tolerance).sort((a, b) => (b.performed_on ?? "").localeCompare(a.performed_on ?? ""))[0];
  if (!good) return { block: "Record a passing calibration first.", calibrationId: null };
  const failed = e.calibrations.filter((c) => c.out_of_tolerance).sort((a, b) => (b.performed_on ?? "").localeCompare(a.performed_on ?? ""))[0];
  if (failed && failed.impacts.some((i) => i.status === "PENDING")) return { block: "Assess the impact on every affected inspection first.", calibrationId: null };
  return { block: null, calibrationId: good.id };
}

export function EquipmentPage() {
  const { can } = useAccess();
  const manage = can("quality.calibration.manage");
  const [status, setStatus] = useState("");
  const [overdue, setOverdue] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityEquipmentQuery({ status: status || undefined, overdue, cursor });
  const nameOf = useUserNames();
  const owners = useUserOptions(!manage);
  const [register] = useRegisterQualityEquipmentMutation();
  const empty = { tag: "", name: "", manufacturer: "", model: "", serial_number: "", location: "", responsible_id: "", interval_days: "365", last_calibrated_on: "" };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateEquipment(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { tag: n.tag.trim(), name: n.name.trim(), responsible_id: n.responsible_id, interval_days: Number(n.interval_days) };
    for (const k of ["manufacturer", "model", "serial_number", "location", "last_calibrated_on"] as const) if (n[k].trim()) body[k] = n[k].trim();
    try { await register(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setN({ ...n, [k]: e.target.value });
  return (
    <>
      <PageHeader title="Measuring equipment" description="Overdue or failed equipment cannot be used for inspections." actions={manage ? <Button onClick={() => setOpen(true)}>Register equipment</Button> : undefined} />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-4">
          <label className="text-sm">Status <select aria-label="Equipment status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option><option value="ACTIVE">Active</option><option value="ON_HOLD">On hold</option><option value="RETIRED">Retired</option></select></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overdue} onChange={(e) => { setOverdue(e.target.checked); setCursor(null); }} />Overdue only</label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No equipment" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Tag</th><th>Name</th><th>Responsible</th><th>Last calibrated</th><th>Next due</th><th>Status</th></tr></thead>
            <tbody>{data.results.map((e) => (
              <tr key={e.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/equipment/${e.id}`}>{e.tag}</Link></td><td>{e.name}</td><td>{nameOf(e.responsible_id)}</td><td>{e.last_calibrated_on ?? "Never"}</td>
                <td>{e.next_due_on ?? "–"} {e.overdue && <Badge tone="red">Overdue</Badge>}</td><td><Badge tone={equipmentTone(e.status)}>{pretty(e.status)}</Badge></td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="Register equipment" open={open} onClose={() => setOpen(false)}>
        <FormField label="Tag" htmlFor="eq-tag"><input id="eq-tag" className={inputClass} value={n.tag} onChange={set("tag")} /></FormField>
        <FormField label="Name" htmlFor="eq-name"><input id="eq-name" className={inputClass} value={n.name} onChange={set("name")} /></FormField>
        <FormField label="Manufacturer" htmlFor="eq-man"><input id="eq-man" className={inputClass} value={n.manufacturer} onChange={set("manufacturer")} /></FormField>
        <FormField label="Model" htmlFor="eq-model"><input id="eq-model" className={inputClass} value={n.model} onChange={set("model")} /></FormField>
        <FormField label="Serial number" htmlFor="eq-serial"><input id="eq-serial" className={inputClass} value={n.serial_number} onChange={set("serial_number")} /></FormField>
        <FormField label="Location" htmlFor="eq-loc"><input id="eq-loc" className={inputClass} value={n.location} onChange={set("location")} /></FormField>
        <FormField label="Responsible" htmlFor="eq-resp"><UserSelect id="eq-resp" value={n.responsible_id} onChange={(x) => setN({ ...n, responsible_id: x })} options={owners} placeholder="Choose…" /></FormField>
        <FormField label="Calibration interval (days)" htmlFor="eq-int"><input id="eq-int" className={inputClass} value={n.interval_days} onChange={set("interval_days")} /></FormField>
        <FormField label="Last calibrated on" htmlFor="eq-last"><input id="eq-last" type="date" className={inputClass} value={n.last_calibrated_on} onChange={set("last_calibrated_on")} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Register</Button></div>
      </Modal>
    </>
  );
}

function RecordDialog({ cal, onClose }: { cal: QCalibration | null; onClose: () => void }) {
  const [record] = useRecordQualityCalibrationMutation();
  const empty = { performed_on: "", performed_by: "", result: "", certificate_ref: "", as_found: "" };
  const [f, setF] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const close = () => { setF(empty); setErr(null); onClose(); };
  const go = async () => {
    const p = validateRecord(f);
    if (p) { setErr(p); return; }
    setErr(null);
    const form = new FormData();
    for (const [k, v] of Object.entries(f)) if (v.trim()) form.append(k, v.trim());
    const picked = file.current?.files?.[0];
    if (picked) form.append("certificate", picked, picked.name);
    try { await record({ id: cal!.id, form }).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Record the calibration" open={!!cal} onClose={close}>
      <FormField label="Calibrated on" htmlFor="rc-on"><input id="rc-on" type="date" className={inputClass} value={f.performed_on} onChange={set("performed_on")} /></FormField>
      <FormField label="Calibrated by" htmlFor="rc-by"><input id="rc-by" className={inputClass} value={f.performed_by} onChange={set("performed_by")} /></FormField>
      <FormField label="Result" htmlFor="rc-res"><select id="rc-res" className={inputClass} value={f.result} onChange={set("result")}><option value="">Choose…</option>{CAL_RESULTS.map((r) => <option key={r} value={r}>{pretty(r)}</option>)}</select></FormField>
      <FormField label="Certificate reference" htmlFor="rc-ref"><input id="rc-ref" className={inputClass} value={f.certificate_ref} onChange={set("certificate_ref")} /></FormField>
      <FormField label="As-found condition" htmlFor="rc-af"><textarea id="rc-af" className={inputClass} value={f.as_found} onChange={set("as_found")} /></FormField>
      <FormField label="Certificate file" htmlFor="rc-file"><input id="rc-file" ref={file} type="file" className={inputClass} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => void go()}>Record</Button></div>
    </Modal>
  );
}

export function EquipmentDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.calibration.manage");
  const { data: e, isLoading, error, refetch } = useGetQualityEquipmentQuery(id);
  const [schedule] = useScheduleQualityCalibrationMutation();
  const [assess] = useAssessQualityImpactMutation();
  const [back] = useReturnQualityEquipmentMutation();
  const [retire] = useRetireQualityEquipmentMutation();
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"schedule" | "return" | "retire" | null>(null);
  const [recording, setRecording] = useState<QCalibration | null>(null);
  const [impact, setImpact] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !e) return <ErrorState error={error} onRetry={refetch} />;
  const live = e.status !== "RETIRED";
  const scheduled = e.calibrations.find((c) => c.status === "SCHEDULED");
  const rb = returnBlock(e);
  const gateReturn = () => { if (rb.block) { setErr(rb.block); return; } setErr(null); setDlg("return"); };
  return (
    <>
      <PageHeader title={`${e.tag} ${e.name}`} description={e.hold_reason || undefined} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/equipment">All equipment</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={equipmentTone(e.status)}>{pretty(e.status)}</Badge>{e.overdue && <Badge tone="red">Calibration overdue</Badge>}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Details">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <dt className="font-medium">Responsible</dt><dd>{nameOf(e.responsible_id)}</dd>
            <dt className="font-medium">Interval</dt><dd>{e.interval_days} days</dd>
            <dt className="font-medium">Last calibrated</dt><dd>{e.last_calibrated_on ?? "Never"}</dd>
            <dt className="font-medium">Next due</dt><dd>{e.next_due_on ?? "–"}</dd>
            <dt className="font-medium">Manufacturer</dt><dd>{e.manufacturer || "–"}</dd>
            <dt className="font-medium">Model</dt><dd>{e.model || "–"}</dd>
            <dt className="font-medium">Serial number</dt><dd>{e.serial_number || "–"}</dd>
            <dt className="font-medium">Location</dt><dd>{e.location || "–"}</dd>
          </dl>
          {manage && live && (
            <div className="mt-3 flex flex-wrap gap-2">
              {!scheduled && <Button variant="secondary" onClick={() => setDlg("schedule")}>Schedule a calibration</Button>}
              {e.status === "ON_HOLD" && <Button onClick={gateReturn}>Return to service</Button>}
              <Button variant="secondary" onClick={() => setDlg("retire")}>Retire</Button>
            </div>
          )}
        </Card>
        <Card title="Calibrations">
          {!e.calibrations.length ? <EmptyState title="No calibrations yet" /> : (
            <ul className="space-y-3 text-sm">{e.calibrations.map((c) => (
              <li key={c.id} className="rounded border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.status === "SCHEDULED" ? `Scheduled for ${c.scheduled_for}` : `Calibrated on ${c.performed_on}`}</span>
                  {c.result && <Badge tone={c.out_of_tolerance ? "red" : "green"}>{pretty(c.result)}</Badge>}
                  {c.out_of_tolerance && <Badge tone="red">Out of tolerance</Badge>}
                  {manage && live && c.status === "SCHEDULED" && <Button variant="secondary" onClick={() => setRecording(c)}>Record result</Button>}
                </div>
                {c.status === "DONE" && <p className="mt-1">By {c.performed_by} · certificate {c.certificate_ref}{c.as_found ? ` · as found: ${c.as_found}` : ""}</p>}
                {c.impacts.length > 0 && (
                  <table className="mt-2 w-full"><thead><tr className="text-left"><th>Inspection</th><th>Assessment</th><th>Note</th><th /></tr></thead>
                    <tbody>{c.impacts.map((i) => (
                      <tr key={i.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/inspections/${i.inspection_id}`}>Open inspection</Link></td><td><Badge tone={i.status === "PENDING" ? "amber" : i.status === "REINSPECT" ? "red" : "green"}>{pretty(i.status)}</Badge></td><td>{i.note}</td>
                        <td>{manage && i.status === "PENDING" && <Button variant="secondary" onClick={() => setImpact(i.id)}>Assess</Button>}</td></tr>))}</tbody></table>
                )}
              </li>))}</ul>
          )}
        </Card>
        <HistoryPanel history={e.history} />
      </div>
      <ActionDialog title="Schedule a calibration" open={dlg === "schedule"} onClose={() => setDlg(null)} cta="Schedule" fields={[{ name: "scheduled_for", label: "Scheduled for", type: "date", required: true }]} submit={(v) => schedule({ id: e.id, scheduled_for: v.scheduled_for ?? "" }).unwrap()} />
      <ActionDialog title="Return to service" open={dlg === "return"} onClose={() => setDlg(null)} cta="Return to service" fields={[{ name: "note", label: "Note" }]} submit={(v) => back({ id: e.id, calibration_id: rb.calibrationId ?? "", note: (v.note ?? "").trim() }).unwrap()} />
      <ActionDialog title="Retire the equipment" open={dlg === "retire"} onClose={() => setDlg(null)} cta="Retire" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => retire({ id: e.id, reason: (v.reason ?? "").trim() }).unwrap()} />
      <ActionDialog title="Assess the impact" open={!!impact} onClose={() => setImpact(null)} cta="Record assessment" fields={[{ name: "affected", label: "Was the inspection affected?", required: true, options: [["yes", "Yes, re-inspect"], ["no", "No, not affected"]] }, { name: "note", label: "Assessment", required: true }]}
        submit={(v) => assess({ id: impact ?? "", affected: v.affected === "yes", note: (v.note ?? "").trim() }).unwrap()} />
      <RecordDialog cal={recording} onClose={() => setRecording(null)} />
    </>
  );
}

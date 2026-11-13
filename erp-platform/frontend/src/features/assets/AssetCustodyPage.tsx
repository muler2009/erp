import { useState } from "react";

import { useAssetAssignmentActionMutation, useAssetTransferActionMutation, useGetCustodyExceptionsQuery, useListAssetAssignmentsQuery, useListAssetLocationsQuery, useListAssetTransfersQuery, useListDepartmentsQuery, useListEmployeesQuery, useListFixedAssetsQuery, useRequestAssetAssignmentMutation, useRequestAssetTransferMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { AssetAssignment, AssetTransfer } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

export const CONDITIONS = ["NEW", "GOOD", "FAIR", "POOR", "DAMAGED"];
export const ASSIGNEE_TYPES = ["EMPLOYEE", "DEPARTMENT", "PROJECT", "LOCATION"];
const condOptions = CONDITIONS.map((c) => [c, pretty(c)] as [string, string]);
const tone = (s: string) => (s === "ACTIVE" || s === "RECEIVED" || s === "COMPLETED" ? "green" : s === "REJECTED" || s === "CANCELLED" ? "red" : s === "RETURNED" ? "slate" : "amber") as "green" | "red" | "slate" | "amber";

export function validateAssignment(f: { asset: string; type: string; assignee: string; kind: string; assigned_on: string; expected_return_on: string }): string | null {
  if (!f.asset) return "Choose the asset.";
  if (!ASSIGNEE_TYPES.includes(f.type)) return "Choose who it is assigned to.";
  if (!f.assignee.trim()) return f.type === "PROJECT" ? "Enter the project." : "Choose the assignee.";
  if (!f.assigned_on) return "Enter the start date.";
  if (f.kind === "TEMPORARY" && (!f.expected_return_on || f.expected_return_on < f.assigned_on)) return "A temporary assignment needs a return date on or after the start.";
  return null;
}
export function validateTransfer(f: { asset: string; reason: string; effective_date: string; to_location: string; to_department: string }): string | null {
  if (!f.asset) return "Choose the asset.";
  if (!f.reason.trim()) return "Give a reason for the transfer.";
  if (!f.effective_date) return "Enter the effective date.";
  if (!f.to_location && !f.to_department) return "Choose a destination location or department.";
  return null;
}

function NewAssignment({ open, onClose }: { open: boolean; onClose: () => void }) {
  const assets = useListFixedAssetsQuery({ status: "AVAILABLE" }, { skip: !open });
  const employees = useListEmployeesQuery({ status: "ACTIVE" }, { skip: !open });
  const departments = useListDepartmentsQuery(undefined, { skip: !open });
  const locations = useListAssetLocationsQuery(undefined, { skip: !open });
  const [request, state] = useRequestAssetAssignmentMutation();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ asset: "", type: "EMPLOYEE", assignee: "", kind: "PERMANENT", assigned_on: today, expected_return_on: "", purpose: "" });
  const [err, setErr] = useState<string | null>(null);
  const options: [string, string][] = f.type === "EMPLOYEE" ? (employees.data?.results ?? []).map((e) => [e.id, `${e.employee_no} ${e.name}`]) : f.type === "DEPARTMENT" ? (departments.data?.results ?? []).map((d) => [d.id, d.name]) : f.type === "LOCATION" ? (locations.data?.results ?? []).map((l) => [l.id, `${l.code} — ${l.name}`]) : [];
  const go = async () => {
    const p = validateAssignment({ ...f, assignee: f.assignee });
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, string> = { asset: f.asset, assignee_type: f.type, kind: f.kind, assigned_on: f.assigned_on, purpose: f.purpose };
    if (f.type === "PROJECT") body.project = f.assignee.trim(); else body.assignee_id = f.assignee;
    if (f.kind === "TEMPORARY") body.expected_return_on = f.expected_return_on;
    try { await request(body).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Assign an asset" open={open} onClose={onClose}>
      <FormField label="Asset" htmlFor="ag-asset"><select id="ag-asset" className={inputClass} value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}><option value="">Choose…</option>{assets.data?.results.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Assign to" htmlFor="ag-type"><select id="ag-type" className={inputClass} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, assignee: "" })}>{ASSIGNEE_TYPES.map((t) => <option key={t} value={t}>{pretty(t)}</option>)}</select></FormField>
        <FormField label={f.type === "PROJECT" ? "Project" : "Assignee"} htmlFor="ag-who">{f.type === "PROJECT" ? <input id="ag-who" className={inputClass} value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })} /> : <select id="ag-who" className={inputClass} value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}><option value="">Choose…</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}</FormField>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Kind" htmlFor="ag-kind"><select id="ag-kind" className={inputClass} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="PERMANENT">Permanent</option><option value="TEMPORARY">Temporary</option></select></FormField>
        <FormField label="From" htmlFor="ag-from"><input id="ag-from" type="date" className={inputClass} value={f.assigned_on} onChange={(e) => setF({ ...f, assigned_on: e.target.value })} /></FormField>
        {f.kind === "TEMPORARY" && <FormField label="Return by" htmlFor="ag-ret"><input id="ag-ret" type="date" className={inputClass} value={f.expected_return_on} onChange={(e) => setF({ ...f, expected_return_on: e.target.value })} /></FormField>}
      </div>
      <FormField label="Purpose" htmlFor="ag-purpose"><input id="ag-purpose" className={inputClass} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Request assignment</Button></div>
    </Modal>
  );
}

function Assignments() {
  const { can } = useAccess();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListAssetAssignmentsQuery({ status: status || undefined, cursor });
  const [act] = useAssetAssignmentActionMutation();
  const [dlg, setDlg] = useState<{ a: AssetAssignment; action: "handover" | "return" | "reject" } | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(failure(e)); } };
  return (
    <Card title="Assignments">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <label className="text-sm">Status <select aria-label="Assignment status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{["REQUESTED", "APPROVED", "ACTIVE", "RETURNED", "REJECTED", "CANCELLED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
        {can("assets.custody.manage") && <Button variant="secondary" onClick={() => setOpen(true)}>New assignment</Button>}
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No assignments" /> : (
        <ul>{data.results.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2 text-sm">
            <span className="min-w-40 flex-1">{a.number} · {a.asset} → {pretty(a.assignee_type)}{a.project ? ` ${a.project}` : ""} ({pretty(a.kind)}, from {a.assigned_on}{a.expected_return_on ? `, due ${a.expected_return_on}` : ""})</span>
            <Badge tone={tone(a.status)}>{pretty(a.status)}</Badge>{a.status === "ACTIVE" && !a.acknowledged && <Badge tone="amber">Not acknowledged</Badge>}
            {a.status === "REQUESTED" && can("assets.custody.approve") && <><Button onClick={() => void run(() => act({ id: a.id, action: "approve" }).unwrap())}>Approve</Button><Button variant="secondary" onClick={() => setDlg({ a, action: "reject" })}>Reject</Button></>}
            {a.status === "APPROVED" && can("assets.custody.manage") && <Button onClick={() => setDlg({ a, action: "handover" })}>Hand over</Button>}
            {a.status === "ACTIVE" && !a.acknowledged && can("assets.custody.acknowledge") && <Button variant="secondary" onClick={() => void run(() => act({ id: a.id, action: "acknowledge" }).unwrap())}>Acknowledge receipt</Button>}
            {a.status === "ACTIVE" && can("assets.custody.manage") && <Button variant="secondary" onClick={() => setDlg({ a, action: "return" })}>Record return</Button>}
            {(a.status === "REQUESTED" || a.status === "APPROVED") && can("assets.custody.manage") && <Button variant="secondary" onClick={() => void run(() => act({ id: a.id, action: "cancel" }).unwrap())}>{`Cancel ${a.number}`}</Button>}
          </li>))}</ul>
      )}
      {cursor && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(null)}>First page</Button></div>}
      {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      <NewAssignment key={String(open)} open={open} onClose={() => setOpen(false)} />
      <ActionDialog key={dlg ? `${dlg.a.id}-${dlg.action}` : "none"} title={dlg?.action === "handover" ? "Hand over asset" : dlg?.action === "return" ? "Record return" : "Reject assignment"} open={!!dlg} onClose={() => setDlg(null)} cta="Confirm"
        fields={dlg?.action === "reject" ? [{ name: "note", label: "Reason", required: true }] : [{ name: "condition", label: "Condition", required: true, options: condOptions }, { name: "notes", label: "Notes" }]}
        submit={(v) => act({ id: dlg!.a.id, action: dlg!.action, ...(dlg!.action === "reject" ? { note: (v.note ?? "").trim() } : { condition: v.condition ?? "", notes: v.notes ?? "" }) }).unwrap()} />
    </Card>
  );
}

function Transfers() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListAssetTransfersQuery();
  const assets = useListFixedAssetsQuery({ status: "AVAILABLE" }, { skip: !can("assets.custody.manage") });
  const locations = useListAssetLocationsQuery();
  const departments = useListDepartmentsQuery(undefined, { skip: !can("assets.custody.manage") });
  const [request] = useRequestAssetTransferMutation();
  const [act] = useAssetTransferActionMutation();
  const [dlg, setDlg] = useState<"new" | { t: AssetTransfer; action: "dispatch" | "receive" | "reject" } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(failure(e)); } };
  const sub = dlg && dlg !== "new" ? dlg : null;
  return (
    <Card title="Transfers">
      {can("assets.custody.manage") && <div className="mb-2"><Button variant="secondary" onClick={() => setDlg("new")}>New transfer</Button></div>}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No transfers" /> : (
        <ul>{data.results.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2 text-sm">
            <span className="min-w-40 flex-1">{t.number} · {t.asset}: {t.from_location ?? "–"} → {t.to_location ?? "same location"} ({t.effective_date}) — {t.reason}</span><Badge tone={tone(t.status)}>{pretty(t.status)}</Badge>
            {t.status === "REQUESTED" && can("assets.custody.approve") && <><Button onClick={() => void run(() => act({ id: t.id, action: "approve" }).unwrap())}>{`Approve ${t.number}`}</Button><Button variant="secondary" onClick={() => setDlg({ t, action: "reject" })}>{`Reject ${t.number}`}</Button></>}
            {t.status === "APPROVED" && can("assets.custody.manage") && <Button onClick={() => setDlg({ t, action: "dispatch" })}>{`Dispatch ${t.number}`}</Button>}
            {t.status === "IN_TRANSIT" && can("assets.custody.acknowledge") && <Button onClick={() => setDlg({ t, action: "receive" })}>{`Receive ${t.number}`}</Button>}
            {(t.status === "REQUESTED" || t.status === "APPROVED") && can("assets.custody.manage") && <Button variant="secondary" onClick={() => void run(() => act({ id: t.id, action: "cancel" }).unwrap())}>{`Cancel ${t.number}`}</Button>}
          </li>))}</ul>
      )}
      <ActionDialog title="New asset transfer" open={dlg === "new"} onClose={() => setDlg(null)} cta="Request transfer"
        fields={[{ name: "asset", label: "Asset", required: true, options: (assets.data?.results ?? []).map((a) => [a.id, `${a.number} ${a.name}`] as [string, string]) }, { name: "reason", label: "Reason", required: true }, { name: "effective_date", label: "Effective date", type: "date", required: true }, { name: "to_location", label: "To location", options: [["", "No change"], ...(locations.data?.results ?? []).map((l) => [l.id, `${l.code} — ${l.name}`] as [string, string])] }, { name: "to_department", label: "To department", options: [["", "No change"], ...(departments.data?.results ?? []).map((d) => [d.id, d.name] as [string, string])] }]}
        submit={async (v) => { const f = { asset: v.asset ?? "", reason: (v.reason ?? "").trim(), effective_date: v.effective_date ?? "", to_location: v.to_location ?? "", to_department: v.to_department ?? "" }; const p = validateTransfer(f); if (p) throw new Error(p); await request({ asset: f.asset, reason: f.reason, effective_date: f.effective_date, ...(f.to_location ? { to_location: f.to_location } : {}), ...(f.to_department ? { to_department: f.to_department } : {}) }).unwrap(); }} />
      <ActionDialog key={sub ? `${sub.t.id}-${sub.action}` : "none"} title={sub ? `${pretty(sub.action.toUpperCase())} ${sub.t.number}` : "Transfer"} open={!!sub} onClose={() => setDlg(null)} cta="Confirm"
        fields={sub?.action === "reject" ? [{ name: "note", label: "Reason", required: true }] : [{ name: "condition", label: "Condition", required: true, options: condOptions }, ...(sub?.action === "receive" ? [{ name: "notes", label: "Notes" }] : [])]}
        submit={(v) => act({ id: sub!.t.id, action: sub!.action, ...(sub!.action === "reject" ? { note: (v.note ?? "").trim() } : { condition: v.condition ?? "", ...(v.notes ? { notes: v.notes } : {}) }) }).unwrap()} />
    </Card>
  );
}

function Exceptions() {
  const { data, isLoading, error, refetch } = useGetCustodyExceptionsQuery();
  return (
    <Card title="Custody exceptions">
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : data && (
        <div className="grid gap-4 md:grid-cols-2 text-sm">
          <div><h3 className="mb-1 font-semibold">Overdue returns</h3>{!data.unreturned.length ? <p className="text-slate-500">None.</p> : <ul>{data.unreturned.map((u) => <li key={u.assignment}>{u.asset} ({u.assignment}){u.expected_return_on ? ` was due ${u.expected_return_on}` : ""}</li>)}</ul>}</div>
          <div><h3 className="mb-1 font-semibold">Not yet acknowledged</h3>{!data.unacknowledged.length ? <p className="text-slate-500">None.</p> : <ul>{data.unacknowledged.map((u) => <li key={u.assignment}>{u.asset} ({u.assignment}) since {u.since}</li>)}</ul>}</div>
        </div>
      )}
    </Card>
  );
}

export function AssetCustodyPage() {
  return (
    <>
      <PageHeader title="Asset custody" description="Who holds which asset, and moves between places." />
      <div className="grid gap-4"><Assignments /><Transfers /><Exceptions /></div>
    </>
  );
}

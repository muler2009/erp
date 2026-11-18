import { useState } from "react";
import { Link } from "react-router";

import { useCreateCapaMutation, useListCapasQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { UserSelect } from "../../shared/ui/UserSelect";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";

export const CAPA_STATUSES = ["ANALYSIS", "PENDING_APPROVAL", "APPROVED", "IMPLEMENTING", "VERIFYING", "CLOSED", "CANCELLED"];
export const CAPA_SOURCES = ["NCR", "AUDIT_FINDING", "COMPLAINT", "INSPECTION", "RISK", "IMPROVEMENT", "OTHER"];

export function capaTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "CLOSED") return "green";
  if (s === "CANCELLED") return "slate";
  if (s === "PENDING_APPROVAL" || s === "VERIFYING") return "amber";
  return "amber";
}

export function validateCapa(f: { kind: string; title: string; source_type: string; source_id: string; problem: string; owner_id: string; reviewer_id: string; due_date: string }): string | null {
  if (!["CORRECTIVE", "PREVENTIVE"].includes(f.kind)) return "Choose corrective or preventive.";
  if (!f.title.trim()) return "Give the CAPA a title.";
  if (!CAPA_SOURCES.includes(f.source_type)) return "Choose what triggered it.";
  if (f.source_type !== "OTHER" && !f.source_id.trim()) return "Name the record that triggered it, or choose Other.";
  if (!f.problem.trim()) return "Describe the problem.";
  if (!f.owner_id) return "Choose the owner.";
  if (!f.reviewer_id) return "Choose the effectiveness reviewer.";
  if (f.owner_id === f.reviewer_id) return "The effectiveness reviewer must be a different person from the owner.";
  if (!f.due_date) return "Enter the due date.";
  return null;
}

export function CapaListPage() {
  const { can } = useAccess();
  const manage = can("quality.capa.manage");
  const [f, setF] = useState({ status: "", kind: "", overdue: false });
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListCapasQuery({ status: f.status || undefined, kind: f.kind || undefined, overdue: f.overdue, cursor });
  const nameOf = useUserNames();
  const people = useUserOptions(!manage);
  const [create] = useCreateCapaMutation();
  const empty = { kind: "CORRECTIVE", title: "", source_type: "OTHER", source_id: "", problem: "", owner_id: "", reviewer_id: "", due_date: "" };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateCapa(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { kind: n.kind, title: n.title.trim(), source_type: n.source_type, problem: n.problem.trim(), owner_id: n.owner_id, reviewer_id: n.reviewer_id, due_date: n.due_date };
    if (n.source_type !== "OTHER") body.source_id = n.source_id.trim();
    try { await create(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Corrective and preventive actions" description="Fix the cause, prove the fix worked, then close." actions={manage ? <Button onClick={() => setOpen(true)}>New CAPA</Button> : undefined} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-3">
          <label className="text-sm">Status <select aria-label="CAPA status" className={inputClass} value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setCursor(null); }}><option value="">All</option>{CAPA_STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          <label className="text-sm">Kind <select aria-label="CAPA kind" className={inputClass} value={f.kind} onChange={(e) => { setF({ ...f, kind: e.target.value }); setCursor(null); }}><option value="">All</option><option value="CORRECTIVE">Corrective</option><option value="PREVENTIVE">Preventive</option></select></label>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.overdue} onChange={(e) => { setF({ ...f, overdue: e.target.checked }); setCursor(null); }} /> Overdue only</label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No CAPAs match" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Title</th><th>Kind</th><th>Status</th><th>Owner</th><th>Due</th></tr></thead>
            <tbody>{data.results.map((c) => (
              <tr key={c.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/capas/${c.id}`}>{c.number}</Link></td><td>{c.title}</td><td>{pretty(c.kind)}</td>
                <td><Badge tone={capaTone(c.status)}>{pretty(c.status)}</Badge></td><td>{nameOf(c.owner_id)}</td><td>{c.due_date}{c.overdue && <> <Badge tone="red">Overdue</Badge></>}</td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="New CAPA" open={open} onClose={() => setOpen(false)}>
        <div className="grid grid-cols-1 gap-x-3 md:grid-cols-2">
          <FormField label="Kind" htmlFor="cp-kind"><select id="cp-kind" className={inputClass} value={n.kind} onChange={(e) => setN({ ...n, kind: e.target.value })}><option value="CORRECTIVE">Corrective</option><option value="PREVENTIVE">Preventive</option></select></FormField>
          <FormField label="Title" htmlFor="cp-title"><input id="cp-title" className={inputClass} value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} /></FormField>
          <FormField label="Triggered by" htmlFor="cp-src"><select id="cp-src" className={inputClass} value={n.source_type} onChange={(e) => setN({ ...n, source_type: e.target.value })}>{CAPA_SOURCES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></FormField>
          {n.source_type !== "OTHER" && <FormField label="Source record ID" htmlFor="cp-sid"><input id="cp-sid" className={inputClass} value={n.source_id} onChange={(e) => setN({ ...n, source_id: e.target.value })} /></FormField>}
          <FormField label="Owner" htmlFor="cp-own"><UserSelect id="cp-own" value={n.owner_id} onChange={(x) => setN({ ...n, owner_id: x })} options={people} placeholder="Choose…" /></FormField>
          <FormField label="Effectiveness reviewer" htmlFor="cp-rev"><UserSelect id="cp-rev" value={n.reviewer_id} onChange={(x) => setN({ ...n, reviewer_id: x })} options={people} placeholder="Choose…" /></FormField>
          <FormField label="Due date" htmlFor="cp-due"><input id="cp-due" type="date" className={inputClass} value={n.due_date} onChange={(e) => setN({ ...n, due_date: e.target.value })} /></FormField>
        </div>
        <FormField label="Problem" htmlFor="cp-prob"><textarea id="cp-prob" className={inputClass} value={n.problem} onChange={(e) => setN({ ...n, problem: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Create</Button></div>
      </Modal>
    </>
  );
}

import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "react-router";

import { useCreateJobRequisitionMutation, useGetFunnelQuery, useListDepartmentsQuery, useListPositionsQuery, useListJobRequisitionsQuery, useJobRequisitionActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { JobRequisition } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, Card, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";
import { pretty } from "./EmployeeDialogs";

export const reqTone = (s: string) => (s === "APPROVED" ? "green" : s === "REJECTED" || s === "CLOSED" ? "red" : s === "PENDING" ? "amber" : "slate") as "green" | "red" | "amber" | "slate";

export function validateRequisition(f: { title: string; headcount: string; justification: string }): string | null {
  if (!f.title.trim()) return "Enter the job title.";
  if (!/^\d+$/.test(f.headcount) || Number(f.headcount) < 1 || Number(f.headcount) > 500) return "Headcount must be a whole number from 1 to 500.";
  if (!f.justification.trim()) return "Say why this role is needed.";
  return null;
}

function NewRequisition({ open, onClose }: { open: boolean; onClose: () => void }) {
  const departments = useListDepartmentsQuery(undefined, { skip: !open });
  const positions = useListPositionsQuery(undefined, { skip: !open });
  const [create, state] = useCreateJobRequisitionMutation();
  const [f, setF] = useState({ title: "", headcount: "1", justification: "", department: "", position: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const problem = validateRequisition(f);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await create({ title: f.title.trim(), headcount: Number(f.headcount), justification: f.justification.trim(), ...(f.department ? { department: f.department } : {}), ...(f.position ? { position: f.position } : {}) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New job requisition" open={open} onClose={onClose}>
      <FormField label="Job title" htmlFor="rq-title"><input id="rq-title" maxLength={150} className={inputClass} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></FormField>
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Headcount" htmlFor="rq-hc"><input id="rq-hc" inputMode="numeric" className={inputClass} value={f.headcount} onChange={(e) => setF({ ...f, headcount: e.target.value })} /></FormField>
        <FormField label="Department" htmlFor="rq-dept"><select id="rq-dept" className={inputClass} value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}><option value="">None</option>{departments.data?.results.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></FormField>
        <FormField label="Position" htmlFor="rq-pos"><select id="rq-pos" className={inputClass} value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })}><option value="">None</option>{positions.data?.results.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></FormField>
      </div>
      <FormField label="Justification" htmlFor="rq-why"><input id="rq-why" className={inputClass} value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Create requisition</Button></div>
    </Modal>
  );
}

export function RecruitmentPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<JobRequisition | null>(null);
  const [note, setNote] = useState("");
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListJobRequisitionsQuery({ cursor });
  const funnel = useGetFunnelQuery();
  const [act, state] = useJobRequisitionActionMutation();
  const run = async (id: string, action: "submit" | "approve" | "reject" | "close", n?: string) => { setErr(null); try { await act({ id, action, note: n }).unwrap(); setRejecting(null); setNote(""); } catch (e) { setErr(errorMessage(e)); } };
  const columns: ColumnDef<JobRequisition>[] = [
    { header: "No.", cell: ({ row }) => <Link className="text-indigo-700 underline" to={`/app/hr/recruitment/${row.original.id}`}>{row.original.number}</Link> },
    { header: "Title", cell: ({ row }) => row.original.title },
    { header: "Headcount", cell: ({ row }) => row.original.headcount },
    { header: "Status", cell: ({ row }) => <Badge tone={reqTone(row.original.status)}>{pretty(row.original.status)}</Badge> },
    { header: "", id: "a", cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex gap-2">
          {r.status === "DRAFT" && <Button loading={state.isLoading} onClick={() => void run(r.id, "submit")}>Submit</Button>}
          {r.status === "PENDING" && can("hr.recruitment.approve") && <><Button onClick={() => void run(r.id, "approve")}>Approve</Button><Button variant="secondary" onClick={() => setRejecting(r)}>Reject</Button></>}
          {r.status === "APPROVED" && <Button variant="secondary" onClick={() => void run(r.id, "close")}>Close</Button>}
        </div>
      );
    } },
  ];
  return (
    <>
      <PageHeader title="Recruitment" description="Job requisitions, approval and hiring pipeline." actions={<Button onClick={() => setCreating(true)}>New requisition</Button>} />
      {funnel.data && <Card title="Candidates by stage"><p className="flex flex-wrap gap-4 text-sm">{Object.entries(funnel.data).map(([k, v]) => <span key={k}>{pretty(k)}: <strong>{v}</strong></span>)}</p></Card>}
      {err && <p role="alert" className="my-3 text-sm text-red-700">{err}</p>}
      <div className="mt-4"><DataTable caption="Job requisitions" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No requisitions yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} /></div>
      <NewRequisition open={creating} onClose={() => setCreating(false)} />
      <Modal title="Reject requisition" open={!!rejecting} onClose={() => setRejecting(null)}>
        <FormField label="Reason (required)" htmlFor="rj-note"><input id="rj-note" className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setRejecting(null)}>Close</Button><Button onClick={() => (note.trim() ? void run(rejecting!.id, "reject", note.trim()) : setErr("A reason is required to reject a requisition."))}>Reject</Button></div>
      </Modal>
    </>
  );
}

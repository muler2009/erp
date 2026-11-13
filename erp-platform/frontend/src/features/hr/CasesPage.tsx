import { useState } from "react";

import { useCaseActionMutation, useFileGrievanceMutation, useGetCaseQuery, useListCasesQuery, useOpenCaseMutation } from "../../shared/api/endpoints";
import type { HrCase } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, Modal, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "./ActionDialog";
import { pretty } from "./EmployeeDialogs";
import { EmployeeRequest } from "./EmployeeRequest";

export const CASE_KINDS: [string, string][] = [["GRIEVANCE", "Grievance"], ["DISCIPLINARY", "Disciplinary"], ["COMMENDATION", "Commendation"]];

function CaseDetail({ c, onClose }: { c: HrCase | null; onClose: () => void }) {
  const { can } = useAccess();
  const manage = can("hr.cases.manage");
  const detail = useGetCaseQuery(c?.id ?? "", { skip: !c });
  const [act] = useCaseActionMutation();
  const [dlg, setDlg] = useState<"note" | "close" | null>(null);
  const d = detail.data ?? c;
  return (
    <Modal title={`Case: ${c?.summary ?? ""}`} open={!!c} onClose={onClose}>
      {detail.isLoading && <Spinner />}
      {d && <p className="mb-2 text-sm">{pretty(d.kind)} · <Badge tone={d.status === "CLOSED" ? "slate" : "amber"}>{pretty(d.status)}</Badge>{d.outcome ? ` · Outcome: ${d.outcome}` : ""}</p>}
      {manage && <ul className="mb-3 text-sm">{(d?.notes ?? []).map((n, i) => <li key={i} className="border-b border-slate-200 py-1">{n.text} <span className="text-slate-400">{new Date(n.at).toLocaleString()}</span></li>)}</ul>}
      {manage && d && d.status !== "CLOSED" && <div className="flex gap-2"><Button variant="secondary" onClick={() => setDlg("note")}>Add note</Button><Button onClick={() => setDlg("close")}>Close case</Button></div>}
      <ActionDialog title="Add case note" open={dlg === "note"} onClose={() => setDlg(null)} cta="Add note" fields={[{ name: "text", label: "Note", required: true }]} submit={(v) => act({ id: c!.id, action: "notes", text: (v.text ?? "").trim() }).unwrap()} />
      <ActionDialog title="Close case" open={dlg === "close"} onClose={() => setDlg(null)} cta="Close case" fields={[{ name: "outcome", label: "Outcome", required: true }]} submit={(v) => act({ id: c!.id, action: "close", outcome: (v.outcome ?? "").trim() }).unwrap()} />
    </Modal>
  );
}

export function CasesPage() {
  const { can } = useAccess();
  const manage = can("hr.cases.manage");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListCasesQuery({ cursor });
  const [open, setOpen] = useState<HrCase | null>(null);
  const [dlg, setDlg] = useState<"case" | "grievance" | null>(null);
  const [openCase] = useOpenCaseMutation();
  const [grieve] = useFileGrievanceMutation();
  return (
    <>
      <PageHeader title="Employee relations" description="Grievances, disciplinary cases and commendations." actions={<>{manage && <Button onClick={() => setDlg("case")}>Open case</Button>} <Button variant="secondary" onClick={() => setDlg("grievance")}>File a grievance</Button></>} />
      <Card title="Cases">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No cases" /> : (
          <ul>{data.results.map((c) => <li key={c.id} className="flex items-center gap-3 border-b border-slate-200 py-2"><span className="flex-1">{c.summary}</span><span className="text-sm text-slate-500">{c.employee_no} · {pretty(c.kind)}</span><Badge tone={c.status === "CLOSED" ? "slate" : "amber"}>{pretty(c.status)}</Badge><Button variant="secondary" onClick={() => setOpen(c)}>View</Button></li>)}</ul>
        )}
        {cursor && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(null)}>First page</Button></div>}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <CaseDetail c={open} onClose={() => setOpen(null)} />
      <EmployeeRequest title="Open case" open={dlg === "case"} onClose={() => setDlg(null)} cta="Open case" fields={[{ name: "kind", label: "Kind", required: true, options: CASE_KINDS }, { name: "summary", label: "Summary", required: true }]} submit={(emp, v) => openCase({ employee: emp, kind: v.kind ?? "", summary: (v.summary ?? "").trim() }).unwrap()} />
      <ActionDialog title="File a grievance" open={dlg === "grievance"} onClose={() => setDlg(null)} cta="File grievance" fields={[{ name: "summary", label: "What happened", required: true }]} submit={(v) => grieve({ summary: (v.summary ?? "").trim() }).unwrap()} />
    </>
  );
}

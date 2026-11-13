import { useState } from "react";

import { useCreatePolicyMutation, useGetOutstandingQuery, useListPoliciesQuery, usePolicyActionMutation, useUpdatePolicyMutation } from "../../shared/api/endpoints";
import type { HrPolicy } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, Modal, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "./ActionDialog";
import { pretty } from "./EmployeeDialogs";

function Outstanding({ p, onClose }: { p: HrPolicy | null; onClose: () => void }) {
  const { data, isLoading, error, refetch } = useGetOutstandingQuery(p?.id ?? "", { skip: !p });
  return (
    <Modal title={`Not yet acknowledged: ${p?.code ?? ""}`} open={!!p} onClose={onClose}>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <p className="text-sm">Everyone has acknowledged this policy.</p> : <ul className="text-sm">{data.map((e) => <li key={e.employee_no}>{e.name} ({e.employee_no})</li>)}</ul>}
    </Modal>
  );
}

export function PoliciesPage() {
  const { can } = useAccess();
  const manage = can("hr.policy.manage");
  const { data, isLoading, error, refetch } = useListPoliciesQuery();
  const [create] = useCreatePolicyMutation();
  const [update] = useUpdatePolicyMutation();
  const [act] = usePolicyActionMutation();
  const [dlg, setDlg] = useState<"new" | null>(null);
  const [edit, setEdit] = useState<HrPolicy | null>(null);
  const [out, setOut] = useState<HrPolicy | null>(null);
  const [read, setRead] = useState<HrPolicy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(failure(e)); } };
  return (
    <>
      <PageHeader title="Policies" description="Company policies and your acknowledgement." actions={manage ? <Button onClick={() => setDlg("new")}>New policy</Button> : undefined} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <Card title="Policies">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No policies yet" /> : (
          <ul>{data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2">
              <span className="min-w-40 flex-1">{p.code} v{p.version} — {p.title}</span><Badge tone={p.status === "PUBLISHED" ? "green" : "amber"}>{pretty(p.status)}</Badge>
              <Button variant="secondary" onClick={() => setRead(p)}>Read</Button>
              {p.status === "PUBLISHED" && (p.acknowledged ? <Badge tone="green">Acknowledged</Badge> : <Button onClick={() => void run(() => act({ id: p.id, action: "acknowledge" }).unwrap())}>Acknowledge</Button>)}
              {manage && p.status === "DRAFT" && <><Button variant="secondary" onClick={() => setEdit(p)}>Edit</Button><Button onClick={() => void run(() => act({ id: p.id, action: "publish" }).unwrap())}>Publish</Button></>}
              {manage && p.status === "PUBLISHED" && <Button variant="secondary" onClick={() => setOut(p)}>Who has not acknowledged</Button>}
            </li>))}</ul>
        )}
      </Card>
      <Modal title={read ? `${read.code}: ${read.title}` : "Policy"} open={!!read} onClose={() => setRead(null)}><p className="whitespace-pre-wrap text-sm">{read?.body}</p></Modal>
      <Outstanding p={out} onClose={() => setOut(null)} />
      <ActionDialog title="New policy" open={dlg === "new"} onClose={() => setDlg(null)} cta="Create draft" fields={[{ name: "code", label: "Code", required: true }, { name: "title", label: "Title", required: true }, { name: "body", label: "Text", required: true }]} submit={(v) => create({ code: (v.code ?? "").trim(), title: (v.title ?? "").trim(), body: v.body ?? "" }).unwrap()} />
      <ActionDialog key={edit?.id} title="Edit policy" open={!!edit} onClose={() => setEdit(null)} cta="Save" fields={[{ name: "title", label: "Title", required: true }, { name: "body", label: "Text", required: true }]} submit={(v) => update({ id: edit!.id, title: (v.title ?? "").trim(), body: v.body ?? "" }).unwrap()} />
    </>
  );
}

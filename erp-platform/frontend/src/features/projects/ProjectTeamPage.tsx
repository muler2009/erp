import { useState } from "react";
import { useParams } from "react-router";

import { useAddProjectMemberMutation, useListProjectMembersQuery, useRemoveProjectMemberMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserPicker } from "../../shared/ui/UserPicker";
import { failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { ProjectNav } from "./ProjectFinancePage";

export function validateMember(f: { user: string | null; cost_rate: string; bill_rate: string; allocation: string }): string | null {
  if (!f.user) return "Choose the person to add.";
  for (const r of [f.cost_rate, f.bill_rate]) { const m = parseMoney(r); if (m === null || m < 0n) return "Rates must be zero or more."; }
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(f.allocation) || Number(f.allocation) > 100) return "Allocation must be between 0 and 100 percent.";
  return null;
}

export function ProjectTeamPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error, refetch } = useListProjectMembersQuery(id);
  const [add, state] = useAddProjectMemberMutation();
  const [remove] = useRemoveProjectMemberMutation();
  const [known, setKnown] = useState<Record<string, string>>({});
  const name = (uid: string) => known[uid] ?? `User ${uid.slice(0, 8)}`;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ user: null as string | null, role: "MEMBER", cost_rate: "0", bill_rate: "0", allocation: "100" });
  const [err, setErr] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateMember(f);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await add({ id, user_id: f.user!, role: f.role, cost_rate: f.cost_rate.trim(), bill_rate: f.bill_rate.trim(), allocation_percent: f.allocation.trim() }).unwrap(); setOpen(false); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Project team" description="Members, roles, rates and allocation." actions={<Button onClick={() => setOpen(true)}>Add member</Button>} />
      <ProjectNav id={id} current="team" />
      {rowErr && <p role="alert" className="mb-3 text-sm text-red-700">{rowErr}</p>}
      <Card title="Members">
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No members" /> : (
          <ul>{data.results.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-2">
              <span className="min-w-40 flex-1">{name(m.user_id)}</span><Badge tone="slate">{pretty(m.role)}</Badge>
              <span className="text-sm text-slate-500">{m.allocation_percent}% · cost {formatMoney(m.cost_rate)}/h · bill {formatMoney(m.bill_rate)}/h</span>
              {m.role !== "MANAGER" && <Button variant="secondary" onClick={async () => { setRowErr(null); try { await remove({ id, user_id: m.user_id }).unwrap(); } catch (e) { setRowErr(failure(e)); } }}>{`Remove ${name(m.user_id)}`}</Button>}
            </li>))}</ul>
        )}
      </Card>
      <Modal title="Add team member" open={open} onClose={() => setOpen(false)}>
        <UserPicker label="Person" onChange={(u) => { setF({ ...f, user: u?.id ?? null }); if (u) setKnown((k) => ({ ...k, [u.id]: u.display_name })); }} />
        <FormField label="Role" htmlFor="tm-role"><select id="tm-role" className={inputClass} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{["MEMBER", "OBSERVER", "MANAGER"].map((r) => <option key={r} value={r}>{pretty(r)}</option>)}</select></FormField>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Cost rate per hour" htmlFor="tm-cost"><input id="tm-cost" className={inputClass} value={f.cost_rate} onChange={(e) => setF({ ...f, cost_rate: e.target.value })} /></FormField>
          <FormField label="Bill rate per hour" htmlFor="tm-bill"><input id="tm-bill" className={inputClass} value={f.bill_rate} onChange={(e) => setF({ ...f, bill_rate: e.target.value })} /></FormField>
          <FormField label="Allocation %" htmlFor="tm-alloc"><input id="tm-alloc" className={inputClass} value={f.allocation} onChange={(e) => setF({ ...f, allocation: e.target.value })} /></FormField>
        </div>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Add member</Button></div>
      </Modal>
    </>
  );
}

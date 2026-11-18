import { useState } from "react";
import { Link, useParams } from "react-router";

import { useGetScarQuery, useListScarsQuery, useListSuppliersQuery, useRaiseScarMutation, useScarActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserSelect } from "../../shared/ui/UserSelect";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";
import { HistoryPanel } from "./panels";

export const SCAR_STATUSES = ["OPEN", "RESPONDED", "ACCEPTED", "REJECTED", "CLOSED"];

export function scarTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "CLOSED" || s === "ACCEPTED") return "green";
  if (s === "REJECTED") return "red";
  if (s === "RESPONDED") return "amber";
  return "slate";
}

export function validateScar(f: { supplier_id: string; description: string; due_date: string; owner_id: string }): string | null {
  if (!f.supplier_id) return "Choose the supplier.";
  if (!f.description.trim()) return "Describe what the supplier must correct.";
  if (!f.due_date) return "Enter the due date.";
  if (!f.owner_id) return "Choose who follows this up.";
  return null;
}

export function ScarsPage() {
  const { can } = useAccess();
  const manage = can("quality.supplier.manage");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListScarsQuery({ status: status || undefined, cursor });
  const suppliers = useListSuppliersQuery();
  const people = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [raise] = useRaiseScarMutation();
  const empty = { supplier_id: "", description: "", due_date: "", owner_id: "", ncr_id: "" };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const supplierName = (id: string) => suppliers.data?.results.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  const go = async () => {
    const p = validateScar(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { supplier_id: n.supplier_id, description: n.description.trim(), due_date: n.due_date, owner_id: n.owner_id };
    if (n.ncr_id.trim()) body.ncr_id = n.ncr_id.trim();
    try { await raise(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Corrective action requests" description="Requests sent to suppliers to correct a quality problem." actions={manage ? <Button onClick={() => setOpen(true)}>Raise a request</Button> : undefined} />
      <Card>
        <div className="mb-3"><label className="text-sm">Status <select aria-label="Request status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="">All</option>{SCAR_STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label></div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No requests match" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Supplier</th><th>Description</th><th>Due</th><th>Follow-up</th><th>Status</th></tr></thead>
            <tbody>{data.results.map((s) => (
              <tr key={s.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/scars/${s.id}`}>{s.number}</Link></td><td>{supplierName(s.supplier_id)}</td><td>{s.description}</td><td>{s.due_date}{s.overdue && <> <Badge tone="red">Overdue</Badge></>}</td><td>{nameOf(s.owner_id)}</td><td><Badge tone={scarTone(s.status)}>{pretty(s.status)}</Badge></td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="Raise a corrective action request" open={open} onClose={() => setOpen(false)}>
        <FormField label="Supplier" htmlFor="sc-sup"><select id="sc-sup" className={inputClass} value={n.supplier_id} onChange={(e) => setN({ ...n, supplier_id: e.target.value })}><option value="">Choose…</option>{suppliers.data?.results.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></FormField>
        <FormField label="What must be corrected" htmlFor="sc-desc"><textarea id="sc-desc" className={inputClass} value={n.description} onChange={(e) => setN({ ...n, description: e.target.value })} /></FormField>
        <FormField label="Respond by" htmlFor="sc-due"><input id="sc-due" type="date" className={inputClass} value={n.due_date} onChange={(e) => setN({ ...n, due_date: e.target.value })} /></FormField>
        <FormField label="Followed up by" htmlFor="sc-own"><UserSelect id="sc-own" value={n.owner_id} onChange={(x) => setN({ ...n, owner_id: x })} options={people} placeholder="Choose…" /></FormField>
        <FormField label="Related non-conformance ID" htmlFor="sc-ncr"><input id="sc-ncr" className={inputClass} value={n.ncr_id} onChange={(e) => setN({ ...n, ncr_id: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Raise request</Button></div>
      </Modal>
    </>
  );
}

export function ScarPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.supplier.manage");
  const { data: s, isLoading, error, refetch } = useGetScarQuery(id);
  const [act] = useScarActionMutation();
  const suppliers = useListSuppliersQuery();
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"response" | "accept" | "reject" | "close" | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !s) return <ErrorState error={error} onRetry={refetch} />;
  const sup = suppliers.data?.results.find((x) => x.id === s.supplier_id)?.name ?? "Supplier";
  return (
    <>
      <PageHeader title={`${s.number} · ${sup}`} description={s.description} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/scars">All requests</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={scarTone(s.status)}>{pretty(s.status)}</Badge><Badge tone="slate">{`Due ${s.due_date}`}</Badge>{s.overdue && <Badge tone="red">Overdue</Badge>}<Badge tone="slate">{`Followed up by ${nameOf(s.owner_id)}`}</Badge>{s.ncr_id && <Link className="text-sm text-blue-700 underline" to={`/app/quality/ncrs/${s.ncr_id}`}>Related non-conformance</Link>}</div>
      <div className="grid gap-4">
        <Card title="Supplier's response">
          <p className="text-sm">{s.response || "No response recorded yet."}</p>
          {s.review_note && <p className="mt-2 text-sm text-slate-600">{`Review: ${s.review_note}`}</p>}
          {manage && (
            <div className="mt-3 flex flex-wrap gap-2">
              {["OPEN", "REJECTED"].includes(s.status) && <Button onClick={() => setDlg("response")}>Record the supplier's response</Button>}
              {s.status === "RESPONDED" && <><Button onClick={() => setDlg("accept")}>Accept the response</Button><Button variant="secondary" onClick={() => setDlg("reject")}>Reject the response</Button></>}
              {s.status === "ACCEPTED" && <Button onClick={() => setDlg("close")}>Close the request</Button>}
            </div>
          )}
        </Card>
        <HistoryPanel history={s.history} />
      </div>
      <ActionDialog title="Record the supplier's response" open={dlg === "response"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "response", label: "Response", required: true }]} submit={(v) => act({ id: s.id, action: "response", body: { response: (v.response ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Accept the response" open={dlg === "accept"} onClose={() => setDlg(null)} cta="Accept" fields={[{ name: "note", label: "Review note", required: true }]} submit={(v) => act({ id: s.id, action: "review", body: { accept: true, note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Reject the response" open={dlg === "reject"} onClose={() => setDlg(null)} cta="Reject" fields={[{ name: "note", label: "Why it is not acceptable", required: true }]} submit={(v) => act({ id: s.id, action: "review", body: { accept: false, note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Close the request" open={dlg === "close"} onClose={() => setDlg(null)} cta="Close" fields={[{ name: "note", label: "Closing note" }]} submit={(v) => act({ id: s.id, action: "close", body: { note: (v.note ?? "").trim() } }).unwrap()} />
    </>
  );
}

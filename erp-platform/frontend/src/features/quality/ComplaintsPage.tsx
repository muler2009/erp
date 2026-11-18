import { useState } from "react";
import { Link, useParams } from "react-router";

import { useGetQualityComplaintQuery, useListProductsQuery, useListQualityComplaintsQuery, useListQualityConfigQuery, useQualityComplaintActionMutation, useRegisterQualityComplaintMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { UserSelect } from "../../shared/ui/UserSelect";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";
import { ActionsPanel, CostsPanel, EvidencePanel, HistoryPanel } from "./panels";

export const COMPLAINT_STATUSES = ["RECEIVED", "INVESTIGATING", "RESPONDED", "CLOSED"];

export function complaintTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "CLOSED") return "green";
  if (s === "RECEIVED") return "red";
  return "amber";
}

export function validateComplaint(f: { complaint_type: string; severity: string; description: string; customer_name: string; investigator_id: string }): string | null {
  if (!f.customer_name.trim()) return "Identify the customer.";
  if (!f.complaint_type) return "Choose the complaint type.";
  if (!f.severity) return "Choose the severity.";
  if (!f.description.trim()) return "Describe the complaint.";
  if (!f.investigator_id) return "Choose who investigates it.";
  return null;
}

/** Mirrors the server: closing needs customer confirmation or a note, and a CAPA when the severity requires one. */
export function closeBlock(c: { capa_id: string | null }, requiresCapa: boolean, confirmedOn: string, note: string): string | null {
  if (!confirmedOn && !note.trim()) return "Record the customer's confirmation, or why none was obtained.";
  if (requiresCapa && !c.capa_id) return "This severity requires a CAPA before the complaint can be closed.";
  return null;
}

export function ComplaintsPage() {
  const { can } = useAccess();
  const manage = can("quality.complaint.manage");
  const [f, setF] = useState({ status: "", severity: "" });
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListQualityComplaintsQuery({ status: f.status || undefined, severity: f.severity || undefined, cursor });
  const severities = useListQualityConfigQuery("SEVERITY");
  const types = useListQualityConfigQuery("COMPLAINT_TYPE");
  const products = useListProductsQuery(undefined, { skip: !manage });
  const people = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [register] = useRegisterQualityComplaintMutation();
  const empty = { customer_name: "", complaint_type: "", severity: "", description: "", investigator_id: "", product_id: "", lot_number: "", channel: "" };
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateComplaint(n);
    if (p) { setErr(p); return; }
    setErr(null);
    const body: Record<string, unknown> = { customer_name: n.customer_name.trim(), complaint_type: n.complaint_type, severity: n.severity, description: n.description.trim(), investigator_id: n.investigator_id };
    for (const k of ["product_id", "lot_number", "channel"] as const) if (n[k].trim()) body[k] = n[k].trim();
    try { await register(body).unwrap(); setOpen(false); setN(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  const reset = (x: typeof f) => { setF(x); setCursor(null); };
  return (
    <>
      <PageHeader title="Customer complaints" description="From receipt to confirmed resolution." actions={manage ? <Button onClick={() => setOpen(true)}>Register a complaint</Button> : undefined} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-3">
          <label className="text-sm">Status <select aria-label="Complaint status" className={inputClass} value={f.status} onChange={(e) => reset({ ...f, status: e.target.value })}><option value="">All</option>{COMPLAINT_STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
          <label className="text-sm">Severity <select aria-label="Complaint severity" className={inputClass} value={f.severity} onChange={(e) => reset({ ...f, severity: e.target.value })}><option value="">All</option>{severities.data?.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
        </div>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No complaints match" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Customer</th><th>Type</th><th>Severity</th><th>Received</th><th>Investigator</th><th>Status</th></tr></thead>
            <tbody>{data.results.map((c) => (
              <tr key={c.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/complaints/${c.id}`}>{c.number}</Link>{c.is_recurring && <> <Badge tone="amber">Recurring</Badge></>}</td><td>{c.customer_name || "–"}</td><td>{pretty(c.complaint_type)}</td><td>{pretty(c.severity)}</td><td>{c.received_on}</td><td>{nameOf(c.investigator_id)}</td><td><Badge tone={complaintTone(c.status)}>{pretty(c.status)}</Badge></td></tr>))}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
      <Modal title="Register a complaint" open={open} onClose={() => setOpen(false)}>
        <div className="grid grid-cols-1 gap-x-3 md:grid-cols-2">
          <FormField label="Customer" htmlFor="cm-cust"><input id="cm-cust" className={inputClass} value={n.customer_name} onChange={(e) => setN({ ...n, customer_name: e.target.value })} /></FormField>
          <FormField label="Complaint type" htmlFor="cm-type"><select id="cm-type" className={inputClass} value={n.complaint_type} onChange={(e) => setN({ ...n, complaint_type: e.target.value })}><option value="">Choose…</option>{types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></FormField>
          <FormField label="Severity" htmlFor="cm-sev"><select id="cm-sev" className={inputClass} value={n.severity} onChange={(e) => setN({ ...n, severity: e.target.value })}><option value="">Choose…</option>{severities.data?.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></FormField>
          <FormField label="Investigator" htmlFor="cm-inv"><UserSelect id="cm-inv" value={n.investigator_id} onChange={(x) => setN({ ...n, investigator_id: x })} options={people} placeholder="Choose…" /></FormField>
          <FormField label="Product" htmlFor="cm-prod"><select id="cm-prod" className={inputClass} value={n.product_id} onChange={(e) => setN({ ...n, product_id: e.target.value })}><option value="">None</option>{products.data?.results.map((p) => <option key={p.id} value={p.id}>{p.sku} {p.name}</option>)}</select></FormField>
          <FormField label="Lot number" htmlFor="cm-lot"><input id="cm-lot" className={inputClass} value={n.lot_number} onChange={(e) => setN({ ...n, lot_number: e.target.value })} /></FormField>
          <FormField label="Received by" htmlFor="cm-chan"><input id="cm-chan" className={inputClass} placeholder="phone, email, visit…" value={n.channel} onChange={(e) => setN({ ...n, channel: e.target.value })} /></FormField>
        </div>
        <FormField label="Description" htmlFor="cm-desc"><textarea id="cm-desc" className={inputClass} value={n.description} onChange={(e) => setN({ ...n, description: e.target.value })} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Register</Button></div>
      </Modal>
    </>
  );
}

export function ComplaintPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.complaint.manage");
  const actor = can("quality.ncr.manage");
  const reporter = can("quality.report");
  const { data: c, isLoading, error, refetch } = useGetQualityComplaintQuery(id);
  const [act] = useQualityComplaintActionMutation();
  const severities = useListQualityConfigQuery("SEVERITY");
  const categories = useListQualityConfigQuery("NCR_CATEGORY", { skip: !manage });
  const people = useUserOptions(!manage);
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<"investigate" | "ncr" | "capa" | "respond" | "close" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !c) return <ErrorState error={error} onRetry={refetch} />;
  const closed = c.status === "CLOSED";
  const requiresCapa = !!severities.data?.find((s) => s.code === c.severity)?.requires_capa;
  const tryClose = () => { const m = closeBlock(c, requiresCapa, "", "x"); if (m) { setErr(m); return; } setErr(null); setDlg("close"); };
  return (
    <>
      <PageHeader title={`${c.number} · ${c.customer_name || "Customer"}`} description={c.description} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/complaints">All complaints</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={complaintTone(c.status)}>{pretty(c.status)}</Badge><Badge tone="slate">{pretty(c.complaint_type)}</Badge><Badge tone="slate">{pretty(c.severity)}</Badge>{c.is_recurring && <Badge tone="amber">Recurring</Badge>}{c.lot_number && <Badge tone="slate">{`Lot ${c.lot_number}`}</Badge>}</div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="grid gap-4">
        <Card title="Handling">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <dt className="font-medium">Received</dt><dd>{c.received_on}{c.channel ? ` by ${c.channel}` : ""}</dd>
            <dt className="font-medium">Investigator</dt><dd>{nameOf(c.investigator_id)}</dd>
            <dt className="font-medium">Findings</dt><dd>{c.findings || "–"}</dd>
            <dt className="font-medium">Response to the customer</dt><dd>{c.response_text || "–"}</dd>
            <dt className="font-medium">Resolution</dt><dd>{c.resolution || "–"}</dd>
            {c.customer_confirmed_on && <><dt className="font-medium">Customer confirmed</dt><dd>{c.customer_confirmed_on}</dd></>}
            {c.capa_id && <><dt className="font-medium">CAPA</dt><dd><Link className="text-blue-700 underline" to={`/app/quality/capas/${c.capa_id}`}>Open the linked CAPA</Link></dd></>}
          </dl>
          {manage && !closed && (
            <div className="mt-3 flex flex-wrap gap-2">
              {["RECEIVED", "INVESTIGATING"].includes(c.status) && <Button onClick={() => setDlg("investigate")}>Record findings</Button>}
              <Button variant="secondary" onClick={() => setDlg("ncr")}>Raise a non-conformance</Button>
              {!c.capa_id && <Button variant="secondary" onClick={() => setDlg("capa")}>Raise a CAPA</Button>}
              {c.status === "INVESTIGATING" && <Button onClick={() => setDlg("respond")}>Respond to the customer</Button>}
              {c.status === "RESPONDED" && <Button onClick={tryClose}>Close the complaint</Button>}
            </div>
          )}
          {requiresCapa && !c.capa_id && !closed && <p className="mt-2 text-sm text-amber-800">This severity needs a CAPA before the complaint can be closed.</p>}
        </Card>
        <ActionsPanel parent="complaint" id={c.id} actions={c.actions} canManage={actor} canReport={false} open={!closed} />
        <EvidencePanel record="complaint" id={c.id} evidence={c.evidence} canUpload={reporter && !closed} />
        <CostsPanel refType="complaint" id={c.id} costs={c.costs} canRecord={actor} />
        <HistoryPanel history={c.history} />
      </div>
      <ActionDialog title="Record findings" open={dlg === "investigate"} onClose={() => setDlg(null)} cta="Record" fields={[{ name: "findings", label: "Findings", required: true }, { name: "lot_number", label: "Lot number" }]}
        submit={(v) => { const body: Record<string, unknown> = { findings: (v.findings ?? "").trim() }; if ((v.lot_number ?? "").trim()) body.lot_number = (v.lot_number ?? "").trim(); return act({ id: c.id, action: "investigate", body }).unwrap(); }} />
      <ActionDialog title="Raise a non-conformance" open={dlg === "ncr"} onClose={() => setDlg(null)} cta="Raise" fields={[{ name: "category", label: "Category", required: true, options: (categories.data ?? []).map((x) => [x.code, x.name] as [string, string]) }, { name: "containment", label: "Containment" }]}
        submit={(v) => act({ id: c.id, action: "ncr", body: { category: v.category, containment: (v.containment ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Raise a CAPA for this complaint" open={dlg === "capa"} onClose={() => setDlg(null)} cta="Raise CAPA" fields={[{ name: "owner_id", label: "Owner", required: true, options: people, searchUsers: true }, { name: "reviewer_id", label: "Effectiveness reviewer", required: true, options: people, searchUsers: true }, { name: "due_date", label: "Due date", type: "date", required: true }]}
        submit={(v) => { if (v.owner_id === v.reviewer_id) throw new Error("The owner and the reviewer must be different people."); return act({ id: c.id, action: "capa", body: { owner_id: v.owner_id, reviewer_id: v.reviewer_id, due_date: v.due_date } }).unwrap(); }} />
      <ActionDialog title="Respond to the customer" open={dlg === "respond"} onClose={() => setDlg(null)} cta="Record response" fields={[{ name: "response_text", label: "What we told the customer", required: true }, { name: "resolution", label: "Resolution", required: true }]}
        submit={(v) => act({ id: c.id, action: "respond", body: { response_text: (v.response_text ?? "").trim(), resolution: (v.resolution ?? "").trim() } }).unwrap()} />
      <ActionDialog title="Close the complaint" open={dlg === "close"} onClose={() => setDlg(null)} cta="Close" fields={[{ name: "customer_confirmed_on", label: "Customer confirmed on", type: "date" }, { name: "note", label: "Note (needed if the customer did not confirm)" }]}
        submit={async (v) => { const m = closeBlock(c, requiresCapa, v.customer_confirmed_on ?? "", v.note ?? ""); if (m) throw new Error(m);
          const body: Record<string, unknown> = { note: (v.note ?? "").trim() }; if (v.customer_confirmed_on) body.customer_confirmed_on = v.customer_confirmed_on;
          await act({ id: c.id, action: "close", body }).unwrap(); }} />
    </>
  );
}

import { useState } from "react";
import { Link, useParams } from "react-router";

import { useAddSupplierCertificateMutation, useEvaluateSupplierMutation, useGetSupplierQualityQuery, useListScarsQuery, useListSupplierEvaluationsQuery, useListSuppliersQuery, useSetSupplierQualityStatusMutation } from "../../shared/api/endpoints";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { scarTone } from "./ScarsPage";

export const SUPPLIER_STATUSES = ["PENDING", "APPROVED", "CONDITIONAL", "RESTRICTED", "BLOCKED"];
const NUM = /^\d+(\.\d+)?$/;

export function supplierTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "APPROVED") return "green";
  if (s === "BLOCKED" || s === "RESTRICTED") return "red";
  if (s === "CONDITIONAL") return "amber";
  return "slate";
}

export function validateSupplierStatus(status: string, reason: string, minScore: string, maxRate: string, openScars: number): string | null {
  if (!SUPPLIER_STATUSES.includes(status)) return "Choose the new status.";
  if (!reason.trim()) return "Give the reason for the change.";
  if (status === "APPROVED" && openScars > 0) return "Close the open corrective action requests before approving this supplier.";
  for (const [l, v] of [["minimum score", minScore], ["maximum rejection rate", maxRate]] as const) {
    if (v.trim() && (!NUM.test(v.trim()) || Number(v) > 100)) return `The ${l} must be between 0 and 100.`;
  }
  return null;
}

export function validateCertificate(name: string, issued: string, expires: string): string | null {
  if (!name.trim()) return "Name the certificate.";
  if (issued && expires && expires < issued) return "The certificate expires before it was issued.";
  return null;
}

export function validateEvaluation(from: string, to: string): string | null {
  if (!from || !to) return "Enter both dates of the period.";
  if (to < from) return "The period ends before it starts.";
  return null;
}

export function SupplierQualityListPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListSuppliersQuery({ cursor });
  return (
    <>
      <PageHeader title="Supplier quality" description="Approval status, certificates, evaluations and corrective action requests." actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/scars">Corrective action requests</Link>} />
      <Card>
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No suppliers" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Supplier</th><th>Procurement status</th></tr></thead>
            <tbody>{data.results.map((s) => <tr key={s.id} className="border-t"><td><Link className="text-blue-700 underline" to={`/app/quality/suppliers/${s.id}`}>{s.name}</Link></td><td>{pretty(s.status)}</td></tr>)}</tbody></table>
        )}
        {data?.next && <div className="mt-2"><Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button></div>}
      </Card>
    </>
  );
}

export function SupplierQualityPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("quality.supplier.manage");
  const suppliers = useListSuppliersQuery();
  const { data: p, isLoading, error, refetch } = useGetSupplierQualityQuery(id);
  const evals = useListSupplierEvaluationsQuery(id);
  const scars = useListScarsQuery({ supplier_id: id });
  const [setStatus] = useSetSupplierQualityStatusMutation();
  const [addCert] = useAddSupplierCertificateMutation();
  const [evaluate] = useEvaluateSupplierMutation();
  const [dlg, setDlg] = useState<"status" | "cert" | "eval" | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !p) return <ErrorState error={error} onRetry={refetch} />;
  const name = suppliers.data?.results.find((s) => s.id === id)?.name ?? "Supplier";
  return (
    <>
      <PageHeader title={`${name} · quality`} description={p.status_reason || undefined} actions={<Link className="text-sm text-blue-700 underline" to="/app/quality/suppliers">All suppliers</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={supplierTone(p.status)}>{pretty(p.status)}</Badge><Badge tone="slate">{`Minimum score ${p.min_score}`}</Badge><Badge tone="slate">{`Maximum rejection rate ${p.max_rejection_rate}%`}</Badge>{p.open_scars > 0 && <Badge tone="red">{`${p.open_scars} open request(s)`}</Badge>}</div>
      <div className="grid gap-4">
        <Card title="Qualification">
          <p className="text-sm">{p.criteria_note || "No criteria note."}</p>
          {manage && <div className="mt-3 flex flex-wrap gap-2"><Button onClick={() => setDlg("status")}>Change status</Button><Button variant="secondary" onClick={() => setDlg("eval")}>Evaluate performance</Button></div>}
        </Card>
        <Card title="Certificates" actions={manage ? <Button variant="secondary" onClick={() => setDlg("cert")}>Add a certificate</Button> : undefined}>
          {!p.certificates.length ? <EmptyState title="No certificates recorded" /> : (
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Name</th><th>Number</th><th>Issuer</th><th>Expires</th></tr></thead>
              <tbody>{p.certificates.map((c) => <tr key={c.id} className="border-t"><td>{c.name}</td><td>{c.number || "–"}</td><td>{c.issuer || "–"}</td><td>{c.expires_on ?? "No expiry"}{c.expired && <> <Badge tone="red">Expired</Badge></>}</td></tr>)}</tbody></table>
          )}
        </Card>
        <Card title="Evaluations">
          {!evals.data?.length ? <EmptyState title="No evaluations yet" /> : (
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Period</th><th>Lots</th><th>Rejected</th><th>Rejection rate</th><th>NCRs</th><th>Score</th><th>Outcome</th></tr></thead>
              <tbody>{evals.data.map((e) => <tr key={e.id} className="border-t"><td>{e.period_from} to {e.period_to}</td><td>{e.lots_inspected}</td><td>{e.lots_rejected}</td><td>{e.rejection_rate}%</td><td>{e.ncr_count}</td><td>{e.score}</td><td><Badge tone={e.outcome === "MEETS" ? "green" : "red"}>{e.outcome === "MEETS" ? "Meets criteria" : "Below criteria"}</Badge></td></tr>)}</tbody></table>
          )}
          <p className="mt-2 text-xs text-slate-500">Score is 100 minus twice the rejection rate (up to 50), 5 per NCR (up to 30) and 5 per open request (up to 20).</p>
        </Card>
        <Card title="Corrective action requests">
          {!scars.data?.results.length ? <EmptyState title="No requests" /> : (
            <ul className="text-sm">{scars.data.results.map((s) => <li key={s.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2"><Link className="text-blue-700 underline" to={`/app/quality/scars/${s.id}`}>{s.number}</Link><span className="flex-1">{s.description}</span><Badge tone={scarTone(s.status)}>{pretty(s.status)}</Badge></li>)}</ul>
          )}
        </Card>
      </div>
      <ActionDialog title="Change supplier status" open={dlg === "status"} onClose={() => setDlg(null)} cta="Change status"
        fields={[{ name: "status", label: "New status", required: true, options: SUPPLIER_STATUSES.map((s) => [s, pretty(s)] as [string, string]) }, { name: "reason", label: "Reason", required: true }, { name: "min_score", label: "Minimum score (0–100)" }, { name: "max_rejection_rate", label: "Maximum rejection rate (%)" }, { name: "criteria_note", label: "Criteria note" }]}
        submit={async (v) => { const m = validateSupplierStatus(v.status ?? "", v.reason ?? "", v.min_score ?? "", v.max_rejection_rate ?? "", p.open_scars); if (m) throw new Error(m);
          const body: Record<string, unknown> = { status: v.status, reason: (v.reason ?? "").trim() };
          for (const k of ["min_score", "max_rejection_rate", "criteria_note"] as const) if ((v[k] ?? "").trim()) body[k] = (v[k] ?? "").trim();
          await setStatus({ id, body }).unwrap(); }} />
      <ActionDialog title="Add a certificate" open={dlg === "cert"} onClose={() => setDlg(null)} cta="Add"
        fields={[{ name: "name", label: "Certificate", required: true }, { name: "number", label: "Number" }, { name: "issuer", label: "Issuer" }, { name: "issued_on", label: "Issued on", type: "date" }, { name: "expires_on", label: "Expires on", type: "date" }]}
        submit={async (v) => { const m = validateCertificate(v.name ?? "", v.issued_on ?? "", v.expires_on ?? ""); if (m) throw new Error(m);
          const body: Record<string, unknown> = { name: (v.name ?? "").trim() };
          for (const k of ["number", "issuer", "issued_on", "expires_on"] as const) if ((v[k] ?? "").trim()) body[k] = (v[k] ?? "").trim();
          await addCert({ id, body }).unwrap(); }} />
      <ActionDialog title="Evaluate performance" open={dlg === "eval"} onClose={() => setDlg(null)} cta="Evaluate"
        fields={[{ name: "date_from", label: "From", type: "date", required: true }, { name: "date_to", label: "To", type: "date", required: true }, { name: "apply", label: "If the supplier falls below criteria", options: [["", "Record only"], ["yes", "Also move an approved supplier to conditional"]] }]}
        submit={async (v) => { const m = validateEvaluation(v.date_from ?? "", v.date_to ?? ""); if (m) throw new Error(m); await evaluate({ id, body: { date_from: v.date_from, date_to: v.date_to, apply_status: v.apply === "yes" } }).unwrap(); }} />
    </>
  );
}

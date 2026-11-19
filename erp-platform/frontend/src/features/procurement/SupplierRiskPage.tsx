import { Link } from "react-router";

import { useGetSupplierRiskQuery, useListExpiringSupplierDocumentsQuery } from "../../shared/api/endpoints";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";

const RISK_TONE: Record<string, "green" | "amber" | "red"> = { LOW: "green", MEDIUM: "amber", HIGH: "red" };

export function SupplierRiskPage() {
  const risk = useGetSupplierRiskQuery();
  const docs = useListExpiringSupplierDocumentsQuery(30);
  return (
    <div>
      <PageHeader title="Supplier risk" description="Which suppliers need attention before you buy from them." />
      <Card title="Suppliers">
        {risk.isLoading ? <Spinner /> : risk.isError ? <ErrorState error={risk.error} onRetry={() => void risk.refetch()} /> : (risk.data ?? []).length === 0 ? <EmptyState title="No suppliers yet" /> : (
          <table className="w-full text-sm"><caption className="sr-only">Supplier risk</caption>
            <thead><tr className="text-left text-slate-500"><th>Supplier</th><th>Status</th><th>Standing</th><th>Risk</th><th className="text-right">Expired documents</th><th>Bank details</th></tr></thead>
            <tbody>{(risk.data ?? []).map((r) => (
              <tr key={r.supplier} className="border-t border-slate-100"><td className="py-1">{r.supplier}</td><td>{r.status.toLowerCase()}</td><td>{r.standing === "GOOD" ? "Good" : <Badge tone="red">{r.standing.toLowerCase()}</Badge>}</td><td><Badge tone={RISK_TONE[r.risk_level] ?? "amber"}>{r.risk_level.toLowerCase()}</Badge></td><td className="text-right">{r.expired_documents > 0 ? <span className="text-red-700">{r.expired_documents}</span> : 0}</td><td>{r.verified_bank ? "Verified" : <span className="text-amber-700">Not verified</span>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Card title="Documents expiring within 30 days">
        {docs.isLoading ? <Spinner /> : docs.isError ? <ErrorState error={docs.error} onRetry={() => void docs.refetch()} /> : (docs.data ?? []).length === 0 ? <EmptyState title="Nothing is expiring" /> : (
          <table className="w-full text-sm"><caption className="sr-only">Expiring documents</caption>
            <thead><tr className="text-left text-slate-500"><th>Supplier</th><th>Document</th><th>Reference</th><th>Expires</th></tr></thead>
            <tbody>{(docs.data ?? []).map((d, n) => <tr key={`${d.supplier}-${d.reference}-${n}`} className="border-t border-slate-100"><td className="py-1">{d.supplier}</td><td>{d.doc_type}</td><td>{d.reference || "—"}</td><td>{d.expiry_date} {d.status === "EXPIRED" && <Badge tone="red">Expired</Badge>}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      <p className="text-sm"><Link className="text-blue-700 underline" to="/app/procurement/suppliers">Open a supplier to fix these</Link></p>
    </div>
  );
}

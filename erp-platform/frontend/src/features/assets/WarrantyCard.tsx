import { useState } from "react";

import { useAddWarrantyMutation, useFileWarrantyClaimMutation, useGetWarrantiesQuery } from "../../shared/api/endpoints";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

const DEC = /^\d+(\.\d{1,4})?$/;

export function validateWarranty(provider: string, start: string, end: string): string | null {
  if (!provider.trim()) return "Enter the warranty provider.";
  if (!start || !end) return "Enter the start and end dates.";
  if (end < start) return "The warranty must end on or after the day it starts.";
  return null;
}

export function WarrantyCard({ id }: { id: string }) {
  const { can } = useAccess();
  const manage = can("assets.insurance.manage");
  const { data, isLoading, error, refetch } = useGetWarrantiesQuery(id);
  const [add] = useAddWarrantyMutation();
  const [claim] = useFileWarrantyClaimMutation();
  const [dlg, setDlg] = useState<"add" | "claim" | null>(null);
  return (
    <Card title="Warranty">
      {isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : (
        <>
          {data.in_force ? <p className="mb-2 text-sm"><Badge tone="green">In force</Badge> {data.in_force.provider_name} until {data.in_force.end_on}{data.in_force.coverage ? ` — ${data.in_force.coverage}` : ""}</p> : <p className="mb-2 text-sm"><Badge tone="slate">No warranty in force</Badge></p>}
          {data.all.length === 0 ? <EmptyState title="No warranties recorded" /> : <ul className="text-sm">{data.all.map((w) => <li key={w.id} className="border-b border-slate-100 py-1">{w.provider_name} {w.reference && `(${w.reference})`}: {w.start_on} to {w.end_on}</li>)}</ul>}
          {manage && <div className="mt-3 flex gap-2"><Button variant="secondary" onClick={() => setDlg("add")}>Add a warranty</Button>{data.in_force && <Button variant="secondary" onClick={() => setDlg("claim")}>File a warranty claim</Button>}</div>}
        </>
      )}
      <ActionDialog title="Add a warranty" open={dlg === "add"} onClose={() => setDlg(null)} cta="Save warranty" fields={[{ name: "provider_name", label: "Provider", required: true }, { name: "start_on", label: "Starts", type: "date", required: true }, { name: "end_on", label: "Ends", type: "date", required: true }, { name: "reference", label: "Reference" }, { name: "coverage", label: "What it covers" }]}
        submit={async (v) => { const p = validateWarranty(v.provider_name ?? "", v.start_on ?? "", v.end_on ?? ""); if (p) throw new Error(p); await add({ id, provider_name: (v.provider_name ?? "").trim(), start_on: v.start_on ?? "", end_on: v.end_on ?? "", reference: (v.reference ?? "").trim(), coverage: (v.coverage ?? "").trim() }).unwrap(); }} />
      <ActionDialog title="File a warranty claim" open={dlg === "claim"} onClose={() => setDlg(null)} cta="File claim" fields={[{ name: "description", label: "What failed", required: true }, { name: "amount_claimed", label: "Amount claimed" }]}
        submit={async (v) => { const a = (v.amount_claimed ?? "").trim(); if (a && !DEC.test(a)) throw new Error("The amount claimed must be a number."); await claim({ id: data!.in_force!.id, description: (v.description ?? "").trim(), amount_claimed: a || "0" }).unwrap(); }} />
    </Card>
  );
}

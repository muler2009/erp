import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "react-router";

import { useCreateRfqMutation, useListRequisitionsQuery, useListRfqsQuery, useListSuppliersQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product, Rfq, RfqInput } from "../../shared/api/types";
import { parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

export const rfqTone = (s: string) => (s === "AWARDED" ? "green" : s === "CANCELLED" ? "red" : s === "OPEN" ? "amber" : "slate") as "green" | "red" | "amber" | "slate";

export interface DraftLine { product: Product | null; description: string; quantity: string }

/** Returns an error message or null; the server repeats every check (qualified suppliers, approved requisition, ...). */
export function validateRfq(f: { title: string; suppliers: string[]; source: "requisition" | "manual"; requisition: string; lines: DraftLine[] }): string | null {
  if (!f.title.trim()) return "Give the RFQ a title.";
  if (f.suppliers.length === 0) return "Invite at least one supplier.";
  if (f.source === "requisition") return f.requisition ? null : "Choose the approved requisition to source.";
  if (f.lines.length === 0) return "Add at least one line.";
  for (const [i, l] of f.lines.entries()) {
    if (!l.product && !l.description.trim()) return `Line ${i + 1}: choose a product or describe the item.`;
    const q = parseMoney(l.quantity);
    if (q === null || q <= 0n) return `Line ${i + 1}: quantity must be more than 0.`;
  }
  return null;
}

export function buildRfqInput(f: { title: string; due: string; suppliers: string[]; source: "requisition" | "manual"; requisition: string; lines: DraftLine[] }): RfqInput {
  const base: RfqInput = { title: f.title.trim(), suppliers: f.suppliers, ...(f.due ? { due_date: f.due } : {}) };
  if (f.source === "requisition") return { ...base, requisition: f.requisition };
  return { ...base, lines: f.lines.map((l) => ({ ...(l.product ? { product: l.product.id } : {}), description: l.description.trim() || l.product?.name || "", quantity: l.quantity.trim() })) };
}

function NewRfqDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const suppliers = useListSuppliersQuery({ status: "QUALIFIED" }, { skip: !open });
  const reqs = useListRequisitionsQuery(undefined, { skip: !open });
  const [create, state] = useCreateRfqMutation();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [source, setSource] = useState<"requisition" | "manual">("manual");
  const [requisition, setRequisition] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ product: null, description: "", quantity: "1" }]);
  const [err, setErr] = useState<string | null>(null);
  const sourceable = reqs.data?.results.filter((r) => r.status === "APPROVED" || r.status === "PARTIALLY_ORDERED") ?? [];
  const patch = (i: number, p: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    const f = { title, due, suppliers: picked, source, requisition, lines };
    const problem = validateRfq(f);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await create(buildRfqInput(f)).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New request for quotation" open={open} onClose={close}>
      <div className="max-h-[70vh] overflow-y-auto">
        <FormField label="Title" htmlFor="rfq-title"><input id="rfq-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></FormField>
        <FormField label="Quotations due (optional)" htmlFor="rfq-due"><input id="rfq-due" type="date" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} /></FormField>
        <fieldset className="mb-3"><legend className="text-sm font-medium">Invite qualified suppliers</legend>
          {suppliers.data?.results.length === 0 && <p className="text-sm text-slate-600">No qualified suppliers yet.</p>}
          {suppliers.data?.results.map((s) => (
            <label key={s.id} className="mr-4 inline-block text-sm"><input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))} /> {s.name}</label>
          ))}
        </fieldset>
        <FormField label="What to source" htmlFor="rfq-source">
          <select id="rfq-source" className={inputClass} value={source} onChange={(e) => setSource(e.target.value as "requisition" | "manual")}><option value="manual">Lines I enter</option><option value="requisition">An approved requisition</option></select>
        </FormField>
        {source === "requisition" ? (
          <FormField label="Requisition" htmlFor="rfq-req">
            <select id="rfq-req" className={inputClass} value={requisition} onChange={(e) => setRequisition(e.target.value)}><option value="">Choose…</option>{sourceable.map((r) => <option key={r.id} value={r.id}>{r.number} {r.title}</option>)}</select>
          </FormField>
        ) : (
          <div>
            {lines.map((l, i) => (
              <div key={i} className="mb-3 rounded border border-slate-200 p-2">
                <ProductPicker label={`Line ${i + 1} product (optional)`} onChange={(p) => patch(i, { product: p, ...(p ? { description: p.name } : {}) })} />
                <div className="grid grid-cols-[1fr_6rem_auto] gap-2">
                  <input aria-label={`Line ${i + 1} description`} className={inputClass} placeholder="Description" value={l.description} onChange={(e) => patch(i, { description: e.target.value })} />
                  <input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className={`${inputClass} text-right`} value={l.quantity} onChange={(e) => patch(i, { quantity: e.target.value })} />
                  {lines.length > 1 && <Button variant="secondary" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</Button>}
                </div>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setLines((ls) => [...ls, { product: null, description: "", quantity: "1" }])}>Add line</Button>
          </div>
        )}
      </div>
      {err && <p role="alert" className="my-3 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Create RFQ</Button></div>
    </Modal>
  );
}

const columns: ColumnDef<Rfq>[] = [
  { header: "RFQ", cell: ({ row }) => <Link className="text-indigo-700 underline" to={`/app/procurement/rfqs/${row.original.id}`}>{row.original.number}</Link> },
  { header: "Title", accessorKey: "title" },
  { header: "Type", cell: ({ row }) => (row.original.kind === "TENDER" ? "Tender" : "RFQ") },
  { header: "Due", cell: ({ row }) => row.original.due_date ?? "" },
  { header: "Status", cell: ({ row }) => <Badge tone={rfqTone(row.original.status)}>{row.original.status}</Badge> },
];

export function RfqsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListRfqsQuery({ cursor });
  return (
    <>
      <PageHeader title="Requests for quotation" description="Invite suppliers, compare their quotations and award one to create the purchase order." actions={can("procurement.rfq.manage") ? <Button onClick={() => setCreating(true)}>New RFQ</Button> : undefined} />
      <DataTable caption="Requests for quotation" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No RFQs yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <NewRfqDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

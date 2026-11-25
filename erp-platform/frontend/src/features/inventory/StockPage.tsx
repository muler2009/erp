import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { useListMovementsQuery, useListStockLevelsQuery, useListWarehousesQuery, useRecordMovementMutation } from "../../shared/api/endpoints";
import { errorMessage, fieldErrors } from "../../shared/api/errors";
import type { MovementInput, Product, StockLevelRow, StockMovementRow } from "../../shared/api/types";
import { formatDateTime } from "../../shared/lib/format";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

type Kind = MovementInput["kind"];
const KINDS: { kind: Kind; label: string; permission: string }[] = [
  { kind: "receive", label: "Receive stock", permission: "inventory.goods.receive" },
  { kind: "issue", label: "Issue stock", permission: "inventory.stock.issue" },
  { kind: "transfer", label: "Transfer stock", permission: "inventory.stock.issue" },
  { kind: "adjust", label: "Adjust stock (count)", permission: "inventory.stock.adjust" },
];

/** Returns an error message, or null when the form is acceptable. The server validates again. */
export function validateMovement(kind: Kind, f: { product: Product | null; location: string; toLocation: string; quantity: string; unitCost: string; counted: string; reason: string }): string | null {
  if (!f.product) return "Choose a product.";
  if (!f.location) return "Choose a location.";
  if (kind === "adjust") {
    const c = parseMoney(f.counted);
    if (c === null || c < 0n) return "Enter the counted quantity (0 or more).";
    if (!f.reason.trim()) return "A reason is required for an adjustment.";
    return null;
  }
  const q = parseMoney(f.quantity);
  if (q === null || q <= 0n) return "Enter a quantity greater than 0.";
  if (kind === "receive") {
    const c = f.unitCost.trim() === "" ? 0n : parseMoney(f.unitCost);
    if (c === null || c < 0n) return "Enter a valid unit cost.";
  }
  if (kind === "transfer") {
    if (!f.toLocation) return "Choose the destination location.";
    if (f.toLocation === f.location) return "The destination must differ from the source.";
  }
  return null;
}

function MovementDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can } = useAccess();
  const allowed = KINDS.filter((k) => can(k.permission));
  const warehouses = useListWarehousesQuery(undefined, { skip: !open });
  const [record, state] = useRecordMovementMutation();
  const [kind, setKind] = useState<Kind>(allowed[0]?.kind ?? "receive");
  const [product, setProduct] = useState<Product | null>(null);
  const [location, setLocation] = useState("");
  const [toLocation, setToLocation] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [counted, setCounted] = useState("");
  const [lot, setLot] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const locations = useMemo(() => warehouses.data?.results.flatMap((w) => w.locations.filter((l) => !l.is_blocked).map((l) => ({ id: l.id, label: `${w.code} / ${l.code}` }))) ?? [], [warehouses.data]);

  const close = () => { setProduct(null); setLocation(""); setToLocation(""); setQuantity(""); setUnitCost(""); setCounted(""); setLot(""); setReason(""); setErr(null); onClose(); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validateMovement(kind, { product, location, toLocation, quantity, unitCost, counted, reason });
    if (problem) { setErr(problem); return; }
    setErr(null);
    const body: MovementInput["body"] = { product: product!.id, location, reason: reason.trim(), ...(lot.trim() ? { lot_code: lot.trim() } : {}) };
    if (kind === "adjust") body.counted_quantity = counted.trim();
    else body.quantity = quantity.trim();
    if (kind === "receive" && unitCost.trim()) body.unit_cost = unitCost.trim();
    if (kind === "transfer") body.to_location = toLocation;
    try { await record({ kind, body }).unwrap(); close(); } catch (x) { setErr(Object.values(fieldErrors(x))[0] ?? errorMessage(x)); }
  };
  const locSelect = (id: string, value: string, set: (v: string) => void, label: string) => (
    <FormField label={label} htmlFor={id}>
      <select id={id} className={inputClass} value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Choose…</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
    </FormField>
  );
  return (
    <Modal title="Record stock movement" open={open} onClose={close}>
      <form onSubmit={submit} noValidate className="max-h-[75vh] overflow-y-auto">
        <FormField label="Movement" htmlFor="mv-kind">
          <select id="mv-kind" className={inputClass} value={kind} onChange={(e) => { setKind(e.target.value as Kind); setErr(null); }}>{allowed.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select>
        </FormField>
        <ProductPicker label="Product" onChange={setProduct} />
        {locSelect("mv-loc", location, setLocation, kind === "transfer" ? "From location" : "Location")}
        {kind === "transfer" && locSelect("mv-to", toLocation, setToLocation, "To location")}
        {kind === "adjust" ? (
          <FormField label="Counted quantity" htmlFor="mv-counted"><input id="mv-counted" inputMode="decimal" className={inputClass} value={counted} onChange={(e) => setCounted(e.target.value)} /></FormField>
        ) : (
          <FormField label="Quantity" htmlFor="mv-qty"><input id="mv-qty" inputMode="decimal" className={inputClass} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></FormField>
        )}
        {kind === "receive" && <FormField label="Unit cost" htmlFor="mv-cost"><input id="mv-cost" inputMode="decimal" className={inputClass} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} /></FormField>}
        {product && product.tracking !== "NONE" && <FormField label={product.tracking === "SERIAL" ? "Serial number" : "Lot code"} htmlFor="mv-lot"><input id="mv-lot" className={inputClass} value={lot} onChange={(e) => setLot(e.target.value)} /></FormField>}
        <FormField label={kind === "adjust" ? "Reason" : "Reason (optional)"} htmlFor="mv-reason"><input id="mv-reason" className={inputClass} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={state.isLoading}>Record</Button></div>
      </form>
    </Modal>
  );
}

const levelCols: ColumnDef<StockLevelRow>[] = [
  { header: "Product", accessorKey: "product" },
  { header: "Warehouse", accessorKey: "warehouse" },
  { header: "Location", accessorKey: "location" },
  { header: "Lot", cell: ({ row }) => row.original.lot ?? "—" },
  { header: "Quantity", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.quantity)}</span> },
];
const moveCols: ColumnDef<StockMovementRow>[] = [
  { header: "When", cell: ({ row }) => formatDateTime(row.original.at) },
  { header: "Product", accessorKey: "product" },
  { header: "Location", accessorKey: "location" },
  { header: "Type", cell: ({ row }) => row.original.type.toLowerCase().replace(/_/g, " ") },
  { header: "Quantity", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.quantity)}</span> },
  { header: "Reason", accessorKey: "reason" },
];

export function StockPage() {
  const [tab, setTab] = useState<"levels" | "movements">("levels");
  const [lc, setLc] = useState<string | null>(null);
  const [mc, setMc] = useState<string | null>(null);
  const [warehouse, setWarehouse] = useState("");
  const warehouses = useListWarehousesQuery();
  const levels = useListStockLevelsQuery({ cursor: lc, warehouse }, { skip: tab !== "levels" });
  const moves = useListMovementsQuery({ cursor: mc }, { skip: tab !== "movements" });
  const [open, setOpen] = useState(false);
  const { can } = useAccess();
  const canMove = KINDS.some((k) => can(k.permission));
  return (
    <>
      <PageHeader title="Stock" description="Quantities by location, and every movement that produced them." actions={canMove ? <Button onClick={() => setOpen(true)}>Record movement</Button> : undefined} />
      <div role="tablist" aria-label="Stock views" className="mb-4 flex flex-wrap gap-2">
        {(["levels", "movements"] as const).map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-brand-600 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}>{t === "levels" ? "Stock on hand" : "Movement history"}</button>
        ))}
      </div>
      {tab === "levels" ? (
        <>
          <label className="mb-3 flex items-center gap-2 text-sm">Warehouse
            <select className={`${inputClass} w-auto`} value={warehouse} onChange={(e) => { setWarehouse(e.target.value); setLc(null); }}>
              <option value="">All</option>{warehouses.data?.results.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
            </select>
          </label>
          <DataTable caption="Stock on hand" columns={levelCols} page={levels.data} isLoading={levels.isLoading} error={levels.error} onRetry={levels.refetch} emptyTitle="No stock on hand" onCursor={setLc} hasPrevious={lc !== null} onFirst={() => setLc(null)} />
        </>
      ) : (
        <DataTable caption="Movement history" columns={moveCols} page={moves.data} isLoading={moves.isLoading} error={moves.error} onRetry={moves.refetch} emptyTitle="No movements yet" onCursor={setMc} hasPrevious={mc !== null} onFirst={() => setMc(null)} />
      )}
      <MovementDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useCreateReservationMutation, useGetAvailabilityQuery, useListReservationsQuery, useListWarehousesQuery, useReleaseReservationMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product, Reservation } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

export function validateReservation(f: { product: Product | null; quantity: string; refType: string; refId: string }): string | null {
  if (!f.product) return "Choose a product.";
  const q = parseMoney(f.quantity);
  if (q === null || q <= 0n) return "Quantity must be more than 0.";
  if (!f.refType.trim() || !f.refId.trim()) return "Say what the stock is reserved for (type and reference).";
  return null;
}

function NewReservationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const warehouses = useListWarehousesQuery(undefined, { skip: !open });
  const [create, state] = useCreateReservationMutation();
  const [product, setProduct] = useState<Product | null>(null);
  const [warehouse, setWarehouse] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [refType, setRefType] = useState("");
  const [refId, setRefId] = useState("");
  const [expires, setExpires] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const avail = useGetAvailabilityQuery({ product: product?.id ?? "", warehouse }, { skip: !product });
  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    const problem = validateReservation({ product, quantity, refType, refId });
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      await create({ product: product!.id, quantity: quantity.trim(), ...(warehouse ? { warehouse } : {}), ref_type: refType.trim(), ref_id: refId.trim(), note: note.trim(), ...(expires ? { expires_on: expires } : {}) }).unwrap();
      close();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New reservation" open={open} onClose={close}>
      <ProductPicker label="Product" onChange={setProduct} />
      <FormField label="Warehouse (optional)" htmlFor="rs-wh"><select id="rs-wh" className={inputClass} value={warehouse} onChange={(e) => setWarehouse(e.target.value)}><option value="">Any warehouse</option>{warehouses.data?.results.filter((w) => w.is_active).map((w) => <option key={w.id} value={w.id}>{w.code} {w.name}</option>)}</select></FormField>
      {product && avail.data && <p className="mb-3 text-sm text-slate-600">Available now: <strong>{formatMoney(avail.data.available)}</strong> (on hand {formatMoney(avail.data.on_hand)}, reserved {formatMoney(avail.data.reserved)})</p>}
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Quantity" htmlFor="rs-qty"><input id="rs-qty" inputMode="decimal" className={`${inputClass} text-right`} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></FormField>
        <FormField label="Expires on (optional)" htmlFor="rs-exp"><input id="rs-exp" type="date" className={inputClass} value={expires} onChange={(e) => setExpires(e.target.value)} /></FormField>
        <FormField label="Reserved for (type)" htmlFor="rs-type"><input id="rs-type" maxLength={40} placeholder="e.g. sales_order" className={inputClass} value={refType} onChange={(e) => setRefType(e.target.value)} /></FormField>
        <FormField label="Reference" htmlFor="rs-ref"><input id="rs-ref" maxLength={80} className={inputClass} value={refId} onChange={(e) => setRefId(e.target.value)} /></FormField>
      </div>
      <FormField label="Note (optional)" htmlFor="rs-note"><input id="rs-note" maxLength={300} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Reserve stock</Button></div>
    </Modal>
  );
}

export function ReservationsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("ACTIVE");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [release, rel] = useReleaseReservationMutation();
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useListReservationsQuery({ cursor, status });
  const doRelease = async (id: string) => { setErr(null); try { await release(id).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const columns: ColumnDef<Reservation>[] = [
    { header: "Product", cell: ({ row }) => row.original.sku },
    { header: "Quantity", cell: ({ row }) => formatMoney(row.original.quantity) },
    { header: "Warehouse", cell: ({ row }) => row.original.warehouse ?? "Any" },
    { header: "For", cell: ({ row }) => `${row.original.ref_type} ${row.original.ref_id}` },
    { header: "Expires", cell: ({ row }) => row.original.expires_on ?? "—" },
    { header: "Status", cell: ({ row }) => <Badge tone={row.original.status === "ACTIVE" ? "amber" : "slate"}>{row.original.status.charAt(0) + row.original.status.slice(1).toLowerCase()}</Badge> },
    { header: "", id: "a", cell: ({ row }) => row.original.status === "ACTIVE" && can("inventory.stock.issue") ? <Button variant="secondary" loading={rel.isLoading} onClick={() => void doRelease(row.original.id)}>Release</Button> : null },
  ];
  return (
    <>
      <PageHeader title="Reservations" description="Stock held for orders and production so it is not promised twice." actions={can("inventory.stock.issue") ? <Button onClick={() => setCreating(true)}>New reservation</Button> : undefined} />
      <div className="mb-3"><label className="text-sm">Show <select aria-label="Status" className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}><option value="ACTIVE">Active</option><option value="">All</option><option value="RELEASED">Released</option></select></label></div>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <DataTable caption="Reservations" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No reservations" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <NewReservationDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

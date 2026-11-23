import { useState } from "react";

import { useUpdateLocationMutation, useUpdateProductMutation, useUpdateWarehouseMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product, Warehouse, WarehouseLocation } from "../../shared/api/types";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";

const NUM = /^\d+(\.\d{1,4})?$/;
export const WAREHOUSE_TYPES = ["MAIN", "BRANCH", "TRANSIT", "QUARANTINE", "VIRTUAL"];
export const LOCATION_KINDS = ["STORAGE", "QUARANTINE", "RESTRICTED", "TRANSIT"];
const pretty = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

export function productProblem(f: { name: string; min: string; max: string; reorder: string; safety: string }): string | null {
  if (!f.name.trim()) return "The name is required.";
  for (const [label, v] of [["Minimum stock", f.min], ["Maximum stock", f.max], ["Reorder level", f.reorder], ["Safety stock", f.safety]] as const) {
    if (v.trim() !== "" && !NUM.test(v.trim())) return `${label} must be a number, 0 or more.`;
  }
  if (f.min.trim() !== "" && f.max.trim() !== "" && Number(f.min) > Number(f.max)) return "The minimum stock cannot be above the maximum.";
  return null;
}

export function ProductEditDialog({ product: p, onClose }: { product: Product; onClose: () => void }) {
  const [update, { isLoading }] = useUpdateProductMutation();
  const n = (v: string | null | undefined) => (v === null || v === undefined ? "" : String(Number(v)));
  const [f, setF] = useState({ name: p.name, category: p.category ?? "", barcode: p.barcode ?? "", description: p.description ?? "", min: n(p.min_stock), max: n(p.max_stock), reorder: n(p.reorder_level), safety: n(p.safety_stock), active: p.is_active });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string | boolean) => setF({ ...f, [k]: v });
  const go = async () => {
    const pr = productProblem(f);
    if (pr) { setErr(pr); return; }
    setErr(null);
    const body: Record<string, unknown> = { name: f.name.trim(), category: f.category.trim(), barcode: f.barcode.trim(), description: f.description.trim(), is_active: f.active };
    for (const [k, v] of [["min_stock", f.min], ["max_stock", f.max], ["reorder_level", f.reorder], ["safety_stock", f.safety]] as const) if (v.trim() !== "") body[k] = v.trim();
    try { await update({ id: p.id, body }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Edit product ${p.sku}`} open onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">The code, unit of measure and tracking cannot be changed once a product exists.</p>
      <FormField label="Name" htmlFor="pe-name"><input id="pe-name" className={inputClass} value={f.name} onChange={(e) => set("name", e.target.value)} /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Category" htmlFor="pe-cat"><input id="pe-cat" className={inputClass} value={f.category} onChange={(e) => set("category", e.target.value)} /></FormField>
        <FormField label="Barcode" htmlFor="pe-bar"><input id="pe-bar" className={inputClass} value={f.barcode} onChange={(e) => set("barcode", e.target.value)} /></FormField>
      </div>
      <FormField label="Description" htmlFor="pe-desc"><input id="pe-desc" className={inputClass} value={f.description} onChange={(e) => set("description", e.target.value)} /></FormField>
      <div className="grid grid-cols-4 gap-3">
        <FormField label="Minimum stock" htmlFor="pe-min"><input id="pe-min" inputMode="decimal" className={inputClass} value={f.min} onChange={(e) => set("min", e.target.value)} /></FormField>
        <FormField label="Maximum stock" htmlFor="pe-max"><input id="pe-max" inputMode="decimal" className={inputClass} value={f.max} onChange={(e) => set("max", e.target.value)} /></FormField>
        <FormField label="Reorder level" htmlFor="pe-re"><input id="pe-re" inputMode="decimal" className={inputClass} value={f.reorder} onChange={(e) => set("reorder", e.target.value)} /></FormField>
        <FormField label="Safety stock" htmlFor="pe-sa"><input id="pe-sa" inputMode="decimal" className={inputClass} value={f.safety} onChange={(e) => set("safety", e.target.value)} /></FormField>
      </div>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} />Active (a product with stock on hand cannot be made inactive)</label>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Save changes</Button></div>
    </Modal>
  );
}

export function WarehouseEditDialog({ warehouse: w, onClose }: { warehouse: Warehouse; onClose: () => void }) {
  const [update, { isLoading }] = useUpdateWarehouseMutation();
  const [f, setF] = useState({ name: w.name, type: w.warehouse_type || "MAIN", address: w.address ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (!f.name.trim()) { setErr("The name is required."); return; }
    setErr(null);
    try { await update({ id: w.id, body: { name: f.name.trim(), warehouse_type: f.type, address: f.address.trim() } }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Edit warehouse ${w.code}`} open onClose={onClose}>
      <FormField label="Name" htmlFor="we-name"><input id="we-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
      <FormField label="Type" htmlFor="we-type"><select id="we-type" className={inputClass} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{WAREHOUSE_TYPES.map((t) => <option key={t} value={t}>{pretty(t)}</option>)}</select></FormField>
      <FormField label="Address" htmlFor="we-addr"><input id="we-addr" className={inputClass} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Save changes</Button></div>
    </Modal>
  );
}

export function locationProblem(capacity: string): string | null {
  return capacity.trim() === "" || (NUM.test(capacity.trim()) && Number(capacity) > 0) ? null : "The capacity must be a number above 0, or empty for no limit.";
}

export function LocationEditDialog({ location: l, onClose }: { location: WarehouseLocation; onClose: () => void }) {
  const [update, { isLoading }] = useUpdateLocationMutation();
  const [f, setF] = useState({ kind: l.kind || "STORAGE", zone: l.zone ?? "", aisle: l.aisle ?? "", rack: l.rack ?? "", shelf: l.shelf ?? "", bin: l.bin ?? "", capacity: l.capacity === null || l.capacity === undefined ? "" : String(Number(l.capacity)), blocked: l.is_blocked });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string | boolean) => setF({ ...f, [k]: v });
  const go = async () => {
    const p = locationProblem(f.capacity);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await update({ id: l.id, body: { kind: f.kind, zone: f.zone.trim(), aisle: f.aisle.trim(), rack: f.rack.trim(), shelf: f.shelf.trim(), bin: f.bin.trim(), capacity: f.capacity.trim() || null, is_blocked: f.blocked } }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Edit location ${l.code}`} open onClose={onClose}>
      <FormField label="Kind" htmlFor="le-kind"><select id="le-kind" className={inputClass} value={f.kind} onChange={(e) => set("kind", e.target.value)}>{LOCATION_KINDS.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}</select></FormField>
      <div className="grid grid-cols-5 gap-2">
        {(["zone", "aisle", "rack", "shelf", "bin"] as const).map((k) => <FormField key={k} label={pretty(k)} htmlFor={`le-${k}`}><input id={`le-${k}`} className={inputClass} value={f[k]} onChange={(e) => set(k, e.target.value)} /></FormField>)}
      </div>
      <FormField label="Capacity (units, empty for no limit)" htmlFor="le-cap"><input id="le-cap" inputMode="decimal" className={inputClass} value={f.capacity} onChange={(e) => set("capacity", e.target.value)} /></FormField>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.blocked} onChange={(e) => set("blocked", e.target.checked)} />Blocked (no stock can be moved in or out)</label>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Save changes</Button></div>
    </Modal>
  );
}

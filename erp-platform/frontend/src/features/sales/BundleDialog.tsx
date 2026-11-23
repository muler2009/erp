import { useState } from "react";

import { useGetProductBundleQuery, useListProductsQuery, useSetProductBundleMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Button, ErrorState, Modal, Spinner, inputClass } from "../../shared/ui/primitives";

export interface BundleRow { product: string; quantity: string }
const DEC = /^\d+(\.\d{1,4})?$/;

export function bundleProblem(self: string, rows: BundleRow[]): string | null {
  if (rows.length === 0) return "A bundle needs at least one component.";
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.product === self) return "A product cannot be part of its own bundle.";
    if (seen.has(r.product)) return "A component is listed twice.";
    seen.add(r.product);
    if (!DEC.test(r.quantity.trim()) || Number(r.quantity) <= 0) return "Every component needs a quantity above 0.";
  }
  return null;
}

function Editor({ productId, initial, onClose }: { productId: string; initial: BundleRow[]; onClose: () => void }) {
  const [save, { isLoading }] = useSetProductBundleMutation();
  const products = useListProductsQuery({});
  const [rows, setRows] = useState<BundleRow[]>(initial.map((r) => ({ product: r.product, quantity: String(Number(r.quantity)) })));
  const [pick, setPick] = useState<{ id: string; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picker, setPicker] = useState(0);
  const names = new Map((products.data?.results ?? []).map((p) => [p.id, `${p.sku} — ${p.name}`]));
  const label = (id: string) => (id === pick?.id ? pick.label : names.get(id) ?? "Product");
  const go = async () => {
    const p = bundleProblem(productId, rows);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await save({ id: productId, items: rows.map((r) => ({ product: r.product, quantity: r.quantity.trim() })) }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <p className="mb-3 text-sm text-slate-600">Selling this product sells all of its components. Components must be active products that are not bundles themselves.</p>
      <ul className="mb-3 space-y-2 text-sm">
        {rows.map((r, i) => (
          <li key={r.product} className="flex items-center gap-2"><span className="flex-1">{label(r.product)}</span>
            <input aria-label={`Quantity of ${label(r.product)}`} inputMode="decimal" className={`${inputClass} w-24`} value={r.quantity} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
            <Button variant="secondary" aria-label={`Remove ${label(r.product)}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button></li>
        ))}
      </ul>
      <div key={picker}>
        <ProductPicker label="Add a component" onChange={(p) => setPick(p ? { id: p.id, label: `${p.sku} — ${p.name}` } : null)} />
      </div>
      <Button variant="secondary" disabled={!pick} onClick={() => { if (pick) { setRows([...rows, { product: pick.id, quantity: "1" }]); setPicker(picker + 1); } }}>Add component</Button>
      {err && <p role="alert" className="my-3 text-sm text-red-700">{err}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Save bundle</Button></div>
    </>
  );
}

export function BundleDialog({ product, onClose }: { product: { id: string; name: string }; onClose: () => void }) {
  const q = useGetProductBundleQuery(product.id);
  return (
    <Modal title={`Bundle: ${product.name}`} open onClose={onClose}>
      {q.isLoading ? <Spinner /> : q.error || !q.data ? <ErrorState error={q.error} onRetry={q.refetch} /> : <Editor productId={product.id} initial={q.data.items} onClose={onClose} />}
    </Modal>
  );
}

import { useState } from "react";

import { useCreateProdLineMutation, useListProdLinesQuery, useSetItemProfileMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const SUPPLY: Record<string, string> = { MANUFACTURED: "Made in-house", SUBCONTRACTED: "Made by a subcontractor", PURCHASED: "Bought in" };
export const lineProblem = (code: string, name: string): string | null => (!code.trim() ? "Give the line a code." : !name.trim() ? "Give the line a name." : null);
export const profileProblem = (p: Product | null, supply: string): string | null => (!p ? "Choose the product." : !SUPPLY[supply] ? "Choose how the item is supplied." : null);

function Lines() {
  const { can } = useAccess();
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListProdLinesQuery({ cursor });
  const [create, st] = useCreateProdLineMutation();
  const [f, setF] = useState({ code: "", name: "", facility: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { const p = lineProblem(f.code, f.name); if (p) return setErr(p); try { await create({ code: f.code.trim(), name: f.name.trim(), facility: f.facility.trim() }).unwrap(); setF({ code: "", name: "", facility: "" }); setErr(null); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Card title="Production lines">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.results.length === 0 && <EmptyState title="No production lines" hint="Lines group work for cost reporting." />}
      {q.data && q.data.results.length > 0 && <table className="mb-3 w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Name</th><th>Facility</th></tr></thead><tbody>{q.data.results.map((l) => <tr key={l.id} className="border-t border-slate-100"><td>{l.code}</td><td>{l.name}</td><td>{l.facility || "—"}</td></tr>)}</tbody></table>}
      <div className="mb-2 flex gap-2">
        {cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}
        {q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button>}
      </div>
      {can("manufacturing.master.manage") && (
        <div>
          <FormField label="Line code" htmlFor="ln-code"><input id="ln-code" className={inputClass} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></FormField>
          <FormField label="Line name" htmlFor="ln-name"><input id="ln-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
          <FormField label="Facility (optional)" htmlFor="ln-fac"><input id="ln-fac" className={inputClass} value={f.facility} onChange={(e) => setF({ ...f, facility: e.target.value })} /></FormField>
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          <Button loading={st.isLoading} onClick={() => void go()}>Add line</Button>
        </div>
      )}
    </Card>
  );
}

function Profile() {
  const { can } = useAccess();
  const [save, st] = useSetItemProfileMutation();
  const [product, setProduct] = useState<Product | null>(null);
  const [f, setF] = useState({ supply: "MANUFACTURED", drawing: "", method: "" });
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!can("manufacturing.master.manage")) return null;
  const go = async () => {
    const p = profileProblem(product, f.supply); if (p) return setErr(p);
    setDone(null);
    try { await save({ product: product!.id, supply_type: f.supply, drawing_ref: f.drawing.trim(), method: f.method.trim() }).unwrap(); setErr(null); setDone(`Saved the supply profile for ${product!.sku}.`); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Card title="Item supply profile">
      <p className="mb-2 text-sm text-slate-600">Say how an item is supplied and where its drawing and method are kept. Saving replaces the item's current profile.</p>
      <ProductPicker label="Item" onChange={(p) => { setProduct(p); setDone(null); }} />
      <FormField label="Supplied how" htmlFor="ip-supply"><select id="ip-supply" className={inputClass} value={f.supply} onChange={(e) => setF({ ...f, supply: e.target.value })}>{Object.entries(SUPPLY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
      <FormField label="Drawing reference" htmlFor="ip-draw"><input id="ip-draw" className={inputClass} value={f.drawing} onChange={(e) => setF({ ...f, drawing: e.target.value })} /></FormField>
      <FormField label="Method notes" htmlFor="ip-method"><input id="ip-method" className={inputClass} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {done && <p role="status" className="mb-2 text-sm text-green-800">{done}</p>}
      <Button loading={st.isLoading} onClick={() => void go()}>Save profile</Button>
    </Card>
  );
}

export function LinesProfilePage() {
  return (<><PageHeader title="Lines and item profiles" description="Production lines and how each item is supplied." /><Lines /><Profile /></>);
}
export default LinesProfilePage;

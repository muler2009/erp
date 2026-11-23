import { useState } from "react";

import { useCreateUomMutation, useGetUomsQuery, useLazyConvertUomQuery, useListItemCategoriesQuery, useSaveItemCategoryMutation, useSetUomConversionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const categoryProblem = (code: string, name: string): string | null => (!code.trim() || !name.trim() ? "Give the category a code and a name." : null);
export const uomProblem = (code: string, name: string): string | null => (!code.trim() || !name.trim() ? "Give the unit a code and a name." : null);
export const conversionProblem = (from: string, to: string, factor: string): string | null =>
  !from || !to ? "Choose both units." : from === to ? "Choose two different units." : !/^\d+(\.\d+)?$/.test(factor.trim()) || Number(factor) <= 0 ? "The factor must be more than 0." : null;
export const convertProblem = (qty: string, from: string, to: string): string | null => (!/^\d+(\.\d+)?$/.test(qty.trim()) ? "Enter the quantity to convert." : !from || !to ? "Choose both units." : null);

function Categories() {
  const { can } = useAccess();
  const q = useListItemCategoriesQuery();
  const [save, st] = useSaveItemCategoryMutation();
  const [f, setF] = useState({ code: "", name: "", parent: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { const p = categoryProblem(f.code, f.name); if (p) return setErr(p); try { await save({ code: f.code.trim(), name: f.name.trim(), ...(f.parent ? { parent: f.parent } : {}) }).unwrap(); setF({ code: "", name: "", parent: "" }); setErr(null); } catch (e) { setErr(errorMessage(e)); } };
  const name = (id: string | null) => q.data?.find((c) => c.id === id)?.name ?? "—";
  return (
    <Card title="Item categories">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.length === 0 && <EmptyState title="No categories" hint="Group your items with categories." />}
      {q.data && q.data.length > 0 && <table className="mb-3 w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Name</th><th>Inside</th></tr></thead><tbody>{q.data.map((c) => <tr key={c.id} className="border-t border-slate-100"><td>{c.code}</td><td>{c.name}</td><td>{name(c.parent)}</td></tr>)}</tbody></table>}
      {can("inventory.product.manage") && (
        <div>
          <FormField label="Category code" htmlFor="ic-code"><input id="ic-code" className={inputClass} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></FormField>
          <FormField label="Category name" htmlFor="ic-name"><input id="ic-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
          <FormField label="Inside (optional)" htmlFor="ic-parent"><select id="ic-parent" className={inputClass} value={f.parent} onChange={(e) => setF({ ...f, parent: e.target.value })}><option value="">Top level</option>{(q.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></FormField>
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          <Button loading={st.isLoading} onClick={() => void go()}>Save category</Button>
        </div>
      )}
    </Card>
  );
}

function Units() {
  const { can } = useAccess();
  const q = useGetUomsQuery();
  const [addUom, us] = useCreateUomMutation();
  const [addConv, cs] = useSetUomConversionMutation();
  const [convert, cv] = useLazyConvertUomQuery();
  const [u, setU] = useState({ code: "", name: "" });
  const [c, setC] = useState({ from: "", to: "", factor: "" });
  const [t, setT] = useState({ quantity: "1", from: "", to: "" });
  const [err, setErr] = useState<string | null>(null);
  const manage = can("inventory.product.manage");
  const units = (q.data?.units ?? []).map((x) => [x.code, `${x.code} — ${x.name}`] as [string, string]);
  const opts = () => <><option value="">Choose…</option>{units.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</>;
  const wrap = async (fn: () => Promise<unknown>, done: () => void) => { setErr(null); try { await fn(); done(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Card title="Units of measure">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && <p className="mb-2 text-sm">Units: {q.data.units.map((x) => x.code).join(", ") || "none yet"}</p>}
      {q.data && q.data.conversions.length > 0 && <ul className="mb-3 text-sm">{q.data.conversions.map((x, i) => <li key={i}>1 {x.from} = {x.factor} {x.to}{x.product ? " (one product only)" : ""}</li>)}</ul>}
      {manage && (
        <>
          <div className="mb-3 flex items-end gap-2">
            <FormField label="New unit code" htmlFor="um-code"><input id="um-code" className={inputClass} value={u.code} onChange={(e) => setU({ ...u, code: e.target.value })} /></FormField>
            <FormField label="Unit name" htmlFor="um-name"><input id="um-name" className={inputClass} value={u.name} onChange={(e) => setU({ ...u, name: e.target.value })} /></FormField>
            <Button loading={us.isLoading} onClick={() => { const p = uomProblem(u.code, u.name); if (p) return setErr(p); void wrap(() => addUom({ code: u.code.trim(), name: u.name.trim() }).unwrap(), () => setU({ code: "", name: "" })); }}>Add unit</Button>
          </div>
          <div className="mb-3 flex items-end gap-2">
            <FormField label="Convert from" htmlFor="cv-from"><select id="cv-from" className={inputClass} value={c.from} onChange={(e) => setC({ ...c, from: e.target.value })}>{opts()}</select></FormField>
            <FormField label="to" htmlFor="cv-to"><select id="cv-to" className={inputClass} value={c.to} onChange={(e) => setC({ ...c, to: e.target.value })}>{opts()}</select></FormField>
            <FormField label="Factor" htmlFor="cv-factor"><input id="cv-factor" className={`${inputClass} w-24`} value={c.factor} onChange={(e) => setC({ ...c, factor: e.target.value })} /></FormField>
            <Button loading={cs.isLoading} onClick={() => { const p = conversionProblem(c.from, c.to, c.factor); if (p) return setErr(p); void wrap(() => addConv({ from: c.from, to: c.to, factor: c.factor.trim() }).unwrap(), () => setC({ from: "", to: "", factor: "" })); }}>Save conversion</Button>
          </div>
        </>
      )}
      <div className="flex items-end gap-2">
        <FormField label="Try a conversion" htmlFor="tc-qty"><input id="tc-qty" className={`${inputClass} w-24`} value={t.quantity} onChange={(e) => setT({ ...t, quantity: e.target.value })} /></FormField>
        <FormField label="From unit" htmlFor="tc-from"><select id="tc-from" className={inputClass} value={t.from} onChange={(e) => setT({ ...t, from: e.target.value })}>{opts()}</select></FormField>
        <FormField label="To unit" htmlFor="tc-to"><select id="tc-to" className={inputClass} value={t.to} onChange={(e) => setT({ ...t, to: e.target.value })}>{opts()}</select></FormField>
        <Button variant="secondary" onClick={() => { const p = convertProblem(t.quantity, t.from, t.to); if (p) return setErr(p); setErr(null); void convert({ quantity: t.quantity.trim(), from: t.from, to: t.to }).then((r) => { if (r.error) setErr(errorMessage(r.error)); }); }}>Convert</Button>
      </div>
      {cv.data && <p className="mt-2 text-sm font-medium">Result: {cv.data.quantity} {t.to}</p>}
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
    </Card>
  );
}

export function ItemSetupPage() {
  return (<><PageHeader title="Item setup" description="Categories and units of measure used by your products." /><Categories /><Units /></>);
}

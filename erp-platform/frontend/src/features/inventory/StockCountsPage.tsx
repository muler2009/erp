import { useState } from "react";
import { Link, useParams } from "react-router";

import { useCreateStockCountMutation, useGetCountWorksheetQuery, useListStockCountsQuery, useListWarehousesQuery, useStockCountActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { CountVariance, Product, StockCountInput, StockCountRow, WorksheetLine } from "../../shared/api/types";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const countTone = (s: string) => (s === "APPROVED" ? "green" : s === "CANCELLED" ? "red" : s === "DRAFT" ? "slate" : "amber") as "green" | "red" | "amber" | "slate";
const pretty = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace("_", " ");

/** Returns an error message or null; the server repeats the checks. */
export function validateCount(f: { warehouse: string; kind: "CYCLE" | "FULL"; locations: string[]; products: string[] }): string | null {
  if (!f.warehouse) return "Choose the warehouse.";
  if (f.kind === "CYCLE" && f.locations.length === 0 && f.products.length === 0) return "A cycle count needs at least one location or product to count.";
  return null;
}

/** A counted value is valid when it is a non-negative number with up to 4 decimals. */
export const validCounted = (v: string) => { const n = parseMoney(v); return n !== null && n >= 0n; };

function NewCountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const warehouses = useListWarehousesQuery(undefined, { skip: !open });
  const [create, state] = useCreateStockCountMutation();
  const [warehouse, setWarehouse] = useState("");
  const [kind, setKind] = useState<"CYCLE" | "FULL">("CYCLE");
  const [freeze, setFreeze] = useState(false);
  const [planned, setPlanned] = useState("");
  const [note, setNote] = useState("");
  const [locations, setLocations] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const wh = warehouses.data?.results.find((w) => w.id === warehouse);
  const close = () => { setErr(null); onClose(); };
  const go = async () => {
    const problem = validateCount({ warehouse, kind, locations, products: products.map((p) => p.id) });
    if (problem) { setErr(problem); return; }
    setErr(null);
    const body: StockCountInput = { warehouse, kind, freeze, note: note.trim(), ...(planned ? { planned_date: planned } : {}), ...(kind === "CYCLE" ? { locations, products: products.map((p) => p.id) } : {}) };
    try { await create(body).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="New stock count" open={open} onClose={close}>
      <div className="max-h-[70vh] overflow-y-auto">
        <FormField label="Warehouse" htmlFor="sc-wh"><select id="sc-wh" className={inputClass} value={warehouse} onChange={(e) => { setWarehouse(e.target.value); setLocations([]); }}><option value="">Choose…</option>{warehouses.data?.results.filter((w) => w.is_active).map((w) => <option key={w.id} value={w.id}>{w.code} {w.name}</option>)}</select></FormField>
        <FormField label="Type" htmlFor="sc-kind"><select id="sc-kind" className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as "CYCLE" | "FULL")}><option value="CYCLE">Cycle count (some locations or products)</option><option value="FULL">Full count (the whole warehouse)</option></select></FormField>
        {kind === "CYCLE" && (
          <>
            <fieldset className="mb-3"><legend className="text-sm font-medium">Locations to count</legend>
              {!wh && <p className="text-sm text-slate-600">Choose a warehouse to list its locations.</p>}
              {wh?.locations.map((l) => <label key={l.id} className="mr-4 inline-block text-sm"><input type="checkbox" checked={locations.includes(l.id)} onChange={(e) => setLocations((s) => (e.target.checked ? [...s, l.id] : s.filter((x) => x !== l.id)))} /> {l.code}</label>)}
            </fieldset>
            <ProductPicker label="Add a product to count (optional)" key={products.length} onChange={(p) => { if (p && !products.some((x) => x.id === p.id)) setProducts((s) => [...s, p]); }} />
            {products.length > 0 && <ul className="mb-3 flex flex-wrap gap-2 text-sm">{products.map((p) => <li key={p.id} className="rounded bg-slate-100 px-2 py-1">{p.sku} <button type="button" aria-label={`Remove ${p.sku}`} onClick={() => setProducts((s) => s.filter((x) => x.id !== p.id))}>×</button></li>)}</ul>}
          </>
        )}
        <FormField label="Planned date (optional)" htmlFor="sc-date"><input id="sc-date" type="date" className={inputClass} value={planned} onChange={(e) => setPlanned(e.target.value)} /></FormField>
        <label className="mb-3 block text-sm"><input type="checkbox" checked={freeze} onChange={(e) => setFreeze(e.target.checked)} /> Freeze stock movements at the counted locations while counting</label>
        <FormField label="Note (optional)" htmlFor="sc-note"><input id="sc-note" maxLength={300} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
      </div>
      {err && <p role="alert" className="my-3 text-sm text-red-700">{err}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Create count</Button></div>
    </Modal>
  );
}

export function StockCountsPage() {
  const { data, isLoading, error, refetch } = useListStockCountsQuery();
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  return (
    <>
      <PageHeader title="Stock counts" description="Cycle and full counts. Counters see no system quantities; variances are approved before stock is adjusted." actions={can("inventory.stock.adjust") ? <Button onClick={() => setCreating(true)}>New count</Button> : undefined} />
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && (data.length === 0 ? <EmptyState title="No stock counts yet" /> : (
        <Card>
          <table className="min-w-full text-sm">
            <caption className="sr-only">Stock counts</caption>
            <thead><tr><th scope="col" className="px-2 py-1 text-left">Count</th><th scope="col" className="px-2 py-1 text-left">Warehouse</th><th scope="col" className="px-2 py-1 text-left">Type</th><th scope="col" className="px-2 py-1 text-left">Status</th></tr></thead>
            <tbody>{data.map((c) => <tr key={c.id} className="border-t border-slate-100"><td className="px-2 py-1">{can("inventory.stock.adjust") ? <Link className="text-indigo-700 underline" to={`/app/inventory/counts/${c.id}`}>{c.number}</Link> : c.number}</td><td className="px-2 py-1">{c.warehouse}</td><td className="px-2 py-1">{c.kind === "FULL" ? "Full" : "Cycle"}{c.freeze ? " · frozen" : ""}</td><td className="px-2 py-1"><Badge tone={countTone(c.status)}>{pretty(c.status)}</Badge></td></tr>)}</tbody>
          </table>
        </Card>
      ))}
      <NewCountDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CountRow({ line, countId, editable }: { line: WorksheetLine; countId: string; editable: boolean }) {
  const [act, state] = useStockCountActionMutation();
  const [value, setValue] = useState(line.counted ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    if (!validCounted(value)) { setErr("Enter a quantity of 0 or more, up to 4 decimals."); return; }
    setErr(null);
    try { await act({ id: countId, action: "record", body: { line: line.line, counted_quantity: value.trim() } }).unwrap(); setSaved(true); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <tr className="border-t border-slate-100">
      <td className="px-2 py-1">{line.location}</td>
      <td className="px-2 py-1">{line.sku} {line.name}{line.lot ? ` · lot ${line.lot}` : ""}{line.recount && <> <Badge tone="amber">Recount</Badge></>}</td>
      <td className="px-2 py-1 text-right">
        {editable ? <input aria-label={`Counted ${line.sku} at ${line.location}`} inputMode="decimal" className={`${inputClass} w-28 text-right`} value={value} onChange={(e) => { setValue(e.target.value); setSaved(false); }} /> : (line.counted ? formatMoney(line.counted) : "—")}
        {err && <p role="alert" className="text-xs text-red-700">{err}</p>}
      </td>
      <td className="px-2 py-1 text-right">{editable && <Button variant="secondary" loading={state.isLoading} aria-label={`Save ${line.sku} at ${line.location}`} onClick={() => void save()}>{saved ? "Saved" : "Save"}</Button>}</td>
    </tr>
  );
}

export function StockCountPage() {
  const { id = "" } = useParams();
  const list = useListStockCountsQuery();
  const count: StockCountRow | undefined = list.data?.find((c) => c.id === id);
  const sheet = useGetCountWorksheetQuery(id, { skip: !id || !count || count.status === "DRAFT" });
  const [act, state] = useStockCountActionMutation();
  const [variances, setVariances] = useState<CountVariance[] | null>(null);
  const [recount, setRecount] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const { can } = useAccess();
  if (list.isLoading) return <Spinner />;
  if (list.error || !count) return <ErrorState error={list.error} onRetry={list.refetch} />;
  const canApprove = can("inventory.adjustment.approve");
  const run = async (action: "start" | "submit" | "approve" | "cancel" | "recount", body?: Record<string, unknown>) => {
    setErr(null);
    try { await act({ id, action, body }).unwrap(); setRecount([]); setVariances(null); } catch (e) { setErr(errorMessage(e)); }
  };
  const loadVariances = async () => { setErr(null); try { setVariances((await act({ id, action: "variances" }).unwrap()).results ?? []); } catch (e) { setErr(errorMessage(e)); } };
  const showVariances = (count.status === "SUBMITTED" || count.status === "APPROVED") && canApprove;
  return (
    <>
      <PageHeader title={`Stock count ${count.number}`} description={`${count.warehouse} · ${count.kind === "FULL" ? "Full" : "Cycle"} count${count.freeze ? " · movements frozen at counted locations" : ""}`} actions={<Link className="text-sm text-indigo-700 underline" to="/app/inventory/counts">All counts</Link>} />
      <Card>
        <p className="mb-3 text-sm"><Badge tone={countTone(count.status)}>{pretty(count.status)}</Badge></p>
        {count.status === "DRAFT" && <p className="text-sm text-slate-600">Starting the count takes a snapshot of the system quantities (hidden from counters) and creates the count sheet.</p>}
        {sheet.isFetching && !sheet.data && <Spinner />}
        {sheet.error && <p role="alert" className="text-sm text-red-700">{errorMessage(sheet.error)}</p>}
        {sheet.data && !showVariances && (
          <table className="min-w-full text-sm">
            <caption className="sr-only">Count sheet</caption>
            <thead><tr><th scope="col" className="px-2 py-1 text-left">Location</th><th scope="col" className="px-2 py-1 text-left">Item</th><th scope="col" className="px-2 py-1 text-right">Counted</th><th /></tr></thead>
            <tbody>{sheet.data.map((l) => <CountRow key={`${l.line}${l.recount}`} line={l} countId={id} editable={count.status === "IN_PROGRESS"} />)}</tbody>
          </table>
        )}
        {showVariances && (
          <>
            {variances === null ? <Button variant="secondary" loading={state.isLoading} onClick={() => void loadVariances()}>Show variances</Button> : variances.length === 0 ? <p className="text-sm">No lines counted.</p> : (
              <table className="min-w-full text-sm">
                <caption className="sr-only">Variances</caption>
                <thead><tr>{count.status === "SUBMITTED" && <th />}<th scope="col" className="px-2 py-1 text-left">Item</th><th scope="col" className="px-2 py-1 text-left">Location</th><th scope="col" className="px-2 py-1 text-right">System</th><th scope="col" className="px-2 py-1 text-right">Counted</th><th scope="col" className="px-2 py-1 text-right">Variance</th><th scope="col" className="px-2 py-1 text-right">Value</th></tr></thead>
                <tbody>
                  {variances.map((v) => {
                    const off = (parseMoney(v.variance) ?? 0n) !== 0n;
                    return (
                      <tr key={v.line} className={`border-t border-slate-100 ${off ? "bg-amber-50" : ""}`}>
                        {count.status === "SUBMITTED" && <td className="px-2 py-1"><input type="checkbox" aria-label={`Recount ${v.sku} at ${v.location}`} checked={recount.includes(v.line)} onChange={(e) => setRecount((s) => (e.target.checked ? [...s, v.line] : s.filter((x) => x !== v.line)))} /></td>}
                        <td className="px-2 py-1">{v.sku}{v.lot ? ` · lot ${v.lot}` : ""}</td><td className="px-2 py-1">{v.location}</td>
                        <td className="px-2 py-1 text-right">{formatMoney(v.system)}</td><td className="px-2 py-1 text-right">{formatMoney(v.counted)}</td>
                        <td className="px-2 py-1 text-right">{formatMoney(v.variance)}{v.variance_pct ? ` (${v.variance_pct}%)` : ""}</td><td className="px-2 py-1 text-right">{formatMoney(v.variance_value)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
        {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {count.status === "DRAFT" && can("inventory.stock.adjust") && <Button loading={state.isLoading} onClick={() => void run("start")}>Start count</Button>}
          {count.status === "IN_PROGRESS" && can("inventory.stock.adjust") && <Button loading={state.isLoading} onClick={() => void run("submit")}>Submit count</Button>}
          {count.status === "SUBMITTED" && canApprove && <Button variant="secondary" disabled={recount.length === 0} loading={state.isLoading} onClick={() => void run("recount", { lines: recount })}>Request recount ({recount.length})</Button>}
          {count.status === "SUBMITTED" && canApprove && <Button loading={state.isLoading} onClick={() => void run("approve")}>Approve and post adjustments</Button>}
          {!["APPROVED", "CANCELLED"].includes(count.status) && can("inventory.stock.adjust") && <Button variant="danger" loading={state.isLoading} onClick={() => void run("cancel")}>Cancel count</Button>}
        </div>
      </Card>
    </>
  );
}

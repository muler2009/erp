import { useState } from "react";

import { useForecastActionMutation, useGenerateForecastsMutation, useGetForecastAccuracyQuery, useListForecastsQuery, useSetForecastMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Product } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { ProductPicker } from "../../shared/ui/ProductPicker";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const monthLabel = (d: string): string => d.slice(0, 7);
export function forecastProblem(p: Product | null, month: string, qty: string): string | null {
  if (!p) return "Choose the product.";
  if (!month) return "Choose the month.";
  if (!/^\d+(\.\d{1,4})?$/.test(qty.trim())) return "The forecast quantity must be a number, or 0.";
  return null;
}

function SetForecast({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [save, st] = useSetForecastMutation();
  const [product, setProduct] = useState<Product | null>(null);
  const [month, setMonth] = useState("");
  const [qty, setQty] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = forecastProblem(product, month, qty); if (p) return setErr(p);
    try { await save({ product: product!.id, period_start: month, quantity: qty.trim() }).unwrap(); setErr(null); setQty(""); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Set a forecast" open={open} onClose={onClose}>
      <ProductPicker label="Product" onChange={setProduct} />
      <FormField label="Any date in the month" htmlFor="fc-month"><input id="fc-month" type="date" className={inputClass} value={month} onChange={(e) => setMonth(e.target.value)} /></FormField>
      <FormField label="Expected demand" htmlFor="fc-qty"><input id="fc-qty" className={inputClass} value={qty} onChange={(e) => setQty(e.target.value)} /></FormField>
      <p className="mb-2 text-xs text-slate-600">Saving puts the forecast back to draft until it is approved.</p>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={st.isLoading} onClick={() => void go()}>Save forecast</Button></div>
    </Modal>
  );
}

function Accuracy() {
  const [months, setMonths] = useState("3");
  const q = useGetForecastAccuracyQuery(Number(months));
  return (
    <Card title="How accurate were past forecasts?">
      <FormField label="Months back" htmlFor="fa-months"><select id="fa-months" className={inputClass} value={months} onChange={(e) => setMonths(e.target.value)}>{["1", "3", "6", "12"].map((m) => <option key={m} value={m}>{m}</option>)}</select></FormField>
      {q.isFetching && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {!q.isFetching && q.data && q.data.length === 0 && <EmptyState title="No approved forecasts to compare" hint="Approved forecasts for finished months are compared with what was delivered." />}
      {!q.isFetching && q.data && q.data.length > 0 && (
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Product</th><th>Month</th><th className="text-right">Forecast</th><th className="text-right">Delivered</th><th className="text-right">Error</th></tr></thead>
          <tbody>{q.data.map((r, i) => <tr key={i} className="border-t border-slate-100"><td>{r.product}</td><td>{monthLabel(r.period)}</td><td className="text-right">{Number(r.forecast)}</td><td className="text-right">{Number(r.actual)}</td><td className="text-right">{r.error_pct === null ? "—" : `${Number(r.error_pct)}%`}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

export function ForecastsPage() {
  const { can } = useAccess();
  const [filter, setFilter] = useState<Product | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListForecastsQuery({ cursor, ...(filter ? { product: filter.id } : {}) });
  const [act] = useForecastActionMutation();
  const [gen, gs] = useGenerateForecastsMutation();
  const [setting, setSetting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const manage = can("supply_chain.plan.manage");
  const approve = can("supply_chain.plan.approve");
  const run = async (id: string, action: "approve" | "revoke") => { setErr(null); try { await act({ id, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const generate = async () => {
    setErr(null); setNote(null);
    try { const r = await gen(filter ? { products: [filter.id] } : {}).unwrap(); setNote(r.length ? `Created ${r.length} draft forecast${r.length > 1 ? "s" : ""} from sales history.` : "Nothing new to forecast: there is no history, or the months are already approved."); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Demand forecasts" description="Expected monthly demand per product. Approved forecasts feed replenishment planning."
        actions={manage ? <div className="flex gap-2"><Button onClick={() => setSetting(true)}>Set a forecast</Button><Button variant="secondary" loading={gs.isLoading} onClick={() => void generate()}>Generate from history</Button></div> : undefined} />
      {note && <p role="status" className="mb-2 rounded bg-green-50 p-2 text-sm text-green-800">{note}</p>}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <Card>
        <div className="mb-3 flex items-end gap-2">
          <ProductPicker label="Show one product" onChange={(p) => { setFilter(p); setCursor(null); }} />
          {filter && <Button variant="secondary" onClick={() => { setFilter(null); setCursor(null); }}>Show all products</Button>}
        </div>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No forecasts" hint="Set a forecast or generate them from sales history." />}
        {q.data && q.data.results.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Product</th><th>Month</th><th className="text-right">Quantity</th><th>Source</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.results.map((r) => (
              <tr key={r.id} className="border-t border-slate-100"><td>{r.sku}</td><td>{monthLabel(r.period_start)}</td><td className="text-right">{Number(r.quantity)}</td><td>{r.method === "HISTORY" ? "From history" : "Entered"}</td>
                <td><Badge tone={r.status === "APPROVED" ? "green" : "amber"}>{r.status === "APPROVED" ? "Approved" : "Draft"}</Badge></td>
                <td>{approve && r.status === "DRAFT" && <Button variant="secondary" onClick={() => void run(r.id, "approve")}>Approve {r.sku} {monthLabel(r.period_start)}</Button>}{approve && r.status === "APPROVED" && <Button variant="secondary" onClick={() => void run(r.id, "revoke")}>Revoke {r.sku} {monthLabel(r.period_start)}</Button>}</td></tr>
            ))}</tbody></table>
        )}
        <div className="mt-3 flex justify-end gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button>}</div>
      </Card>
      <Accuracy />
      <SetForecast open={setting} onClose={() => setSetting(false)} />
    </>
  );
}
export default ForecastsPage;

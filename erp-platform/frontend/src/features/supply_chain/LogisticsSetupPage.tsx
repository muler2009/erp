import { useState } from "react";

import { useCreateCarrierMutation, useCreateRouteMutation, useListCarriersQuery, useListRoutesQuery, useUpdateCarrierMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const MODE: Record<string, string> = { ROAD: "Road", AIR: "Air", SEA: "Sea", RAIL: "Rail", COURIER: "Courier" };
export const carrierProblem = (code: string, name: string): string | null => (!code.trim() ? "Give the carrier a code." : !name.trim() ? "Give the carrier a name." : null);
export function routeProblem(r: { code: string; name: string; origin: string; destination: string; km: string; days: string }): string | null {
  if (!r.code.trim() || !r.name.trim()) return "Give the route a code and a name.";
  if (!r.origin.trim() || !r.destination.trim()) return "Say where the route starts and ends.";
  if (!/^\d+(\.\d{1,2})?$/.test(r.km.trim())) return "Distance must be a number of kilometres, or 0.";
  if (!/^\d+$/.test(r.days.trim()) || Number(r.days) < 1) return "Transit time must be a whole number of days, at least 1.";
  return null;
}

function Carriers() {
  const { can } = useAccess();
  const manage = can("supply_chain.logistics.manage");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListCarriersQuery({ cursor });
  const [create, st] = useCreateCarrierMutation();
  const [update] = useUpdateCarrierMutation();
  const [f, setF] = useState({ code: "", name: "", mode: "ROAD", contact: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { const p = carrierProblem(f.code, f.name); if (p) return setErr(p); try { await create({ code: f.code.trim(), name: f.name.trim(), mode: f.mode, contact: f.contact.trim() }).unwrap(); setF({ code: "", name: "", mode: "ROAD", contact: "" }); setErr(null); } catch (e) { setErr(errorMessage(e)); } };
  const toggle = async (id: string, is_active: boolean) => { setErr(null); try { await update({ id, is_active }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Card title="Carriers">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.results.length === 0 && <EmptyState title="No carriers" hint="Add the companies that move your goods." />}
      {q.data && q.data.results.length > 0 && (
        <table className="mb-3 w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Name</th><th>Mode</th><th>Status</th><th /></tr></thead>
          <tbody>{q.data.results.map((c) => <tr key={c.id} className="border-t border-slate-100"><td>{c.code}</td><td>{c.name}</td><td>{MODE[c.mode] ?? c.mode}</td><td><Badge tone={c.is_active ? "green" : "slate"}>{c.is_active ? "Active" : "Inactive"}</Badge></td>
            <td>{manage && <Button variant="secondary" onClick={() => void toggle(c.id, !c.is_active)}>{c.is_active ? `Deactivate ${c.code}` : `Activate ${c.code}`}</Button>}</td></tr>)}</tbody></table>
      )}
      <div className="mb-2 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button>}</div>
      {manage && (
        <div>
          <FormField label="Carrier code" htmlFor="cr-code"><input id="cr-code" className={inputClass} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></FormField>
          <FormField label="Carrier name" htmlFor="cr-name"><input id="cr-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
          <FormField label="Mode" htmlFor="cr-mode"><select id="cr-mode" className={inputClass} value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>{Object.entries(MODE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
          <FormField label="Contact" htmlFor="cr-contact"><input id="cr-contact" className={inputClass} value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></FormField>
          {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
          <Button loading={st.isLoading} onClick={() => void go()}>Add carrier</Button>
        </div>
      )}
      {!manage && err && <p role="alert" className="text-sm text-red-700">{err}</p>}
    </Card>
  );
}

function Routes() {
  const { can } = useAccess();
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListRoutesQuery({ cursor });
  const carriers = useListCarriersQuery();
  const [create, st] = useCreateRouteMutation();
  const blank = { code: "", name: "", origin: "", destination: "", km: "0", days: "1", carrier: "" };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    const p = routeProblem(f); if (p) return setErr(p);
    try { await create({ code: f.code.trim(), name: f.name.trim(), origin: f.origin.trim(), destination: f.destination.trim(), distance_km: f.km.trim(), transit_days: Number(f.days), ...(f.carrier ? { carrier: f.carrier } : {}) }).unwrap(); setF(blank); setErr(null); } catch (e) { setErr(errorMessage(e)); }
  };
  const carrierName = (id: string | null) => carriers.data?.results.find((c) => c.id === id)?.code ?? "—";
  return (
    <Card title="Routes">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.results.length === 0 && <EmptyState title="No routes" hint="Routes give shipments a default transit time and carrier." />}
      {q.data && q.data.results.length > 0 && (
        <table className="mb-3 w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>From → To</th><th className="text-right">Km</th><th className="text-right">Days</th><th>Carrier</th></tr></thead>
          <tbody>{q.data.results.map((r) => <tr key={r.id} className="border-t border-slate-100"><td>{r.code}</td><td>{r.origin} → {r.destination}</td><td className="text-right">{Number(r.distance_km)}</td><td className="text-right">{r.transit_days}</td><td>{carrierName(r.carrier)}</td></tr>)}</tbody></table>
      )}
      <div className="mb-2 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button>}</div>
      {can("supply_chain.logistics.manage") && (
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Route code" htmlFor="rt-code"><input id="rt-code" className={inputClass} value={f.code} onChange={set("code")} /></FormField>
          <FormField label="Route name" htmlFor="rt-name"><input id="rt-name" className={inputClass} value={f.name} onChange={set("name")} /></FormField>
          <FormField label="Starts at" htmlFor="rt-from"><input id="rt-from" className={inputClass} value={f.origin} onChange={set("origin")} /></FormField>
          <FormField label="Ends at" htmlFor="rt-to"><input id="rt-to" className={inputClass} value={f.destination} onChange={set("destination")} /></FormField>
          <FormField label="Distance in km" htmlFor="rt-km"><input id="rt-km" className={inputClass} value={f.km} onChange={set("km")} /></FormField>
          <FormField label="Transit days" htmlFor="rt-days"><input id="rt-days" className={inputClass} value={f.days} onChange={set("days")} /></FormField>
          <FormField label="Usual carrier" htmlFor="rt-car"><select id="rt-car" className={inputClass} value={f.carrier} onChange={set("carrier")}><option value="">None</option>{(carriers.data?.results ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></FormField>
          <div className="col-span-2">{err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}<Button loading={st.isLoading} onClick={() => void go()}>Add route</Button></div>
        </div>
      )}
    </Card>
  );
}

export function LogisticsSetupPage() {
  return (<><PageHeader title="Carriers and routes" description="Who moves your goods and the usual routes they take." /><Carriers /><Routes /></>);
}
export default LogisticsSetupPage;

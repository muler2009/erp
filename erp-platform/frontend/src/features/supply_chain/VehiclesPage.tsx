import { useState } from "react";

import { useCreateScVehicleMutation, useListCarriersQuery, useListScVehiclesQuery, useUpdateScVehicleMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const NUM = /^\d+(\.\d{1,2})?$/;
export function vehicleProblem(code: string, kg: string, m3: string): string | null {
  if (!code.trim()) return "Give the vehicle a code.";
  if (!NUM.test(kg.trim()) || !NUM.test(m3.trim())) return "Capacity in kg and m³ must be numbers, or 0.";
  return null;
}

export function VehiclesPage() {
  const { can } = useAccess();
  const manage = can("supply_chain.logistics.manage");
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListScVehiclesQuery({ cursor });
  const carriers = useListCarriersQuery();
  const [create, st] = useCreateScVehicleMutation();
  const [update] = useUpdateScVehicleMutation();
  const blank = { code: "", plate: "", type: "", kg: "0", m3: "0", carrier: "" };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    const p = vehicleProblem(f.code, f.kg, f.m3); if (p) return setErr(p);
    try { await create({ code: f.code.trim(), plate: f.plate.trim(), vehicle_type: f.type.trim(), capacity_kg: f.kg.trim(), capacity_m3: f.m3.trim(), ...(f.carrier ? { carrier: f.carrier } : {}) }).unwrap(); setF(blank); setErr(null); } catch (e) { setErr(errorMessage(e)); }
  };
  const toggle = async (id: string, is_active: boolean) => { setErr(null); try { await update({ id, is_active }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const carrierCode = (id: string | null) => carriers.data?.results.find((c) => c.id === id)?.code ?? "—";
  return (
    <>
      <PageHeader title="Delivery vehicles" description="Vehicles that can be assigned to shipments." />
      <Card>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data && q.data.results.length === 0 && <EmptyState title="No vehicles" hint="Add the vehicles you can assign to shipments." />}
        {q.data && q.data.results.length > 0 && (
          <table className="mb-3 w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Plate</th><th>Type</th><th className="text-right">kg</th><th className="text-right">m³</th><th>Carrier</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.results.map((v) => <tr key={v.id} className="border-t border-slate-100"><td>{v.code}</td><td>{v.plate || "—"}</td><td>{v.vehicle_type || "—"}</td><td className="text-right">{Number(v.capacity_kg)}</td><td className="text-right">{Number(v.capacity_m3)}</td><td>{carrierCode(v.carrier)}</td><td><Badge tone={v.is_active ? "green" : "slate"}>{v.is_active ? "Active" : "Inactive"}</Badge></td>
              <td>{manage && <Button variant="secondary" onClick={() => void toggle(v.id, !v.is_active)}>{v.is_active ? `Deactivate ${v.code}` : `Activate ${v.code}`}</Button>}</td></tr>)}</tbody></table>
        )}
        <div className="mb-2 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Next page</Button>}</div>
        {manage && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Vehicle code" htmlFor="vh-code"><input id="vh-code" className={inputClass} value={f.code} onChange={set("code")} /></FormField>
            <FormField label="Plate" htmlFor="vh-plate"><input id="vh-plate" className={inputClass} value={f.plate} onChange={set("plate")} /></FormField>
            <FormField label="Type" htmlFor="vh-type"><input id="vh-type" className={inputClass} value={f.type} onChange={set("type")} /></FormField>
            <FormField label="Carrier" htmlFor="vh-car"><select id="vh-car" className={inputClass} value={f.carrier} onChange={set("carrier")}><option value="">Own vehicle</option>{(carriers.data?.results ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></FormField>
            <FormField label="Capacity in kg" htmlFor="vh-kg"><input id="vh-kg" className={inputClass} value={f.kg} onChange={set("kg")} /></FormField>
            <FormField label="Capacity in m³" htmlFor="vh-m3"><input id="vh-m3" className={inputClass} value={f.m3} onChange={set("m3")} /></FormField>
            <div className="col-span-2">{err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}<Button loading={st.isLoading} onClick={() => void go()}>Add vehicle</Button></div>
          </div>
        )}
        {!manage && err && <p role="alert" className="text-sm text-red-700">{err}</p>}
      </Card>
    </>
  );
}
export default VehiclesPage;

import { useState } from "react";

import { useCloseVehicleIncidentMutation, useGetFleetCostsQuery, useGetFleetExpiriesQuery, useListEmployeesQuery, useGetFuelEfficiencyQuery, useListFixedAssetsQuery, useListVehicleIncidentsQuery, useListVehiclesQuery, useRegisterVehicleMutation, useVehicleActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Vehicle } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useEmployeeNames } from "../hr/names";

export const FUELS = ["PETROL", "DIESEL", "ELECTRIC", "HYBRID"];
export const INCIDENT_SEVERITIES = ["MINOR", "MAJOR", "TOTAL_LOSS"];
const DEC = /^\d+(\.\d{1,4})?$/;

export function validateVehicle(f: { asset: string; plate_number: string; fuel_type: string }): string | null {
  if (!f.asset) return "Choose the vehicle asset.";
  if (!f.plate_number.trim()) return "Enter the plate number.";
  if (!FUELS.includes(f.fuel_type)) return "Choose the fuel type.";
  return null;
}
export function validateFuel(liters: string, cost: string, odometer: string): string | null {
  if (!DEC.test(liters.trim()) || Number(liters) <= 0) return "Litres must be a positive number.";
  if (!DEC.test(cost.trim())) return "Cost must be zero or more.";
  if (!DEC.test(odometer.trim())) return "Enter the odometer reading as a number.";
  return null;
}
export function validateIncident(description: string, severity: string, damage: string): string | null {
  if (!description.trim()) return "Describe the incident.";
  if (!INCIDENT_SEVERITIES.includes(severity)) return "Choose the severity.";
  if (damage.trim() && !DEC.test(damage.trim())) return "Damage cost must be a number.";
  return null;
}

type Act = { v: Vehicle; kind: "driver" | "renew" | "fuel" | "incident" };

function Efficiency({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useGetFuelEfficiencyQuery(id);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  if (!data.length) return <p className="text-sm text-slate-500">Not enough fuel records to work out efficiency (two fills are needed).</p>;
  return <ul className="text-sm">{data.map((r) => <li key={r.filled_on}>{r.filled_on}: {r.km} km on {r.liters} L = <strong>{r.km_per_liter} km/L</strong></li>)}</ul>;
}

function Incidents({ id, canClose }: { id: string; canClose: boolean }) {
  const { data, isLoading, error, refetch } = useListVehicleIncidentsQuery(id);
  const [close] = useCloseVehicleIncidentMutation();
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  if (!data.results.length) return <p className="text-sm text-slate-500">No incidents recorded.</p>;
  return (
    <>
      {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
      <ul className="text-sm">{data.results.map((i) => (
        <li key={i.id} className="flex flex-wrap items-center gap-2 py-1"><span>{i.occurred_on}</span><Badge tone={i.severity === "MINOR" ? "slate" : "red"}>{pretty(i.severity)}</Badge><span>{i.description}</span><span className="text-slate-500">damage {formatMoney(i.damage_cost)}</span><Badge tone={i.status === "OPEN" ? "amber" : "green"}>{pretty(i.status)}</Badge>
          {canClose && i.status === "OPEN" && <Button variant="secondary" onClick={async () => { setErr(null); try { await close(i.id).unwrap(); } catch (e) { setErr(failure(e)); } }}>{`Close incident: ${i.description}`}</Button>}</li>))}</ul>
    </>
  );
}

function Vehicles() {
  const { can } = useAccess();
  const manage = can("assets.fleet.manage");
  const { data, isLoading, error, refetch } = useListVehiclesQuery({});
  const assets = useListFixedAssetsQuery({}, { skip: !manage });
  const [register] = useRegisterVehicleMutation();
  const [act] = useVehicleActionMutation();
  const nameOf = useEmployeeNames();
  const emps = useListEmployeesQuery({ status: "ACTIVE" }, { skip: !manage });
  const [open, setOpen] = useState(false);
  const empty = { asset: "", plate_number: "", vin: "", fuel_type: "DIESEL", registration_expiry: "", driver_license_expiry: "" };
  const [f, setF] = useState(empty);
  const [ferr, setFerr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<Act | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const v = dlg?.v;
  const go = async () => {
    const p = validateVehicle(f);
    if (p) { setFerr(p); return; }
    setFerr(null);
    try { await register({ asset: f.asset, plate_number: f.plate_number.trim(), vin: f.vin.trim(), fuel_type: f.fuel_type, ...(f.registration_expiry ? { registration_expiry: f.registration_expiry } : {}), ...(f.driver_license_expiry ? { driver_license_expiry: f.driver_license_expiry } : {}) }).unwrap(); setOpen(false); setF(empty); } catch (e) { setFerr(errorMessage(e)); }
  };
  return (
    <Card title="Vehicles">
      {manage && <div className="mb-2"><Button onClick={() => setOpen(true)}>Register a vehicle</Button></div>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No vehicles registered" /> : (
        <ul>{data.results.map((x) => (
          <li key={x.id} className="border-b border-slate-200 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono font-medium">{x.plate_number}</span><span>{x.asset.number}</span><Badge tone="slate">{pretty(x.fuel_type)}</Badge><span className="text-slate-500">odometer {x.odometer}</span></div>
            <p className="text-slate-600">Driver: {x.driver_id ? nameOf(x.driver_id) : "none"}{x.driver_license_expiry ? ` (licence to ${x.driver_license_expiry})` : ""} · registration {x.registration_expiry ? `to ${x.registration_expiry}` : "not recorded"}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {manage && <><Button variant="secondary" onClick={() => setDlg({ v: x, kind: "driver" })}>{`Assign driver to ${x.plate_number}`}</Button><Button variant="secondary" onClick={() => setDlg({ v: x, kind: "renew" })}>{`Renew registration ${x.plate_number}`}</Button><Button variant="secondary" onClick={() => setDlg({ v: x, kind: "fuel" })}>{`Log fuel ${x.plate_number}`}</Button><Button variant="secondary" onClick={() => setDlg({ v: x, kind: "incident" })}>{`Report incident ${x.plate_number}`}</Button></>}
              <Button variant="secondary" onClick={() => setDetail(detail === x.id ? null : x.id)}>{detail === x.id ? `Hide history ${x.plate_number}` : `History ${x.plate_number}`}</Button>
            </div>
            {detail === x.id && <div className="mt-2 grid gap-3 rounded border border-slate-200 p-3 md:grid-cols-2"><div><h3 className="mb-1 font-medium">Fuel efficiency</h3><Efficiency id={x.id} /></div><div><h3 className="mb-1 font-medium">Incidents</h3><Incidents id={x.id} canClose={manage} /></div></div>}
          </li>))}</ul>
      )}
      <Modal title="Register a vehicle" open={open} onClose={() => setOpen(false)}>
        <FormField label="Vehicle asset" htmlFor="vh-asset"><select id="vh-asset" className={inputClass} value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}><option value="">Choose…</option>{assets.data?.results.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Plate number" htmlFor="vh-plate"><input id="vh-plate" className={inputClass} value={f.plate_number} onChange={(e) => setF({ ...f, plate_number: e.target.value })} /></FormField>
          <FormField label="VIN" htmlFor="vh-vin"><input id="vh-vin" className={inputClass} value={f.vin} onChange={(e) => setF({ ...f, vin: e.target.value })} /></FormField>
          <FormField label="Fuel type" htmlFor="vh-fuel"><select id="vh-fuel" className={inputClass} value={f.fuel_type} onChange={(e) => setF({ ...f, fuel_type: e.target.value })}>{FUELS.map((x) => <option key={x} value={x}>{pretty(x)}</option>)}</select></FormField>
          <FormField label="Registration expires" htmlFor="vh-reg"><input id="vh-reg" type="date" className={inputClass} value={f.registration_expiry} onChange={(e) => setF({ ...f, registration_expiry: e.target.value })} /></FormField>
        </div>
        {ferr && <p role="alert" className="mb-3 text-sm text-red-700">{ferr}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Register</Button></div>
      </Modal>
      <ActionDialog key={`dr${v?.id}`} title="Assign a driver" open={dlg?.kind === "driver"} onClose={() => setDlg(null)} cta="Assign" fields={[{ name: "driver_id", label: "Driver", required: true, options: (emps.data?.results ?? []).map((e) => [e.id, `${e.employee_no} ${e.name}`] as [string, string]) }, { name: "license_expiry", label: "Licence expires", type: "date", required: true }]} submit={(val) => act({ id: v!.id, action: "driver", body: { driver_id: val.driver_id, license_expiry: val.license_expiry } }).unwrap()} />
      <ActionDialog key={`rn${v?.id}`} title="Renew registration" open={dlg?.kind === "renew"} onClose={() => setDlg(null)} cta="Renew" fields={[{ name: "expiry", label: "New expiry", type: "date", required: true }]} submit={(val) => { if (v?.registration_expiry && (val.expiry ?? "") <= v.registration_expiry) throw new Error("The new expiry must be later than the current one."); return act({ id: v!.id, action: "renew-registration", body: { expiry: val.expiry } }).unwrap(); }} />
      <ActionDialog key={`fu${v?.id}`} title="Log fuel" open={dlg?.kind === "fuel"} onClose={() => setDlg(null)} cta="Record fill-up" fields={[{ name: "filled_on", label: "Date", type: "date" }, { name: "liters", label: "Litres", required: true }, { name: "cost", label: "Cost", required: true }, { name: "odometer", label: "Odometer", required: true }]}
        submit={async (val) => { const p = validateFuel(val.liters ?? "", val.cost ?? "", val.odometer ?? ""); if (p) throw new Error(p); await act({ id: v!.id, action: "fuel", body: { liters: (val.liters ?? "").trim(), cost: (val.cost ?? "").trim(), odometer: (val.odometer ?? "").trim(), ...(val.filled_on ? { filled_on: val.filled_on } : {}) } }).unwrap(); }} />
      <ActionDialog key={`in${v?.id}`} title="Report an incident" open={dlg?.kind === "incident"} onClose={() => setDlg(null)} cta="Report" fields={[{ name: "description", label: "What happened", required: true }, { name: "severity", label: "Severity", required: true, options: INCIDENT_SEVERITIES.map((s) => [s, pretty(s)] as [string, string]) }, { name: "occurred_on", label: "Date", type: "date" }, { name: "damage_cost", label: "Damage cost" }]}
        submit={async (val) => { const p = validateIncident(val.description ?? "", val.severity ?? "", val.damage_cost ?? ""); if (p) throw new Error(p); await act({ id: v!.id, action: "incidents", body: { description: (val.description ?? "").trim(), severity: val.severity, ...(val.occurred_on ? { occurred_on: val.occurred_on } : {}), ...((val.damage_cost ?? "").trim() ? { damage_cost: (val.damage_cost ?? "").trim() } : {}) } }).unwrap(); }} />
    </Card>
  );
}

function Expiries() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error, refetch } = useGetFleetExpiriesQuery(days);
  return (
    <Card title="Expiring registrations, licences and insurance">
      <label className="mb-2 block text-sm">Look ahead <select aria-label="Fleet expiry window" className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="Nothing expires in this window" /> : (
        <ul className="text-sm">{data.map((r) => <li key={r.plate} className="border-b border-slate-100 py-2"><span className="font-mono font-medium">{r.plate}</span> {r.asset}: {r.issues.map((i) => <span key={i.item} className="mr-2">{pretty(i.item)} {i.date ?? "none in force"} {i.expired ? <Badge tone="red">Expired</Badge> : <Badge tone="amber">Due</Badge>}</span>)}</li>)}</ul>
      )}
    </Card>
  );
}

function Costs() {
  const today = new Date().toISOString().slice(0, 10);
  const [p, setP] = useState({ from: `${today.slice(0, 4)}-01-01`, to: today });
  const bad = !p.from || !p.to ? "Choose both dates." : p.to < p.from ? "The end date must be on or after the start date." : null;
  const { data, isLoading, error, refetch } = useGetFleetCostsQuery(p, { skip: !!bad });
  return (
    <Card title="Running costs">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <FormField label="From" htmlFor="fc-from"><input id="fc-from" type="date" className={inputClass} value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} /></FormField>
        <FormField label="To" htmlFor="fc-to"><input id="fc-to" type="date" className={inputClass} value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} /></FormField>
      </div>
      {bad ? <p role="alert" className="text-sm text-red-700">{bad}</p> : isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No vehicles" /> : (
        <table className="w-full text-sm"><caption className="sr-only">Fleet costs</caption><thead><tr className="text-left"><th>Vehicle</th><th className="text-right">Fuel</th><th className="text-right">Litres</th><th className="text-right">Maintenance</th><th className="text-right">Total</th><th className="text-right">Km</th><th className="text-right">Cost / km</th></tr></thead>
          <tbody>{data.map((r) => <tr key={r.plate} className="border-t border-slate-100"><td>{r.plate} <span className="text-slate-500">{r.asset}</span></td><td className="text-right">{formatMoney(r.fuel_cost)}</td><td className="text-right">{r.liters}</td><td className="text-right">{formatMoney(r.maintenance_cost)}</td><td className="text-right font-semibold">{formatMoney(r.total_cost)}</td><td className="text-right">{r.km}</td><td className="text-right">{r.cost_per_km ?? "–"}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

const TABS = [["vehicles", "Vehicles"], ["expiries", "Expiries"], ["costs", "Costs"]] as const;

export function FleetPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("vehicles");
  return (
    <>
      <PageHeader title="Fleet" description="Vehicles, drivers, fuel, incidents, expiries and running costs." />
      <div role="tablist" className="mb-4 flex gap-2 border-b border-slate-200">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-slate-900 font-semibold" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "vehicles" && <Vehicles />}
      {tab === "expiries" && <Expiries />}
      {tab === "costs" && <Costs />}
    </>
  );
}

import { useState } from "react";

import { useCreateLocationMutation, useCreateWarehouseMutation, useListWarehousesQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Warehouse, WarehouseLocation } from "../../shared/api/types";
import { Can, useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { LocationEditDialog, WarehouseEditDialog } from "./StockSetupEdit";

function CodeNameDialog({ title, open, onClose, onSubmit }: { title: string; open: boolean; onClose: () => void; onSubmit: (v: { code: string; name: string }) => Promise<void> }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setCode(""); setName(""); setErr(null); onClose(); };
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !name.trim()) { setErr("Code and name are required."); return; }
    setBusy(true); setErr(null);
    try { await onSubmit({ code: code.trim(), name: name.trim() }); close(); } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} open={open} onClose={close}>
      <form onSubmit={go} noValidate>
        <FormField label="Code" htmlFor="cn-code"><input id="cn-code" className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} /></FormField>
        <FormField label="Name" htmlFor="cn-name"><input id="cn-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></FormField>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

export function WarehousesPage() {
  const { data, isLoading, error, refetch } = useListWarehousesQuery();
  const [createWarehouse] = useCreateWarehouseMutation();
  const [createLocation] = useCreateLocationMutation();
  const [newWarehouse, setNewWarehouse] = useState(false);
  const [addTo, setAddTo] = useState<{ id: string; code: string } | null>(null);
  const [editWh, setEditWh] = useState<Warehouse | null>(null);
  const [editLoc, setEditLoc] = useState<WarehouseLocation | null>(null);
  const { can } = useAccess();
  return (
    <>
      <PageHeader title="Warehouses" description="Where stock is kept." actions={<Can permission="inventory.product.manage"><Button onClick={() => setNewWarehouse(true)}>New warehouse</Button></Can>} />
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && data.results.length === 0 && <EmptyState title="No warehouses yet" />}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.results.map((w) => (
          <Card key={w.id} title={`${w.code} — ${w.name}`} actions={<div className="flex items-center gap-2">{!w.is_active && <Badge>Inactive</Badge>}<Can permission="inventory.product.manage"><Button variant="secondary" aria-label={`Edit warehouse ${w.code}`} onClick={() => setEditWh(w)}>Edit</Button><Button variant="secondary" aria-label={`Add location to ${w.code}`} onClick={() => setAddTo({ id: w.id, code: w.code })}>Add location</Button></Can></div>}>
            {w.locations.length === 0 ? <p className="text-sm text-slate-500">No locations yet.</p> : (
              <ul className="flex flex-wrap gap-1">
                {w.locations.map((l) => <li key={l.id} className={`rounded px-2 py-0.5 text-xs ${l.is_blocked ? "bg-red-100 text-red-800" : "bg-slate-100 text-slate-700"}`}>{can("inventory.product.manage") ? <button type="button" aria-label={`Edit location ${l.code}`} onClick={() => setEditLoc(l)}>{l.code}{l.is_blocked ? " (blocked)" : ""}</button> : <>{l.code}{l.is_blocked ? " (blocked)" : ""}</>}</li>)}
              </ul>
            )}
          </Card>
        ))}
      </div>
      {editWh && <WarehouseEditDialog warehouse={editWh} onClose={() => setEditWh(null)} />}
      {editLoc && <LocationEditDialog location={editLoc} onClose={() => setEditLoc(null)} />}
      <CodeNameDialog title="New warehouse" open={newWarehouse} onClose={() => setNewWarehouse(false)} onSubmit={async (v) => { await createWarehouse(v).unwrap(); }} />
      <CodeNameDialog title={addTo ? `New location in ${addTo.code}` : ""} open={!!addTo} onClose={() => setAddTo(null)} onSubmit={async (v) => { await createLocation({ warehouse: addTo!.id, ...v }).unwrap(); }} />
    </>
  );
}

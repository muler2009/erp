import { useState } from "react";

import { useCountActionMutation, useGetCountReportQuery, useListAssetCategoriesQuery, useListAssetLocationsQuery, useListCountsQuery, useResolveCountLineMutation, useStartCountMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { VerificationCount } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { CONDITIONS } from "./InspectionsPage";

/** What may be done about each kind of discrepancy — the same table the server enforces. */
export const RESOLUTIONS: Record<string, string[]> = {
  MISSING: ["FOUND", "WRITE_OFF_REQUESTED", "CONFIRMED_LOCATION"],
  FOUND_ELSEWHERE: ["LOCATION_UPDATED", "CONFIRMED_LOCATION"],
  UNEXPECTED: ["LOCATION_UPDATED", "CONFIRMED_LOCATION"],
  CONDITION_CHANGED: ["CONDITION_UPDATED", "CONFIRMED_LOCATION"],
};

export function validateScan(code: string): string | null {
  return code.trim() ? null : "Scan or type the asset's barcode, QR code or number.";
}

function Report({ count, canClose, canResolve }: { count: VerificationCount; canClose: boolean; canResolve: boolean }) {
  const { data, isLoading, error, refetch } = useGetCountReportQuery(count.id);
  const [resolve] = useResolveCountLineMutation();
  const [act] = useCountActionMutation();
  const [line, setLine] = useState<{ id: string; asset: string; kind: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const open = data.discrepancies.filter((d) => !d.resolution);
  return (
    <div className="text-sm">
      <p className="mb-2">{data.found} of {data.expected} expected assets found{data.accuracy_percent ? ` · accuracy ${data.accuracy_percent}%` : ""} · {open.length} unresolved discrepanc{open.length === 1 ? "y" : "ies"}</p>
      {err && <p role="alert" className="mb-2 text-red-700">{err}</p>}
      {!data.discrepancies.length ? <EmptyState title="No discrepancies" /> : (
        <ul>{data.discrepancies.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1">
            <span className="font-medium">{d.asset}</span><Badge tone="amber">{pretty(d.kind)}</Badge>{d.resolution ? <Badge tone="green">{pretty(d.resolution)}</Badge> : null}{d.notes && <span className="text-slate-500">{d.notes}</span>}
            {canResolve && !d.resolution && count.status === "IN_REVIEW" && <Button variant="secondary" onClick={() => setLine({ id: d.id, asset: d.asset, kind: d.kind })}>{`Resolve ${d.asset}`}</Button>}
          </li>))}</ul>
      )}
      {canClose && count.status === "IN_REVIEW" && <div className="mt-3"><Button disabled={open.length > 0} onClick={async () => { setErr(null); try { await act({ id: count.id, action: "close" }).unwrap(); } catch (e) { setErr(failure(e)); } }}>Close the count</Button>{open.length > 0 && <span className="ml-2 text-slate-500">Resolve every discrepancy first.</span>}</div>}
      <ActionDialog key={line?.id} title={`Resolve ${line?.asset ?? ""}`} open={!!line} onClose={() => setLine(null)} cta="Record resolution" fields={[{ name: "resolution", label: "Resolution", required: true, options: (RESOLUTIONS[line?.kind ?? ""] ?? []).map((r) => [r, pretty(r)] as [string, string]) }, { name: "notes", label: "Notes" }]}
        submit={(v) => resolve({ id: line!.id, resolution: v.resolution ?? "", notes: (v.notes ?? "").trim() }).unwrap()} />
    </div>
  );
}

function Scanner({ count, onClose }: { count: VerificationCount | null; onClose: () => void }) {
  const [act] = useCountActionMutation();
  const locs = useListAssetLocationsQuery(undefined, { skip: !count });
  const [f, setF] = useState({ code: "", location: "", condition: "" });
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = validateScan(f.code);
    if (p) { setErr(p); return; }
    setErr(null);
    try {
      const r = (await act({ id: count!.id, action: "scan", body: { code: f.code.trim(), ...(f.location ? { location: f.location } : {}), ...(f.condition ? { condition: f.condition } : {}) } }).unwrap()) as { asset: string; discrepancy: string };
      setLog([`${r.asset}${r.discrepancy ? ` — ${pretty(r.discrepancy)}` : " — OK"}`, ...log]);
      setF({ ...f, code: "" });
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Scan assets for ${count?.number ?? ""}`} open={!!count} onClose={onClose}>
      <FormField label="Code" htmlFor="sc-code"><input id="sc-code" autoFocus className={inputClass} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Found at" htmlFor="sc-loc"><select id="sc-loc" className={inputClass} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })}><option value="">Count location</option>{locs.data?.results.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</select></FormField>
        <FormField label="Condition" htmlFor="sc-cond"><select id="sc-cond" className={inputClass} value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })}><option value="">Unchanged</option>{CONDITIONS.map((c) => <option key={c} value={c}>{pretty(c)}</option>)}</select></FormField>
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <Button onClick={() => void go()}>Record scan</Button>
      {log.length > 0 && <ul aria-label="Scanned so far" className="mt-3 max-h-40 overflow-auto text-sm">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      <div className="mt-3 flex justify-end"><Button variant="secondary" onClick={onClose}>Done</Button></div>
    </Modal>
  );
}

export function CountsPage() {
  const { can } = useAccess();
  const manage = can("assets.verification.manage");
  const approve = can("assets.verification.approve");
  const { data, isLoading, error, refetch } = useListCountsQuery({});
  const locs = useListAssetLocationsQuery(undefined, { skip: !manage });
  const cats = useListAssetCategoriesQuery(undefined, { skip: !manage });
  const [start] = useStartCountMutation();
  const [act] = useCountActionMutation();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", location: "", category: "" });
  const [ferr, setFerr] = useState<string | null>(null);
  const [scanning, setScanning] = useState<VerificationCount | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (!f.name.trim()) { setFerr("Name the count."); return; }
    setFerr(null);
    try { await start({ name: f.name.trim(), ...(f.location ? { location: f.location } : {}), ...(f.category ? { category: f.category } : {}) }).unwrap(); setOpen(false); setF({ name: "", location: "", category: "" }); } catch (e) { setFerr(errorMessage(e)); }
  };
  const quick = async (c: VerificationCount, action: "complete" | "cancel") => {
    setErr(null); setMsg(null);
    try { const r = (await act({ id: c.id, action }).unwrap()) as { missing?: number; discrepancies?: number } | undefined; if (action === "complete" && r) setMsg(`${c.number}: ${r.missing ?? 0} missing, ${r.discrepancies ?? 0} discrepancies to review.`); } catch (e) { setErr(failure(e)); }
  };
  return (
    <>
      <PageHeader title="Verification counts" description="Count the asset base by scanning, then review what is missing, moved or changed." />
      <Card title="Counts">
        {manage && <div className="mb-2"><Button onClick={() => setOpen(true)}>Start a count</Button></div>}
        {msg && <p role="status" className="mb-2 text-sm text-green-700">{msg}</p>}
        {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No counts yet" /> : (
          <ul>{data.results.map((c) => (
            <li key={c.id} className="border-b border-slate-200 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2"><span className="font-mono">{c.number}</span><span className="font-medium">{c.name}</span><Badge tone={c.status === "CLOSED" ? "green" : c.status === "CANCELLED" ? "red" : "amber"}>{pretty(c.status)}</Badge><span className="text-slate-500">{c.lines} line(s) · started {c.started_on}</span></div>
              <div className="mt-2 flex flex-wrap gap-2">
                {manage && c.status === "OPEN" && <><Button onClick={() => setScanning(c)}>{`Scan ${c.number}`}</Button><Button variant="secondary" onClick={() => void quick(c, "complete")}>{`Finish scanning ${c.number}`}</Button></>}
                {manage && ["OPEN", "IN_REVIEW"].includes(c.status) && <Button variant="secondary" onClick={() => void quick(c, "cancel")}>{`Cancel ${c.number}`}</Button>}
                <Button variant="secondary" onClick={() => setViewing(viewing === c.id ? null : c.id)}>{viewing === c.id ? `Hide results ${c.number}` : `Results ${c.number}`}</Button>
              </div>
              {viewing === c.id && <div className="mt-2 rounded border border-slate-200 p-3"><Report count={c} canClose={approve} canResolve={approve} /></div>}
            </li>))}</ul>
        )}
      </Card>
      <Modal title="Start a count" open={open} onClose={() => setOpen(false)}>
        <FormField label="Name" htmlFor="cn-name"><input id="cn-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Location" htmlFor="cn-loc"><select id="cn-loc" className={inputClass} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })}><option value="">Everywhere</option>{locs.data?.results.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</select></FormField>
          <FormField label="Category" htmlFor="cn-cat"><select id="cn-cat" className={inputClass} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All</option>{cats.data?.results.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></FormField>
        </div>
        {ferr && <p role="alert" className="mb-3 text-sm text-red-700">{ferr}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Start count</Button></div>
      </Modal>
      <Scanner key={scanning?.id} count={scanning} onClose={() => setScanning(null)} />
    </>
  );
}

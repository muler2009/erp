import { useState } from "react";

import { useListQualityConfigQuery, useSaveQualityConfigMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QConfigItem } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const CONFIG_LISTS: [string, string][] = [
  ["SEVERITY", "Severity levels"], ["NCR_CATEGORY", "Non-conformance categories"], ["DEFECT_TYPE", "Defect types"], ["ANALYSIS_METHOD", "Root-cause methods"],
  ["AUDIT_TYPE", "Audit types"], ["FINDING_TYPE", "Finding types"], ["COMPLAINT_TYPE", "Complaint types"], ["RISK_CATEGORY", "Risk categories"], ["IMPROVEMENT_CATEGORY", "Improvement categories"],
];

export function validateConfigItem(f: { code: string; name: string; rank: string }, existing: string[], editing: boolean): string | null {
  const code = f.code.trim();
  if (!code) return "Enter a code.";
  if (!/^[A-Za-z0-9_]+$/.test(code) || code.length > 30) return "The code may use letters, digits and underscores, up to 30 characters.";
  if (!editing && existing.includes(code.toUpperCase())) return "This code is already in the list.";
  if (!f.name.trim()) return "Enter a name.";
  if (f.name.trim().length > 120) return "The name is too long (120 characters at most).";
  if (!/^\d+$/.test(f.rank.trim()) || Number(f.rank) < 1 || Number(f.rank) > 32767) return "The rank must be a whole number from 1 to 32767.";
  return null;
}

export function QualitySettingsPage() {
  const { can } = useAccess();
  const admin = can("quality.admin");
  const [kind, setKind] = useState("SEVERITY");
  const { data, isLoading, error, refetch } = useListQualityConfigQuery(kind);
  const [save] = useSaveQualityConfigMutation();
  const empty = { code: "", name: "", rank: "1", requires_capa: false };
  const [dlg, setDlg] = useState<{ editing: QConfigItem | null } | null>(null);
  const [f, setF] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);
  const isSeverity = kind === "SEVERITY";
  const items = [...(data ?? [])].sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code));
  const label = CONFIG_LISTS.find(([k]) => k === kind)?.[1] ?? kind;
  const openDialog = (it: QConfigItem | null) => { setErr(null); setF(it ? { code: it.code, name: it.name, rank: String(it.rank), requires_capa: it.requires_capa } : empty); setDlg({ editing: it }); };
  const go = async () => {
    const p = validateConfigItem(f, items.map((i) => i.code), !!dlg?.editing);
    if (p) { setErr(p); return; }
    setErr(null);
    try {
      await save({ kind, code: f.code.trim(), name: f.name.trim(), rank: Number(f.rank), requires_capa: isSeverity && f.requires_capa, is_active: dlg?.editing?.is_active ?? true }).unwrap();
      setDlg(null);
    } catch (e) { setErr(errorMessage(e)); }
  };
  const toggle = async (it: QConfigItem) => {
    setRowErr(null);
    try { await save({ kind, code: it.code, name: it.name, rank: it.rank, requires_capa: it.requires_capa, is_active: !it.is_active }).unwrap(); } catch (e) { setRowErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Quality lists" description="The choices offered on quality forms. Retire an entry instead of deleting it: records already using it keep it." actions={admin ? <Button onClick={() => openDialog(null)}>Add an entry</Button> : undefined} />
      <Card>
        <div className="mb-3"><label className="text-sm">List <select aria-label="List" className={inputClass} value={kind} onChange={(e) => { setKind(e.target.value); setRowErr(null); }}>{CONFIG_LISTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label></div>
        {rowErr && <p role="alert" className="mb-3 text-sm text-red-700">{rowErr}</p>}
        {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !items.length ? <EmptyState title="Nothing in this list yet" /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Name</th>{isSeverity && <th>Rank</th>}{isSeverity && <th>Needs a CAPA to close</th>}<th>Status</th><th /></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.id} className={`border-t ${i.is_active ? "" : "text-slate-500"}`}><td>{i.code}</td><td>{i.name}</td>{isSeverity && <td>{i.rank}</td>}{isSeverity && <td>{i.requires_capa ? "Yes" : "No"}</td>}
                <td><Badge tone={i.is_active ? "green" : "slate"}>{i.is_active ? "Active" : "Retired"}</Badge></td>
                <td>{admin && <><Button variant="secondary" onClick={() => openDialog(i)}>{`Edit ${i.code}`}</Button> <Button variant="secondary" onClick={() => void toggle(i)}>{i.is_active ? `Retire ${i.code}` : `Restore ${i.code}`}</Button></>}</td></tr>))}</tbody></table>
        )}
      </Card>
      <Modal title={dlg?.editing ? `Edit ${label} entry` : `Add to ${label}`} open={!!dlg} onClose={() => setDlg(null)}>
        <FormField label="Code" htmlFor="cf-code"><input id="cf-code" className={inputClass} value={f.code} disabled={!!dlg?.editing} onChange={(e) => setF({ ...f, code: e.target.value })} /></FormField>
        <FormField label="Name" htmlFor="cf-name"><input id="cf-name" className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
        {isSeverity && <>
          <FormField label="Rank (higher is worse)" htmlFor="cf-rank"><input id="cf-rank" className={inputClass} value={f.rank} onChange={(e) => setF({ ...f, rank: e.target.value })} /></FormField>
          <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.requires_capa} onChange={(e) => setF({ ...f, requires_capa: e.target.checked })} />A closed record at this level needs a CAPA</label>
        </>}
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button onClick={() => void go()}>Save</Button></div>
      </Modal>
    </>
  );
}

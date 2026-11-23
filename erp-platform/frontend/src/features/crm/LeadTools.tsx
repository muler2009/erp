import { useState } from "react";

import { useFindLeadDuplicatesQuery, useImportLeadsMutation, useMergeLeadsMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Lead } from "../../shared/api/types";
import { Badge, Button, ErrorState, FormField, Modal, Spinner, inputClass } from "../../shared/ui/primitives";

export const IMPORT_COLUMNS = ["name", "company", "email", "phone", "source", "industry", "priority", "budget"];

/** First problem with the pasted or chosen file before anything is sent. */
export function importProblem(csv: string): string | null {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return "Choose a file or paste the rows.";
  const header = (lines[0] ?? "").split(",").map((h) => h.trim().toLowerCase());
  if (!header.includes("name")) return "The first line must be a header row that includes a name column.";
  const unknown = header.filter((h) => h && !IMPORT_COLUMNS.includes(h));
  if (unknown.length) return `Unknown column: ${unknown.join(", ")}. Use ${IMPORT_COLUMNS.join(", ")}.`;
  if (lines.length === 1) return "The file has a header but no rows.";
  return lines.length - 1 > 500 ? "At most 500 rows can be imported at once." : null;
}

export function LeadImportDialog({ onClose }: { onClose: () => void }) {
  const [run, { isLoading }] = useImportLeadsMutation();
  const [csv, setCsv] = useState("");
  const [checked, setChecked] = useState<string | null>(null); // the exact text that passed the check
  const [result, setResult] = useState<{ valid: boolean; rows: number; errors: { row: number; errors: string[] }[]; created: number; dry_run: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const edit = (v: string) => { setCsv(v); setChecked(null); setResult(null); };
  const pick = (f: File | undefined) => { if (!f) return; const r = new FileReader(); r.onload = () => edit(String(r.result ?? "")); r.readAsText(f); };
  const go = async (dry_run: boolean) => {
    const p = importProblem(csv);
    if (p) { setErr(p); return; }
    setErr(null);
    try {
      const r = await run({ csv, dry_run }).unwrap();
      setResult(r);
      if (dry_run && r.valid) setChecked(csv);
    } catch (e) { setErr(errorMessage(e)); }
  };
  const done = result && !result.dry_run && result.valid;
  return (
    <Modal title="Import leads" open onClose={onClose}>
      <p className="mb-2 text-sm text-slate-600">One lead per row, with a header row. Columns: {IMPORT_COLUMNS.join(", ")} (only name is required). The file is checked first; nothing is created unless every row is clean.</p>
      <FormField label="Choose a CSV file" htmlFor="li-file"><input id="li-file" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} /></FormField>
      <FormField label="Or paste the rows" htmlFor="li-text"><textarea id="li-text" rows={6} className={inputClass} value={csv} onChange={(e) => edit(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {result && !done && (result.valid
        ? <p role="status" className="mb-2 text-sm text-green-700">All {result.rows} row(s) look good. Import them when you are ready.</p>
        : <ul aria-label="Problems found" className="mb-2 max-h-40 overflow-y-auto text-sm text-red-700">{result.errors.map((x) => <li key={x.row}>Row {x.row}: {x.errors.join(", ")}</li>)}</ul>)}
      {done && <p role="status" className="mb-2 text-sm text-green-700">{result.created} lead(s) created.</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{done ? "Close" : "Cancel"}</Button>
        {!done && <Button variant="secondary" loading={isLoading} onClick={() => void go(true)}>Check file</Button>}
        {!done && <Button loading={isLoading} disabled={checked === null || checked !== csv} onClick={() => void go(false)}>Import</Button>}
      </div>
    </Modal>
  );
}

export function LeadMergeDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const q = useFindLeadDuplicatesQuery({ name: lead.name, company: lead.company, email: lead.email, phone: lead.phone });
  const [merge, { isLoading }] = useMergeLeadsMutation();
  const [other, setOther] = useState("");
  const [keepThis, setKeepThis] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const matches = (q.data?.leads ?? []).filter((l) => l.id !== lead.id && l.status !== "CONVERTED");
  const go = async () => {
    if (!other) { setErr("Choose the lead to merge."); return; }
    setErr(null);
    try { await merge(keepThis ? { keep: lead.id, merge: other } : { keep: other, merge: lead.id }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Possible duplicates of ${lead.name}`} open onClose={onClose}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : (
        <>
          {(q.data?.accounts ?? []).length > 0 && <p className="mb-2 text-sm text-amber-700">An account with this company name already exists: {q.data!.accounts.map((a) => a.name).join(", ")}.</p>}
          {matches.length === 0 ? <p className="mb-3 text-sm text-slate-600">No other open lead looks like this one.</p> : (
            <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Merge with</legend>
              {matches.map((m) => (
                <label key={m.id} className="mb-1 flex items-center gap-2 text-sm"><input type="radio" name="dup" checked={other === m.id} onChange={() => setOther(m.id)} />{m.name}{m.company ? `, ${m.company}` : ""} <Badge tone="slate">{m.status.toLowerCase()}</Badge><span className="text-slate-500">matched on {m.matched_on}</span></label>
              ))}
            </fieldset>
          )}
          {matches.length > 0 && (
            <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Keep</legend>
              <label className="mr-4 text-sm"><input type="radio" name="keep" checked={keepThis} onChange={() => setKeepThis(true)} /> This lead ({lead.name})</label>
              <label className="text-sm"><input type="radio" name="keep" checked={!keepThis} onChange={() => setKeepThis(false)} /> The other lead</label>
              <p className="mt-1 text-xs text-slate-500">Blank details are filled from the merged lead and its activities move across. The merged lead stays on record, marked merged.</p>
            </fieldset>
          )}
        </>
      )}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button>{matches.length > 0 && <Button variant="danger" loading={isLoading} onClick={() => void go()}>Merge leads</Button>}</div>
    </Modal>
  );
}

import { useState } from "react";

import { errorMessage } from "../../shared/api/errors";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";
import { UserSelect } from "../../shared/ui/UserSelect";

/** Plain Errors thrown by a dialog's own checks are shown as written; everything else goes through the API error formatter. */
export const failure = (e: unknown): string => (e instanceof Error ? e.message : errorMessage(e));

/** A small reusable "ask, then POST" dialog for the lifecycle steps. */
export function ActionDialog({ title, open, onClose, fields, submit, cta, initial }: { title: string; open: boolean; onClose: () => void; fields: { name: string; label: string; type?: string; required?: boolean; options?: [string, string][]; searchUsers?: boolean }[]; submit: (v: Record<string, string>) => Promise<unknown>; cta: string; initial?: Record<string, string> }) {
  const [v, setV] = useState<Record<string, string>>(initial ?? {});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const missing = fields.find((f) => f.required && !(v[f.name] ?? "").trim());
    if (missing) { setErr(`${missing.label} is required.`); return; }
    setErr(null); setBusy(true);
    try { await submit(v); setV({}); onClose(); } catch (e) { setErr(failure(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} open={open} onClose={onClose}>
      {fields.map((f) => (
        <FormField key={f.name} label={f.label} htmlFor={`ad-${f.name}`}>
          {f.options && f.searchUsers ? <UserSelect id={`ad-${f.name}`} value={v[f.name] ?? ""} onChange={(x) => setV({ ...v, [f.name]: x })} options={f.options} />
            : f.options ? <select id={`ad-${f.name}`} className={inputClass} value={v[f.name] ?? ""} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}><option value="">Choose…</option>{f.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            : f.type === "textarea" ? <textarea id={`ad-${f.name}`} rows={3} className={inputClass} value={v[f.name] ?? ""} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
            : <input id={`ad-${f.name}`} type={f.type ?? "text"} className={inputClass} value={v[f.name] ?? ""} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />}
        </FormField>
      ))}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void go()}>{cta}</Button></div>
    </Modal>
  );
}


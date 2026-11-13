import { useState } from "react";

import { FormField, Button, Modal, inputClass } from "../../shared/ui/primitives";
import { failure } from "./ActionDialog";
import { EmployeeSelect } from "./EmployeeSelect";

/** A generic dialog with a leading employee picker for the requests below. */
export function EmployeeRequest({ title, open, onClose, cta, fields, submit, pickEmployee = true }: { title: string; open: boolean; onClose: () => void; cta: string; fields: { name: string; label: string; type?: string; options?: [string, string][]; required?: boolean }[]; submit: (emp: string, v: Record<string, string>) => Promise<unknown>; pickEmployee?: boolean }) {
  const [emp, setEmp] = useState("");
  const [v, setV] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (pickEmployee && !emp) { setErr("Choose the employee."); return; }
    const missing = fields.find((f) => f.required && !(v[f.name] ?? "").trim());
    if (missing) { setErr(`${missing.label} is required.`); return; }
    setErr(null); setBusy(true);
    try { await submit(emp, v); setV({}); setEmp(""); onClose(); } catch (e) { setErr(failure(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} open={open} onClose={onClose}>
      {pickEmployee && <FormField label="Employee" htmlFor="rq-emp"><EmployeeSelect id="rq-emp" label="Employee" value={emp} onChange={setEmp} /></FormField>}
      {fields.map((f) => (
        <FormField key={f.name} label={f.label} htmlFor={`rq-${f.name}`}>
          {f.options ? <select id={`rq-${f.name}`} className={inputClass} value={v[f.name] ?? ""} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}><option value="">Choose…</option>{f.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            : <input id={`rq-${f.name}`} type={f.type ?? "text"} className={inputClass} value={v[f.name] ?? ""} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />}
        </FormField>
      ))}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void go()}>{cta}</Button></div>
    </Modal>
  );
}


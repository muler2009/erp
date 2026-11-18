import { useState } from "react";

import { useCreateOrgRecordMutation, useListCurrenciesQuery, useListOrgOptionsQuery, useUpdateOrgRecordMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { OrgRecord } from "../../shared/api/types";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";
import { UserSelect } from "../../shared/ui/UserSelect";
import { useUserNames, useUserOptions } from "../quality/names";
import type { OrgField, OrgKindConfig } from "./structure";

function RecordSelect({ field, id, value, onChange, exclude }: { field: OrgField; id: string; value: string; onChange: (v: string) => void; exclude?: string }) {
  const { data = [], isLoading } = useListOrgOptionsQuery(field.from!);
  return (
    <select id={id} className={inputClass} value={value} disabled={isLoading} onChange={(e) => onChange(e.target.value)}>
      <option value="">{isLoading ? "Loading…" : "None"}</option>
      {data.filter((r) => r.id !== exclude).map((r) => <option key={r.id} value={r.id}>{r.code} {r.name ?? r.title}</option>)}
    </select>
  );
}

function CurrencySelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const { data, isLoading } = useListCurrenciesQuery({ active: true });
  return (
    <select id={id} className={inputClass} value={value} disabled={isLoading} onChange={(e) => onChange(e.target.value)}>
      <option value="">{isLoading ? "Loading…" : "None"}</option>
      {(data?.results ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
    </select>
  );
}

/** Create or edit one structural record. Edits send the loaded version so a concurrent change is reported, not overwritten. */
export function OrgRecordDialog({ config, record, open, onClose }: { config: OrgKindConfig; record: OrgRecord | null; open: boolean; onClose: () => void }) {
  const [create, creating] = useCreateOrgRecordMutation();
  const [update, updating] = useUpdateOrgRecordMutation();
  const people = useUserOptions(!open);
  const nameOf = useUserNames();
  const initial = (): Record<string, string> => Object.fromEntries(config.fields.map((f) => [f.name, String((record as unknown as Record<string, unknown> | null)?.[f.name] ?? "")]));
  const [v, setV] = useState<Record<string, string>>(initial);
  const [active, setActive] = useState(record?.is_active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const editing = record !== null;
  const known = new Set(people.map(([k]) => k));
  const submit = async () => {
    const missing = config.fields.find((f) => f.required && !(v[f.name] ?? "").trim());
    if (missing) { setErr(`${missing.label} is required.`); return; }
    const body: Record<string, unknown> = {};
    for (const f of config.fields) {
      const val = (v[f.name] ?? "").trim();
      body[f.name] = f.type === "select" || f.type === "user" || f.type === "currency" ? (val || null) : val;
    }
    setErr(null);
    try {
      if (editing) await update({ kind: config.kind, id: record.id, body: { ...body, is_active: active, version: record.version } }).unwrap();
      else await create({ kind: config.kind, body }).unwrap();
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={editing ? `Edit ${config.singular}` : `New ${config.singular}`} open={open} onClose={onClose}>
      {config.fields.map((f) => {
        const id = `org-${f.name}`;
        const val = v[f.name] ?? "";
        const set = (x: string) => setV({ ...v, [f.name]: x });
        return (
          <FormField key={f.name} label={f.label} htmlFor={id}>
            {f.type === "select" ? <RecordSelect field={f} id={id} value={val} onChange={set} exclude={f.name === "parent" ? record?.id : undefined} />
              : f.type === "currency" ? <CurrencySelect id={id} value={val} onChange={set} />
              : f.type === "user" ? <UserSelect id={id} value={val} onChange={set} options={val && !known.has(val) ? [...people, [val, nameOf(val)]] : people} />
              : f.type === "textarea" ? <textarea id={id} rows={3} className={inputClass} value={val} onChange={(e) => set(e.target.value)} />
              : <input id={id} className={inputClass} value={val} onChange={(e) => set(e.target.value)} />}
          </FormField>
        );
      })}
      {editing && (
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
      )}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={creating.isLoading || updating.isLoading} onClick={() => void submit()}>{editing ? "Save changes" : "Create"}</Button>
      </div>
    </Modal>
  );
}

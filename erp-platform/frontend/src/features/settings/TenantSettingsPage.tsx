import { useState } from "react";

import { useGetTenantSettingsQuery, useListTenantModulesQuery, useSetTenantModuleMutation, useUpdateTenantSettingsMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { TenantSettings } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const CHOICES: Record<string, [string, string][]> = {
  "documents.version_scheme": [["SEQUENTIAL", "Sequential (1, 2, 3)"], ["MAJOR_MINOR", "Major.minor (1.0, 1.1)"]],
  "locale.date_format": [["YYYY-MM-DD", "2026-11-22"], ["DD/MM/YYYY", "22/11/2026"], ["MM/DD/YYYY", "11/22/2026"]],
};
const GROUPS: Record<string, string> = { documents: "Documents", quality: "Quality", analytics: "Analytics", locale: "Language and dates", notifications: "Notifications", procurement: "Procurement", assets: "Assets", projects: "Projects", manufacturing: "Manufacturing", supply_chain: "Supply chain", sales: "Sales", hr: "Human resources", workflow: "Approvals" };
export const settingLabel = (key: string) => { const w = key.split(".").slice(1).join(" ").replace(/_/g, " "); return w.charAt(0).toUpperCase() + w.slice(1); };
export const groupOf = (key: string) => GROUPS[key.split(".")[0] ?? ""] ?? key.split(".")[0] ?? key;

/** Turns the text boxes back into the types the server stores. Returns the changed keys only, or the first problem. */
export function changedSettings(original: TenantSettings, draft: Record<string, string | boolean>): { values: TenantSettings } | { problem: string } {
  const values: TenantSettings = {};
  for (const [k, d] of Object.entries(draft)) {
    const o = original[k];
    if (typeof o === "number") {
      const t = String(d).trim();
      if (!/^-?\d+(\.\d+)?$/.test(t)) return { problem: `${settingLabel(k)} must be a number.` };
      if (Number(t) !== o) values[k] = Number(t);
    } else if (typeof o === "boolean") {
      if (d !== o) values[k] = d as boolean;
    } else if (d !== o) {
      values[k] = String(d);
    }
  }
  return { values };
}

export function TenantSettingsPage() {
  const q = useGetTenantSettingsQuery();
  const [save, s] = useUpdateTenantSettingsMutation();
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const orig = q.data;
  const val = (k: string) => (k in draft ? draft[k] : typeof orig[k] === "boolean" ? orig[k] : String(orig[k]));
  const groups = new Map<string, string[]>();
  for (const k of Object.keys(orig).sort()) groups.set(groupOf(k), [...(groups.get(groupOf(k)) ?? []), k]);
  const go = async () => {
    setOk(false); setErr(null);
    const r = changedSettings(orig, draft);
    if ("problem" in r) { setErr(r.problem); return; }
    if (Object.keys(r.values).length === 0) { setErr("Nothing has changed."); return; }
    try { await save(r.values).unwrap(); setDraft({}); setOk(true); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Workspace settings" description="Rules that apply to everyone in this workspace." actions={<Button loading={s.isLoading} onClick={() => void go()}>Save changes</Button>} />
      {err && <p role="alert" className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-800">{err}</p>}
      {ok && <p role="status" className="mb-3 rounded-md bg-green-50 p-3 text-sm text-green-800">Settings saved.</p>}
      <div className="space-y-4">
        {[...groups.entries()].map(([g, keys]) => (
          <Card key={g} title={g}>
            <div className="grid gap-3 md:grid-cols-2">
              {keys.map((k) => (
                <label key={k} className="block text-sm">
                  <span className="mb-1 block font-medium text-slate-700">{settingLabel(k)}</span>
                  {typeof orig[k] === "boolean" ? <input type="checkbox" aria-label={`${g}: ${settingLabel(k)}`} checked={val(k) as boolean} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />
                    : CHOICES[k] ? <select aria-label={`${g}: ${settingLabel(k)}`} className={inputClass} value={String(val(k))} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}>{CHOICES[k].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    : <input aria-label={`${g}: ${settingLabel(k)}`} className={inputClass} value={String(val(k))} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />}
                </label>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

export function ModulesPage() {
  const q = useListTenantModulesQuery();
  const [set, s] = useSetTenantModuleMutation();
  const { can } = useAccess();
  const [err, setErr] = useState<string | null>(null);
  const flip = async (module: string, enabled: boolean) => { setErr(null); try { await set({ module, enabled }).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <>
      <PageHeader title="Modules" description="Which parts of the system this workspace uses. A module must be part of your subscription before it can be switched on." />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data?.length ? <EmptyState title="No modules" /> : (
        <Card><ul className="divide-y divide-slate-100 text-sm">{q.data.map((m) => (
          <li key={m.module} className="flex items-center justify-between py-2">
            <span className="capitalize">{m.module.replace(/[._]/g, " ")} {!m.entitled && <Badge tone="slate">Not in subscription</Badge>} {m.entitled && <Badge tone={m.enabled ? "green" : "amber"}>{m.enabled ? "On" : "Off"}</Badge>}</span>
            {can("modules.manage") && <Button variant="secondary" loading={s.isLoading && s.originalArgs?.module === m.module} disabled={!m.entitled && !m.enabled} aria-label={`${m.enabled ? "Switch off" : "Switch on"} ${m.module}`} onClick={() => void flip(m.module, !m.enabled)}>{m.enabled ? "Switch off" : "Switch on"}</Button>}
          </li>))}</ul></Card>
      )}
    </>
  );
}

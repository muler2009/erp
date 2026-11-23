import { useState } from "react";

import { useGetAccountSummaryQuery, useLinkContactToAccountMutation, useListCrmAccountsQuery, useListStagesQuery, useRetireStageMutation, useSaveStageMutation, useSetLeadConsentMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { CrmContact, Lead } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { CONTACT_ROLES } from "./options";

// ------------------------------------------------------------------ pipeline stages
export function stageProblem(f: { code: string; name: string; position: string; probability: string }, isNew: boolean): string | null {
  if (isNew && !/^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(f.code.trim())) return "The code needs letters, digits or underscores, starting with a letter.";
  if (!f.name.trim() && isNew) return "Give the stage a name.";
  if (f.probability.trim() === "" ? isNew : !/^\d{1,3}$/.test(f.probability.trim()) || Number(f.probability) > 100) return "Probability must be a whole number from 0 to 100.";
  if (f.position.trim() === "" ? isNew : !/^\d{1,4}$/.test(f.position.trim())) return "Position must be a whole number.";
  return null;
}

export function PipelineSettingsPage() {
  const q = useListStagesQuery();
  const [save] = useSaveStageMutation();
  const [retire] = useRetireStageMutation();
  const [dlg, setDlg] = useState<{ code: string; name: string; probability: number } | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const drop = async (code: string) => { setErr(null); try { await retire(code).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  const isNew = dlg === "new";
  return (
    <>
      <PageHeader title="Pipeline stages" description="The steps an opportunity moves through. Won and lost are fixed. The stages are listed in their current order." actions={<Button onClick={() => setDlg("new")}>New stage</Button>} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data?.length ? <EmptyState title="No stages" /> : (
        <Card><ol className="divide-y divide-slate-100 text-sm">{q.data.map((s, i) => (
          <li key={s.code} className="flex items-center justify-between py-2">
            <span>{i + 1}. {s.name} <span className="text-slate-500">({s.code}) · {s.probability}% likely</span> {(s.is_won || s.is_lost) && <Badge tone="slate">Fixed</Badge>}</span>
            {!s.is_won && !s.is_lost && <span className="flex gap-2"><Button variant="secondary" aria-label={`Edit stage ${s.name}`} onClick={() => setDlg(s)}>Edit</Button><Button variant="danger" aria-label={`Retire stage ${s.name}`} onClick={() => void drop(s.code)}>Retire</Button></span>}
          </li>))}</ol></Card>
      )}
      {dlg && (
        <ActionDialog key={isNew ? "new" : dlg.code} title={isNew ? "New stage" : `Edit stage ${dlg.name}`} cta="Save stage" open onClose={() => setDlg(null)}
          initial={isNew ? { code: "", name: "", position: "", probability: "" } : { code: dlg.code, name: dlg.name, position: "", probability: String(dlg.probability) }}
          fields={[...(isNew ? [{ name: "code", label: "Code", required: true }] : []), { name: "name", label: "Name", required: isNew }, { name: "position", label: isNew ? "Position (order number)" : "New position (leave empty to keep)", required: isNew }, { name: "probability", label: "Chance of winning (%)", required: true }]}
          submit={async (v) => {
            const f = { code: (v.code ?? (isNew ? "" : dlg.code)).trim(), name: (v.name ?? "").trim(), position: (v.position ?? "").trim(), probability: (v.probability ?? "").trim() };
            const p = stageProblem(f, isNew); if (p) throw new Error(p);
            await save({ code: f.code.toUpperCase(), ...(f.name ? { name: f.name } : {}), ...(f.position ? { position: Number(f.position) } : {}), ...(f.probability ? { probability: Number(f.probability) } : {}) }).unwrap();
          }} />
      )}
    </>
  );
}

// ------------------------------------------------------------------ account summary
export function AccountSummaryCard({ id }: { id: string }) {
  const [currency, setCurrency] = useState("");
  const valid = currency.trim() === "" || /^[A-Za-z]{3}$/.test(currency.trim());
  const q = useGetAccountSummaryQuery({ id, ...(currency.trim() && valid ? { currency: currency.trim().toUpperCase() } : {}) }, { skip: !valid });
  const d = q.data;
  return (
    <Card title="Purchase history">
      <label className="mb-2 block text-sm">Currency (optional) <input aria-label="Summary currency" maxLength={3} className={`${inputClass} w-24`} value={currency} onChange={(e) => setCurrency(e.target.value)} /></label>
      {!valid && <p role="alert" className="text-sm text-red-700">Enter a 3-letter currency code.</p>}
      {valid && (q.isFetching ? <Spinner /> : q.error || !d ? <ErrorState error={q.error} onRetry={q.refetch} /> : (
        <div className="text-sm">
          <p>Lifetime value <b>{formatMoney(d.lifetime_value)} {d.currency}</b> · {d.orders} orders · average {formatMoney(d.average_order_value)}</p>
          <p className="text-slate-600">First order {d.first_order ?? "–"} · last order {d.last_order ?? "–"}</p>
          <p className="text-slate-600">{d.open_opportunities} open opportunities · {d.open_cases} open service cases{d.satisfaction !== null ? ` · satisfaction ${d.satisfaction}` : ""}</p>
          {d.top_products.length > 0 && <ul className="mt-2 list-disc pl-5">{d.top_products.map((p) => <li key={p.product}>{p.product}: {formatMoney(p.revenue)}</li>)}</ul>}
        </div>
      ))}
    </Card>
  );
}

// ------------------------------------------------------------------ lead consent
export function LeadConsentDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [set, { isLoading }] = useSetLeadConsentMutation();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = async (body: { consent?: boolean; opt_out?: boolean }, done: string) => { setErr(null); setOk(null); try { await set({ id: lead.id, ...body }).unwrap(); setOk(done); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal title={`Marketing consent: ${lead.name}`} open onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">Record what this lead agreed to. An opt-out also withdraws consent. The current state is not shown here because the server does not send it with the lead.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={isLoading} onClick={() => void run({ consent: true }, "Consent recorded.")}>Record consent</Button>
        <Button variant="secondary" loading={isLoading} onClick={() => void run({ consent: false }, "Consent withdrawn.")}>Withdraw consent</Button>
        <Button variant="danger" loading={isLoading} onClick={() => void run({ opt_out: true }, "Opt-out recorded.")}>Record opt-out</Button>
        <Button variant="secondary" loading={isLoading} onClick={() => void run({ opt_out: false }, "Opt-out cleared.")}>Clear opt-out</Button>
      </div>
      {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
      {ok && <p role="status" className="mt-3 text-sm text-green-700">{ok}</p>}
      <div className="mt-4 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Modal>
  );
}

// ------------------------------------------------------------------ link a contact to another account
export function LinkContactDialog({ contact, onClose }: { contact: CrmContact; onClose: () => void }) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [account, setAccount] = useState("");
  const [role, setRole] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [link, { isLoading }] = useLinkContactToAccountMutation();
  const found = useListCrmAccountsQuery(term ? { q: term } : undefined);
  const options = (found.data?.results ?? []).filter((a) => a.id !== contact.account);
  const go = async () => {
    if (!account) { setErr("Choose an account to link."); return; }
    setErr(null);
    try { await link({ id: contact.id, account, role }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Link ${contact.first_name} ${contact.last_name} to another account`} open onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">For a person who works with more than one customer. Linking again changes their role at that account.</p>
      <form className="mb-2 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setTerm(text.trim()); }}>
        <FormField label="Find account" htmlFor="lc-find"><input id="lc-find" className={inputClass} value={text} onChange={(e) => setText(e.target.value)} /></FormField>
        <Button type="submit" variant="secondary" className="mb-3">Search</Button>
      </form>
      <FormField label="Account" htmlFor="lc-acc"><select id="lc-acc" className={inputClass} value={account} onChange={(e) => setAccount(e.target.value)}><option value="">Choose…</option>{options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></FormField>
      <FormField label="Role at that account" htmlFor="lc-role"><select id="lc-role" className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}><option value="">No role</option>{CONTACT_ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Link account</Button></div>
    </Modal>
  );
}

import { useState } from "react";

import { useDecideAssetClaimMutation, useGetExpiringCoverageQuery, useGetUninsuredAssetsQuery, useInsurancePolicyActionMutation, useListAssetClaimsQuery, useListFixedAssetsQuery, useListInsurancePoliciesQuery, useCreateInsurancePolicyMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { InsurancePolicy } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";

const DEC = /^\d+(\.\d{1,4})?$/;

export function validatePolicy(f: { policy_number: string; insurer: string; start_on: string; end_on: string; premium: string; coverage_amount: string }): string | null {
  if (!f.policy_number.trim() || !f.insurer.trim()) return "Enter the policy number and the insurer.";
  if (!f.start_on || !f.end_on) return "Enter the start and end dates.";
  if (f.end_on < f.start_on) return "The policy must end on or after the day it starts.";
  if (f.premium.trim() && !DEC.test(f.premium.trim())) return "Premium must be a number.";
  if (f.coverage_amount.trim() && !DEC.test(f.coverage_amount.trim())) return "Coverage amount must be a number.";
  return null;
}
export function validateClaim(f: { asset: string; incident_date: string; description: string; amount: string }, policy?: { start_on: string; end_on: string }): string | null {
  if (!f.asset) return "Choose the insured asset.";
  if (!f.incident_date) return "Enter the date of the incident.";
  if (policy && (f.incident_date < policy.start_on || f.incident_date > policy.end_on)) return `The incident must fall within the policy period (${policy.start_on} to ${policy.end_on}).`;
  if (!f.description.trim()) return "Describe what happened.";
  if (f.amount.trim() && !DEC.test(f.amount.trim())) return "The amount claimed must be a number.";
  return null;
}

function Policies() {
  const { can } = useAccess();
  const manage = can("assets.insurance.manage");
  const { data, isLoading, error, refetch } = useListInsurancePoliciesQuery();
  const assets = useListFixedAssetsQuery({});
  const [create] = useCreateInsurancePolicyMutation();
  const [act] = useInsurancePolicyActionMutation();
  const [open, setOpen] = useState(false);
  const empty = { policy_number: "", insurer: "", start_on: "", end_on: "", premium: "", coverage_amount: "" };
  const [f, setF] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<{ p: InsurancePolicy; kind: "cover" | "renew" | "claim" } | null>(null);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const [cf, setCf] = useState({ asset: "", incident_date: "", description: "", amount: "" });
  const [rowErr, setRowErr] = useState<string | null>(null);
  const name = (id: string) => { const a = assets.data?.results.find((x) => x.id === id); return a ? a.number : id; };
  const go = async () => {
    const p = validatePolicy(f);
    if (p) { setErr(p); return; }
    setErr(null);
    try { await create({ ...f, policy_number: f.policy_number.trim(), insurer: f.insurer.trim(), premium: f.premium.trim() || "0", coverage_amount: f.coverage_amount.trim() || "0" }).unwrap(); setOpen(false); setF(empty); } catch (e) { setErr(errorMessage(e)); }
  };
  const p = dlg?.p;
  const submitClaim = async () => {
    const bad = validateClaim(cf, p);
    if (bad) { setClaimErr(bad); return; }
    setClaimErr(null);
    try { await act({ id: p!.id, action: "claims", body: { asset: cf.asset, incident_date: cf.incident_date, description: cf.description.trim(), amount_claimed: cf.amount.trim() || "0" } }).unwrap(); setCf({ asset: "", incident_date: "", description: "", amount: "" }); setDlg(null); } catch (e) { setClaimErr(errorMessage(e)); }
  };
  return (
    <Card title="Insurance policies">
      {manage && <div className="mb-2"><Button onClick={() => setOpen(true)}>New policy</Button></div>}
      {rowErr && <p role="alert" className="mb-2 text-sm text-red-700">{rowErr}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No policies yet" /> : (
        <ul>{data.results.map((x) => (
          <li key={x.id} className="border-b border-slate-200 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono">{x.policy_number}</span><span className="font-medium">{x.insurer}</span><span className="text-slate-500">{x.start_on} to {x.end_on}</span><span>premium {formatMoney(x.premium)} · cover {formatMoney(x.coverage_amount)}</span></div>
            <p className="mt-1 text-slate-600">{x.assets.length ? x.assets.map((a) => `${name(a.asset)} (${formatMoney(a.insured_value)})`).join(", ") : "No assets covered yet"}</p>
            {manage && <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setDlg({ p: x, kind: "cover" })}>{`Cover an asset on ${x.policy_number}`}</Button>
              <Button variant="secondary" onClick={() => setDlg({ p: x, kind: "claim" })}>{`File a claim on ${x.policy_number}`}</Button>
              <Button variant="secondary" onClick={() => setDlg({ p: x, kind: "renew" })}>{`Renew ${x.policy_number}`}</Button>
              {x.assets.map((a) => <Button key={a.asset} variant="secondary" onClick={async () => { setRowErr(null); try { await act({ id: x.id, action: "uncover", body: { asset: a.asset } }).unwrap(); } catch (e) { setRowErr(failure(e)); } }}>{`Remove ${name(a.asset)} from ${x.policy_number}`}</Button>)}
            </div>}
          </li>))}</ul>
      )}
      <Modal title="New insurance policy" open={open} onClose={() => setOpen(false)}>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Policy number" htmlFor="ip-no"><input id="ip-no" className={inputClass} value={f.policy_number} onChange={(e) => setF({ ...f, policy_number: e.target.value })} /></FormField>
          <FormField label="Insurer" htmlFor="ip-ins"><input id="ip-ins" className={inputClass} value={f.insurer} onChange={(e) => setF({ ...f, insurer: e.target.value })} /></FormField>
          <FormField label="Starts" htmlFor="ip-s"><input id="ip-s" type="date" className={inputClass} value={f.start_on} onChange={(e) => setF({ ...f, start_on: e.target.value })} /></FormField>
          <FormField label="Ends" htmlFor="ip-e"><input id="ip-e" type="date" className={inputClass} value={f.end_on} onChange={(e) => setF({ ...f, end_on: e.target.value })} /></FormField>
          <FormField label="Premium" htmlFor="ip-p"><input id="ip-p" className={inputClass} value={f.premium} onChange={(e) => setF({ ...f, premium: e.target.value })} /></FormField>
          <FormField label="Coverage amount" htmlFor="ip-c"><input id="ip-c" className={inputClass} value={f.coverage_amount} onChange={(e) => setF({ ...f, coverage_amount: e.target.value })} /></FormField>
        </div>
        {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void go()}>Create policy</Button></div>
      </Modal>
      <ActionDialog key={`cv${p?.id}`} title="Cover an asset" open={dlg?.kind === "cover"} onClose={() => setDlg(null)} cta="Add cover" fields={[{ name: "asset", label: "Asset", required: true, options: (assets.data?.results ?? []).map((a) => [a.id, `${a.number} ${a.name}`] as [string, string]) }, { name: "insured_value", label: "Insured value", required: true }]}
        submit={(v) => { if (!DEC.test((v.insured_value ?? "").trim())) throw new Error("The insured value must be a number."); return act({ id: p!.id, action: "cover", body: { asset: v.asset, insured_value: (v.insured_value ?? "").trim() } }).unwrap(); }} />
      <ActionDialog key={`rn${p?.id}`} title="Renew policy" open={dlg?.kind === "renew"} onClose={() => setDlg(null)} cta="Renew" fields={[{ name: "policy_number", label: "New policy number", required: true }, { name: "start_on", label: "Starts", type: "date", required: true }, { name: "end_on", label: "Ends", type: "date", required: true }, { name: "premium", label: "Premium", required: true }]}
        submit={(v) => { if ((v.end_on ?? "") < (v.start_on ?? "")) throw new Error("The policy must end on or after the day it starts."); if (!DEC.test((v.premium ?? "").trim())) throw new Error("Premium must be a number."); return act({ id: p!.id, action: "renew", body: { policy_number: (v.policy_number ?? "").trim(), start_on: v.start_on, end_on: v.end_on, premium: (v.premium ?? "").trim() } }).unwrap(); }} />
      <Modal title="File an insurance claim" open={dlg?.kind === "claim"} onClose={() => setDlg(null)}>
        <FormField label="Insured asset" htmlFor="cl-asset"><select id="cl-asset" className={inputClass} value={cf.asset} onChange={(e) => setCf({ ...cf, asset: e.target.value })}><option value="">Choose…</option>{p?.assets.map((a) => <option key={a.asset} value={a.asset}>{name(a.asset)}</option>)}</select></FormField>
        <FormField label="Incident date" htmlFor="cl-date"><input id="cl-date" type="date" className={inputClass} value={cf.incident_date} onChange={(e) => setCf({ ...cf, incident_date: e.target.value })} /></FormField>
        <FormField label="What happened" htmlFor="cl-desc"><textarea id="cl-desc" className={inputClass} value={cf.description} onChange={(e) => setCf({ ...cf, description: e.target.value })} /></FormField>
        <FormField label="Amount claimed" htmlFor="cl-amt"><input id="cl-amt" className={inputClass} value={cf.amount} onChange={(e) => setCf({ ...cf, amount: e.target.value })} /></FormField>
        {claimErr && <p role="alert" className="mb-3 text-sm text-red-700">{claimErr}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button onClick={() => void submitClaim()}>File claim</Button></div>
      </Modal>
    </Card>
  );
}

function Claims() {
  const { can } = useAccess();
  const manage = can("assets.insurance.manage");
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useListAssetClaimsQuery(status || undefined);
  const [decide] = useDecideAssetClaimMutation();
  const [settling, setSettling] = useState<{ kind: string; id: string; claimed: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (kind: string, id: string, action: "accept" | "reject") => { setErr(null); try { await decide({ kind, id, action }).unwrap(); } catch (e) { setErr(failure(e)); } };
  return (
    <Card title="Warranty and insurance claims">
      <label className="mb-2 block text-sm">Status <select aria-label="Claim status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["FILED", "ACCEPTED", "REJECTED", "SETTLED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></label>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No claims" /> : (
        <ul>{data.results.map((c) => (
          <li key={`${c.kind}${c.id}`} className="border-b border-slate-200 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2"><Badge tone="slate">{pretty(c.kind.toUpperCase())}</Badge><span className="font-medium">{c.asset}</span><span className="text-slate-500">{c.source} · {c.date}</span><Badge tone={c.status === "SETTLED" || c.status === "ACCEPTED" ? "green" : c.status === "REJECTED" ? "red" : "amber"}>{pretty(c.status)}</Badge></div>
            <p>{c.description}</p>
            <p className="text-slate-600">Claimed {formatMoney(c.amount_claimed)} · recovered {formatMoney(c.amount_recovered)}</p>
            {manage && c.status === "FILED" && <div className="mt-1 flex gap-2"><Button onClick={() => void act(c.kind, c.id, "accept")}>{`Accept ${c.asset} claim`}</Button><Button variant="secondary" onClick={() => void act(c.kind, c.id, "reject")}>{`Reject ${c.asset} claim`}</Button></div>}
            {manage && c.status === "ACCEPTED" && <div className="mt-1"><Button onClick={() => setSettling({ kind: c.kind, id: c.id, claimed: c.amount_claimed })}>{`Settle ${c.asset} claim`}</Button></div>}
          </li>))}</ul>
      )}
      <ActionDialog key={settling?.id} title="Settle claim" open={!!settling} onClose={() => setSettling(null)} cta="Record settlement" fields={[{ name: "amount", label: "Amount recovered", required: true }]}
        submit={(v) => { const a = (v.amount ?? "").trim(); if (!DEC.test(a)) throw new Error("The amount recovered must be a number."); return decide({ kind: settling!.kind, id: settling!.id, action: "settle", amount_recovered: a }).unwrap(); }} />
    </Card>
  );
}

function Watch() {
  const [days, setDays] = useState(30);
  const unins = useGetUninsuredAssetsQuery();
  const exp = useGetExpiringCoverageQuery(days);
  return (
    <div className="grid gap-4">
      <Card title="Assets that need insurance but have none in force">
        {unins.isLoading ? <Spinner /> : unins.error ? <ErrorState error={unins.error} onRetry={unins.refetch} /> : !unins.data?.length ? <EmptyState title="Every asset that needs cover has it" /> : (
          <ul className="text-sm">{unins.data.map((r) => <li key={r.asset} className="border-b border-slate-100 py-1">{r.asset} {r.name} ({r.category}) — {formatMoney(r.gross_value)}</li>)}</ul>
        )}
      </Card>
      <Card title="Expiring soon">
        <label className="mb-2 block text-sm">Look ahead <select aria-label="Expiry window" className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
        {exp.isLoading ? <Spinner /> : exp.error ? <ErrorState error={exp.error} onRetry={exp.refetch} /> : !exp.data || (!exp.data.warranties.length && !exp.data.policies.length) ? <EmptyState title="Nothing expires in this window" /> : (
          <ul className="text-sm">
            {exp.data.warranties.map((w) => <li key={`w${w.asset}${w.end_on}`} className="border-b border-slate-100 py-1">Warranty on {w.asset} ({w.provider}) ends {w.end_on}</li>)}
            {exp.data.policies.map((p) => <li key={`p${p.policy}`} className="border-b border-slate-100 py-1">Policy {p.policy} ({p.insurer}) ends {p.end_on} {p.renewed ? <Badge tone="green">Renewed</Badge> : <Badge tone="amber">Not renewed</Badge>}</li>)}
          </ul>
        )}
      </Card>
    </div>
  );
}

const TABS = [["policies", "Policies"], ["claims", "Claims"], ["watch", "Watch list"]] as const;

export function CoveragePage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("policies");
  return (
    <>
      <PageHeader title="Insurance and warranties" description="Policies, claims, and what is uninsured or about to expire." />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2 border-b border-slate-200">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-slate-900 font-semibold" : "text-slate-600"}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "policies" && <Policies />}
      {tab === "claims" && <Claims />}
      {tab === "watch" && <Watch />}
    </>
  );
}

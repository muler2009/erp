import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "react-router";

import { useCreateCampaignMutation, useListCampaignsOverviewQuery, useListCampaignsQuery, useListCurrenciesQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Campaign } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

export const CAMPAIGN_CHANNELS: [string, string][] = [["EMAIL", "Email"], ["PHONE", "Phone"], ["SMS", "SMS"], ["EVENT", "Event"], ["SOCIAL", "Social"], ["OTHER", "Other"]];
export const LEAD_CRITERIA = ["source", "industry", "qualification", "priority", "status"];
export const CONTACT_CRITERIA = ["industry", "segment", "lifecycle_stage", "classification", "customer_type"];
export const statusTone = (s: string) => (s === "ACTIVE" ? "green" : s === "CANCELLED" ? "red" : s === "COMPLETED" ? "slate" : "amber");

/** Builds the audience object the API expects; throws a readable message for blank or repeated criteria. */
export function buildAudience(kind: string, rows: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = { kind };
  for (const r of rows) {
    if (!r.key && !r.value.trim()) continue;
    if (!r.key || !r.value.trim()) throw new Error("Each audience rule needs both a field and a value.");
    if (r.key in out) throw new Error(`The audience rule "${r.key}" is used twice.`);
    out[r.key] = r.value.trim();
  }
  return out;
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const currencies = useListCurrenciesQuery({ active: true });
  const [create, { isLoading }] = useCreateCampaignMutation();
  const [f, setF] = useState({ name: "", channel: "EMAIL", currency: "", start_date: "", end_date: "", budget: "0", objective: "" });
  const [kind, setKind] = useState("leads");
  const [rows, setRows] = useState([{ key: "", value: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const keys = kind === "leads" ? LEAD_CRITERIA : CONTACT_CRITERIA;
  const submit = async () => {
    if (!f.name.trim() || !f.currency || !f.start_date || !f.end_date) { setErr("Name, currency, start and end dates are required."); return; }
    if (f.end_date < f.start_date) { setErr("The end date cannot be before the start date."); return; }
    if (!/^\d+(\.\d{1,2})?$/.test(f.budget.trim())) { setErr("The budget must be an amount with at most 2 decimals."); return; }
    try {
      const audience = buildAudience(kind, rows);
      await create({ ...f, name: f.name.trim(), budget: f.budget.trim(), audience }).unwrap();
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  const input = (name: keyof typeof f, label: string, type = "text") => (
    <FormField label={label} htmlFor={`cm-${name}`}><input id={`cm-${name}`} type={type} className={inputClass} value={f[name]} onChange={(e) => setF({ ...f, [name]: e.target.value })} /></FormField>
  );
  return (
    <Modal title="New campaign" open onClose={onClose}>
      {input("name", "Name")}
      <FormField label="Channel" htmlFor="cm-channel"><select id="cm-channel" className={inputClass} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{CAMPAIGN_CHANNELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
      <FormField label="Currency" htmlFor="cm-currency"><select id="cm-currency" className={inputClass} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option value="">Choose…</option>{(currencies.data?.results ?? []).map((c) => <option key={c.code} value={c.code}>{c.code} {c.name}</option>)}</select></FormField>
      {input("start_date", "Starts", "date")}{input("end_date", "Ends", "date")}{input("budget", "Budget")}{input("objective", "Objective")}
      <fieldset className="mb-3 rounded border border-slate-200 p-3">
        <legend className="px-1 text-sm font-medium">Who to reach</legend>
        <FormField label="Audience" htmlFor="cm-kind"><select id="cm-kind" className={inputClass} value={kind} onChange={(e) => { setKind(e.target.value); setRows([{ key: "", value: "" }]); }}><option value="leads">Leads</option><option value="contacts">Customer contacts</option></select></FormField>
        {rows.map((r, i) => (
          <div key={i} className="mb-2 flex gap-2">
            <select aria-label={`Rule ${i + 1} field`} className={inputClass} value={r.key} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}><option value="">Field…</option>{keys.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}</select>
            <input aria-label={`Rule ${i + 1} value`} className={inputClass} value={r.value} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          </div>
        ))}
        <Button variant="secondary" onClick={() => setRows([...rows, { key: "", value: "" }])}>Add rule</Button>
        <p className="mt-2 text-xs text-slate-500">People without consent for the channel are listed as excluded, never contacted.</p>
      </fieldset>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void submit()}>Create campaign</Button></div>
    </Modal>
  );
}

export function CampaignsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error, refetch } = useListCampaignsQuery({ cursor });
  const overview = useListCampaignsOverviewQuery();
  const rep = (c: Campaign) => overview.data?.find((r) => r.campaign === c.number);
  const columns: ColumnDef<Campaign>[] = [
    { header: "Number", accessorKey: "number" },
    { header: "Campaign", cell: ({ row }) => <Link className="text-indigo-700 hover:underline" to={`/app/crm/campaigns/${row.original.id}`}>{row.original.name}</Link> },
    { header: "Channel", cell: ({ row }) => CAMPAIGN_CHANNELS.find(([k]) => k === row.original.channel)?.[1] ?? row.original.channel },
    { header: "Period", cell: ({ row }) => `${row.original.start_date} to ${row.original.end_date}` },
    { header: "Status", cell: ({ row }) => <Badge tone={statusTone(row.original.status)}>{row.original.status.toLowerCase()}</Badge> },
    { header: "Budget", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.budget)} {row.original.currency}</span> },
    { header: "Spent", cell: ({ row }) => <span className="block text-right">{rep(row.original) ? formatMoney(rep(row.original)!.spent) : "…"}</span> },
    { header: "Leads", cell: ({ row }) => rep(row.original)?.leads_generated ?? "…" },
    { header: "ROI", cell: ({ row }) => (rep(row.original)?.roi_percent ? `${rep(row.original)!.roi_percent}%` : "–") },
  ];
  return (
    <>
      <PageHeader title="Campaigns" description="Marketing campaigns, who they reach, what they cost and what they bring in." actions={<Button onClick={() => setCreating(true)}>New campaign</Button>} />
      <DataTable caption="Campaigns" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No campaigns yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </>
  );
}

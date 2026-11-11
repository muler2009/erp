import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useConvertLeadMutation, useCreateLeadMutation, useListLeadsQuery, useSetLeadStatusMutation } from "../../shared/api/endpoints";
import { errorMessage, fieldErrors } from "../../shared/api/errors";
import type { Lead } from "../../shared/api/types";
import { parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

export const leadSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  company: z.string().trim().max(200),
  email: z.union([z.literal(""), z.string().trim().email("Enter a valid email address")]),
  phone: z.string().trim().max(50),
  source: z.string().trim().max(100),
});
type LeadForm = z.infer<typeof leadSchema>;

/** Moves a lead may make from each status; mirrors the server's rules so only valid buttons show (the server enforces them). */
export const LEAD_FLOW: Record<string, string[]> = { NEW: ["CONTACTED", "QUALIFIED", "DISQUALIFIED"], CONTACTED: ["QUALIFIED", "DISQUALIFIED"], QUALIFIED: ["DISQUALIFIED"] };
const tone = (s: string) => (s === "QUALIFIED" || s === "CONVERTED" ? "green" : s === "DISQUALIFIED" ? "red" : s === "NEW" ? "amber" : "slate");
const pretty = (s: string) => s.toLowerCase();

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, state] = useCreateLeadMutation();
  const { register, handleSubmit, setError, reset, formState } = useForm<LeadForm>({ resolver: zodResolver(leadSchema), defaultValues: { name: "", company: "", email: "", phone: "", source: "" } });
  const close = () => { reset(); onClose(); };
  const submit = handleSubmit(async (body) => {
    try { await create(body).unwrap(); close(); } catch (e) {
      const fe = fieldErrors(e);
      const known = Object.keys(fe).filter((k) => k in body);
      known.forEach((k) => setError(k as keyof LeadForm, { message: fe[k] }));
      if (known.length === 0) setError("root", { message: errorMessage(e) });
    }
  });
  const f = (n: keyof LeadForm, label: string, type = "text") => (
    <FormField label={label} htmlFor={`ld-${n}`} error={formState.errors[n]?.message}><input id={`ld-${n}`} type={type} className={inputClass} {...register(n)} /></FormField>
  );
  return (
    <Modal title="New lead" open={open} onClose={close}>
      <form onSubmit={submit} noValidate>
        {f("name", "Contact name")}{f("company", "Company")}{f("email", "Email", "email")}{f("phone", "Phone")}{f("source", "Source")}
        {formState.errors.root && <p role="alert" className="mb-3 text-sm text-red-700">{formState.errors.root.message}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={state.isLoading}>Create lead</Button></div>
      </form>
    </Modal>
  );
}

type Target = { lead: Lead; mode: "DISQUALIFIED" | "convert" } | null;

function ActionDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const [setStatus, s1] = useSetLeadStatusMutation();
  const [convert, s2] = useConvertLeadMutation();
  const [reason, setReason] = useState("");
  const [oppName, setOppName] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const close = () => { setReason(""); setOppName(""); setAmount(""); setCurrency(""); setErr(null); onClose(); };
  const go = async () => {
    setErr(null);
    try {
      if (target!.mode === "DISQUALIFIED") {
        if (!reason.trim()) { setErr("A reason is required to disqualify a lead."); return; }
        await setStatus({ id: target!.lead.id, status: "DISQUALIFIED", reason: reason.trim() }).unwrap();
      } else {
        const a = amount.trim() === "" ? "0" : amount.trim();
        const n = parseMoney(a);
        if (n === null || n < 0n) { setErr("Enter a valid amount."); return; }
        if (!/^[A-Za-z]{3}$/.test(currency.trim())) { setErr("Enter the 3-letter currency code, e.g. USD."); return; }
        await convert({ id: target!.lead.id, opportunity_name: oppName.trim() || `${target!.lead.company || target!.lead.name} opportunity`, amount: a, currency: currency.trim().toUpperCase() }).unwrap();
      }
      close();
    } catch (e) { setErr(errorMessage(e)); }
  };
  const dq = target?.mode === "DISQUALIFIED";
  return (
    <Modal title={target ? (dq ? `Disqualify ${target.lead.name}` : `Convert ${target.lead.name}`) : ""} open={!!target} onClose={close}>
      {dq ? (
        <FormField label="Reason" htmlFor="ld-reason"><textarea id="ld-reason" rows={3} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
      ) : (
        <>
          <FormField label="Opportunity name" htmlFor="cv-name"><input id="cv-name" className={inputClass} value={oppName} onChange={(e) => setOppName(e.target.value)} /></FormField>
          <FormField label="Expected amount" htmlFor="cv-amount"><input id="cv-amount" inputMode="decimal" className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} /></FormField>
          <FormField label="Currency" htmlFor="cv-cur"><input id="cv-cur" className={inputClass} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} /></FormField>
        </>
      )}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button variant={dq ? "danger" : "primary"} loading={s1.isLoading || s2.isLoading} onClick={() => void go()}>{dq ? "Disqualify" : "Convert to opportunity"}</Button></div>
    </Modal>
  );
}

export function LeadsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useListLeadsQuery({ cursor, status });
  const [setLeadStatus] = useSetLeadStatusMutation();
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<Target>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { can } = useAccess();
  const manage = can("crm.manage");
  const columns = useMemo<ColumnDef<Lead>[]>(() => {
    const cols: ColumnDef<Lead>[] = [
      { header: "Name", accessorKey: "name" }, { header: "Company", accessorKey: "company" }, { header: "Email", accessorKey: "email" }, { header: "Source", accessorKey: "source" },
      { header: "Status", cell: ({ row }) => <Badge tone={tone(row.original.status)}>{pretty(row.original.status)}</Badge> },
    ];
    if (manage) cols.push({
      id: "actions", header: "Actions",
      cell: ({ row }) => {
        const l = row.original;
        const next = LEAD_FLOW[l.status] ?? [];
        const move = async (to: string) => { setActionError(null); try { await setLeadStatus({ id: l.id, status: to, reason: "" }).unwrap(); } catch (e) { setActionError(errorMessage(e)); } };
        return (
          <div className="flex flex-wrap gap-1">
            {next.includes("CONTACTED") && <Button variant="secondary" aria-label={`Mark ${l.name} contacted`} onClick={() => void move("CONTACTED")}>Contacted</Button>}
            {next.includes("QUALIFIED") && <Button variant="secondary" aria-label={`Qualify ${l.name}`} onClick={() => void move("QUALIFIED")}>Qualify</Button>}
            {l.status === "QUALIFIED" && <Button aria-label={`Convert ${l.name}`} onClick={() => setTarget({ lead: l, mode: "convert" })}>Convert</Button>}
            {next.includes("DISQUALIFIED") && <Button variant="secondary" aria-label={`Disqualify ${l.name}`} onClick={() => setTarget({ lead: l, mode: "DISQUALIFIED" })}>Disqualify</Button>}
          </div>
        );
      },
    });
    return cols;
  }, [manage, setLeadStatus]);
  return (
    <>
      <PageHeader title="Leads" actions={manage ? <Button onClick={() => setCreating(true)}>New lead</Button> : undefined} />
      <label className="mb-3 flex items-center gap-2 text-sm">Status
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}>
          <option value="">All</option>{["NEW", "CONTACTED", "QUALIFIED", "DISQUALIFIED", "CONVERTED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
        </select>
      </label>
      {actionError && <p role="alert" className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-800">{actionError}</p>}
      <DataTable caption="Leads" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No leads" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
      <ActionDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}

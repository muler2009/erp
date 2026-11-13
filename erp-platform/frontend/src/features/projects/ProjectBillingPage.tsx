import { useState } from "react";
import { useParams } from "react-router";

import { useGetBillingPreviewQuery, useGetProjectBillingQuery, useGetProjectTimeQuery, useInvoiceProjectMutation, useListProjectTasksQuery } from "../../shared/api/endpoints";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { ProjectNav } from "./ProjectFinancePage";

export function validatePeriod(from: string, to: string): string | null {
  if (!from || !to) return "Choose both dates.";
  return to < from ? "The end date is before the start date." : null;
}

export function validateInvoice(f: { kind: string; invoice_date: string; amount: string; task: string; period_start: string; period_end: string }): string | null {
  if (!["MILESTONE", "TIME", "ADVANCE"].includes(f.kind)) return "Choose what to invoice.";
  if (!f.invoice_date) return "Enter the invoice date.";
  if (f.kind === "MILESTONE" && !f.task) return "Choose the milestone to bill.";
  if (f.kind === "ADVANCE") { const a = parseMoney(f.amount); if (a === null || a <= 0n) return "Enter an advance amount greater than zero."; }
  if (f.kind === "TIME") return validatePeriod(f.period_start, f.period_end);
  return null;
}

export function ProjectBillingPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const manage = can("projects.billing.manage");
  const [range, setRange] = useState({ from: "", to: "" });
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [rangeErr, setRangeErr] = useState<string | null>(null);
  const time = useGetProjectTimeQuery({ id, ...(applied ?? { from: "", to: "" }) }, { skip: !applied });
  const preview = useGetBillingPreviewQuery({ id, ...(applied ?? { from: "", to: "" }) }, { skip: !applied || !manage });
  const billing = useGetProjectBillingQuery(id);
  const tasks = useListProjectTasksQuery(id, { skip: !manage });
  const [invoice] = useInvoiceProjectMutation();
  const [dlg, setDlg] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const apply = () => { const p = validatePeriod(range.from, range.to); setRangeErr(p); if (!p) setApplied(range); };
  return (
    <>
      <PageHeader title="Time and billing" description="Approved hours, what they would bill, and project invoices." actions={manage ? <Button onClick={() => setDlg(true)}>Create invoice</Button> : undefined} />
      <ProjectNav id={id} current="billing" />
      {done && <p role="status" className="mb-3 text-sm text-green-700">{done}</p>}
      <Card title="Period">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="From" htmlFor="pb-from"><input id="pb-from" type="date" className={inputClass} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></FormField>
          <FormField label="To" htmlFor="pb-to"><input id="pb-to" type="date" className={inputClass} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></FormField>
          <div className="mb-3"><Button onClick={apply}>Show</Button></div>
        </div>
        {rangeErr && <p role="alert" className="text-sm text-red-700">{rangeErr}</p>}
      </Card>
      {applied && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Card title="Approved hours (cost)">
            {time.isLoading ? <Spinner /> : time.error ? <ErrorState error={time.error} onRetry={time.refetch} /> : time.data && (
              <><p className="text-sm">{time.data.hours} hours · cost {formatMoney(time.data.cost)}{Number(time.data.unmatched_hours) > 0 && ` · ${time.data.unmatched_hours} hours from people not on the team`}</p>
                <ul className="mt-1 text-sm">{time.data.rows.map((r) => <li key={r.user_id}>User {r.user_id.slice(0, 8)}: {r.hours} h × {formatMoney(r.rate)} = {formatMoney(r.cost)}</li>)}</ul></>
            )}
          </Card>
          {manage && <Card title="Time billing preview">
            {preview.isLoading ? <Spinner /> : preview.error ? <ErrorState error={preview.error} onRetry={preview.refetch} /> : preview.data && (
              <><p className="text-sm">Would bill <strong>{formatMoney(preview.data.amount)}</strong></p>
                <ul className="mt-1 text-sm">{preview.data.rows.map((r) => <li key={r.user_id}>User {r.user_id.slice(0, 8)}: {r.hours} h × {formatMoney(r.rate)} = {formatMoney(r.amount)}</li>)}</ul></>
            )}
          </Card>}
        </div>
      )}
      <div className="mt-4"><Card title="Invoices raised">
        {billing.isLoading ? <Spinner /> : billing.error ? <ErrorState error={billing.error} onRetry={billing.refetch} /> : (
          <><p className="text-sm">Billed {formatMoney(billing.data!.billed)} · recognised {formatMoney(billing.data!.recognized)} · paid {formatMoney(billing.data!.paid)}{billing.data!.remaining !== null && ` · remaining ${formatMoney(billing.data!.remaining)}`}</p>
            <ul className="mt-1 text-sm">{billing.data!.rows.map((r) => <li key={r.invoice_id}>{pretty(r.kind)} {formatMoney(r.amount)} — {pretty(r.invoice_status)}{r.description ? `: ${r.description}` : ""}</li>)}</ul></>
        )}
      </Card></div>
      <ActionDialog title="Create project invoice" open={dlg} onClose={() => setDlg(false)} cta="Create invoice"
        fields={[{ name: "kind", label: "Invoice for", required: true, options: [["MILESTONE", "A reached milestone"], ["TIME", "Approved time"], ["ADVANCE", "An advance"]] }, { name: "invoice_date", label: "Invoice date", type: "date", required: true }, { name: "task", label: "Milestone (milestone billing)", options: (tasks.data?.results ?? []).filter((t) => t.milestone).map((t) => [t.id, `${t.wbs} ${t.name}`] as [string, string]) }, { name: "amount", label: "Amount (advance)" }, { name: "period_start", label: "Period start (time billing)", type: "date" }, { name: "period_end", label: "Period end (time billing)", type: "date" }, { name: "description", label: "Description" }]}
        submit={async (v) => {
          const f = { kind: v.kind ?? "", invoice_date: v.invoice_date ?? "", amount: (v.amount ?? "").trim(), task: v.task ?? "", period_start: v.period_start ?? "", period_end: v.period_end ?? "" };
          const p = validateInvoice(f); if (p) throw new Error(p);
          const r = await invoice({ id, kind: f.kind, invoice_date: f.invoice_date, description: v.description ?? "", ...(f.kind === "ADVANCE" ? { amount: f.amount } : {}), ...(f.kind === "MILESTONE" ? { task: f.task } : {}), ...(f.kind === "TIME" ? { period_start: f.period_start, period_end: f.period_end } : {}) }).unwrap();
          setDone(`Invoice created for ${formatMoney(r.amount)}.`);
        }} />
    </>
  );
}

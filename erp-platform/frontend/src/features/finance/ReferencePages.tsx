import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useCreatePartnerMutation, useCreateTaxRateMutation, useListAccountsQuery, useListPartnersQuery, useListTaxRatesQuery } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const partnerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  is_customer: z.boolean(),
  is_supplier: z.boolean(),
  tax_id: z.string().trim().max(40),
}).refine((v) => v.is_customer || v.is_supplier, { path: ["is_customer"], message: "Choose customer, supplier or both" });
type PartnerForm = z.infer<typeof partnerSchema>;

export const taxRateSchema = z.object({
  code: z.string().trim().min(1, "Code is required").max(20),
  name: z.string().trim().min(1, "Name is required").max(100),
  kind: z.enum(["SALES", "PURCHASE"]),
  rate: z.string().trim().refine((v) => { const n = parseMoney(v); return n !== null && n >= 0n && n <= 1000000n; }, "Rate must be between 0 and 100, up to 4 decimals"),
  account: z.string().min(1, "Choose the tax account"),
});
type TaxForm = z.infer<typeof taxRateSchema>;

function PartnerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, state] = useCreatePartnerMutation();
  const { register, handleSubmit, reset, setError, formState } = useForm<PartnerForm>({ resolver: zodResolver(partnerSchema), defaultValues: { name: "", is_customer: true, is_supplier: false, tax_id: "" } });
  const close = () => { reset(); onClose(); };
  const submit = handleSubmit(async (v) => {
    try { await create(v).unwrap(); close(); } catch (e) { setError("root", { message: errorMessage(e) }); }
  });
  return (
    <Modal title="New partner" open={open} onClose={close}>
      <form onSubmit={submit} noValidate>
        <FormField label="Name" htmlFor="pt-name" error={formState.errors.name?.message}><input id="pt-name" className={inputClass} {...register("name")} /></FormField>
        <fieldset className="mb-3"><legend className="text-sm font-medium">Role</legend>
          <label className="mr-4 text-sm"><input type="checkbox" {...register("is_customer")} /> Customer</label>
          <label className="text-sm"><input type="checkbox" {...register("is_supplier")} /> Supplier</label>
          {formState.errors.is_customer && <p role="alert" className="text-xs text-red-700">{formState.errors.is_customer.message}</p>}
        </fieldset>
        <FormField label="Tax ID (optional)" htmlFor="pt-tax"><input id="pt-tax" className={inputClass} {...register("tax_id")} /></FormField>
        {formState.errors.root && <p role="alert" className="mb-3 text-sm text-red-700">{formState.errors.root.message}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={state.isLoading}>Save partner</Button></div>
      </form>
    </Modal>
  );
}

export function PartnersPage() {
  const { data, isLoading, error, refetch } = useListPartnersQuery();
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  return (
    <>
      <PageHeader title="Partners" description="Customers and suppliers used on invoices and payments." actions={can("finance.invoice.create") ? <Button onClick={() => setCreating(true)}>New partner</Button> : undefined} />
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && (data.results.length === 0 ? <EmptyState title="No partners yet" /> : (
        <Card>
          <table className="min-w-full text-sm">
            <caption className="sr-only">Partners</caption>
            <thead><tr><th scope="col" className="px-2 py-1 text-left">Name</th><th scope="col" className="px-2 py-1 text-left">Role</th><th scope="col" className="px-2 py-1 text-left">Tax ID</th></tr></thead>
            <tbody>{data.results.map((p) => <tr key={p.id} className="border-t border-slate-100"><td className="px-2 py-1">{p.name}</td><td className="px-2 py-1">{[p.is_customer && "Customer", p.is_supplier && "Supplier"].filter(Boolean).join(" · ")}</td><td className="px-2 py-1">{p.tax_id}</td></tr>)}</tbody>
          </table>
          {data.next && <p className="mt-2 text-xs text-slate-500">Showing the first page only.</p>}
        </Card>
      ))}
      <PartnerDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function TaxDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useListAccountsQuery(undefined, { skip: !open });
  const [create, state] = useCreateTaxRateMutation();
  const { register, handleSubmit, reset, setError, watch, formState } = useForm<TaxForm>({ resolver: zodResolver(taxRateSchema), defaultValues: { code: "", name: "", kind: "SALES", rate: "", account: "" } });
  const kind = watch("kind");
  // Sales tax posts to a liability account, purchase tax to an asset account; the server enforces it too.
  const options = accounts.data?.results.filter((a) => a.is_postable && a.is_active && a.type === (kind === "SALES" ? "LIABILITY" : "ASSET")) ?? [];
  const close = () => { reset(); onClose(); };
  const submit = handleSubmit(async (v) => {
    try { await create(v).unwrap(); close(); } catch (e) { setError("root", { message: errorMessage(e) }); }
  });
  return (
    <Modal title="New tax rate" open={open} onClose={close}>
      <form onSubmit={submit} noValidate>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Code" htmlFor="tx-code" error={formState.errors.code?.message}><input id="tx-code" className={inputClass} {...register("code")} /></FormField>
          <FormField label="Name" htmlFor="tx-name" error={formState.errors.name?.message}><input id="tx-name" className={inputClass} {...register("name")} /></FormField>
          <FormField label="Applies to" htmlFor="tx-kind"><select id="tx-kind" className={inputClass} {...register("kind")}><option value="SALES">Sales</option><option value="PURCHASE">Purchases</option></select></FormField>
          <FormField label="Rate (%)" htmlFor="tx-rate" error={formState.errors.rate?.message}><input id="tx-rate" inputMode="decimal" className={inputClass} {...register("rate")} /></FormField>
        </div>
        <FormField label="Tax account" htmlFor="tx-acct" error={formState.errors.account?.message}>
          <select id="tx-acct" className={inputClass} {...register("account")}><option value="">Choose…</option>{options.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>
        </FormField>
        {formState.errors.root && <p role="alert" className="mb-3 text-sm text-red-700">{formState.errors.root.message}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={state.isLoading}>Save tax rate</Button></div>
      </form>
    </Modal>
  );
}

export function TaxRatesPage() {
  const { data, isLoading, error, refetch } = useListTaxRatesQuery();
  const [creating, setCreating] = useState(false);
  const { can } = useAccess();
  return (
    <>
      <PageHeader title="Tax rates" description="Rates applied to invoice lines." actions={can("finance.accounts.manage") ? <Button onClick={() => setCreating(true)}>New tax rate</Button> : undefined} />
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && (data.results.length === 0 ? <EmptyState title="No tax rates yet" /> : (
        <Card>
          <table className="min-w-full text-sm">
            <caption className="sr-only">Tax rates</caption>
            <thead><tr><th scope="col" className="px-2 py-1 text-left">Code</th><th scope="col" className="px-2 py-1 text-left">Name</th><th scope="col" className="px-2 py-1 text-left">Applies to</th><th scope="col" className="px-2 py-1 text-right">Rate</th><th scope="col" className="px-2 py-1 text-left">Status</th></tr></thead>
            <tbody>{data.results.map((t) => <tr key={t.id} className="border-t border-slate-100"><td className="px-2 py-1">{t.code}</td><td className="px-2 py-1">{t.name}</td><td className="px-2 py-1">{t.kind === "SALES" ? "Sales" : "Purchases"}</td><td className="px-2 py-1 text-right">{formatMoney(t.rate)}%</td><td className="px-2 py-1">{t.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td></tr>)}</tbody>
          </table>
          {data.next && <p className="mt-2 text-xs text-slate-500">Showing the first page only.</p>}
        </Card>
      ))}
      <TaxDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

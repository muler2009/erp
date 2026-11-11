import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { useCreateInvoiceMutation, useUpdateInvoiceMutation, useListAccountsQuery, useListPartnersQuery, useListTaxRatesQuery } from "../../shared/api/endpoints";
import { errorMessage, fieldErrors } from "../../shared/api/errors";
import { formatMoney, multiplyMoney, parseMoney, percentOf } from "../../shared/lib/money";
import type { Invoice } from "../../shared/api/types";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";

const KINDS = [
  { value: "CUSTOMER_INVOICE", label: "Customer invoice", tax: "SALES", partner: "is_customer" },
  { value: "SUPPLIER_INVOICE", label: "Supplier invoice", tax: "PURCHASE", partner: "is_supplier" },
  { value: "CUSTOMER_CREDIT_NOTE", label: "Customer credit note", tax: "SALES", partner: "is_customer" },
  { value: "SUPPLIER_CREDIT_NOTE", label: "Supplier credit note", tax: "PURCHASE", partner: "is_supplier" },
] as const;
const CREDIT_OF = { CUSTOMER_INVOICE: "CUSTOMER_CREDIT_NOTE", SUPPLIER_INVOICE: "SUPPLIER_CREDIT_NOTE" } as const;

const pos = (what: string, zero: boolean) => z.string().trim().refine((v) => { const n = parseMoney(v); return n !== null && (zero ? n >= 0n : n > 0n); }, `${what} must be ${zero ? "0 or more" : "more than 0"}, up to 4 decimals`);

export const invoiceSchema = z
  .object({
    kind: z.enum(["CUSTOMER_INVOICE", "SUPPLIER_INVOICE", "CUSTOMER_CREDIT_NOTE", "SUPPLIER_CREDIT_NOTE"]),
    partner: z.string().min(1, "Choose a customer or supplier"),
    invoice_date: z.string().min(1, "Invoice date is required"),
    due_date: z.string(),
    currency: z.union([z.literal(""), z.string().trim().regex(/^[A-Za-z]{3}$/, "Use a 3-letter currency code")]),
    supplier_ref: z.string().trim().max(60),
    lines: z.array(z.object({ description: z.string().trim().min(1, "Describe the line").max(300), quantity: pos("Quantity", false), unit_price: pos("Price", true), account: z.string().min(1, "Choose an account"), tax_rate: z.string() })).min(1, "Add at least one line"),
  })
  .superRefine((v, ctx) => {
    if (v.due_date && v.due_date < v.invoice_date) ctx.addIssue({ code: "custom", path: ["due_date"], message: "Due date cannot be before the invoice date" });
  });
type Form = z.infer<typeof invoiceSchema>;

/**
 * With `creditFor` the dialog issues a credit note against that posted invoice: kind, partner and currency are fixed to the original's.
 * With `editing` it edits that DRAFT document (dates, reference and lines; the server checks the version so a concurrent change is refused).
 */
export function NewInvoiceDialog({ open, onClose, creditFor, editing }: { open: boolean; onClose: () => void; creditFor?: Invoice; editing?: Invoice }) {
  const fixed = creditFor ?? editing;
  const partners = useListPartnersQuery(undefined, { skip: !open });
  const taxes = useListTaxRatesQuery(undefined, { skip: !open });
  const accounts = useListAccountsQuery(undefined, { skip: !open });
  const [create, createState] = useCreateInvoiceMutation();
  const [update, updateState] = useUpdateInvoiceMutation();
  const state = editing ? updateState : createState;
  const blank = { description: "", quantity: "1", unit_price: "0", account: "", tax_rate: "" };
  const { register, control, handleSubmit, setError, reset, formState } = useForm<Form>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: creditFor
      ? { kind: CREDIT_OF[creditFor.kind as keyof typeof CREDIT_OF], partner: creditFor.partner.id, invoice_date: new Date().toISOString().slice(0, 10), due_date: "", currency: creditFor.currency, supplier_ref: "", lines: [blank] }
      : { kind: "CUSTOMER_INVOICE", partner: "", invoice_date: new Date().toISOString().slice(0, 10), due_date: "", currency: "", supplier_ref: "", lines: [blank] },
  });
  // Editing: the stored lines carry the account *code*, so fill the form once the chart of accounts has loaded.
  useEffect(() => {
    if (!editing || !accounts.data) return;
    const byCode = new Map(accounts.data.results.map((a) => [a.code, a.id]));
    reset({
      kind: editing.kind as Form["kind"], partner: editing.partner.id, invoice_date: editing.invoice_date, due_date: editing.due_date ?? "", currency: editing.currency, supplier_ref: editing.supplier_ref ?? "",
      lines: (editing.lines ?? []).map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, account: byCode.get(l.account) ?? "", tax_rate: l.tax_rate ?? "" })),
    });
  }, [editing, accounts.data, taxes.data, reset]);
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const kind = useWatch({ control, name: "kind" });
  const lines = useWatch({ control, name: "lines" });
  const meta = KINDS.find((k) => k.value === kind)!;
  const partnerOptions = partners.data?.results.filter((p) => p[meta.partner]) ?? [];
  const taxOptions = taxes.data?.results.filter((t) => t.kind === meta.tax && t.is_active) ?? [];
  const accountOptions = accounts.data?.results.filter((a) => a.is_postable && a.is_active) ?? [];
  const rateOf = (id: string) => taxOptions.find((t) => t.id === id)?.rate ?? "0";
  let net = 0n, tax = 0n;
  for (const l of lines) { const t = multiplyMoney(l.quantity, l.unit_price); net += t; tax += percentOf(t, rateOf(l.tax_rate)); }

  const close = () => { reset(); onClose(); };
  const submit = handleSubmit(async (v) => {
    const payloadLines = v.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, account: l.account, tax_rate: l.tax_rate || null }));
    try {
      if (editing) {
        await update({ id: editing.id, version: editing.version ?? 0, invoice_date: v.invoice_date, due_date: v.due_date || null, supplier_ref: v.supplier_ref, lines: payloadLines }).unwrap();
        close();
        return;
      }
      await create({
        kind: v.kind, partner: v.partner, invoice_date: v.invoice_date,
        ...(v.due_date ? { due_date: v.due_date } : {}), ...(v.currency ? { currency: v.currency.toUpperCase() } : {}),
        ...(v.kind === "SUPPLIER_INVOICE" && v.supplier_ref ? { supplier_ref: v.supplier_ref } : {}),
        ...(creditFor ? { credit_for: creditFor.id } : {}),
        lines: v.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, account: l.account, tax_rate: l.tax_rate || null })),
      }).unwrap();
      close();
    } catch (e) {
      const fe = fieldErrors(e);
      setError("root", { message: Object.values(fe)[0] ?? errorMessage(e) });
    }
  });
  return (
    <Modal title={editing ? `Edit ${editing.number}` : creditFor ? `Credit note for ${creditFor.number}` : "New invoice"} open={open} onClose={close}>
      <form onSubmit={submit} noValidate className="max-h-[75vh] overflow-y-auto">
        {fixed ? (
          <p className="mb-3 text-sm text-slate-700">{meta.label} · {fixed.partner.name} · {fixed.currency}</p>
        ) : (
          <>
            <FormField label="Type" htmlFor="inv-kind"><select id="inv-kind" className={inputClass} {...register("kind")}>{KINDS.slice(0, 2).map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></FormField>
            <FormField label={kind === "CUSTOMER_INVOICE" ? "Customer" : "Supplier"} htmlFor="inv-partner" error={formState.errors.partner?.message}>
              <select id="inv-partner" className={inputClass} {...register("partner")}><option value="">Choose…</option>{partnerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </FormField>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Invoice date" htmlFor="inv-date" error={formState.errors.invoice_date?.message}><input id="inv-date" type="date" className={inputClass} {...register("invoice_date")} /></FormField>
          <FormField label="Due date" htmlFor="inv-due" error={formState.errors.due_date?.message}><input id="inv-due" type="date" className={inputClass} {...register("due_date")} /></FormField>
          {!fixed && <FormField label="Currency (blank = company currency)" htmlFor="inv-cur" error={formState.errors.currency?.message}><input id="inv-cur" maxLength={3} className={inputClass} {...register("currency")} /></FormField>}
          {(kind === "SUPPLIER_INVOICE") && <FormField label="Supplier reference" htmlFor="inv-ref"><input id="inv-ref" className={inputClass} {...register("supplier_ref")} /></FormField>}
        </div>
        <table className="mb-2 w-full text-sm">
          <thead><tr><th className="text-left">Description</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-left">Account</th><th className="text-left">Tax</th><th /></tr></thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={f.id}>
                <td><input aria-label={`Line ${i + 1} description`} className={inputClass} {...register(`lines.${i}.description`)} /></td>
                <td><input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className={`${inputClass} w-20 text-right`} {...register(`lines.${i}.quantity`)} /></td>
                <td><input aria-label={`Line ${i + 1} price`} inputMode="decimal" className={`${inputClass} w-24 text-right`} {...register(`lines.${i}.unit_price`)} /></td>
                <td><select aria-label={`Line ${i + 1} account`} className={inputClass} {...register(`lines.${i}.account`)}><option value="">Choose…</option>{accountOptions.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></td>
                <td><select aria-label={`Line ${i + 1} tax`} className={inputClass} {...register(`lines.${i}.tax_rate`)}><option value="">No tax</option>{taxOptions.map((t) => <option key={t.id} value={t.id}>{t.name} ({formatMoney(t.rate)}%)</option>)}</select></td>
                <td>{fields.length > 1 && <Button variant="secondary" aria-label={`Remove line ${i + 1}`} onClick={() => remove(i)}>×</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {formState.errors.lines?.map?.((le, i) => le && <p key={i} role="alert" className="text-xs text-red-700">Line {i + 1}: {le.description?.message ?? le.quantity?.message ?? le.unit_price?.message ?? le.account?.message}</p>)}
        <div className="mb-3 flex items-center justify-between text-sm">
          <Button variant="secondary" onClick={() => append(blank)}>Add line</Button>
          <span>Net {formatMoney(net)} · Tax {formatMoney(tax)} · <strong>Total {formatMoney(net + tax)}</strong> <span className="text-slate-500">(estimate; the server calculates the final amounts)</span></span>
        </div>
        {formState.errors.root && <p role="alert" className="mb-3 text-sm text-red-700">{formState.errors.root.message}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={state.isLoading}>{editing ? "Save changes" : creditFor ? "Save credit note draft" : "Save draft"}</Button></div>
      </form>
    </Modal>
  );
}

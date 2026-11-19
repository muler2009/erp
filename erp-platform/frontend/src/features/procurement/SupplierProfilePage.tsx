import { useState } from "react";
import { Link, useParams } from "react-router";

import { useAddSupplierBankMutation, useAddSupplierContactMutation, useAddSupplierDocumentMutation, useGetSupplierProfileQuery, useListProductsQuery, useListSupplierBanksQuery, useListSupplierCatalogueQuery, useSetSupplierCataloguePriceMutation, useSetSupplierStandingMutation, useUpdateSupplierProfileMutation, useVerifySupplierBankMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { SupplierProfileData } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

const DEC = /^\d+(\.\d{1,4})?$/;
export const STANDING: Record<SupplierProfileData["standing"], { label: string; tone: "green" | "amber" | "red" }> = { GOOD: { label: "In good standing", tone: "green" }, SUSPENDED: { label: "Suspended", tone: "amber" }, BLACKLISTED: { label: "Blacklisted", tone: "red" } };
export const RISK: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };

/** Validates the profile form; returns a message or null. */
export function profileProblem(f: { name: string; payment_terms_days: string; early_discount_percent: string; early_discount_days: string; wht_percent: string; currency: string }): string | null {
  if (!f.name.trim()) return "The supplier needs a name.";
  if (!/^\d+$/.test(f.payment_terms_days.trim()) || Number(f.payment_terms_days) > 365) return "Payment terms must be a whole number of days, 0 to 365.";
  if (!DEC.test(f.early_discount_percent.trim()) || Number(f.early_discount_percent) > 20) return "The early-payment discount must be between 0 and 20 percent.";
  if (!/^\d+$/.test(f.early_discount_days.trim()) || Number(f.early_discount_days) > 365) return "Early-payment days must be a whole number, 0 to 365.";
  if (!DEC.test(f.wht_percent.trim()) || Number(f.wht_percent) > 50) return "Withholding tax must be between 0 and 50 percent.";
  if (f.currency.trim() && !/^[A-Za-z]{3}$/.test(f.currency.trim())) return "Currency must be a three-letter code, such as USD.";
  return null;
}

/** First problem with a catalogue price entry, or null. */
export function priceProblem(f: { product: string; unit_price: string; currency: string; min_order_quantity: string; lead_time_days: string }): string | null {
  if (!f.product) return "Choose the product.";
  if (!DEC.test(f.unit_price.trim())) return "The price must be a number such as 4.50.";
  if (!/^[A-Za-z]{3}$/.test(f.currency.trim())) return "Enter the three-letter currency code, such as USD.";
  if (!DEC.test(f.min_order_quantity.trim()) || Number(f.min_order_quantity) <= 0) return "The minimum order quantity must be above zero.";
  if (!/^\d+$/.test(f.lead_time_days.trim())) return "Lead time must be a whole number of days.";
  return null;
}

function Details({ s, canEdit }: { s: SupplierProfileData; canEdit: boolean }) {
  const [update] = useUpdateSupplierProfileMutation();
  const [edit, setEdit] = useState(false);
  return (
    <Card title="Details" actions={canEdit ? <Button variant="secondary" onClick={() => setEdit(true)}>Edit details</Button> : undefined}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <div><dt className="text-xs text-slate-500">Legal name</dt><dd>{s.legal_name || "—"}</dd></div>
        <div><dt className="text-xs text-slate-500">Tax ID</dt><dd>{s.tax_id || "—"}</dd></div>
        <div><dt className="text-xs text-slate-500">Email / phone</dt><dd>{s.email || "—"} / {s.phone || "—"}</dd></div>
        <div><dt className="text-xs text-slate-500">Category</dt><dd>{s.category || "—"}</dd></div>
        <div><dt className="text-xs text-slate-500">Pays in</dt><dd>{s.currency || "—"}, {s.payment_terms_days} days</dd></div>
        <div><dt className="text-xs text-slate-500">Early-payment discount</dt><dd>{Number(s.early_discount_percent)}% within {s.early_discount_days} days</dd></div>
        <div><dt className="text-xs text-slate-500">Withholding tax</dt><dd>{Number(s.wht_percent)}%</dd></div>
        <div><dt className="text-xs text-slate-500">Risk</dt><dd>{RISK[s.risk_level] ?? s.risk_level}{s.is_preferred ? " · preferred supplier" : ""}</dd></div>
      </dl>
      {edit && <ActionDialog title="Edit supplier details" cta="Save" open onClose={() => setEdit(false)}
        initial={{ name: s.name, legal_name: s.legal_name, phone: s.phone, category: s.category, currency: s.currency, payment_terms_days: String(s.payment_terms_days), early_discount_percent: String(Number(s.early_discount_percent)), early_discount_days: String(s.early_discount_days), wht_percent: String(Number(s.wht_percent)), risk_level: s.risk_level, is_preferred: s.is_preferred ? "yes" : "no" }}
        fields={[{ name: "name", label: "Name", required: true }, { name: "legal_name", label: "Legal name" }, { name: "phone", label: "Phone" }, { name: "category", label: "Category" }, { name: "currency", label: "Currency" }, { name: "payment_terms_days", label: "Payment terms (days)" }, { name: "early_discount_percent", label: "Early-payment discount (%)" }, { name: "early_discount_days", label: "Early-payment window (days)" }, { name: "wht_percent", label: "Withholding tax (%)" }, { name: "risk_level", label: "Risk", options: Object.entries(RISK) }, { name: "is_preferred", label: "Preferred supplier", options: [["no", "No"], ["yes", "Yes"]] }]}
        submit={async (v) => {
          const f = { name: v.name ?? "", payment_terms_days: v.payment_terms_days ?? "", early_discount_percent: v.early_discount_percent ?? "", early_discount_days: v.early_discount_days ?? "", wht_percent: v.wht_percent ?? "", currency: v.currency ?? "" };
          const p = profileProblem(f);
          if (p) throw new Error(p);
          await update({ id: s.id, body: { name: f.name.trim(), legal_name: v.legal_name ?? "", phone: v.phone ?? "", category: v.category ?? "", currency: f.currency.trim().toUpperCase(), payment_terms_days: Number(f.payment_terms_days), early_discount_percent: f.early_discount_percent.trim(), early_discount_days: Number(f.early_discount_days), wht_percent: f.wht_percent.trim(), risk_level: v.risk_level, is_preferred: v.is_preferred === "yes" } }).unwrap();
        }} />}
    </Card>
  );
}

function Standing({ s, canEdit }: { s: SupplierProfileData; canEdit: boolean }) {
  const [set] = useSetSupplierStandingMutation();
  const [open, setOpen] = useState(false);
  const st = STANDING[s.standing];
  return (
    <Card title="Standing" actions={canEdit ? <Button variant="secondary" onClick={() => setOpen(true)}>Change standing</Button> : undefined}>
      <p className="text-sm"><Badge tone={st.tone}>{st.label}</Badge>{s.standing_reason ? <span className="ml-2 text-slate-600">{s.standing_reason}</span> : null}</p>
      <p className="mt-1 text-sm text-slate-600">Orders cannot be placed with a suspended or blacklisted supplier.</p>
      {open && <ActionDialog title="Change standing" cta="Save standing" open onClose={() => setOpen(false)} initial={{ standing: s.standing }}
        fields={[{ name: "standing", label: "Standing", required: true, options: Object.entries(STANDING).map(([k, v]) => [k, v.label]) }, { name: "reason", label: "Reason (required unless in good standing)" }, { name: "until", label: "Suspended until (optional)", type: "date" }]}
        submit={async (v) => {
          if (v.standing !== "GOOD" && !(v.reason ?? "").trim()) throw new Error("Give a reason for suspending or blacklisting.");
          if (v.standing === "GOOD" && s.standing === "BLACKLISTED" && !(v.reason ?? "").trim()) throw new Error("Lifting a blacklisting needs a documented reason.");
          await set({ id: s.id, body: { standing: v.standing, reason: v.reason ?? "", ...(v.standing === "SUSPENDED" && v.until ? { until: v.until } : {}) } }).unwrap();
        }} />}
      {s.scorecard.evaluations > 0 && <p className="mt-2 text-sm text-slate-600">Scorecard from {s.scorecard.evaluations} evaluation{s.scorecard.evaluations === 1 ? "" : "s"}: delivery {s.scorecard.delivery?.toFixed(1)}, quality {s.scorecard.quality?.toFixed(1)}, price {s.scorecard.price?.toFixed(1)}, overall {s.scorecard.overall?.toFixed(1)}.</p>}
    </Card>
  );
}

function Contacts({ s, canEdit }: { s: SupplierProfileData; canEdit: boolean }) {
  const [add] = useAddSupplierContactMutation();
  const [open, setOpen] = useState(false);
  return (
    <Card title="Contacts" actions={canEdit ? <Button variant="secondary" onClick={() => setOpen(true)}>Add contact</Button> : undefined}>
      {s.contacts.length === 0 ? <EmptyState title="No contacts" /> : <ul className="text-sm">{s.contacts.map((c) => <li key={c.id} className="border-t border-slate-100 py-1">{c.name}{c.role ? `, ${c.role}` : ""} · {c.email || "no email"} · {c.phone || "no phone"} {c.primary && <Badge tone="green">Main contact</Badge>}</li>)}</ul>}
      {open && <ActionDialog title="Add contact" cta="Add contact" open onClose={() => setOpen(false)} fields={[{ name: "name", label: "Name", required: true }, { name: "role", label: "Role" }, { name: "email", label: "Email" }, { name: "phone", label: "Phone" }, { name: "is_primary", label: "Main contact", options: [["no", "No"], ["yes", "Yes"]] }]}
        submit={async (v) => { if (v.email && !/^\S+@\S+\.\S+$/.test(v.email)) throw new Error("Enter a valid email address."); await add({ id: s.id, body: { name: v.name!.trim(), role: v.role ?? "", email: v.email ?? "", phone: v.phone ?? "", is_primary: v.is_primary === "yes" } }).unwrap(); }} />}
    </Card>
  );
}

function Banks({ s }: { s: SupplierProfileData }) {
  const { can } = useAccess();
  const q = useListSupplierBanksQuery(s.id, { skip: !can("procurement.supplier.bank") });
  const [add] = useAddSupplierBankMutation();
  const [verify] = useVerifySupplierBankMutation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!can("procurement.supplier.bank")) return null;
  const doVerify = async (id: string) => { setErr(null); try { await verify(id).unwrap(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Card title="Bank accounts" actions={<Button variant="secondary" onClick={() => setOpen(true)}>Add bank account</Button>}>
      <p className="mb-2 text-sm text-slate-600">A second person must verify new details before payments can use them.</p>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="No bank accounts" /> : (
        <ul className="text-sm">{(q.data ?? []).map((b) => <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-1"><span>{b.bank_name} · {b.account_name} · {b.account_number}{b.currency ? ` · ${b.currency}` : ""}{b.default ? " · default" : ""}</span>
          {b.verified ? <Badge tone="green">Verified</Badge> : <span className="flex items-center gap-2"><Badge tone="amber">Not verified</Badge><Button variant="secondary" onClick={() => void doVerify(b.id)}>{`Verify ${b.bank_name} ${b.account_number}`}</Button></span>}</li>)}</ul>
      )}
      {open && <ActionDialog title="Add bank account" cta="Add account" open onClose={() => setOpen(false)} fields={[{ name: "bank_name", label: "Bank", required: true }, { name: "account_name", label: "Account name", required: true }, { name: "account_number", label: "Account number", required: true }, { name: "currency", label: "Currency (optional)" }, { name: "is_default", label: "Default account", options: [["no", "No"], ["yes", "Yes"]] }]}
        submit={async (v) => { if (v.currency && !/^[A-Za-z]{3}$/.test(v.currency.trim())) throw new Error("Currency must be a three-letter code, such as USD."); await add({ id: s.id, body: { bank_name: v.bank_name!.trim(), account_name: v.account_name!.trim(), account_number: v.account_number!.trim(), currency: (v.currency ?? "").trim().toUpperCase(), is_default: v.is_default === "yes" } }).unwrap(); }} />}
    </Card>
  );
}

function Documents({ s, canEdit }: { s: SupplierProfileData; canEdit: boolean }) {
  const [add] = useAddSupplierDocumentMutation();
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card title="Documents" actions={canEdit ? <Button variant="secondary" onClick={() => setOpen(true)}>Add document</Button> : undefined}>
      {s.documents.length === 0 ? <EmptyState title="No documents" hint="Licences, certificates and insurance can be recorded here." /> : <ul className="text-sm">{s.documents.map((d) => <li key={d.id} className="flex items-center justify-between border-t border-slate-100 py-1"><span>{d.type}{d.reference ? ` · ${d.reference}` : ""}</span>{d.expiry_date ? (d.expiry_date < today ? <Badge tone="red">Expired {d.expiry_date}</Badge> : <span className="text-slate-600">Expires {d.expiry_date}</span>) : <span className="text-slate-500">No expiry</span>}</li>)}</ul>}
      {open && <ActionDialog title="Add document" cta="Add document" open onClose={() => setOpen(false)} fields={[{ name: "doc_type", label: "Type (e.g. Tax certificate)", required: true }, { name: "reference", label: "Reference" }, { name: "expiry_date", label: "Expires (optional)", type: "date" }]}
        submit={async (v) => { await add({ id: s.id, body: { doc_type: v.doc_type!.trim(), reference: v.reference ?? "", ...(v.expiry_date ? { expiry_date: v.expiry_date } : {}) } }).unwrap(); }} />}
    </Card>
  );
}

function Catalogue({ s, canEdit }: { s: SupplierProfileData; canEdit: boolean }) {
  const q = useListSupplierCatalogueQuery(s.id);
  const products = useListProductsQuery({});
  const [set] = useSetSupplierCataloguePriceMutation();
  const [open, setOpen] = useState(false);
  const name = (id: string) => { const p = products.data?.results.find((x) => x.id === id); return p ? `${p.sku} — ${p.name}` : "Product"; };
  return (
    <Card title="Price catalogue" actions={canEdit ? <Button variant="secondary" onClick={() => setOpen(true)}>Set a price</Button> : undefined}>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <EmptyState title="No agreed prices" /> : (
        <table className="w-full text-sm"><caption className="sr-only">Current prices</caption><thead><tr className="text-left text-slate-500"><th>Product</th><th className="text-right">Price</th><th>From</th></tr></thead>
          <tbody>{(q.data ?? []).map((r) => <tr key={r.product} className="border-t border-slate-100"><td className="py-1">{name(r.product)}</td><td className="text-right">{formatMoney(r.unit_price)} {r.currency}</td><td>{r.valid_from}</td></tr>)}</tbody></table>
      )}
      {open && <ActionDialog title="Set a price" cta="Save price" open onClose={() => setOpen(false)} initial={{ currency: s.currency, min_order_quantity: "1", lead_time_days: "0" }}
        fields={[{ name: "product", label: "Product", required: true, options: (products.data?.results ?? []).map((p) => [p.id, `${p.sku} — ${p.name}`]) }, { name: "unit_price", label: "Price", required: true }, { name: "currency", label: "Currency", required: true }, { name: "valid_from", label: "Starts (optional, must be after the current price)", type: "date" }, { name: "min_order_quantity", label: "Minimum order quantity" }, { name: "lead_time_days", label: "Lead time (days)" }, { name: "supplier_sku", label: "Supplier's product code" }, { name: "is_preferred", label: "Preferred for this product", options: [["no", "No"], ["yes", "Yes"]] }]}
        submit={async (v) => {
          const f = { product: v.product ?? "", unit_price: v.unit_price ?? "", currency: v.currency ?? "", min_order_quantity: v.min_order_quantity ?? "", lead_time_days: v.lead_time_days ?? "" };
          const p = priceProblem(f);
          if (p) throw new Error(p);
          await set({ id: s.id, body: { product: f.product, unit_price: f.unit_price.trim(), currency: f.currency.trim().toUpperCase(), min_order_quantity: f.min_order_quantity.trim(), lead_time_days: Number(f.lead_time_days), supplier_sku: v.supplier_sku ?? "", is_preferred: v.is_preferred === "yes", ...(v.valid_from ? { valid_from: v.valid_from } : {}) } }).unwrap();
        }} />}
    </Card>
  );
}

export function SupplierProfilePage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const q = useGetSupplierProfileQuery(id);
  if (q.isLoading) return <Spinner />;
  const s = q.data;
  if (q.isError || !s) return <ErrorState error={q.error ?? new Error("Could not load.")} onRetry={() => void q.refetch()} />;
  const manage = can("procurement.supplier.manage");
  return (
    <div>
      <p className="mb-2 text-sm"><Link className="text-blue-700 underline" to="/app/procurement/suppliers">← All suppliers</Link></p>
      <PageHeader title={s.name} description={`Status: ${s.status.toLowerCase()}`} />
      <Details s={s} canEdit={manage} />
      <Standing s={s} canEdit={manage} />
      <Contacts s={s} canEdit={manage} />
      <Banks s={s} />
      <Documents s={s} canEdit={manage} />
      <Catalogue s={s} canEdit={manage} />
    </div>
  );
}

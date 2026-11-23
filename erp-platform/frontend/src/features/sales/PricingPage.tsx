import { useState } from "react";

import { useCreatePriceListMutation, useGetPriceHistoryQuery, useGetProductSalesProfileQuery, useGetSalesCatalogQuery, useListCrmAccountsQuery, useListCurrenciesQuery, useListDiscountRulesQuery, useListPriceListsQuery, useLazyLookupPriceQuery, useRemovePriceItemMutation, useSaveDiscountRuleMutation, useSaveProductSalesProfileMutation, useSetPriceItemMutation, useSetPriceListActiveMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { CatalogItem, PriceListRow } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames } from "../quality/names";
import { BundleDialog } from "./BundleDialog";

const TABS = ["Price lists", "Products", "Discount limits", "Price check"] as const;
export const KIND_LABEL: Record<string, string> = { STANDARD: "Standard", PROMOTIONAL: "Promotion", CUSTOMER: "Customer-specific", CONTRACT: "Contract" };
const DECIMAL = /^\d+(\.\d{1,4})?$/;

/** Returns a message when the text is not a non-negative decimal, otherwise null. Blank is allowed only when `blankOk`. */
export function decimalProblem(label: string, v: string, opts: { blankOk?: boolean; positive?: boolean; max?: number } = {}): string | null {
  const t = v.trim();
  if (!t) return opts.blankOk ? null : `${label} is required.`;
  if (!DECIMAL.test(t)) return `${label} must be a number such as 12.50.`;
  const n = Number(t);
  if (opts.positive && n <= 0) return `${label} must be more than zero.`;
  if (opts.max !== undefined && n > opts.max) return `${label} cannot be more than ${opts.max}.`;
  return null;
}

export function validityText(p: Pick<PriceListRow, "valid_from" | "valid_to">): string {
  if (!p.valid_from && !p.valid_to) return "Always";
  return `${p.valid_from ?? "…"} to ${p.valid_to ?? "…"}`;
}

function useProductNames() {
  const cat = useGetSalesCatalogQuery({ all: true });
  const m = new Map((cat.data ?? []).map((p) => [p.id, `${p.sku} ${p.name}`]));
  return { nameOf: (id: string) => m.get(id) ?? `Product ${id.slice(0, 8)}`, options: (cat.data ?? []).map((p) => [p.id, `${p.sku} ${p.name}`] as [string, string]) };
}

function ItemsDialog({ list, canManage, onClose }: { list: PriceListRow; canManage: boolean; onClose: () => void }) {
  const { nameOf, options } = useProductNames();
  const nameOfUser = useUserNames();
  const [setItem, { isLoading: saving }] = useSetPriceItemMutation();
  const [removeItem] = useRemovePriceItemMutation();
  const history = useGetPriceHistoryQuery({ price_list: list.id }, { skip: !canManage });
  const [f, setF] = useState({ product: "", min_quantity: "1", unit_price: "" });
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    const problem = (!f.product && "Choose a product.") || decimalProblem("Minimum quantity", f.min_quantity, { positive: true }) || decimalProblem("Unit price", f.unit_price);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try { await setItem({ id: list.id, product: f.product, unit_price: f.unit_price.trim(), min_quantity: f.min_quantity.trim() }).unwrap(); setF({ ...f, unit_price: "" }); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Prices in ${list.name}`} open onClose={onClose}>
      {list.items.length ? (
        <table className="mb-3 min-w-full text-sm"><caption className="sr-only">Prices</caption>
          <thead><tr className="text-left text-slate-500"><th className="py-1">Product</th><th className="text-right">From quantity</th><th className="text-right">Unit price ({list.currency})</th><th /></tr></thead>
          <tbody>{list.items.map((i) => (
            <tr key={`${i.product}-${i.min_quantity}`} className="border-t border-slate-100"><td className="py-1">{nameOf(i.product)}</td><td className="text-right">{Number(i.min_quantity)}</td><td className="text-right">{formatMoney(i.unit_price)}</td>
              <td className="text-right">{canManage && <button className="text-xs text-red-700 hover:underline" aria-label={`Remove ${nameOf(i.product)} from ${i.min_quantity}`} onClick={() => { setErr(null); removeItem({ id: list.id, product: i.product, min_quantity: i.min_quantity }).unwrap().catch((e) => setErr(errorMessage(e))); }}>remove</button>}</td></tr>))}</tbody></table>
      ) : <EmptyState title="No prices in this list yet" />}
      {canManage && (
        <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-4">
          <FormField label="Product" htmlFor="pi-product"><select id="pi-product" className={inputClass} value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })}><option value="">Choose…</option>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
          <FormField label="From quantity" htmlFor="pi-qty"><input id="pi-qty" className={inputClass} value={f.min_quantity} onChange={(e) => setF({ ...f, min_quantity: e.target.value })} /></FormField>
          <FormField label="Unit price" htmlFor="pi-price"><input id="pi-price" className={inputClass} value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></FormField>
          <div className="flex items-end"><Button loading={saving} onClick={() => void add()}>Save price</Button></div>
        </div>
      )}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {canManage && history.data && history.data.length > 0 && (
        <details className="text-sm"><summary className="cursor-pointer text-slate-600">Price changes ({history.data.length})</summary>
          <ul className="mt-2">{history.data.slice(0, 20).map((h, i) => <li key={i}>{new Date(h.changed_at).toLocaleDateString()} · {nameOf(h.product)} · {h.old_price === null ? "new" : formatMoney(h.old_price)} → {formatMoney(h.new_price)} · {nameOfUser(h.changed_by)}</li>)}</ul></details>
      )}
      <div className="mt-3 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Modal>
  );
}

function PriceLists({ canManage }: { canManage: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListPriceListsQuery({ cursor });
  const [create] = useCreatePriceListMutation();
  const [setActive] = useSetPriceListActiveMutation();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const currencies = useListCurrenciesQuery({ active: true }, { skip: !creating });
  const accounts = useListCrmAccountsQuery(undefined, { skip: !creating });
  const open = data?.results.find((p) => p.id === openId) ?? null;
  return (
    <>
      {canManage && <div className="mb-3 flex justify-end"><Button onClick={() => setCreating(true)}>New price list</Button></div>}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.results.length ? <EmptyState title="No price lists yet" hint="Create a standard list first; customer and contract lists override it." /> : (
        <>
          <table className="min-w-full text-sm"><caption className="sr-only">Price lists</caption>
            <thead><tr className="text-left text-slate-500"><th className="py-1">Name</th><th>Type</th><th>Currency</th><th>Valid</th><th>Prices</th><th>Status</th><th /></tr></thead>
            <tbody>{data.results.map((p) => (
              <tr key={p.id} className="border-t border-slate-100"><td className="py-1">{p.name}</td><td>{KIND_LABEL[p.kind]}</td><td>{p.currency}</td><td>{validityText(p)}</td><td>{p.items.length}</td>
                <td><Badge tone={p.is_active ? "green" : "slate"}>{p.is_active ? "Active" : "Inactive"}</Badge></td>
                <td className="flex justify-end gap-2 py-1"><Button variant="secondary" onClick={() => setOpenId(p.id)}>{`Prices of ${p.name}`}</Button>
                  {canManage && <Button variant="secondary" onClick={() => { setErr(null); setActive({ id: p.id, active: !p.is_active }).unwrap().catch((e) => setErr(errorMessage(e))); }}>{`${p.is_active ? "Deactivate" : "Activate"} ${p.name}`}</Button>}</td></tr>))}</tbody></table>
          <div className="mt-2 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{data.next && <Button variant="secondary" onClick={() => setCursor(data.next)}>Next page</Button>}</div>
        </>
      )}
      {open && <ItemsDialog list={open} canManage={canManage} onClose={() => setOpenId(null)} />}
      {creating && (
        <ActionDialog title="New price list" cta="Create price list" open onClose={() => setCreating(false)} initial={{ kind: "STANDARD" }}
          fields={[{ name: "name", label: "Name", required: true }, { name: "currency", label: "Currency", required: true, options: (currencies.data?.results ?? []).map((c) => [c.code, `${c.code} ${c.name}`]) },
            { name: "kind", label: "Type", required: true, options: Object.entries(KIND_LABEL) }, { name: "account", label: "Customer (customer and contract lists only)", options: (accounts.data?.results ?? []).map((a) => [a.id, a.name]) },
            { name: "valid_from", label: "Valid from (promotions and contracts)", type: "date" }, { name: "valid_to", label: "Valid to", type: "date" }]}
          submit={async (v) => {
            if (v.valid_from && v.valid_to && v.valid_to < v.valid_from) throw new Error("The end date cannot be before the start date.");
            await create({ name: v.name!.trim(), currency: v.currency, kind: v.kind, account: v.account || null, valid_from: v.valid_from || null, valid_to: v.valid_to || null, items: [] }).unwrap();
          }} />
      )}
    </>
  );
}

function ProfileDialog({ item, onClose }: { item: CatalogItem; onClose: () => void }) {
  const { data, isLoading, error } = useGetProductSalesProfileQuery(item.id);
  const [save] = useSaveProductSalesProfileMutation();
  if (isLoading) return <Modal title={`Selling limits for ${item.name}`} open onClose={onClose}><Spinner /></Modal>;
  if (error || !data) return <Modal title={`Selling limits for ${item.name}`} open onClose={onClose}><ErrorState error={error} /></Modal>;
  const yn: [string, string][] = [["yes", "Yes"], ["no", "No"]];
  return (
    <ActionDialog title={`Selling limits for ${item.name}`} cta="Save limits" open onClose={onClose}
      initial={{ is_sellable: data.is_sellable ? "yes" : "no", is_discontinued: data.is_discontinued ? "yes" : "no", min_price: data.min_price ?? "", min_margin_percent: data.min_margin_percent ?? "", max_discount_percent: data.max_discount_percent ?? "" }}
      fields={[{ name: "is_sellable", label: "Can be sold", options: yn }, { name: "is_discontinued", label: "Discontinued", options: yn }, { name: "min_price", label: "Lowest price (blank for none)" }, { name: "min_margin_percent", label: "Lowest margin % (blank for none)" }, { name: "max_discount_percent", label: "Largest discount % (blank for none)" }]}
      submit={async (v) => {
        const problem = decimalProblem("Lowest price", v.min_price ?? "", { blankOk: true }) || decimalProblem("Lowest margin %", v.min_margin_percent ?? "", { blankOk: true, max: 100 }) || decimalProblem("Largest discount %", v.max_discount_percent ?? "", { blankOk: true, max: 100 });
        if (problem) throw new Error(problem);
        const num = (s?: string) => (s && s.trim() ? s.trim() : null);
        await save({ id: item.id, body: { is_sellable: v.is_sellable !== "no", is_discontinued: v.is_discontinued === "yes", min_price: num(v.min_price), min_margin_percent: num(v.min_margin_percent), max_discount_percent: num(v.max_discount_percent) } }).unwrap();
      }} />
  );
}

function Products({ canManage }: { canManage: boolean }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const { data, isLoading, error, refetch } = useGetSalesCatalogQuery({ search: q.trim(), all });
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [bundling, setBundling] = useState<CatalogItem | null>(null);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <FormField label="Search products" htmlFor="pc-q"><input id="pc-q" className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or SKU" /></FormField>
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Include products that cannot be sold</label>
      </div>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No products match" /> : (
        <table className="min-w-full text-sm"><caption className="sr-only">Products</caption>
          <thead><tr className="text-left text-slate-500"><th className="py-1">SKU</th><th>Name</th><th>Category</th><th>Status</th><th className="text-right">Lowest price</th><th className="text-right">Largest discount</th><th className="text-right">Available</th><th /></tr></thead>
          <tbody>{data.map((p) => (
            <tr key={p.id} className="border-t border-slate-100"><td className="py-1">{p.sku}</td><td>{p.name}{p.is_bundle && <Badge tone="slate">Bundle</Badge>}</td><td>{p.category || "–"}</td>
              <td><Badge tone={p.discontinued ? "red" : p.sellable ? "green" : "amber"}>{p.discontinued ? "Discontinued" : p.sellable ? "For sale" : "Not for sale"}</Badge></td>
              <td className="text-right">{p.min_price ? formatMoney(p.min_price) : "–"}</td><td className="text-right">{p.max_discount_percent ? `${Number(p.max_discount_percent)}%` : "–"}</td><td className="text-right">{p.available === null ? "n/a" : Number(p.available)}</td>
              <td className="text-right">{canManage && <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEditing(p)}>{`Limits for ${p.name}`}</Button><Button variant="secondary" onClick={() => setBundling(p)}>{`Bundle for ${p.name}`}</Button></div>}</td></tr>))}</tbody></table>
      )}
      {editing && <ProfileDialog item={editing} onClose={() => setEditing(null)} />}
      {bundling && <BundleDialog product={bundling} onClose={() => setBundling(null)} />}
    </>
  );
}

function DiscountLimits({ canManage }: { canManage: boolean }) {
  const { data, isLoading, error, refetch } = useListDiscountRulesQuery();
  const [save] = useSaveDiscountRuleMutation();
  const [dlg, setDlg] = useState<"new" | { scope: "CATEGORY" | "CLASSIFICATION"; key: string; max_percent: string; is_active: boolean } | null>(null);
  const edit = dlg && dlg !== "new" ? dlg : null;
  return (
    <>
      <p className="mb-3 text-sm text-slate-600">The largest discount a salesperson may give without approval. When several limits apply, the lowest one wins.</p>
      {canManage && <div className="mb-3 flex justify-end"><Button onClick={() => setDlg("new")}>Set a limit</Button></div>}
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState title="No discount limits yet" /> : (
        <table className="min-w-full text-sm"><caption className="sr-only">Discount limits</caption>
          <thead><tr className="text-left text-slate-500"><th className="py-1">Applies to</th><th>Name</th><th className="text-right">Largest discount</th><th>Status</th><th /></tr></thead>
          <tbody>{data.map((r) => (
            <tr key={`${r.scope}-${r.key}`} className="border-t border-slate-100"><td className="py-1">{r.scope === "CATEGORY" ? "Product category" : "Customer classification"}</td><td>{r.key}</td><td className="text-right">{Number(r.max_percent)}%</td>
              <td><Badge tone={r.is_active ? "green" : "slate"}>{r.is_active ? "Active" : "Off"}</Badge></td><td className="text-right">{canManage && <Button variant="secondary" onClick={() => setDlg(r)}>{`Edit limit ${r.key}`}</Button>}</td></tr>))}</tbody></table>
      )}
      {dlg && (
        <ActionDialog title={edit ? `Edit limit ${edit.key}` : "Set a limit"} cta="Save limit" open onClose={() => setDlg(null)}
          initial={edit ? { scope: edit.scope, key: edit.key, max_percent: String(Number(edit.max_percent)), is_active: edit.is_active ? "yes" : "no" } : { scope: "CATEGORY", is_active: "yes" }}
          fields={[{ name: "scope", label: "Applies to", required: true, options: [["CATEGORY", "Product category"], ["CLASSIFICATION", "Customer classification"]] }, { name: "key", label: "Category or classification name", required: true }, { name: "max_percent", label: "Largest discount %", required: true }, { name: "is_active", label: "Active", options: [["yes", "Yes"], ["no", "No"]] }]}
          submit={async (v) => {
            const problem = decimalProblem("Largest discount %", v.max_percent ?? "", { max: 100 });
            if (problem) throw new Error(problem);
            await save({ scope: v.scope as "CATEGORY", key: v.key!.trim(), max_percent: v.max_percent!.trim(), is_active: v.is_active !== "no" }).unwrap();
          }} />
      )}
    </>
  );
}

function PriceCheck() {
  const { options } = useProductNames();
  const currencies = useListCurrenciesQuery({ active: true });
  const accounts = useListCrmAccountsQuery();
  const [lookup, result] = useLazyLookupPriceQuery();
  const [f, setF] = useState({ product: "", currency: "", quantity: "1", account: "" });
  const [err, setErr] = useState<string | null>(null);
  const go = () => {
    const problem = (!f.product && "Choose a product.") || (!f.currency && "Choose a currency.") || decimalProblem("Quantity", f.quantity, { positive: true });
    if (problem) { setErr(problem); return; }
    setErr(null);
    void lookup({ product: f.product, currency: f.currency, quantity: f.quantity.trim(), ...(f.account ? { account: f.account } : {}) });
  };
  return (
    <>
      <p className="mb-3 text-sm text-slate-600">See which price a customer would get today: contract, then customer, then promotion, then standard.</p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
        <FormField label="Product" htmlFor="pk-product"><select id="pk-product" className={inputClass} value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })}><option value="">Choose…</option>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
        <FormField label="Currency" htmlFor="pk-currency"><select id="pk-currency" className={inputClass} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option value="">Choose…</option>{(currencies.data?.results ?? []).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></FormField>
        <FormField label="Quantity" htmlFor="pk-qty"><input id="pk-qty" className={inputClass} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></FormField>
        <FormField label="Customer (optional)" htmlFor="pk-account"><select id="pk-account" className={inputClass} value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}><option value="">Any customer</option>{(accounts.data?.results ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></FormField>
      </div>
      <Button loading={result.isFetching} onClick={go}>Check price</Button>
      {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
      {result.isError && <p role="alert" className="mt-3 text-sm text-red-700">{errorMessage(result.error)}</p>}
      {result.isSuccess && !err && <p role="status" className="mt-3 text-lg">{result.data.unit_price === null ? "No price is set for this product, currency and quantity." : `${formatMoney(result.data.unit_price)} ${f.currency} per unit`}</p>}
    </>
  );
}

export function PricingPage() {
  const { can } = useAccess();
  const manage = can("sales.pricelist.manage");
  const [tab, setTab] = useState<(typeof TABS)[number]>("Price lists");
  return (
    <>
      <PageHeader title="Pricing" description="Price lists, what can be sold, and how much discount is allowed." />
      <div role="tablist" aria-label="Pricing" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)} className={`px-3 py-2 text-sm ${t === tab ? "border-b-2 border-indigo-600 font-medium text-indigo-700" : "text-slate-600 hover:text-slate-900"}`}>{t}</button>)}
      </div>
      <Card title={tab}>
        {tab === "Price lists" && <PriceLists canManage={manage} />}{tab === "Products" && <Products canManage={manage} />}{tab === "Discount limits" && <DiscountLimits canManage={manage} />}{tab === "Price check" && <PriceCheck />}
      </Card>
    </>
  );
}

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { bundleProblem } from "./BundleDialog";
import { CommissionsPage } from "./CommissionsPage";
import { wordingProblem } from "./ContractEdit";
import { ContractDetailPage } from "./ContractDetailPage";
import { PricingPage } from "./PricingPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const PRODS = http.get("*/api/v1/inventory/products", () => page([{ id: "p1", sku: "SKU-1", name: "Widget" }, { id: "p2", sku: "SKU-2", name: "Gadget" }]));
const EMP = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [] }));

describe("helpers", () => {
  it("checks bundles", () => {
    expect(bundleProblem("b", [{ product: "p1", quantity: "2" }])).toBeNull();
    expect(bundleProblem("b", [])).toMatch(/at least one/);
    expect(bundleProblem("b", [{ product: "b", quantity: "1" }])).toMatch(/own bundle/);
    expect(bundleProblem("b", [{ product: "p1", quantity: "1" }, { product: "p1", quantity: "2" }])).toMatch(/twice/);
    expect(bundleProblem("b", [{ product: "p1", quantity: "0" }])).toMatch(/above 0/);
  });
  it("checks contract wording and renewal", () => {
    expect(wordingProblem({ auto_renew: false, renewal_term_months: "", renewal_notice_days: "" })).toBeNull();
    expect(wordingProblem({ auto_renew: true, renewal_term_months: "0", renewal_notice_days: "" })).toMatch(/months/);
    expect(wordingProblem({ auto_renew: false, renewal_term_months: "", renewal_notice_days: "3.5" })).toMatch(/whole number/);
  });
});

describe("Product bundles", () => {
  const catalog = http.get("*/api/v1/sales/catalog", () => HttpResponse.json([{ id: "b1", sku: "KIT-1", name: "Starter kit", category: "", uom: "pcs", sellable: true, discontinued: false, min_price: null, max_discount_percent: null, available: "1", is_bundle: true }]));
  const open = async (permissions: string[], extra: Parameters<typeof server.use> = []) => {
    server.use(catalog, PRODS, EMP, http.get("*/api/v1/sales/products/b1/bundle", () => HttpResponse.json({ product: "b1", items: [{ product: "p1", quantity: "2.0000" }] })), ...extra);
    renderWithProviders(<PricingPage />, { permissions });
    await userEvent.click(await screen.findByRole("tab", { name: "Products" }));
  };
  it("is only offered to price managers", async () => {
    await open(["sales.view"]);
    await screen.findByText("Starter kit");
    expect(screen.queryByRole("button", { name: /Bundle for/ })).toBeNull();
  });
  it("edits components and saves them", async () => {
    let body: Record<string, unknown> | null = null;
    await open(["sales.view", "sales.pricelist.manage"], [http.put("*/api/v1/sales/products/b1/bundle", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ product: "b1", items: [] }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Bundle for Starter kit" }));
    const q = await screen.findByLabelText(/Quantity of SKU-1/);
    await userEvent.clear(q); await userEvent.type(q, "3");
    await userEvent.click(screen.getByRole("button", { name: "Save bundle" }));
    await waitFor(() => expect(body).toEqual({ items: [{ product: "p1", quantity: "3" }] }));
  });
  it("will not save an empty bundle and shows the server's refusal", async () => {
    await open(["sales.view", "sales.pricelist.manage"], [http.put("*/api/v1/sales/products/b1/bundle", () => HttpResponse.json({ error: { code: "invalid_bundle", message: "Components must be distinct, active, non-bundle products with positive quantities." } }, { status: 422 }))]);
    await userEvent.click(await screen.findByRole("button", { name: "Bundle for Starter kit" }));
    await userEvent.click(await screen.findByRole("button", { name: /Remove SKU-1/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save bundle" }));
    expect(await screen.findByText("A bundle needs at least one component.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Add a component"), "Gad");
    await userEvent.click(await screen.findByRole("button", { name: "SKU-2 — Gadget" }));
    await userEvent.click(screen.getByRole("button", { name: "Add component" }));
    await userEvent.click(screen.getByRole("button", { name: "Save bundle" }));
    expect(await screen.findByText(/non-bundle products/)).toBeInTheDocument();
  });
});

describe("Commission plans", () => {
  const PLAN = { id: "p1", name: "Standard", tiers: [{ from: "0", rate: "2" }, { from: "50000", rate: "3" }], category_rates: { Accessories: "5" }, is_active: true };
  const open = async (extra: Parameters<typeof server.use> = []) => {
    server.use(EMP, http.get("*/api/v1/sales/targets", () => HttpResponse.json({ owner_id: "u1", net_sales: "0", target: null, attainment_percent: null, remaining: null })), http.get("*/api/v1/sales/commission-plans", () => HttpResponse.json([PLAN])), ...extra);
    renderWithProviders(<CommissionsPage />, { permissions: ["crm.view", "crm.assign"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Plans" }));
  };
  it("edits tiers under the same name", async () => {
    let body: Record<string, unknown> | null = null;
    await open([http.post("*/api/v1/sales/commission-plans", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Edit Standard" }));
    const d = within(await screen.findByRole("dialog", { name: "Edit plan: Standard" }));
    const t = d.getByLabelText(/Tiers/) as HTMLTextAreaElement;
    expect(t.value).toBe("0:2\n50000:3");
    await userEvent.clear(t); await userEvent.type(t, "100:2");
    await userEvent.click(d.getByRole("button", { name: "Save plan" }));
    expect(await d.findByText("The first tier must start at 0.")).toBeInTheDocument();
    await userEvent.clear(t); await userEvent.type(t, "0:4");
    await userEvent.click(d.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(body).toEqual({ name: "Standard", tiers: [{ from: "0", rate: "4" }], category_rates: { Accessories: "5" }, is_active: true }));
  });
  it("deactivates a plan, keeping its tiers", async () => {
    let body: Record<string, unknown> | null = null;
    await open([http.post("*/api/v1/sales/commission-plans", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate Standard" }));
    await waitFor(() => expect(body).toMatchObject({ name: "Standard", is_active: false, tiers: PLAN.tiers }));
  });
  it("refuses a new plan that reuses a name instead of overwriting it", async () => {
    let hit = false;
    await open([http.post("*/api/v1/sales/commission-plans", () => { hit = true; return HttpResponse.json({}, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "New plan" }));
    const d = within(await screen.findByRole("dialog", { name: "New commission plan" }));
    await userEvent.type(d.getByLabelText("Name"), "standard");
    await userEvent.click(d.getByRole("button", { name: "Create plan" }));
    expect(await d.findByText(/already exists/)).toBeInTheDocument();
    expect(hit).toBe(false);
  });
});

describe("Contract editing", () => {
  const contract = (o = {}) => ({ id: "c1", number: "", account: "a1", title: "Annual supply", status: "DRAFT", start_date: "2026-01-01", end_date: "2026-12-31", currency: "USD", committed_value: "50000.00", auto_renew: false, renewal_term_months: null, renewal_notice_days: null, payment_terms: "Net 30", delivery_terms: "", terms: "", version: 1, renews: null, items: [{ product: "p1", min_quantity: "10", unit_price: "4.50" }], obligations: [], ...o });
  const mount = (c: object, perms: string[], extra: Parameters<typeof server.use> = []) => {
    server.use(PRODS, http.get("*/api/v1/sales/contracts/c1", () => HttpResponse.json(c)), http.get("*/api/v1/sales/contracts/c1/utilisation", () => HttpResponse.json({ contract: "c1", currency: "USD", ordered: "0", committed: null, percent: null, remaining: null, obligations_open: 0, obligations_overdue: 0 })),
      http.get("*/api/v1/sales/contracts/c1/history", () => HttpResponse.json([])), ...extra);
    renderWithProviders(<Routes><Route path="/app/sales/contracts/:id" element={<ContractDetailPage />} /></Routes>, { permissions: perms, route: "/app/sales/contracts/c1" });
  };
  it("edits a draft in full, including prices", async () => {
    let body: Record<string, unknown> | null = null;
    mount(contract(), ["sales.view", "sales.quote.create"], [http.patch("*/api/v1/sales/contracts/c1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(contract()); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
    const d = within(await screen.findByRole("dialog", { name: "Edit draft contract" }));
    const title = d.getByLabelText("Title");
    await userEvent.clear(title); await userEvent.type(title, "Annual supply 2026");
    const price = d.getByLabelText("Price 1");
    await userEvent.clear(price); await userEvent.type(price, "0");
    await userEvent.click(d.getByRole("button", { name: "Save changes" }));
    expect(await d.findByText("Every agreed price must be above zero.")).toBeInTheDocument();
    await userEvent.clear(price); await userEvent.type(price, "4.75");
    await userEvent.click(d.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(body).toMatchObject({ title: "Annual supply 2026", start_date: "2026-01-01", end_date: "2026-12-31", committed_value: "50000", payment_terms: "Net 30", items: [{ product: "p1", min_quantity: "10", unit_price: "4.75" }] }));
  });
  it("lets an approver change only wording on a contract in force", async () => {
    let body: Record<string, unknown> | null = null;
    mount(contract({ status: "ACTIVE", number: "CT-1" }), ["sales.view", "sales.order.approve"], [http.patch("*/api/v1/sales/contracts/c1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(contract({ status: "ACTIVE" })); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Change wording" }));
    const d = within(await screen.findByRole("dialog", { name: "Change contract wording" }));
    expect(d.queryByLabelText("Title")).toBeNull();
    expect(d.queryByLabelText("Price 1")).toBeNull();
    await userEvent.clear(d.getByLabelText("Payment terms")); await userEvent.type(d.getByLabelText("Payment terms"), "Net 45");
    await userEvent.click(d.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(body).toEqual({ payment_terms: "Net 45", delivery_terms: "", terms: "", auto_renew: false }));
  });
  it("hides editing from people without the right permission", async () => {
    mount(contract({ status: "ACTIVE", number: "CT-1" }), ["sales.view", "sales.quote.create"]);
    await screen.findByText(/CT-1/);
    expect(screen.queryByRole("button", { name: "Change wording" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
  });
});

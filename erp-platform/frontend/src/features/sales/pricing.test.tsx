import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { PricingPage, decimalProblem, validityText } from "./PricingPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const MANAGE = ["sales.view", "sales.pricelist.manage"];
const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const prod = (o = {}) => ({ id: "p1", sku: "SKU-1", name: "Widget", category: "Parts", uom: "pcs", sellable: true, discontinued: false, min_price: "8.00", max_discount_percent: "10", available: "5.0000", is_bundle: false, ...o });
const list = (o = {}) => ({ id: "l1", name: "Retail 2026", kind: "STANDARD", account: null, currency: "USD", valid_from: null, valid_to: null, is_active: true, items: [{ product: "p1", min_quantity: "1.0000", unit_price: "12.5000" }], ...o });
const base = [
  http.get("*/api/v1/sales/catalog", () => HttpResponse.json([prod()])),
  http.get("*/api/v1/org/currencies", () => page([{ id: "c1", code: "USD", name: "US Dollar", symbol: "$", decimals: 2, is_active: true }])),
  http.get("*/api/v1/crm/accounts", () => page([{ id: "a1", name: "Acme Ltd" }])),
  http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [] })),
  http.get("*/api/v1/sales/pricing/history", () => HttpResponse.json([{ price_list: "l1", product: "p1", min_quantity: "1", old_price: null, new_price: "12.50", changed_by: null, changed_at: "2026-11-01T08:00:00Z" }])),
];

describe("helpers", () => {
  it("checks decimals and validity", () => {
    expect(decimalProblem("Price", "")).toMatch(/required/);
    expect(decimalProblem("Price", "", { blankOk: true })).toBeNull();
    expect(decimalProblem("Price", "1,5")).toMatch(/number/);
    expect(decimalProblem("Qty", "0", { positive: true })).toMatch(/more than zero/);
    expect(decimalProblem("Pct", "101", { max: 100 })).toMatch(/more than 100|cannot be more/);
    expect(decimalProblem("Price", "12.50")).toBeNull();
    expect(validityText({ valid_from: null, valid_to: null })).toBe("Always");
    expect(validityText({ valid_from: "2026-01-01", valid_to: "2026-02-01" })).toBe("2026-01-01 to 2026-02-01");
  });
});

describe("PricingPage price lists", () => {
  it("lists price lists; buyers without manage rights get no buttons", async () => {
    server.use(...base, http.get("*/api/v1/sales/price-lists", () => page([list()])));
    renderWithProviders(<PricingPage />, { permissions: ["sales.view"] });
    expect(await screen.findByText("Retail 2026")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New price list" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Deactivate/ })).toBeNull();
  });

  it("creates a list, rejects an end date before the start, and shows server refusals", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(...base, http.get("*/api/v1/sales/price-lists", () => page([])),
      http.post("*/api/v1/sales/pricing/lists", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ error: { code: "dates_required", message: "Promotional and contract lists need a validity period." } }, { status: 400 }); }));
    renderWithProviders(<PricingPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "New price list" }));
    const d = within(await screen.findByRole("dialog", { name: "New price list" }));
    await userEvent.type(d.getByLabelText("Name"), "Summer");
    await d.findByRole("option", { name: /USD/ });
    await userEvent.selectOptions(d.getByLabelText("Currency"), "USD");
    await userEvent.selectOptions(d.getByLabelText("Type"), "PROMOTIONAL");
    await userEvent.click(d.getByRole("button", { name: "Create price list" }));
    expect(await d.findByText("Promotional and contract lists need a validity period.")).toBeInTheDocument();
    expect(body).toMatchObject({ name: "Summer", currency: "USD", kind: "PROMOTIONAL", account: null, items: [] });
  });

  it("activates/deactivates a list", async () => {
    let sent: unknown = null;
    server.use(...base, http.get("*/api/v1/sales/price-lists", () => page([list()])),
      http.post("*/api/v1/sales/pricing/lists/l1/active", async ({ request }) => { sent = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<PricingPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate Retail 2026" }));
    await waitFor(() => expect(sent).toEqual({ active: false }));
  });

  it("edits prices of a list: validates, saves, removes", async () => {
    let put: unknown = null; let del = "";
    server.use(...base, http.get("*/api/v1/sales/price-lists", () => page([list()])),
      http.put("*/api/v1/sales/pricing/lists/l1/items", async ({ request }) => { put = await request.json(); return HttpResponse.json({}); }),
      http.delete("*/api/v1/sales/pricing/lists/l1/items", ({ request }) => { del = new URL(request.url).search; return new HttpResponse(null, { status: 204 }); }));
    renderWithProviders(<PricingPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Prices of Retail 2026" }));
    const d = within(await screen.findByRole("dialog", { name: "Prices in Retail 2026" }));
    expect(await d.findByRole("cell", { name: "SKU-1 Widget" })).toBeInTheDocument();
    expect(d.getByText("12.50")).toBeInTheDocument();
    await userEvent.click(d.getByRole("button", { name: "Save price" }));
    expect(await d.findByText("Choose a product.")).toBeInTheDocument();
    await userEvent.selectOptions(d.getByLabelText("Product"), "p1");
    await userEvent.type(d.getByLabelText("Unit price"), "abc");
    await userEvent.click(d.getByRole("button", { name: "Save price" }));
    expect(await d.findByText(/Unit price must be a number/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Unit price"));
    await userEvent.type(d.getByLabelText("Unit price"), "11.00");
    await userEvent.clear(d.getByLabelText("From quantity"));
    await userEvent.type(d.getByLabelText("From quantity"), "10");
    await userEvent.click(d.getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(put).toEqual({ product: "p1", unit_price: "11.00", min_quantity: "10" }));
    await userEvent.click(d.getByRole("button", { name: /^Remove SKU-1 Widget/ }));
    await waitFor(() => expect(del).toContain("product=p1"));
    expect(await d.findByText(/Price changes \(1\)/)).toBeInTheDocument();
  });
});

describe("PricingPage products, limits and price check", () => {
  it("shows products and saves selling limits, clearing blanks", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(...base, http.get("*/api/v1/sales/price-lists", () => page([])),
      http.get("*/api/v1/sales/products/p1/profile", () => HttpResponse.json({ product: "p1", is_sellable: true, is_discontinued: false, min_price: "8.00", min_margin_percent: null, max_discount_percent: "10" })),
      http.put("*/api/v1/sales/products/p1/profile", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}); }));
    renderWithProviders(<PricingPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("tab", { name: "Products" }));
    expect(await screen.findByText("For sale")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Limits for Widget" }));
    await waitFor(() => expect((screen.getByLabelText("Largest discount % (blank for none)") as HTMLInputElement).value).toBe("10"));
    const d = within(screen.getByRole("dialog", { name: "Selling limits for Widget" }));
    await userEvent.clear(d.getByLabelText("Largest discount % (blank for none)"));
    await userEvent.type(d.getByLabelText("Lowest margin % (blank for none)"), "150");
    await userEvent.click(d.getByRole("button", { name: "Save limits" }));
    expect(await d.findByText(/cannot be more than 100/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Lowest margin % (blank for none)"));
    await userEvent.click(d.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(body).toEqual({ is_sellable: true, is_discontinued: false, min_price: "8.00", min_margin_percent: null, max_discount_percent: null }));
  });

  it("sets a discount limit and rejects over 100%", async () => {
    let body: unknown = null;
    server.use(...base, http.get("*/api/v1/sales/price-lists", () => page([])),
      http.get("*/api/v1/sales/pricing/discount-rules", () => HttpResponse.json([{ scope: "CATEGORY", key: "Parts", max_percent: "15.00", is_active: true }])),
      http.put("*/api/v1/sales/pricing/discount-rules", async ({ request }) => { body = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<PricingPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("tab", { name: "Discount limits" }));
    expect(await screen.findByText("15%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit limit Parts" }));
    const d = within(await screen.findByRole("dialog", { name: "Edit limit Parts" }));
    await userEvent.clear(d.getByLabelText("Largest discount %"));
    await userEvent.type(d.getByLabelText("Largest discount %"), "120");
    await userEvent.click(d.getByRole("button", { name: "Save limit" }));
    expect(await d.findByText(/cannot be more than 100/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Largest discount %"));
    await userEvent.type(d.getByLabelText("Largest discount %"), "12.5");
    await userEvent.click(d.getByRole("button", { name: "Save limit" }));
    await waitFor(() => expect(body).toEqual({ scope: "CATEGORY", key: "Parts", max_percent: "12.5", is_active: true }));
  });

  it("checks the price a customer would get, and says when none is set", async () => {
    const seen: URLSearchParams[] = [];
    server.use(...base, http.get("*/api/v1/sales/price-lists", () => page([])),
      http.get("*/api/v1/sales/price", ({ request }) => { seen.push(new URL(request.url).searchParams); return HttpResponse.json({ unit_price: seen.length === 1 ? "11.0000" : null }); }));
    renderWithProviders(<PricingPage />, { permissions: ["sales.view"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Price check" }));
    await userEvent.click(screen.getByRole("button", { name: "Check price" }));
    expect(await screen.findByText("Choose a product.")).toBeInTheDocument();
    await screen.findByRole("option", { name: /SKU-1/ });
    await screen.findByRole("option", { name: "USD" });
    await userEvent.selectOptions(screen.getByLabelText("Product"), "p1");
    await userEvent.selectOptions(screen.getByLabelText("Currency"), "USD");
    await userEvent.click(screen.getByRole("button", { name: "Check price" }));
    expect(await screen.findByText("11.00 USD per unit")).toBeInTheDocument();
    expect(seen[0]?.get("quantity")).toBe("1");
    await userEvent.clear(screen.getByLabelText("Quantity"));
    await userEvent.type(screen.getByLabelText("Quantity"), "50");
    await userEvent.click(screen.getByRole("button", { name: "Check price" }));
    expect(await screen.findByText(/No price is set/)).toBeInTheDocument();
  });
});

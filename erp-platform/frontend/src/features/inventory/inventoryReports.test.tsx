import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import * as csv from "../../shared/lib/csvDownload";
import { renderWithProviders } from "../../test/utils";
import { InventoryReportsPage, cell, headerFor, pickProblem, reportParams } from "./InventoryReportsPage";
import { ItemSetupPage, categoryProblem, conversionProblem, convertProblem, uomProblem } from "./ItemSetupPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const prod = { id: "p1", sku: "CH-1", name: "Chain", uom: "pc", barcode: null, category: "", tracking: "LOT", is_stocked: true, is_active: true, on_hand: "5" };
const WH = { id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "MAIN", address: "", locations: [] };
const base = [
  http.get("*/api/v1/inventory/warehouses", () => HttpResponse.json({ results: [WH], next: null })),
  http.get("*/api/v1/inventory/locations/utilisation", () => HttpResponse.json({ results: [{ warehouse: "MAIN", location: "A1", kind: "STORAGE", used: "50.0000", capacity: "200.0000", utilisation_pct: "25.00" }, { warehouse: "MAIN", location: "B1", kind: "STORAGE", used: "3.0000", capacity: null, utilisation_pct: null }] })),
];

describe("helpers", () => {
  it("report helpers", () => {
    expect(headerFor("unit_cost")).toBe("Unit cost");
    expect(headerFor("weird_key")).toBe("Weird key");
    expect(cell(null)).toBe("—");
    expect(cell("12.5000")).toBe("12.50");
    expect(cell("MAIN")).toBe("MAIN");
    const f = { code: "summary", group_by: "category", from: "2026-01-01", to: "", days: "30", warehouse: "w1" };
    expect(reportParams(f)).toEqual({ group_by: "category" });
    expect(reportParams({ ...f, code: "movements" })).toEqual({ from: "2026-01-01", warehouse: "w1" });
    expect(reportParams({ ...f, code: "abc" })).toEqual({ days: "30" });
    expect(reportParams({ ...f, code: "abc", days: "x" })).toEqual({ days: "365" });
    expect(pickProblem(null, "w", "1")).toMatch(/product/);
    expect(pickProblem(prod as never, "", "1")).toMatch(/warehouse/);
    expect(pickProblem(prod as never, "w", "0")).toMatch(/more than 0/);
    expect(pickProblem(prod as never, "w", "2")).toBeNull();
  });
  it("setup helpers", () => {
    expect(categoryProblem("", "x")).toMatch(/code/);
    expect(categoryProblem("A", "B")).toBeNull();
    expect(uomProblem("kg", "")).toMatch(/name/);
    expect(conversionProblem("kg", "kg", "1")).toMatch(/different/);
    expect(conversionProblem("kg", "g", "0")).toMatch(/more than 0/);
    expect(conversionProblem("kg", "g", "1000")).toBeNull();
    expect(convertProblem("x", "kg", "g")).toMatch(/quantity/);
    expect(convertProblem("1", "", "g")).toMatch(/units/);
  });
});

describe("InventoryReportsPage", () => {
  it("shows the summary report with readable headers and downloads CSV with the same filters", async () => {
    const dl = vi.spyOn(csv, "downloadCsv").mockResolvedValue();
    server.use(...base, http.get("*/api/v1/inventory/reports/summary", () => HttpResponse.json({ results: [{ group: "MAIN", quantity: "10.0000", value: "250.0000" }] })));
    renderWithProviders(<InventoryReportsPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("250.00")).toBeInTheDocument();
    expect(screen.getByText("Group")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(dl).toHaveBeenCalledWith("/api/v1/inventory/reports/summary", { group_by: "warehouse", export: "csv" }, "inventory-summary.csv"));
  });

  it("stock card waits for a product; turnover single-row report; adjustments by reason", async () => {
    server.use(...base,
      http.get("*/api/v1/inventory/reports/summary", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [prod], next: null })),
      http.get("*/api/v1/inventory/reports/stock-card", ({ request }) => HttpResponse.json({ sku: "CH-1", rows: [{ date: "2026-11-01", type: "RECEIPT", quantity: "5.0000", balance: "5.0000" }], _p: new URL(request.url).searchParams.get("product") })),
      http.get("*/api/v1/inventory/reports/turnover", () => HttpResponse.json({ period_days: 365, issued_value: "100.0000", inventory_value: "50.0000", turnover: "2.0000", days_of_inventory: "182.5" })),
      http.get("*/api/v1/inventory/reports/adjustments", () => HttpResponse.json({ rows: [{ number: "ADJ-1", sku: "CH-1", delta: "-1.0000", reason_code: "LOSS", status: "POSTED" }], by_reason: { LOSS: { count: 1, net_value: "-10.0000" } } })));
    renderWithProviders(<InventoryReportsPage />, { permissions: ["inventory.view"] });
    await screen.findByText("Location utilisation");
    await userEvent.selectOptions(screen.getByLabelText("Report"), "stock-card");
    expect(await screen.findByText("Choose a product to see its stock card.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeDisabled();
    await userEvent.type(screen.getAllByRole("combobox", { name: "Product" })[0]!, "ch");
    await userEvent.click(await screen.findByRole("button", { name: /CH-1/ }));
    expect(await screen.findByText("RECEIPT")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Report"), "turnover");
    expect(await screen.findByText("Days of inventory")).toBeInTheDocument();
    expect(screen.getByText("182.50")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Report"), "adjustments");
    expect(await screen.findByText("ADJ-1")).toBeInTheDocument();
    expect(screen.getByText(/By reason: LOSS 1 \(-10.00\)/)).toBeInTheDocument();
  });

  it("shows location utilisation including locations with no limit", async () => {
    server.use(...base, http.get("*/api/v1/inventory/reports/summary", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<InventoryReportsPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("25.00%")).toBeInTheDocument();
    expect(screen.getByText("No limit")).toBeInTheDocument();
    expect(await screen.findByText("Nothing to show")).toBeInTheDocument();
  });

  it("suggests lots by policy and surfaces server errors", async () => {
    let policy = "";
    server.use(...base, http.get("*/api/v1/inventory/reports/summary", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [prod], next: null })),
      http.get("*/api/v1/inventory/picks", ({ request }) => { policy = new URL(request.url).searchParams.get("policy") ?? ""; return HttpResponse.json({ picks: [{ location: "l1", lot_code: "L7", quantity: "3.0000", expiry_date: "2027-01-01" }] }); }));
    renderWithProviders(<InventoryReportsPage />, { permissions: ["inventory.view"] });
    await screen.findByText("Which lots to pick");
    await userEvent.click(screen.getByRole("button", { name: "Suggest lots" }));
    expect(await screen.findByText("Choose the product.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("combobox", { name: "Lot-tracked product" }), "ch");
    await userEvent.click(await screen.findByRole("button", { name: /CH-1/ }));
    await userEvent.selectOptions(screen.getByLabelText("Warehouse", { selector: "#pk-wh" }), "w1");
    await userEvent.type(screen.getByLabelText("Quantity needed"), "3");
    await userEvent.selectOptions(screen.getByLabelText("Rule"), "FIFO");
    await userEvent.click(screen.getByRole("button", { name: "Suggest lots" }));
    expect(await screen.findByText("L7")).toBeInTheDocument();
    expect(policy).toBe("FIFO");
  });
});

describe("ItemSetupPage", () => {
  const cats = http.get("*/api/v1/inventory/categories", () => HttpResponse.json({ results: [{ id: "c1", code: "TOOLS", name: "Tools", parent: null }, { id: "c2", code: "HAND", name: "Hand tools", parent: "c1" }] }));
  const uoms = http.get("*/api/v1/inventory/uoms", () => HttpResponse.json({ units: [{ code: "kg", name: "Kilogram" }, { code: "g", name: "Gram" }], conversions: [{ product: null, from: "kg", to: "g", factor: "1000.0000" }] }));

  it("lists categories with their parent and saves a new one", async () => {
    let body: unknown = null;
    server.use(cats, uoms, http.post("*/api/v1/inventory/categories", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "c3", code: "X", name: "X", parent: "c1" }, { status: 201 }); }));
    renderWithProviders(<ItemSetupPage />, { permissions: ["inventory.view", "inventory.product.manage"] });
    expect(await screen.findByText("Hand tools", { selector: "td" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save category" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/code and a name/);
    await userEvent.type(screen.getByLabelText("Category code"), "SAW");
    await userEvent.type(screen.getByLabelText("Category name"), "Saws");
    await userEvent.selectOptions(screen.getByLabelText("Inside (optional)"), "c1");
    await userEvent.click(screen.getByRole("button", { name: "Save category" }));
    await waitFor(() => expect(body).toEqual({ code: "SAW", name: "Saws", parent: "c1" }));
  });

  it("converts units and saves a conversion; setup forms hidden without permission", async () => {
    let body: unknown = null;
    server.use(cats, uoms,
      http.get("*/api/v1/inventory/uoms/convert", () => HttpResponse.json({ quantity: "2500.0000" })),
      http.post("*/api/v1/inventory/uoms", async ({ request }) => { body = await request.json(); return HttpResponse.json({ from: "g", to: "kg", factor: "0.001" }, { status: 201 }); }));
    const v = renderWithProviders(<ItemSetupPage />, { permissions: ["inventory.view", "inventory.product.manage"] });
    expect(await screen.findByText(/1 kg = 1000.0000 g/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("From unit"), "kg");
    await userEvent.selectOptions(screen.getByLabelText("To unit"), "g");
    await userEvent.clear(screen.getByLabelText("Try a conversion"));
    await userEvent.type(screen.getByLabelText("Try a conversion"), "2.5");
    await userEvent.click(screen.getByRole("button", { name: "Convert" }));
    expect(await screen.findByText("Result: 2500.0000 g")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Convert from"), "g");
    await userEvent.selectOptions(screen.getByLabelText("to"), "kg");
    await userEvent.type(screen.getByLabelText("Factor"), "0.001");
    await userEvent.click(screen.getByRole("button", { name: "Save conversion" }));
    await waitFor(() => expect(body).toEqual({ from: "g", to: "kg", factor: "0.001" }));
    v.unmount();
    renderWithProviders(<ItemSetupPage />, { permissions: ["inventory.view"] });
    await screen.findByText("Item categories");
    expect(screen.queryByRole("button", { name: "Save category" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add unit" })).toBeNull();
  });
});

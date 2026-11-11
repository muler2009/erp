import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ProductsPage, productSchema } from "./ProductsPage";
import { StockPage, validateMovement } from "./StockPage";
import { ValuationPage } from "./ValuationPage";
import { WarehousesPage } from "./WarehousesPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const product = (over = {}) => ({ id: "p1", sku: "CHAIR-1", name: "Office chair", uom: "unit", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "12.0000", ...over });
const warehouse = { id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "STANDARD", address: "", locations: [{ id: "l1", code: "A1", kind: "BIN", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }, { id: "l2", code: "B1", kind: "BIN", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: true }, { id: "l3", code: "C1", kind: "BIN", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] };

describe("productSchema", () => {
  it("needs sku, name and unit", () => {
    const ok = { sku: "A", name: "A", uom: "unit", tracking: "NONE", is_stocked: true, barcode: "", category: "" };
    expect(productSchema.safeParse(ok).success).toBe(true);
    expect(productSchema.safeParse({ ...ok, sku: "" }).success).toBe(false);
    expect(productSchema.safeParse({ ...ok, uom: "" }).success).toBe(false);
    expect(productSchema.safeParse({ ...ok, tracking: "BATCH" }).success).toBe(false);
  });
});

describe("validateMovement", () => {
  const base = { product: product() as never, location: "l1", toLocation: "", quantity: "5", unitCost: "", counted: "", reason: "" };
  it("accepts a plain receipt and rejects bad quantities", () => {
    expect(validateMovement("receive", base)).toBeNull();
    expect(validateMovement("receive", { ...base, quantity: "0" })).toMatch(/greater than 0/);
    expect(validateMovement("receive", { ...base, quantity: "-1" })).toMatch(/greater than 0/);
    expect(validateMovement("receive", { ...base, quantity: "1e2" })).toMatch(/greater than 0/);
    expect(validateMovement("receive", { ...base, unitCost: "abc" })).toMatch(/unit cost/);
  });
  it("needs a product and a location", () => {
    expect(validateMovement("issue", { ...base, product: null })).toMatch(/product/);
    expect(validateMovement("issue", { ...base, location: "" })).toMatch(/location/);
  });
  it("transfers need a different destination", () => {
    expect(validateMovement("transfer", { ...base, toLocation: "" })).toMatch(/destination/);
    expect(validateMovement("transfer", { ...base, toLocation: "l1" })).toMatch(/differ/);
    expect(validateMovement("transfer", { ...base, toLocation: "l3" })).toBeNull();
  });
  it("adjustments need a counted quantity (0 is allowed) and a reason", () => {
    expect(validateMovement("adjust", { ...base, counted: "", reason: "x" })).toMatch(/counted/);
    expect(validateMovement("adjust", { ...base, counted: "0", reason: "" })).toMatch(/reason/);
    expect(validateMovement("adjust", { ...base, counted: "0", reason: "damaged" })).toBeNull();
  });
});

describe("ProductsPage", () => {
  it("lists products and searches through the API", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/inventory/products", ({ request }) => { seen.push(new URL(request.url).search); return page([product()]); }));
    renderWithProviders(<ProductsPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("Office chair")).toBeInTheDocument();
    expect(screen.getByText("12.00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New product" })).toBeNull();
    await userEvent.type(screen.getByLabelText("Search"), "chair");
    await waitFor(() => expect(seen.some((s) => s.includes("search=chair"))).toBe(true));
  });

  it("creates a product and shows server field errors", async () => {
    server.use(
      http.get("*/api/v1/inventory/products", () => page([])),
      http.get("*/api/v1/inventory/uoms", () => HttpResponse.json({ units: [{ code: "unit", name: "Unit" }, { code: "kg", name: "Kilogram" }], conversions: [] })),
      http.post("*/api/v1/inventory/products", () => HttpResponse.json({ error: { code: "validation_error", message: "Invalid.", details: [{ field: "sku", code: "duplicate", message: "SKU already exists" }] } }, { status: 400 })),
    );
    renderWithProviders(<ProductsPage />, { permissions: ["inventory.view", "inventory.product.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New product" }));
    await userEvent.type(screen.getByLabelText("SKU"), "CHAIR-1");
    await userEvent.type(screen.getByLabelText("Name"), "Chair");
    await waitFor(() => expect(screen.getByLabelText("Unit of measure")).toHaveValue("unit"));
    await userEvent.click(document.querySelector("form button[type=submit]")!);
    expect(await screen.findByText("SKU already exists")).toBeInTheDocument();
  });
});

describe("WarehousesPage", () => {
  it("shows locations, marking blocked ones, and hides management without permission", async () => {
    server.use(http.get("*/api/v1/inventory/warehouses", () => page([warehouse])));
    renderWithProviders(<WarehousesPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("MAIN — Main")).toBeInTheDocument();
    expect(screen.getByText("B1 (blocked)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New warehouse" })).toBeNull();
  });

  it("adds a location to a warehouse", async () => {
    let body: any;
    server.use(http.get("*/api/v1/inventory/warehouses", () => page([warehouse])), http.post("*/api/v1/inventory/locations", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "l9" }, { status: 201 }); }));
    renderWithProviders(<WarehousesPage />, { permissions: ["inventory.view", "inventory.product.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Add location to MAIN" }));
    await userEvent.type(screen.getByLabelText("Code"), "D4");
    await userEvent.type(screen.getByLabelText("Name"), "Bin D4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(body).toEqual({ warehouse: "w1", code: "D4", name: "Bin D4" }));
  });
});

describe("StockPage", () => {
  const common = () => server.use(
    http.get("*/api/v1/inventory/warehouses", () => page([warehouse])),
    http.get("*/api/v1/inventory/stock", () => page([{ product: "CHAIR-1", warehouse: "MAIN", location: "A1", lot: null, quantity: "12.0000" }])),
    http.get("*/api/v1/inventory/movements", () => page([{ id: "m1", product: "CHAIR-1", location: "A1", lot: null, type: "RECEIPT", quantity: "12.0000", unit_cost: "5.0000", ref_type: "manual", ref_id: "receipt", reason: "", at: "2026-01-01T10:00:00Z" }])),
    http.get("*/api/v1/inventory/products", () => page([product()])),
  );

  it("shows stock levels and movement history tabs", async () => {
    common();
    renderWithProviders(<StockPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("12.00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record movement" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Movement history" }));
    expect(await screen.findByText("receipt")).toBeInTheDocument();
  });

  it("only offers movement types the user may perform", async () => {
    common();
    renderWithProviders(<StockPage />, { permissions: ["inventory.view", "inventory.stock.issue"] });
    await userEvent.click(await screen.findByRole("button", { name: "Record movement" }));
    const options = Array.from((screen.getByLabelText("Movement") as HTMLSelectElement).options).map((o) => o.text);
    expect(options).toEqual(["Issue stock", "Transfer stock"]);
  });

  it("records a receipt with exact decimal strings and offers only unblocked locations", async () => {
    let body: any;
    common();
    server.use(http.post("*/api/v1/inventory/receipts", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "m2" }, { status: 201 }); }));
    renderWithProviders(<StockPage />, { permissions: ["inventory.view", "inventory.goods.receive"] });
    await userEvent.click(await screen.findByRole("button", { name: "Record movement" }));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(await screen.findByText("Choose a product.")).toBeInTheDocument();
    expect(body).toBeUndefined();
    await userEvent.type(screen.getByRole("combobox", { name: "Product" }), "ch");
    await userEvent.click(await screen.findByRole("button", { name: "CHAIR-1 — Office chair" }));
    const locOptions = Array.from((screen.getByLabelText("Location") as HTMLSelectElement).options).map((o) => o.text);
    expect(locOptions).toContain("MAIN / A1");
    expect(locOptions).not.toContain("MAIN / B1"); // blocked
    await userEvent.selectOptions(screen.getByLabelText("Location"), "l1");
    await userEvent.type(screen.getByLabelText("Quantity"), "7.5");
    await userEvent.type(screen.getByLabelText("Unit cost"), "5.25");
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(body).toEqual({ product: "p1", location: "l1", reason: "", quantity: "7.5", unit_cost: "5.25" }));
  });

  it("shows the server's refusal, e.g. insufficient stock", async () => {
    common();
    server.use(http.post("*/api/v1/inventory/issues", () => HttpResponse.json({ error: { code: "insufficient_stock", message: "Only 12 available.", details: [] } }, { status: 409 })));
    renderWithProviders(<StockPage />, { permissions: ["inventory.view", "inventory.stock.issue"] });
    await userEvent.click(await screen.findByRole("button", { name: "Record movement" }));
    await userEvent.type(screen.getByRole("combobox", { name: "Product" }), "ch");
    await userEvent.click(await screen.findByRole("button", { name: "CHAIR-1 — Office chair" }));
    await userEvent.selectOptions(screen.getByLabelText("Location"), "l1");
    await userEvent.type(screen.getByLabelText("Quantity"), "99");
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(await screen.findByText("Only 12 available.")).toBeInTheDocument();
  });
});

describe("ValuationPage", () => {
  it("shows value by product, the total, and alerts", async () => {
    server.use(
      http.get("*/api/v1/inventory/valuation", () => HttpResponse.json({ rows: [{ sku: "CHAIR-1", name: "Office chair", quantity: "12.0000", average_cost: "5.0000", value: "60.0000" }], total_value: "60.0000" })),
      http.get("*/api/v1/inventory/alerts", () => HttpResponse.json({ results: [{ sku: "DESK-2", name: "Desk", on_hand: "1.0000", alert: "BELOW_MINIMUM", threshold: "5.0000" }] })),
    );
    renderWithProviders(<ValuationPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("below minimum")).toBeInTheDocument();
    expect(screen.getAllByText("60.00").length).toBe(2); // row value and total
  });
  it("shows the empty alert state", async () => {
    server.use(http.get("*/api/v1/inventory/valuation", () => HttpResponse.json({ rows: [], total_value: "0.0000" })), http.get("*/api/v1/inventory/alerts", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<ValuationPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("No alerts")).toBeInTheDocument();
    expect(screen.getByText("No stock to value")).toBeInTheDocument();
  });
});

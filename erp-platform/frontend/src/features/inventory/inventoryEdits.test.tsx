import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ProductsPage } from "./ProductsPage";
import { WarehousesPage } from "./WarehousesPage";
import { locationProblem, productProblem } from "./StockSetupEdit";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const PROD = { id: "p1", sku: "SKU1", name: "Widget", uom: "EA", barcode: "123", category: "Parts", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "5", min_stock: "2", max_stock: "10", safety_stock: null, reorder_level: "3" };
const WH = { id: "w1", code: "WH1", name: "Main", is_active: true, warehouse_type: "MAIN", address: "", locations: [{ id: "l1", code: "A-01", kind: "STORAGE", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] };

it("checks product and location input", () => {
  expect(productProblem({ name: "", min: "", max: "", reorder: "", safety: "" })).toMatch(/name/);
  expect(productProblem({ name: "x", min: "5", max: "2", reorder: "", safety: "" })).toMatch(/minimum/);
  expect(productProblem({ name: "x", min: "a", max: "", reorder: "", safety: "" })).toMatch(/Minimum stock must/);
  expect(productProblem({ name: "x", min: "1", max: "2", reorder: "1", safety: "1" })).toBeNull();
  expect(locationProblem("0")).toMatch(/above 0/);
  expect(locationProblem("")).toBeNull();
  expect(locationProblem("12.5")).toBeNull();
});

describe("product edit", () => {
  it("hides Edit without permission", async () => {
    server.use(http.get("*/api/v1/inventory/products", () => page([PROD])));
    renderWithProviders(<ProductsPage />, { permissions: ["inventory.product.view"] });
    await screen.findByText("Widget");
    expect(screen.queryByRole("button", { name: "Edit SKU1" })).toBeNull();
  });
  it("blocks bad ranges, then saves; shows server refusal", async () => {
    let body: Record<string, unknown> | null = null; let refuse = true;
    server.use(
      http.get("*/api/v1/inventory/products", () => page([PROD])),
      http.patch("*/api/v1/inventory/products/p1", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        if (refuse) return HttpResponse.json({ error: { code: "invalid", message: "Product has stock on hand." } }, { status: 400 });
        return HttpResponse.json(PROD);
      }),
    );
    renderWithProviders(<ProductsPage />, { permissions: ["inventory.product.view", "inventory.product.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Edit SKU1" }));
    const min = await screen.findByLabelText("Minimum stock");
    await userEvent.clear(min); await userEvent.type(min, "50");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/minimum stock cannot be above/)).toBeInTheDocument();
    expect(body).toBeNull();
    await userEvent.clear(min); await userEvent.type(min, "1");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Product has stock on hand.")).toBeInTheDocument();
    expect(body).toMatchObject({ name: "Widget", min_stock: "1", is_active: true });
    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await vi.waitFor(() => expect(screen.queryByText("Product has stock on hand.")).toBeNull());
  });
});

describe("warehouse and location edit", () => {
  it("edits a warehouse", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get("*/api/v1/inventory/warehouses", () => page([WH])),
      http.patch("*/api/v1/inventory/warehouses/w1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(WH); }),
    );
    renderWithProviders(<WarehousesPage />, { permissions: ["inventory.product.view", "inventory.product.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Edit warehouse WH1" }));
    await userEvent.selectOptions(screen.getByLabelText("Type"), "TRANSIT");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await vi.waitFor(() => expect(body).toMatchObject({ name: "Main", warehouse_type: "TRANSIT" }));
  });
  it("blocks a location and rejects zero capacity", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get("*/api/v1/inventory/warehouses", () => page([WH])),
      http.patch("*/api/v1/inventory/locations/l1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}); }),
    );
    renderWithProviders(<WarehousesPage />, { permissions: ["inventory.product.view", "inventory.product.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Edit location A-01" }));
    await userEvent.type(screen.getByLabelText(/Capacity/), "0");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/above 0/)).toBeInTheDocument();
    expect(body).toBeNull();
    await userEvent.clear(screen.getByLabelText(/Capacity/));
    await userEvent.click(screen.getByLabelText(/Blocked/));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await vi.waitFor(() => expect(body).toMatchObject({ is_blocked: true, capacity: null }));
  });
  it("shows no edit controls without permission", async () => {
    server.use(http.get("*/api/v1/inventory/warehouses", () => page([WH])));
    renderWithProviders(<WarehousesPage />, { permissions: ["inventory.product.view"] });
    await screen.findByText("A-01");
    expect(screen.queryByRole("button", { name: "Edit warehouse WH1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit location A-01" })).toBeNull();
  });
});

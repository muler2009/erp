import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { StockControlPage, reorderProblem } from "./StockControlPage";
import { TraceabilityPage, lookupProblem, statusNoteProblem } from "./TraceabilityPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const prod = { id: "p1", sku: "CH-1", name: "Chain", uom: "pc", barcode: null, category: "", tracking: "LOT", is_stocked: true, is_active: true, on_hand: "5" };
const products = http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [prod], next: null }));

describe("helpers", () => {
  it("reorderProblem", () => {
    const ok = { product: prod as never, warehouse: "w", min: "5", qty: "20" };
    expect(reorderProblem(ok)).toBeNull();
    expect(reorderProblem({ ...ok, product: null })).toMatch(/product/);
    expect(reorderProblem({ ...ok, warehouse: "" })).toMatch(/warehouse/);
    expect(reorderProblem({ ...ok, min: "x" })).toMatch(/minimum/);
    expect(reorderProblem({ ...ok, qty: "0" })).toMatch(/more than 0/);
  });
  it("lookup and status note rules", () => {
    expect(lookupProblem(null, "L1", "lot code")).toMatch(/product/);
    expect(lookupProblem(prod as never, " ", "lot code")).toMatch(/lot code/);
    expect(lookupProblem(prod as never, "L1", "lot code")).toBeNull();
    expect(statusNoteProblem("", "")).toMatch(/status/);
    expect(statusNoteProblem("RECALLED", " ")).toMatch(/note/);
    expect(statusNoteProblem("AVAILABLE", "")).toBeNull();
  });
});

describe("StockControlPage", () => {
  it("shows alerts with plain labels", async () => {
    server.use(http.get("*/api/v1/inventory/alerts", () => HttpResponse.json({ results: [{ sku: "A", name: "Bolt", on_hand: "0", alert: "OUT_OF_STOCK" }, { sku: "B", name: "Milk", lot: "L9", location: "C1", quantity: "4", expiry_date: "2026-01-01", alert: "EXPIRED" }] })));
    renderWithProviders(<StockControlPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("Out of stock")).toBeInTheDocument();
    expect(screen.getAllByText("Expired").length).toBe(2);
    expect(screen.getByText(/Lot L9 at C1/)).toBeInTheDocument();
  });

  it("empty alerts, ageing, slow-moving and expired tabs", async () => {
    server.use(
      http.get("*/api/v1/inventory/alerts", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/inventory/ageing", () => HttpResponse.json({ results: [{ sku: "A", name: "Bolt", buckets: { "0-30": "5.0000", "31-60": "0", "61-90": "0", "90+": "2.0000" }, oldest_days: 120 }] })),
      http.get("*/api/v1/inventory/slow-moving", ({ request }) => HttpResponse.json({ slow_moving: [{ sku: "A", name: "Bolt", on_hand: "7", last_issue: null, value: "70", classification: "OBSOLETE_CANDIDATE" }], excess: [], _days: new URL(request.url).searchParams.get("days") })),
      http.get("*/api/v1/inventory/expired", () => HttpResponse.json({ results: [] })),
    );
    renderWithProviders(<StockControlPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("No alerts")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Ageing" }));
    expect(await screen.findByText("90+")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Slow-moving" }));
    expect(await screen.findByText("Possibly obsolete")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.getByText("No excess stock")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Expired" }));
    expect(await screen.findByText("No expired stock")).toBeInTheDocument();
  });

  it("saves a reorder rule; form hidden without manage permission", async () => {
    let body: unknown = null;
    server.use(
      http.get("*/api/v1/inventory/reorder-rules", () => HttpResponse.json({ below_minimum: [{ sku: "A", warehouse: "MAIN", on_hand: "2", min_quantity: "10", suggested_order_quantity: "50" }] })),
      http.get("*/api/v1/inventory/warehouses", () => HttpResponse.json({ results: [{ id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "MAIN", address: "", locations: [] }], next: null })),
      http.post("*/api/v1/inventory/reorder-rules", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "r" }, { status: 201 }); }),
      products,
    );
    const view = renderWithProviders(<StockControlPage />, { permissions: ["inventory.view", "inventory.product.manage"] });
    await userEvent.click(screen.getByRole("tab", { name: "Reorder" }));
    expect(await screen.findByText("MAIN")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/product/);
    await userEvent.type(screen.getByRole("combobox", { name: "Product" }), "ch");
    await userEvent.click(await screen.findByRole("button", { name: /CH-1/ }));
    await userEvent.selectOptions(await screen.findByLabelText("Warehouse"), "w1");
    await userEvent.type(screen.getByLabelText("Minimum quantity"), "10");
    await userEvent.type(screen.getByLabelText("Order quantity"), "50");
    await userEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(body).toEqual({ product: "p1", warehouse: "w1", min_quantity: "10", reorder_quantity: "50" }));
    view.unmount();
    renderWithProviders(<StockControlPage />, { permissions: ["inventory.view"] });
    await userEvent.click(screen.getByRole("tab", { name: "Reorder" }));
    await screen.findByText("MAIN");
    expect(screen.queryByText("Set a reorder rule")).toBeNull();
  });
});

describe("TraceabilityPage", () => {
  const trace = { lot: "L1", status: "AVAILABLE", expiry_date: "2027-01-01", received: [{ ref_type: "GoodsReceipt", ref_id: "GR-1", quantity: "10", location: "A1" }], on_hand: [{ location: "A1", quantity: "6" }], issued: [{ ref_type: "SalesOrder", ref_id: "SO-1", quantity: "4", at: "2026-11-01T10:00:00Z" }] };
  const pick = async () => {
    await userEvent.type(screen.getByRole("combobox", { name: "Product" }), "ch");
    await userEvent.click(await screen.findByRole("button", { name: /CH-1/ }));
  };

  it("traces a lot and requires a note to recall it", async () => {
    let body: unknown = null;
    server.use(products,
      http.get("*/api/v1/inventory/lots/p1/L1/trace", () => HttpResponse.json(trace)),
      http.post("*/api/v1/inventory/lots/p1/L1/status", async ({ request }) => { body = await request.json(); return HttpResponse.json({ lot: "L1", status: "RECALLED" }); }));
    renderWithProviders(<TraceabilityPage />, { permissions: ["inventory.view", "inventory.stock.adjust"] });
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/product/);
    await pick();
    await userEvent.type(screen.getByLabelText("Lot code"), "L1");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText(/SalesOrder SO-1/)).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Change status" }));
    await userEvent.selectOptions(await screen.findByLabelText("New status"), "RECALLED");
    await userEvent.click(screen.getByRole("button", { name: "Save status" }));
    expect(await screen.findByText("A note is required when a lot is not available.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Note"), "Supplier recall");
    await userEvent.click(screen.getByRole("button", { name: "Save status" }));
    await waitFor(() => expect(body).toEqual({ status: "RECALLED", note: "Supplier recall" }));
  });

  it("hides status change without permission and shows server error for unknown lot", async () => {
    server.use(products, http.get("*/api/v1/inventory/lots/p1/NOPE/trace", () => HttpResponse.json({ error: { code: "not_found", message: "Lot not found." } }, { status: 404 })));
    renderWithProviders(<TraceabilityPage />, { permissions: ["inventory.view"] });
    await pick();
    await userEvent.type(screen.getByLabelText("Lot code"), "NOPE");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText(/Lot not found/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change status" })).toBeNull();
  });

  it("looks up a serial number", async () => {
    server.use(products, http.get("*/api/v1/inventory/serials/p1/SN1", () => HttpResponse.json({ serial: "SN1", status: "ISSUED", location: null, received_ref: "GR-1", issued_ref: "SO-2", warranty_until: "2028-01-01" })));
    renderWithProviders(<TraceabilityPage />, { permissions: ["inventory.view"] });
    await pick();
    await userEvent.selectOptions(screen.getByLabelText("Look up a"), "serial");
    await userEvent.type(screen.getByLabelText("Serial number"), "SN1");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText("Issued")).toBeInTheDocument();
    expect(screen.getByText("2028-01-01")).toBeInTheDocument();
  });
});

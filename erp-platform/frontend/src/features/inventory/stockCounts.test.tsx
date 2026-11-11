import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { StockCountPage, StockCountsPage, validCounted, validateCount } from "./StockCountsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const row = (o: object = {}) => ({ id: "c1", number: "SC-1", warehouse: "MAIN", kind: "CYCLE", status: "DRAFT", freeze: false, created_at: "2026-11-01T10:00:00Z", ...o });
const list = (...rows: object[]) => http.get("*/api/v1/inventory/stock-counts", () => HttpResponse.json({ results: rows }));
const sheetLine = (o: object = {}) => ({ line: "l1", sku: "W-1", name: "Widget", location: "A1", lot: "", counted: null, assigned_to: null, recount: false, ...o });
const view = (perms: string[]) => renderWithProviders(<Routes><Route path="/app/inventory/counts/:id" element={<StockCountPage />} /></Routes>, { permissions: perms, route: "/app/inventory/counts/c1" });
const ADJ = ["inventory.view", "inventory.stock.adjust"];
const APPROVE = [...ADJ, "inventory.adjustment.approve"];

describe("validators", () => {
  it("a cycle count needs a warehouse and a scope; a full count only a warehouse", () => {
    expect(validateCount({ warehouse: "", kind: "FULL", locations: [], products: [] })).toMatch(/warehouse/);
    expect(validateCount({ warehouse: "w", kind: "CYCLE", locations: [], products: [] })).toMatch(/at least one/);
    expect(validateCount({ warehouse: "w", kind: "CYCLE", locations: ["l"], products: [] })).toBeNull();
    expect(validateCount({ warehouse: "w", kind: "FULL", locations: [], products: [] })).toBeNull();
  });
  it("counted quantities are non-negative decimals", () => {
    expect(validCounted("0")).toBe(true);
    expect(validCounted("12.5")).toBe(true);
    expect(validCounted("-1")).toBe(false);
    expect(validCounted("")).toBe(false);
    expect(validCounted("1e3")).toBe(false);
  });
});

describe("StockCountsPage", () => {
  it("lists counts and creates a cycle count over chosen locations", async () => {
    server.use(list(row()), http.get("*/api/v1/inventory/warehouses", () => HttpResponse.json({ results: [{ id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "OWN", address: "", locations: [{ id: "loc1", code: "A1", kind: "BIN", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] }], next: null, previous: null })));
    let body: any = null;
    server.use(http.post("*/api/v1/inventory/stock-counts", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "c2", number: "SC-2", status: "DRAFT" }, { status: 201 }); }));
    renderWithProviders(<StockCountsPage />, { permissions: ADJ });
    const user = userEvent.setup();
    expect(await screen.findByText("SC-1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New count" }));
    await user.click(await screen.findByRole("button", { name: "Create count" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/warehouse/);
    await screen.findByRole("option", { name: "MAIN Main" });
    await user.selectOptions(screen.getByLabelText("Warehouse"), "w1");
    await user.click(screen.getByRole("button", { name: "Create count" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least one location/);
    await user.click(screen.getByLabelText("A1"));
    await user.click(screen.getByLabelText(/Freeze stock movements/));
    await user.click(screen.getByRole("button", { name: "Create count" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ warehouse: "w1", kind: "CYCLE", freeze: true, note: "", locations: ["loc1"], products: [] });
  });

  it("hides New count without the adjust permission", async () => {
    server.use(list());
    renderWithProviders(<StockCountsPage />, { permissions: ["inventory.view"] });
    await screen.findByText("No stock counts yet");
    expect(screen.queryByRole("button", { name: "New count" })).toBeNull();
  });
});

describe("StockCountPage", () => {
  it("starts a draft count", async () => {
    let called = false;
    server.use(list(row()), http.post("*/api/v1/inventory/stock-counts/c1/start", () => { called = true; return HttpResponse.json({ status: "IN_PROGRESS" }); }));
    view(ADJ);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Start count" }));
    await waitFor(() => expect(called).toBe(true));
  });

  it("records a counted quantity blind, and shows server refusals", async () => {
    server.use(list(row({ status: "IN_PROGRESS" })), http.get("*/api/v1/inventory/stock-counts/c1", () => HttpResponse.json({ worksheet: [sheetLine(), sheetLine({ line: "l2", sku: "W-2", location: "B2" })] })));
    let body: any = null;
    server.use(http.post("*/api/v1/inventory/stock-counts/c1/record", async ({ request }) => {
      const b: any = await request.json();
      if (b.line === "l2") return HttpResponse.json({ error: { code: "not_assigned", message: "This line is assigned to another counter.", details: [] } }, { status: 403 });
      body = b; return HttpResponse.json({ line: "l1", counted: "7.0000" });
    }));
    view(ADJ);
    const user = userEvent.setup();
    const input = await screen.findByLabelText("Counted W-1 at A1");
    expect(screen.queryByText(/system/i)).toBeNull(); // counters never see system quantities
    await user.type(input, "-3");
    await user.click(screen.getByRole("button", { name: "Save W-1 at A1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/0 or more/);
    await user.clear(input); await user.type(input, "7");
    await user.click(screen.getByRole("button", { name: "Save W-1 at A1" }));
    await waitFor(() => expect(body).toEqual({ line: "l1", counted_quantity: "7" }));
    await user.type(screen.getByLabelText("Counted W-2 at B2"), "1");
    await user.click(screen.getByRole("button", { name: "Save W-2 at B2" }));
    expect(await screen.findByText(/assigned to another counter/)).toBeInTheDocument();
  });

  it("shows the server refusal when submitting with uncounted lines", async () => {
    server.use(list(row({ status: "IN_PROGRESS" })), http.get("*/api/v1/inventory/stock-counts/c1", () => HttpResponse.json({ worksheet: [sheetLine()] })),
      http.post("*/api/v1/inventory/stock-counts/c1/submit", () => HttpResponse.json({ error: { code: "uncounted_lines", message: "1 line(s) have not been counted.", details: [] } }, { status: 409 })));
    view(ADJ);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Submit count" }));
    expect(await screen.findByText(/have not been counted/)).toBeInTheDocument();
  });

  it("lets an approver see variances, ask for a recount of chosen lines, or approve", async () => {
    server.use(list(row({ status: "SUBMITTED" })), http.get("*/api/v1/inventory/stock-counts/c1", () => HttpResponse.json({ worksheet: [sheetLine({ counted: "7.0000" })] })),
      http.post("*/api/v1/inventory/stock-counts/c1/variances", () => HttpResponse.json({ results: [{ line: "l1", sku: "W-1", location: "A1", lot: "", system: "10.0000", counted: "7.0000", variance: "-3.0000", variance_pct: "-30.00", variance_value: "-30.0000" }] })));
    let recount: any = null; let approved = false;
    server.use(
      http.post("*/api/v1/inventory/stock-counts/c1/recount", async ({ request }) => { recount = await request.json(); return HttpResponse.json({ status: "IN_PROGRESS" }); }),
      http.post("*/api/v1/inventory/stock-counts/c1/approve", () => { approved = true; return HttpResponse.json({ status: "APPROVED" }); }),
    );
    view(APPROVE);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show variances" }));
    const r = await screen.findByText("W-1");
    expect(r.closest("tr")).toHaveTextContent("-30.00");
    expect(screen.getByRole("button", { name: /Request recount/ })).toBeDisabled();
    await user.click(screen.getByLabelText("Recount W-1 at A1"));
    await user.click(screen.getByRole("button", { name: "Request recount (1)" }));
    await waitFor(() => expect(recount).toEqual({ lines: ["l1"] }));
    await user.click(screen.getByRole("button", { name: "Approve and post adjustments" }));
    await waitFor(() => expect(approved).toBe(true));
  });

  it("shows the separation-of-duties refusal on approval, and hides approval from a non-approver", async () => {
    server.use(list(row({ status: "SUBMITTED" })), http.get("*/api/v1/inventory/stock-counts/c1", () => HttpResponse.json({ worksheet: [sheetLine({ counted: "7.0000" })] })),
      http.post("*/api/v1/inventory/stock-counts/c1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: the person who created the count cannot approve its variances.", details: [] } }, { status: 403 })));
    const first = view(APPROVE);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Approve and post adjustments" }));
    expect(await screen.findByText(/cannot approve its variances/)).toBeInTheDocument();
    first.unmount();
    view(ADJ);
    await screen.findByText("Submitted");
    expect(screen.queryByRole("button", { name: /Approve|Show variances/ })).toBeNull();
  });
});

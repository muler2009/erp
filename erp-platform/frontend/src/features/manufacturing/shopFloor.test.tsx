import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ProductionOrdersPage, byproductProblem, dispositionProblem, priorityProblem, reworkHoursProblem } from "./ProductionOrdersPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const prod = { id: "p9", sku: "SAWDUST", name: "Sawdust", uom: "kg", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "0" };
const row = (o = {}) => ({ id: "o1", number: "MO-1", product: "p1", sku: "BIKE", bom: "b1", quantity: "5.0000", status: "IN_PROGRESS", planned_start: "2026-12-01", planned_end: "2026-12-05", produced_quantity: "0.0000", scrapped_quantity: "0.0000", standard_unit_cost: "10.0000", ...o });
const op = (o = {}) => ({ id: "x1", sequence: 10, name: "Assemble", work_center: "CNC", status: "IN_PROGRESS", planned_hours: "2", actual_hours: "0", planned_start: null, planned_end: null, is_paused: false, approved: false, ...o });
const detail = (o = {}) => ({ ...row(), priority: 3, is_rework: false, components: [], operations: [op()], checks: [], receipts: [], availability: [], ...o });
const wh = http.get("*/api/v1/inventory/warehouses", () => HttpResponse.json({ results: [{ id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "MAIN", address: "", locations: [{ id: "l1", code: "FG", kind: "STORAGE", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] }], next: null }));
const wcs = http.get("*/api/v1/manufacturing/work-centers", () => HttpResponse.json({ results: [{ id: "wc1", code: "CNC", name: "Cutter", is_active: true, hourly_rate: "10", capacity_hours: "8", calendar: "" }], next: null }));
const base = (d: object) => [
  http.get("*/api/v1/manufacturing/orders", () => HttpResponse.json({ results: [row()], next: null })),
  http.get("*/api/v1/manufacturing/orders/o1", () => HttpResponse.json(d)),
  http.get("*/api/v1/manufacturing/orders/o1/cost", () => HttpResponse.json({ order: "MO-1", status: "IN_PROGRESS", quantity: "5", produced: "0", scrapped: "0", standard_unit_cost: "10", material_cost: "0", conversion_cost: "0", actual_cost: "0", actual_unit_cost: null, standard_cost_of_output: "0", scrap_cost: "0", variance: "0", by_operation: [] })),
  wh, wcs,
];
const post = (path: string, sink: (b: unknown) => void) => http.post(`*/api/v1/manufacturing/${path}`, async ({ request }) => { sink(await request.json().catch(() => ({}))); return HttpResponse.json(detail()); });
const FULL = ["manufacturing.view", "manufacturing.order.manage", "manufacturing.operation.approve", "manufacturing.disposition.approve"];
const open = async () => userEvent.click(await screen.findByRole("button", { name: "Open MO-1" }));

describe("helpers", () => {
  it("validation rules", () => {
    expect(priorityProblem("0")).toMatch(/1/);
    expect(priorityProblem("6")).toMatch(/1/);
    expect(priorityProblem("2")).toBeNull();
    expect(byproductProblem(null, "1", "0")).toMatch(/product/);
    expect(byproductProblem(prod as never, "0", "0")).toMatch(/more than 0/);
    expect(byproductProblem(prod as never, "1", "x")).toMatch(/cost/);
    expect(byproductProblem(prod as never, "1", "0")).toBeNull();
    expect(dispositionProblem("", "n", "")).toMatch(/Choose/);
    expect(dispositionProblem("SCRAP", " ", "")).toMatch(/note/);
    expect(dispositionProblem("RELEASE", "ok", "")).toMatch(/location/);
    expect(dispositionProblem("SCRAP", "ok", "")).toBeNull();
    expect(reworkHoursProblem("", "1")).toMatch(/work centre/);
    expect(reworkHoursProblem("w", "0")).toMatch(/more than 0/);
    expect(reworkHoursProblem("w", "1.5")).toBeNull();
  });
});

describe("shop-floor extras", () => {
  it("pause needs a reason, then pauses", async () => {
    let body: unknown = null;
    server.use(...base(detail()), post("orders/o1/operations/x1/pause", (b) => { body = b; }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Pause Assemble" }));
    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByText("Give a reason for the pause.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Tool change");
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(body).toEqual({ reason: "Tool change" }));
  });

  it("a paused operation shows Paused, can resume and cannot be finished", async () => {
    let hit = false;
    server.use(...base(detail({ operations: [op({ is_paused: true })] })), post("orders/o1/operations/x1/resume", () => { hit = true; }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish Assemble" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Resume Assemble" }));
    await waitFor(() => expect(hit).toBe(true));
  });

  it("approves a finished operation only with the permission", async () => {
    let hit = false;
    const d = detail({ operations: [op({ status: "DONE" })] });
    server.use(...base(d), post("orders/o1/operations/x1/approve", () => { hit = true; }));
    const view = renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Approve Assemble" }));
    await waitFor(() => expect(hit).toBe(true));
    view.unmount();
    renderWithProviders(<ProductionOrdersPage />, { permissions: ["manufacturing.view", "manufacturing.order.manage"] });
    await open();
    await screen.findByText("Done");
    expect(screen.queryByRole("button", { name: "Approve Assemble" })).toBeNull();
  });

  it("changes priority and reschedules", async () => {
    const sent: Record<string, unknown> = {};
    server.use(...base(detail()), post("orders/o1/priority", (b) => { sent.p = b; }), post("orders/o1/reschedule", (b) => { sent.r = b; }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    expect(await screen.findByText(/priority 3/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Change priority" }));
    const field = await screen.findByLabelText(/Priority \(1/);
    await userEvent.clear(field);
    await userEvent.type(field, "9");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/number from 1/)).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, "1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent.p).toEqual({ priority: 1 }));
    await userEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(await screen.findByLabelText("New start date"), { target: { value: "2026-12-10" } });
    await userEvent.click(screen.getAllByRole("button", { name: "Reschedule" }).at(-1)!);
    await waitFor(() => expect(sent.r).toEqual({ start: "2026-12-10" }));
  });

  it("records a by-product", async () => {
    let body: unknown = null;
    server.use(...base(detail()), http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [prod], next: null })), post("orders/o1/byproducts", (b) => { body = b; }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Record by-product" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save by-product" }));
    expect(await screen.findByText("Choose the product.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("combobox", { name: "By-product" }), "saw");
    await userEvent.click(await screen.findByRole("button", { name: /SAWDUST/ }));
    await userEvent.type(screen.getByLabelText("Quantity"), "2");
    await userEvent.clear(screen.getByLabelText("Value per unit"));
    await userEvent.type(screen.getByLabelText("Value per unit"), "1.5");
    await userEvent.click(screen.getByRole("button", { name: "Save by-product" }));
    await waitFor(() => expect(body).toEqual({ product: "p9", quantity: "2", unit_cost: "1.5", kind: "BYPRODUCT", decision: "REUSE" }));
  });

  it("decides on goods on hold: release needs a location", async () => {
    let body: unknown = null;
    const d = detail({ receipts: [{ id: "r1", quantity: "3", lot_code: "L7", status: "ON_HOLD" }] });
    server.use(...base(d), http.post("*/api/v1/manufacturing/receipts/r1/disposition", async ({ request }) => { body = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    expect(await screen.findByText(/on quality hold/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Decide on 3 lot L7/ }));
    await userEvent.selectOptions(await screen.findByLabelText("Decision"), "RELEASE");
    await userEvent.type(screen.getByLabelText("Note"), "Passed retest");
    await userEvent.click(screen.getByRole("button", { name: "Save decision" }));
    expect(await screen.findByText("Choose the storage location to release into.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "MAIN / FG" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText(/Release into/), "l1");
    await userEvent.click(screen.getByRole("button", { name: "Save decision" }));
    await waitFor(() => expect(body).toEqual({ decision: "RELEASE", note: "Passed retest", release_location: "l1" }));
  });

  it("no decision button without the permission", async () => {
    const d = detail({ receipts: [{ id: "r1", quantity: "3", lot_code: "", status: "ON_HOLD" }] });
    server.use(...base(d));
    renderWithProviders(<ProductionOrdersPage />, { permissions: ["manufacturing.view", "manufacturing.order.manage"] });
    await open();
    await screen.findByText(/on quality hold/);
    expect(screen.queryByRole("button", { name: /Decide on/ })).toBeNull();
  });

  it("rework order: books time and finishes rework", async () => {
    const sent: Record<string, unknown> = {};
    server.use(...base(detail({ is_rework: true })), post("orders/o1/rework/time", (b) => { sent.t = b; }), post("orders/o1/rework/finish", (b) => { sent.f = b; }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    expect(await screen.findByText(/rework order/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Book rework time" }));
    await userEvent.selectOptions(await screen.findByLabelText("Work centre"), "wc1");
    await userEvent.type(screen.getByLabelText("Hours"), "1.5");
    await userEvent.click(screen.getByRole("button", { name: "Book" }));
    await waitFor(() => expect(sent.t).toEqual({ work_center: "wc1", hours: "1.5" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish rework" }));
    await waitFor(() => expect(sent.f).toEqual({}));
  });

  it("non-rework orders show no rework buttons", async () => {
    server.use(...base(detail()));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    await screen.findByRole("button", { name: "Record by-product" });
    expect(screen.queryByRole("button", { name: "Finish rework" })).toBeNull();
  });
});

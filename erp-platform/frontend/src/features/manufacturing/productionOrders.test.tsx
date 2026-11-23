import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ProductionOrdersPage, completeOpProblem, issueProblem, orderProblem, receiveProblem, scrapProblem } from "./ProductionOrdersPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const prod = { id: "p1", sku: "BIKE", name: "Bike", uom: "pc", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "0" };
const row = (o = {}) => ({ id: "o1", number: "MO-1", product: "p1", sku: "BIKE", bom: "b1", quantity: "5.0000", status: "DRAFT", planned_start: "2026-12-01", planned_end: "2026-12-05", produced_quantity: "0.0000", scrapped_quantity: "0.0000", standard_unit_cost: "10.0000", ...o });
const detail = (o = {}) => ({ ...row(), components: [{ id: "c1", product: "p2", sku: "CHAIN", required: "5.0000", issued: "0.0000", returned: "0.0000" }],
  operations: [{ id: "x1", sequence: 10, name: "Assemble", work_center: "CNC", status: "PENDING", planned_hours: "2.0000", actual_hours: "0.0000", planned_start: null, planned_end: null }],
  checks: [{ id: "k1", name: "Torque", step_sequence: null, result: "PENDING", specification: "" }], receipts: [], availability: [{ product: "p2", sku: "CHAIN", required: "5", issued: "0", on_hand: "2", short: "3.0000" }], ...o });
const list = (rows: object[]) => http.get("*/api/v1/manufacturing/orders", () => HttpResponse.json({ results: rows, next: null }));
const get = (o = {}) => http.get("*/api/v1/manufacturing/orders/o1", () => HttpResponse.json(detail(o)));
const cost = http.get("*/api/v1/manufacturing/orders/o1/cost", () => HttpResponse.json({ order: "MO-1", status: "IN_PROGRESS", quantity: "5", produced: "0", scrapped: "0", standard_unit_cost: "10", material_cost: "40.0000", conversion_cost: "12.0000", actual_cost: "52.0000", actual_unit_cost: null, standard_cost_of_output: "50.0000", scrap_cost: "0", variance: "2.0000", by_operation: [] }));
const FULL = ["manufacturing.view", "manufacturing.order.manage", "manufacturing.order.approve", "manufacturing.order.close", "manufacturing.quality.check"];
const open = async () => userEvent.click(await screen.findByRole("button", { name: "Open MO-1" }));
const post = (path: string, sink: (b: unknown) => void, status = "IN_PROGRESS") => http.post(`*/api/v1/manufacturing/orders/o1/${path}`, async ({ request }) => { sink(await request.json()); return HttpResponse.json(detail({ status })); });

describe("helpers", () => {
  it("validation rules", () => {
    expect(orderProblem(null, "1", "l", "", "")).toMatch(/product/);
    expect(orderProblem(prod as never, "0", "l", "", "")).toMatch(/more than 0/);
    expect(orderProblem(prod as never, "1", "", "", "")).toMatch(/location/);
    expect(orderProblem(prod as never, "1", "l", "2026-12-05", "2026-12-01")).toMatch(/before/);
    expect(orderProblem(prod as never, "1", "l", "2026-12-01", "2026-12-05")).toBeNull();
    expect(issueProblem("", "1")).toMatch(/material/);
    expect(issueProblem("p", "0")).toMatch(/more than 0/);
    expect(completeOpProblem("", "", "", "")).toMatch(/hours/);
    expect(completeOpProblem("2", "x", "", "")).toMatch(/good/);
    expect(completeOpProblem("2", "", "", "")).toBeNull();
    expect(scrapProblem("OUTPUT", "1", " ", "")).toMatch(/reason/);
    expect(scrapProblem("MATERIAL", "1", "bad", "")).toMatch(/material/);
    expect(scrapProblem("OUTPUT", "1", "bad", "")).toBeNull();
    expect(receiveProblem("0")).toMatch(/more than 0/);
  });
});

describe("ProductionOrdersPage", () => {
  it("empty state; no create button without permission", async () => {
    server.use(list([]));
    renderWithProviders(<ProductionOrdersPage />, { permissions: ["manufacturing.view"] });
    expect(await screen.findByText("No production orders")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New production order" })).toBeNull();
  });

  it("creates an order", async () => {
    let body: unknown = null;
    server.use(list([]),
      http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [prod], next: null })),
      http.get("*/api/v1/inventory/warehouses", () => HttpResponse.json({ results: [{ id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "MAIN", address: "", locations: [{ id: "l1", code: "FG", kind: "STORAGE", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] }], next: null })),
      http.post("*/api/v1/manufacturing/orders", async ({ request }) => { body = await request.json(); return HttpResponse.json(detail(), { status: 201 }); }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await userEvent.click(await screen.findByRole("button", { name: "New production order" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create order" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/product/);
    await userEvent.type(screen.getByRole("combobox", { name: "Product to make" }), "bi");
    await userEvent.click(await screen.findByRole("button", { name: /BIKE/ }));
    await userEvent.clear(screen.getByLabelText("Quantity"));
    await userEvent.type(screen.getByLabelText("Quantity"), "5");
    await waitFor(() => expect(screen.getByRole("option", { name: "MAIN / FG" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Finished goods go to"), "l1");
    await userEvent.click(screen.getByRole("button", { name: "Create order" }));
    await waitFor(() => expect(body).toEqual({ product: "p1", quantity: "5", location: "l1" }));
  });

  it("draft order: approve and release; shortage is shown", async () => {
    const hits: string[] = [];
    server.use(list([row()]), get(),
      http.post("*/api/v1/manufacturing/orders/o1/approve", () => { hits.push("approve"); return HttpResponse.json(detail()); }),
      http.post("*/api/v1/manufacturing/orders/o1/release", () => { hits.push("release"); return HttpResponse.json(detail({ status: "RELEASED" })); }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    expect(await screen.findByText("3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(hits).toEqual(["approve", "release"]));
  });

  it("hides actions without permission", async () => {
    server.use(list([row()]), get());
    renderWithProviders(<ProductionOrdersPage />, { permissions: ["manufacturing.view"] });
    await open();
    await screen.findByText("CHAIN");
    for (const n of ["Approve", "Release", "Cancel order"]) expect(screen.queryByRole("button", { name: n })).toBeNull();
  });

  it("running order: issue material, start and finish operation", async () => {
    const sent: Record<string, unknown> = {};
    server.use(list([row({ status: "IN_PROGRESS" })]), get({ status: "IN_PROGRESS" }), cost,
      post("issue", (b) => { sent.issue = b; }), post("operations/x1/start", (b) => { sent.start = b; }), post("operations/x1/complete", (b) => { sent.finish = b; }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    expect(await screen.findByText("Actual total")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Issue a material" }));
    await userEvent.click(await screen.findByRole("button", { name: "Issue" }));
    expect(await screen.findByText("Choose the material.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Material"), "p2");
    await userEvent.type(screen.getByLabelText("Quantity"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Issue" }));
    await waitFor(() => expect(sent.issue).toEqual({ product: "p2", quantity: "5" }));
    await userEvent.click(screen.getByRole("button", { name: "Start Assemble" }));
    await waitFor(() => expect(sent.start).toEqual({}));
  });

  it("finish operation sends hours and defaults", async () => {
    let body: unknown = null;
    server.use(list([row({ status: "IN_PROGRESS" })]), get({ status: "IN_PROGRESS", operations: [{ id: "x1", sequence: 10, name: "Assemble", work_center: "CNC", status: "IN_PROGRESS", planned_hours: "2", actual_hours: "0", planned_start: null, planned_end: null }] }), cost, post("operations/x1/complete", (b) => { body = b; }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Finish Assemble" }));
    await userEvent.click(await screen.findByRole("button", { name: "Finish" }));
    expect(await screen.findByText("Enter the hours worked, or 0.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Hours worked"), "2.5");
    await userEvent.type(screen.getByLabelText("Good quantity"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(body).toEqual({ hours: "2.5", good: "5", defective: "0", rework: "0", notes: "" }));
  });

  it("records a quality check, reports scrap and receives output", async () => {
    const sent: Record<string, unknown> = {};
    server.use(list([row({ status: "IN_PROGRESS" })]), get({ status: "IN_PROGRESS" }), cost,
      post("checks/k1", (b) => { sent.check = b; }), post("scrap", (b) => { sent.scrap = b; }), post("receive", (b) => { sent.receive = b; }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Record Torque" }));
    await userEvent.selectOptions(await screen.findByLabelText("Result"), "FAIL");
    await userEvent.click(screen.getByRole("button", { name: "Save result" }));
    await waitFor(() => expect(sent.check).toEqual({ result: "FAIL", measured: "", note: "" }));
    await userEvent.click(screen.getByRole("button", { name: "Report scrap" }));
    await userEvent.type(await screen.findByLabelText("Quantity"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(await screen.findByText("A reason is required.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Cracked frame");
    await userEvent.click(screen.getByRole("button", { name: "Report" }));
    await waitFor(() => expect(sent.scrap).toEqual({ kind: "OUTPUT", quantity: "1", reason: "Cracked frame" }));
    await userEvent.click(screen.getByRole("button", { name: "Receive output" }));
    await userEvent.type(await screen.findByLabelText("Quantity made"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Receive" }));
    await waitFor(() => expect(sent.receive).toEqual({ quantity: "4" }));
  });

  it("hold needs a reason; the server's refusal is shown on close", async () => {
    let hold: unknown = null;
    server.use(list([row({ status: "COMPLETED" })]), get({ status: "COMPLETED" }), cost,
      http.post("*/api/v1/manufacturing/orders/o1/close", () => HttpResponse.json({ error: { code: "checks_pending", message: "Final inspection must pass before closing." } }, { status: 409 })),
      post("hold", (b) => { hold = b; }));
    renderWithProviders(<ProductionOrdersPage />, { permissions: FULL });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Close order" }));
    expect(await screen.findByText("Final inspection must pass before closing.")).toBeInTheDocument();
    expect(hold).toBeNull();
  });
});

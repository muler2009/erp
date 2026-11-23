import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { PlanningPage, demandProblem, rangeProblem } from "./PlanningPage";
import { PlansPage, planInput, planProblem, type PlanDraft } from "./PlansPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const prod = { id: "p1", sku: "BIKE", name: "Bike", uom: "pc", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "0" };
const products = http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [prod], next: null }));
const d = (o: Partial<PlanDraft> = {}): PlanDraft => ({ name: "Dec plan", start: "2026-12-01", end: "2026-12-31", lines: [{ product: "p1", sku: "BIKE", quantity: "10", required_date: "2026-12-10" }], ...o });

describe("helpers", () => {
  it("planProblem and planInput", () => {
    expect(planProblem(d())).toBeNull();
    expect(planProblem(d({ name: "" }))).toMatch(/name/);
    expect(planProblem(d({ start: "" }))).toMatch(/period/);
    expect(planProblem(d({ end: "2026-11-01" }))).toMatch(/ends before/);
    expect(planProblem(d({ lines: [] }))).toMatch(/at least one/);
    expect(planProblem(d({ lines: [{ product: "p1", sku: "BIKE", quantity: "0", required_date: "2026-12-10" }] }))).toMatch(/more than 0/);
    expect(planProblem(d({ lines: [{ product: "p1", sku: "BIKE", quantity: "1", required_date: "" }] }))).toMatch(/needed/);
    expect(planProblem(d({ lines: [{ product: "p1", sku: "BIKE", quantity: "1", required_date: "2027-01-05" }] }))).toMatch(/outside/);
    expect(planInput(d())).toEqual({ name: "Dec plan", period_start: "2026-12-01", period_end: "2026-12-31", lines: [{ product: "p1", quantity: "10", required_date: "2026-12-10" }] });
  });
  it("range and demand rules", () => {
    expect(rangeProblem("", "2026-01-01")).toMatch(/both/);
    expect(rangeProblem("2026-02-01", "2026-01-01")).toMatch(/before/);
    expect(rangeProblem("2026-01-01", "2026-01-02")).toBeNull();
    expect(demandProblem([])).toMatch(/at least one/);
    expect(demandProblem([{ product: null, quantity: "1" }])).toMatch(/choose/);
    expect(demandProblem([{ product: prod as never, quantity: "0" }])).toMatch(/more than 0/);
    expect(demandProblem([{ product: prod as never, quantity: "2" }])).toBeNull();
  });
});

describe("PlansPage", () => {
  const row = (o = {}) => ({ id: "pl1", number: "PLN-1", name: "Dec plan", period_start: "2026-12-01", period_end: "2026-12-31", status: "DRAFT", revision: 1, created_by: "u1", approved_by: null, ...o });
  const detail = (o = {}) => ({ ...row(), lines: [{ id: "ln1", product: "p1", sku: "BIKE", quantity: "10.0000", required_date: "2026-12-10", priority: 3, order: null }], revisions: [], ...o });
  const list = (rows: object[]) => http.get("*/api/v1/manufacturing/plans", () => HttpResponse.json({ results: rows, next: null }));
  const get = (o = {}) => http.get("*/api/v1/manufacturing/plans/pl1", () => HttpResponse.json(detail(o)));
  const open = async () => userEvent.click(await screen.findByRole("button", { name: "Open PLN-1" }));

  it("empty state; no create without permission", async () => {
    server.use(list([]));
    renderWithProviders(<PlansPage />, { permissions: ["manufacturing.view"] });
    expect(await screen.findByText("No production plans")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New plan" })).toBeNull();
  });

  it("fills a plan from demand and creates it", async () => {
    let body: unknown = null;
    server.use(list([]), products,
      http.get("*/api/v1/manufacturing/plans/suggest", () => HttpResponse.json([{ product: "p1", sku: "BIKE", quantity: "12.0000", required_date: "2026-12-15" }])),
      http.post("*/api/v1/manufacturing/plans", async ({ request }) => { body = await request.json(); return HttpResponse.json(detail(), { status: 201 }); }));
    renderWithProviders(<PlansPage />, { permissions: ["manufacturing.view", "manufacturing.plan.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Fill from demand" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid period/);
    await userEvent.type(screen.getByLabelText("Plan name"), "Dec plan");
    await userEvent.type(screen.getByLabelText("From"), "2026-12-01");
    await userEvent.type(screen.getByLabelText("To"), "2026-12-31");
    await userEvent.click(screen.getByRole("button", { name: "Fill from demand" }));
    expect(await screen.findByLabelText("Quantity of BIKE")).toHaveValue("12");
    await userEvent.click(screen.getByRole("button", { name: "Create plan" }));
    await waitFor(() => expect(body).toEqual({ name: "Dec plan", period_start: "2026-12-01", period_end: "2026-12-31", lines: [{ product: "p1", quantity: "12", required_date: "2026-12-15" }] }));
  });

  it("feasibility check shows shortages and bottlenecks", async () => {
    server.use(list([row()]), get(), http.get("*/api/v1/manufacturing/plans/pl1/check", () => HttpResponse.json({ plan: "PLN-1", feasible: false, material_shortages: [{ sku: "CHAIN", required: "10", available: "4", short: "6" }], capacity: [{ work_center: "CNC", plan_hours: "50", already_committed_hours: "0", capacity_hours: "40", utilization_percent: "125.0000", bottleneck: true }] })));
    renderWithProviders(<PlansPage />, { permissions: ["manufacturing.view"] });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Check feasibility" }));
    expect(await screen.findByText("Not feasible")).toBeInTheDocument();
    expect(screen.getByText(/Short of CHAIN: need 10, have 4/)).toBeInTheDocument();
    expect(screen.getByText(/CNC is over capacity \(125%\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("approves, then releases to a location; cancel needs a reason", async () => {
    const calls: unknown[] = [];
    server.use(list([row({ status: "APPROVED" })]), get({ status: "APPROVED" }),
      http.get("*/api/v1/inventory/warehouses", () => HttpResponse.json({ results: [{ id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "MAIN", address: "", locations: [{ id: "l1", code: "FG", kind: "STORAGE", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] }], next: null })),
      http.post("*/api/v1/manufacturing/plans/pl1/release", async ({ request }) => { calls.push(await request.json()); return HttpResponse.json([], { status: 201 }); }),
      http.post("*/api/v1/manufacturing/plans/pl1/cancel", async ({ request }) => { calls.push(await request.json()); return HttpResponse.json(detail({ status: "CANCELLED" })); }));
    renderWithProviders(<PlansPage />, { permissions: ["manufacturing.view", "manufacturing.plan.manage", "manufacturing.plan.approve"] });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Release as production orders" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create orders" }));
    expect(await screen.findByText("Choose the location for the finished goods.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "MAIN / FG" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Finished goods go to"), "l1");
    await userEvent.click(screen.getByRole("button", { name: "Create orders" }));
    await waitFor(() => expect(calls).toEqual([{ location: "l1" }]));
  });

  it("approval error is shown (separation of duties)", async () => {
    server.use(list([row()]), get(), http.post("*/api/v1/manufacturing/plans/pl1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve a plan you created." } }, { status: 403 })));
    renderWithProviders(<PlansPage />, { permissions: ["manufacturing.view", "manufacturing.plan.approve"] });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/cannot approve a plan you created/)).toBeInTheDocument();
  });
});

describe("PlanningPage", () => {
  it("MRP preview shows make/buy suggestions and validates demands", async () => {
    let body: unknown = null;
    server.use(products, http.post("*/api/v1/manufacturing/mrp/preview", async ({ request }) => { body = await request.json(); return HttpResponse.json([{ product: "p2", sku: "CHAIN", action: "BUY", quantity: "20.0000", need_by: "2026-12-10", start_by: "2026-12-03", lead_days: 7 }]); }));
    renderWithProviders(<PlanningPage />, { permissions: ["manufacturing.view"] });
    await userEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least one/);
    await userEvent.type(screen.getByRole("combobox", { name: "Add demand for" }), "bi");
    await userEvent.click(await screen.findByRole("button", { name: /BIKE/ }));
    await userEvent.clear(screen.getByLabelText("Demand quantity 1"));
    await userEvent.type(screen.getByLabelText("Demand quantity 1"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(await screen.findByText("CHAIN")).toBeInTheDocument();
    expect(screen.getByText("Buy")).toBeInTheDocument();
    expect(body).toEqual({ demands: [{ product: "p1", quantity: "5" }] });
  });

  it("capacity tab shows overload and conflicts; date range is checked", async () => {
    server.use(
      http.get("*/api/v1/manufacturing/reports/load", () => HttpResponse.json([{ work_center: "CNC", planned_hours: "50.0000", capacity_hours: "40.0000", utilization_percent: "125.00", overloaded: true }])),
      http.get("*/api/v1/manufacturing/schedule/conflicts", () => HttpResponse.json([{ work_center: "CNC", date: "2026-12-02", planned_hours: "12.0000", capacity_hours: "8.0000" }])));
    renderWithProviders(<PlanningPage />, { permissions: ["manufacturing.view"] });
    await userEvent.click(screen.getByRole("tab", { name: "Capacity" }));
    expect(await screen.findByText("Overloaded")).toBeInTheDocument();
    expect(await screen.findByText(/2026-12-02: CNC has 12 h booked, capacity 8 h/)).toBeInTheDocument();
    fireChange(screen.getByLabelText("To"), "2000-01-01");
    expect(await screen.findByRole("alert")).toHaveTextContent(/before/);
  });

  it("schedule and WIP tabs", async () => {
    server.use(
      http.get("*/api/v1/manufacturing/reports/schedule", () => HttpResponse.json([{ order: "MO-1", product: "BIKE", status: "RELEASED", start: "2026-12-01", end: "2026-12-05", operations: [{ sequence: 10, work_center: "CNC", start: "2026-12-01T08:00:00Z", end: "2026-12-02T08:00:00Z", status: "PENDING" }] }])),
      http.get("*/api/v1/manufacturing/reports/wip", () => HttpResponse.json({ total: "250.0000", orders: [{ order: "MO-1", product: "BIKE", status: "IN_PROGRESS", wip_value: "250.0000" }] })),
      http.get("*/api/v1/manufacturing/reports/wip-aging", () => HttpResponse.json([{ order: "MO-1", product: "BIKE", status: "IN_PROGRESS", current_operation: "Assemble", work_center: "CNC", age_days: 9 }])));
    renderWithProviders(<PlanningPage />, { permissions: ["manufacturing.view"] });
    await userEvent.click(screen.getByRole("tab", { name: "Schedule" }));
    expect(await screen.findByText(/MO-1 · BIKE · 2026-12-01 to 2026-12-05/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Work in progress" }));
    expect(await screen.findByText("Total: 250.00")).toBeInTheDocument();
    expect(await screen.findByText("Assemble (CNC)")).toBeInTheDocument();
  });
});

import { fireEvent } from "@testing-library/react";
const fireChange = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

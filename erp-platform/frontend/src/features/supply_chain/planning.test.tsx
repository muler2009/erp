import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ForecastsPage, forecastProblem } from "./ForecastsPage";
import { ReplenishmentPage, adjustProblem } from "./ReplenishmentPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null });
const prod = { id: "p1", sku: "WIDGET", name: "Widget", uom: "pc", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "0" };
const products = http.get("*/api/v1/inventory/products", () => page([prod]));
const fc = (o = {}) => ({ id: "f1", product: "p1", sku: "WIDGET", period_start: "2026-12-01", quantity: "10.0000", method: "MANUAL", status: "DRAFT", ...o });
const accuracy = http.get("*/api/v1/supply-chain/forecasts/accuracy", () => HttpResponse.json([]));
const PLAN = ["supply_chain.view", "supply_chain.plan.manage", "supply_chain.plan.approve"];

describe("helpers", () => {
  it("validate", () => {
    expect(forecastProblem(null, "2026-12-01", "1")).toMatch(/product/);
    expect(forecastProblem(prod as never, "", "1")).toMatch(/month/);
    expect(forecastProblem(prod as never, "2026-12-01", "x")).toMatch(/number/);
    expect(forecastProblem(prod as never, "2026-12-01", "0")).toBeNull();
    const cur = { quantity: "10.0000", need_by: "2026-12-10" };
    expect(adjustProblem("", "", "r", cur)).toMatch(/Change/);
    expect(adjustProblem("0", "", "r", cur)).toMatch(/more than 0/);
    expect(adjustProblem("10", "", "r", cur)).toMatch(/Nothing/);
    expect(adjustProblem("12", "", " ", cur)).toMatch(/reason/);
    expect(adjustProblem("12", "", "r", cur)).toBeNull();
    expect(adjustProblem("", "2026-12-20", "r", cur)).toBeNull();
  });
});

describe("ForecastsPage", () => {
  it("empty state; read-only users see no buttons", async () => {
    server.use(http.get("*/api/v1/supply-chain/forecasts", () => page([])), accuracy);
    renderWithProviders(<ForecastsPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("No forecasts")).toBeInTheDocument();
    expect(await screen.findByText("No approved forecasts to compare")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set a forecast" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate from history" })).toBeNull();
  });

  it("sets a forecast", async () => {
    let body: unknown = null;
    server.use(http.get("*/api/v1/supply-chain/forecasts", () => page([])), accuracy, products, http.post("*/api/v1/supply-chain/forecasts", async ({ request }) => { body = await request.json(); return HttpResponse.json(fc(), { status: 201 }); }));
    renderWithProviders(<ForecastsPage />, { permissions: PLAN });
    await userEvent.click(await screen.findByRole("button", { name: "Set a forecast" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save forecast" }));
    expect(await screen.findByText("Choose the product.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("combobox", { name: "Product" }), "wid");
    await userEvent.click(await screen.findByRole("button", { name: /WIDGET/ }));
    fireEvent.change(screen.getByLabelText("Any date in the month"), { target: { value: "2026-12-15" } });
    await userEvent.type(screen.getByLabelText("Expected demand"), "25");
    await userEvent.click(screen.getByRole("button", { name: "Save forecast" }));
    await waitFor(() => expect(body).toEqual({ product: "p1", period_start: "2026-12-15", quantity: "25" }));
  });

  it("generates from history and reports the result", async () => {
    server.use(http.get("*/api/v1/supply-chain/forecasts", () => page([])), accuracy, http.post("*/api/v1/supply-chain/forecasts/generate", () => HttpResponse.json([fc(), fc({ id: "f2" })], { status: 201 })));
    renderWithProviders(<ForecastsPage />, { permissions: PLAN });
    await userEvent.click(await screen.findByRole("button", { name: "Generate from history" }));
    expect(await screen.findByText("Created 2 draft forecasts from sales history.")).toBeInTheDocument();
  });

  it("approve shows the separation-of-duties refusal; approved rows can be revoked", async () => {
    let revoked = false;
    server.use(http.get("*/api/v1/supply-chain/forecasts", () => page([fc(), fc({ id: "f2", sku: "GADGET", status: "APPROVED", method: "HISTORY" })])), accuracy,
      http.post("*/api/v1/supply-chain/forecasts/f1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve a forecast you created." } }, { status: 403 })),
      http.post("*/api/v1/supply-chain/forecasts/f2/revoke", () => { revoked = true; return HttpResponse.json(fc()); }));
    renderWithProviders(<ForecastsPage />, { permissions: PLAN });
    await userEvent.click(await screen.findByRole("button", { name: "Approve WIDGET 2026-12" }));
    expect(await screen.findByText("You cannot approve a forecast you created.")).toBeInTheDocument();
    expect(screen.getByText("From history")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revoke GADGET 2026-12" }));
    await waitFor(() => expect(revoked).toBe(true));
  });

  it("without approve permission there are no approve buttons", async () => {
    server.use(http.get("*/api/v1/supply-chain/forecasts", () => page([fc()])), accuracy);
    renderWithProviders(<ForecastsPage />, { permissions: ["supply_chain.view", "supply_chain.plan.manage"] });
    await screen.findByText("WIDGET");
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("shows accuracy rows", async () => {
    server.use(http.get("*/api/v1/supply-chain/forecasts", () => page([])), http.get("*/api/v1/supply-chain/forecasts/accuracy", () => HttpResponse.json([{ product: "WIDGET", period: "2026-10-01", forecast: "10.0000", actual: "8.0000", error_pct: "25.00" }])));
    renderWithProviders(<ForecastsPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("25%")).toBeInTheDocument();
  });
});

describe("ReplenishmentPage", () => {
  const sg = (o = {}) => ({ id: "g1", product: "p1", sku: "WIDGET", action: "BUY", quantity: "10.0000", need_by: "2026-12-10", start_by: "2026-12-01", lead_days: 9, supplier_id: null, status: "OPEN", note: "", converted_ref_type: "", converted_ref_id: null, ...o });
  const plan = { id: "sp1", number: "SPL-1", plan_date: "2026-11-20", status: "DRAFT", revision: 1, created_by: "u1", approved_by: null };
  const base = (rows: object[]) => [http.get("*/api/v1/supply-chain/replenishment/suggestions", () => page(rows)), http.get("*/api/v1/supply-chain/plans", () => page([plan])),
    http.get("*/api/v1/inventory/warehouses", () => page([{ id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "MAIN", address: "", locations: [{ id: "l1", code: "FG", kind: "STORAGE", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] }]))];

  it("runs planning and reports", async () => {
    server.use(...base([]), http.post("*/api/v1/supply-chain/replenishment/run", () => HttpResponse.json({ run: "r", suggestions: [sg()] }, { status: 201 })));
    renderWithProviders(<ReplenishmentPage />, { permissions: PLAN });
    expect(await screen.findByText("No open suggestions")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run planning" }));
    expect(await screen.findByText(/1 suggestion\./)).toBeInTheDocument();
  });

  it("a buy suggestion becomes a requisition in one click; a make suggestion needs a location", async () => {
    const bodies: unknown[] = [];
    server.use(...base([sg(), sg({ id: "g2", sku: "FRAME", action: "MAKE" })]),
      http.post("*/api/v1/supply-chain/replenishment/suggestions/g1/convert", async ({ request }) => { bodies.push(await request.json()); return HttpResponse.json(sg({ status: "CONVERTED" })); }),
      http.post("*/api/v1/supply-chain/replenishment/suggestions/g2/convert", async ({ request }) => { bodies.push(await request.json()); return HttpResponse.json(sg({ status: "CONVERTED" })); }));
    renderWithProviders(<ReplenishmentPage />, { permissions: PLAN });
    await userEvent.click(await screen.findByRole("button", { name: "Create requisition for WIDGET" }));
    await waitFor(() => expect(bodies).toEqual([{}]));
    await userEvent.click(screen.getByRole("button", { name: "Create order for FRAME" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create order" }));
    expect(await screen.findByText("Choose the location for the finished goods.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "MAIN / FG" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Finished goods go to"), "l1");
    await userEvent.click(screen.getByRole("button", { name: "Create order" }));
    await waitFor(() => expect(bodies[1]).toEqual({ location: "l1" }));
  });

  it("dismiss needs a reason; adjust sends only what changed", async () => {
    const sent: Record<string, unknown> = {};
    server.use(...base([sg()]),
      http.post("*/api/v1/supply-chain/replenishment/suggestions/g1/dismiss", async ({ request }) => { sent.d = await request.json(); return HttpResponse.json(sg()); }),
      http.post("*/api/v1/supply-chain/replenishment/suggestions/g1/adjust", async ({ request }) => { sent.a = await request.json(); return HttpResponse.json(sg()); }));
    renderWithProviders(<ReplenishmentPage />, { permissions: PLAN });
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss WIDGET" }));
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Give a reason for dismissing.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Not needed");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(sent.d).toEqual({ note: "Not needed" }));
    await userEvent.click(await screen.findByRole("button", { name: "Adjust WIDGET" }));
    await userEvent.type(await screen.findByLabelText("New quantity"), "15");
    await userEvent.type(screen.getByLabelText("Reason"), "Bigger order");
    await userEvent.click(screen.getByRole("button", { name: "Save change" }));
    await waitFor(() => expect(sent.a).toEqual({ quantity: "15", reason: "Bigger order" }));
  });

  it("read-only users see suggestions without actions", async () => {
    server.use(...base([sg()]));
    renderWithProviders(<ReplenishmentPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("WIDGET")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run planning" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Create requisition/ })).toBeNull();
  });

  it("opens a supply plan, shows balance and changes, and approves", async () => {
    let approved = false;
    server.use(...base([]),
      http.get("*/api/v1/supply-chain/plans/sp1", () => HttpResponse.json({ ...plan, balance: { items: [{ product: "p1", sku: "WIDGET", available: "2", inbound: "0", demand: "12", projected: "-10", shortage: "10", surplus: "0" }] }, suggestions: [sg()], changes: [{ revision: 2, suggestion: "g1", field: "need_by", old: "2026-12-10", new: "2026-12-20", reason: "Late order", by: "u2", at: "x" }] })),
      http.post("*/api/v1/supply-chain/plans/sp1/approve", () => { approved = true; return HttpResponse.json({ ...plan, status: "APPROVED", balance: {}, suggestions: [], changes: [] }); }));
    renderWithProviders(<ReplenishmentPage />, { permissions: PLAN });
    await userEvent.click(await screen.findByRole("button", { name: "Open SPL-1" }));
    expect(await screen.findByText(/need by 2026-12-10 → 2026-12-20/)).toBeInTheDocument();
    expect(screen.getByText("Demand against supply")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(approved).toBe(true));
  });
});

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { LogisticsReportsPage } from "./LogisticsReportsPage";
import { LogisticsSetupPage, carrierProblem, routeProblem } from "./LogisticsSetupPage";
import { ShipmentsPage, costProblem, exceptionProblem, receiptProblem, shipmentInput, shipmentProblem, type ShipDraft } from "./ShipmentsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const MANAGE = ["supply_chain.view", "supply_chain.logistics.manage"];
const carrier = (o = {}) => ({ id: "c1", code: "DHL", name: "DHL Express", mode: "COURIER", contact: "", is_active: true, ...o });
const route = (o = {}) => ({ id: "r1", code: "R1", name: "Addis-Adama", origin: "Addis", destination: "Adama", distance_km: "90.00", transit_days: 2, carrier: "c1", is_active: true, ...o });
const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null });
const carriers = http.get("*/api/v1/supply-chain/carriers", () => page([carrier()]));
const routes = http.get("*/api/v1/supply-chain/routes", () => page([route()]));
const row = (o = {}) => ({ id: "s1", number: "SHP-1", kind: "OUTBOUND", status: "PLANNED", carrier: "c1", route: null, origin: "Addis", destination: "Adama", planned_dispatch: "2026-12-01", planned_arrival: "2026-12-04", actual_dispatch: null, actual_arrival: null, tracking_ref: "", weight_kg: "100", pod_received_by: "", pod_at: null, ...o });
const detail = (o = {}) => ({ ...row(), lines: [{ id: "ln1", product: null, description: "Pallet", quantity: "4.0000", received: null, damaged: "0", discrepancy_note: "" }], events: [{ status: "PLANNED", location: "", note: "Shipment planned", at: "2026-11-20T08:00:00Z" }], costs: [], exceptions: [], ...o });
const vehiclesH = http.get("*/api/v1/supply-chain/vehicles", () => page([{ id: "v1", code: "TRK-1", plate: "AA123", vehicle_type: "Truck", capacity_kg: "1000.00", capacity_m3: "10.00", carrier: null, is_active: true }]));
const serve = (o = {}, status = "PLANNED") => [vehiclesH, http.get("*/api/v1/supply-chain/shipments", () => page([row({ status })])), http.get("*/api/v1/supply-chain/shipments/s1", () => HttpResponse.json(detail({ status, ...o })))];
const open = async () => userEvent.click(await screen.findByRole("button", { name: "Open SHP-1" }));
const post = (path: string, sink: (b: unknown) => void) => http.post(`*/api/v1/supply-chain/shipments/s1/${path}`, async ({ request }) => { sink(await request.json()); return HttpResponse.json(detail()); });

const draft = (o: Partial<ShipDraft> = {}): ShipDraft => ({ kind: "OUTBOUND", origin: "A", destination: "B", dispatch: "2026-12-01", arrival: "2026-12-03", carrier: "", route: "", weight: "", tracking: "", lines: [{ description: "Box", quantity: "2" }], ...o });

describe("helpers", () => {
  it("validate shipments, costs, problems, receipts, carriers and routes", () => {
    expect(shipmentProblem(draft({ origin: " " }), false)).toMatch(/from and to/);
    expect(shipmentProblem(draft({ dispatch: "" }), false)).toMatch(/dispatch/);
    expect(shipmentProblem(draft({ arrival: "" }), false)).toMatch(/arrival/);
    expect(shipmentProblem(draft({ arrival: "" }), true)).toBeNull();
    expect(shipmentProblem(draft({ arrival: "2026-11-30" }), false)).toMatch(/before/);
    expect(shipmentProblem(draft({ weight: "x" }), false)).toMatch(/Weight/);
    expect(shipmentProblem(draft({ lines: [] }), false)).toMatch(/at least one/);
    expect(shipmentProblem(draft({ lines: [{ description: "", quantity: "1" }] }), false)).toMatch(/describe/);
    expect(shipmentProblem(draft({ lines: [{ description: "x", quantity: "0" }] }), false)).toMatch(/more than 0/);
    expect(shipmentInput(draft({ carrier: "c1" }))).toEqual({ kind: "OUTBOUND", origin: "A", destination: "B", planned_dispatch: "2026-12-01", planned_arrival: "2026-12-03", carrier: "c1", lines: [{ description: "Box", quantity: "2" }] });
    expect(costProblem("", "1")).toMatch(/kind/);
    expect(costProblem("FUEL", "0")).toMatch(/more than 0/);
    expect(costProblem("FUEL", "12.5")).toBeNull();
    expect(exceptionProblem("", "x")).toMatch(/went wrong/);
    expect(exceptionProblem("DELAY", " ")).toMatch(/Describe/);
    const r = { id: "l", shipped: 4, received: "4", damaged: "0", note: "" };
    expect(receiptProblem([{ ...r, received: "5" }])).toMatch(/more than was shipped/);
    expect(receiptProblem([{ ...r, damaged: "9" }])).toMatch(/Damaged/);
    expect(receiptProblem([{ ...r, received: "x" }])).toMatch(/numbers/);
    expect(receiptProblem([r])).toBeNull();
    expect(carrierProblem("", "x")).toMatch(/code/);
    expect(carrierProblem("D", " ")).toMatch(/name/);
    const rt = { code: "R", name: "n", origin: "a", destination: "b", km: "10", days: "2" };
    expect(routeProblem({ ...rt, km: "x" })).toMatch(/Distance/);
    expect(routeProblem({ ...rt, days: "0" })).toMatch(/at least 1/);
    expect(routeProblem(rt)).toBeNull();
  });
});

describe("ShipmentsPage", () => {
  it("empty state, no create button without permission", async () => {
    server.use(http.get("*/api/v1/supply-chain/shipments", () => page([])));
    renderWithProviders(<ShipmentsPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("No shipments")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New shipment" })).toBeNull();
  });

  it("filters by status", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/supply-chain/shipments", ({ request }) => { seen.push(new URL(request.url).search); return page([]); }));
    renderWithProviders(<ShipmentsPage />, { permissions: ["supply_chain.view"] });
    await screen.findByText("No shipments");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "DELIVERED");
    await waitFor(() => expect(seen.some((s) => s.includes("status=DELIVERED"))).toBe(true));
  });

  it("creates a shipment, picking a route fills the places and carrier", async () => {
    let body: unknown = null;
    server.use(http.get("*/api/v1/supply-chain/shipments", () => page([])), carriers, routes, http.post("*/api/v1/supply-chain/shipments", async ({ request }) => { body = await request.json(); return HttpResponse.json(detail(), { status: 201 }); }));
    renderWithProviders(<ShipmentsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "New shipment" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create shipment" }));
    expect(await screen.findByText("Say where it is going from and to.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: /R1 — Addis to Adama/ })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Route (optional)"), "r1");
    expect(screen.getByLabelText("From")).toHaveValue("Addis");
    fireEvent.change(screen.getByLabelText("Dispatch date"), { target: { value: "2026-12-01" } });
    await userEvent.type(screen.getByLabelText("Item 1 description"), "Pallet");
    await userEvent.click(screen.getByRole("button", { name: "Create shipment" }));
    await waitFor(() => expect(body).toEqual({ kind: "OUTBOUND", origin: "Addis", destination: "Adama", planned_dispatch: "2026-12-01", carrier: "c1", route: "r1", lines: [{ description: "Pallet", quantity: "1" }] }));
  });

  it("dispatches a planned shipment", async () => {
    let body: unknown = null;
    server.use(...serve(), post("dispatch", (b) => { body = b; }));
    renderWithProviders(<ShipmentsPage />, { permissions: MANAGE });
    await open();
    expect(screen.queryByRole("button", { name: "Confirm delivery" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Dispatch" }));
    await userEvent.type(await screen.findByLabelText("Leaving from"), "Main gate");
    await userEvent.click(screen.getAllByRole("button", { name: "Dispatch" }).at(-1)!);
    await waitFor(() => expect(body).toEqual({ location: "Main gate", note: "" }));
  });

  it("confirms delivery with a shortfall and damage per item", async () => {
    let body: unknown = null;
    server.use(...serve({}, "IN_TRANSIT"), post("deliver", (b) => { body = b; }));
    renderWithProviders(<ShipmentsPage />, { permissions: MANAGE });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Confirm delivery" }));
    await userEvent.type(await screen.findByLabelText("Received by"), "Abebe");
    const rec = screen.getByLabelText("Received of Pallet");
    await userEvent.clear(rec);
    await userEvent.type(rec, "9");
    await userEvent.click(screen.getAllByRole("button", { name: "Confirm delivery" }).at(-1)!);
    expect(await screen.findByText("Received cannot be more than was shipped.")).toBeInTheDocument();
    await userEvent.clear(rec);
    await userEvent.type(rec, "3");
    await userEvent.clear(screen.getByLabelText("Damaged of Pallet"));
    await userEvent.type(screen.getByLabelText("Damaged of Pallet"), "1");
    await userEvent.click(screen.getAllByRole("button", { name: "Confirm delivery" }).at(-1)!);
    await waitFor(() => expect(body).toEqual({ received_by: "Abebe", note: "", lines: [{ line: "ln1", received: "3", damaged: "1", note: "" }] }));
  });

  it("adds a cost and reports a problem; shows the server's refusal", async () => {
    const sent: Record<string, unknown> = {};
    server.use(...serve({}, "DISPATCHED"), post("costs", (b) => { sent.cost = b; }),
      http.post("*/api/v1/supply-chain/shipments/s1/exceptions", () => HttpResponse.json({ error: { code: "invalid", message: "Cannot report on this shipment." } }, { status: 400 })));
    renderWithProviders(<ShipmentsPage />, { permissions: MANAGE });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Add cost" }));
    await userEvent.selectOptions(await screen.findByLabelText("Kind of cost"), "FUEL");
    await userEvent.type(screen.getByLabelText("Amount"), "12.5");
    await userEvent.click(screen.getAllByRole("button", { name: "Add cost" }).at(-1)!);
    await waitFor(() => expect(sent.cost).toEqual({ cost_type: "FUEL", amount: "12.5", description: "" }));
    await userEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    await userEvent.selectOptions(await screen.findByLabelText("What went wrong"), "DELAY");
    await userEvent.type(screen.getByLabelText("Description"), "Road closed");
    await userEvent.click(screen.getAllByRole("button", { name: "Report" }).at(-1)!);
    expect(await screen.findByText("Cannot report on this shipment.")).toBeInTheDocument();
  });

  it("cancel needs a reason; delivered shipments offer no actions; no actions without permission", async () => {
    let body: unknown = null;
    server.use(...serve(), post("cancel", (b) => { body = b; }));
    const v = renderWithProviders(<ShipmentsPage />, { permissions: MANAGE });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel shipment" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Cancel shipment" }).at(-1)!);
    expect(await screen.findByText("Give a reason for cancelling.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Order cancelled");
    await userEvent.click(screen.getAllByRole("button", { name: "Cancel shipment" }).at(-1)!);
    await waitFor(() => expect(body).toEqual({ reason: "Order cancelled" }));
    v.unmount();
    server.use(...serve({ pod_received_by: "Abebe", pod_at: "2026-12-04T10:00:00Z" }, "DELIVERED"));
    const w = renderWithProviders(<ShipmentsPage />, { permissions: MANAGE });
    await open();
    expect(await screen.findByText(/Received by Abebe on 2026-12-04/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dispatch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel shipment" })).toBeNull();
    w.unmount();
    server.use(...serve());
    renderWithProviders(<ShipmentsPage />, { permissions: ["supply_chain.view"] });
    await open();
    await screen.findByText(/Shipment planned/);
    expect(screen.queryByRole("button", { name: "Dispatch" })).toBeNull();
  });
});

describe("LogisticsSetupPage", () => {
  it("adds and deactivates a carrier; a duplicate is refused", async () => {
    let n = 0;
    const bodies: unknown[] = [];
    let patched: unknown = null;
    server.use(carriers, routes,
      http.post("*/api/v1/supply-chain/carriers", async ({ request }) => { bodies.push(await request.json()); n += 1; return n === 1 ? HttpResponse.json({ error: { code: "duplicate_code", message: "Carrier code already used." } }, { status: 409 }) : HttpResponse.json(carrier({ id: "c2" }), { status: 201 }); }),
      http.patch("*/api/v1/supply-chain/carriers/c1", async ({ request }) => { patched = await request.json(); return HttpResponse.json(carrier({ is_active: false })); }));
    renderWithProviders(<LogisticsSetupPage />, { permissions: MANAGE });
    expect(await screen.findByText("DHL Express")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add carrier" }));
    expect(await screen.findByText("Give the carrier a code.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Carrier code"), "DHL");
    await userEvent.type(screen.getByLabelText("Carrier name"), "Dup");
    await userEvent.click(screen.getByRole("button", { name: "Add carrier" }));
    expect(await screen.findByText("Carrier code already used.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add carrier" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate DHL" }));
    await waitFor(() => expect(patched).toEqual({ is_active: false }));
  });

  it("adds a route", async () => {
    let body: unknown = null;
    server.use(carriers, http.get("*/api/v1/supply-chain/routes", () => page([])), http.post("*/api/v1/supply-chain/routes", async ({ request }) => { body = await request.json(); return HttpResponse.json(route(), { status: 201 }); }));
    renderWithProviders(<LogisticsSetupPage />, { permissions: MANAGE });
    expect(await screen.findByText("No routes")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Route code"), "R2");
    await userEvent.type(screen.getByLabelText("Route name"), "North");
    await userEvent.type(screen.getByLabelText("Starts at"), "Addis");
    await userEvent.type(screen.getByLabelText("Ends at"), "Bahir Dar");
    await userEvent.clear(screen.getByLabelText("Transit days"));
    await userEvent.type(screen.getByLabelText("Transit days"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Add route" }));
    await waitFor(() => expect(body).toEqual({ code: "R2", name: "North", origin: "Addis", destination: "Bahir Dar", distance_km: "0", transit_days: 3 }));
  });

  it("view-only users get no forms", async () => {
    server.use(carriers, routes);
    renderWithProviders(<LogisticsSetupPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("DHL Express")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add carrier" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add route" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate DHL" })).toBeNull();
  });
});

describe("LogisticsReportsPage", () => {
  const exc = { id: "e1", shipment: "s1", kind: "DELAY", severity: "HIGH", description: "Road closed", status: "OPEN", resolution: "", auto_detected: true };

  it("resolves an open problem with a resolution", async () => {
    let body: unknown = null;
    server.use(http.get("*/api/v1/supply-chain/exceptions", () => page([exc])), http.post("*/api/v1/supply-chain/exceptions/e1/resolve", async ({ request }) => { body = await request.json(); return HttpResponse.json(exc); }));
    renderWithProviders(<LogisticsReportsPage />, { permissions: MANAGE });
    expect(await screen.findByText(/found automatically/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Resolve Delay/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Mark resolved" }));
    expect(await screen.findByText("Say what was done to resolve it.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("What was done"), "Rerouted");
    await userEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
    await waitFor(() => expect(body).toEqual({ resolution: "Rerouted" }));
  });

  it("empty problems; view-only users cannot resolve; runs a report with nested lists", async () => {
    const urls: string[] = [];
    server.use(http.get("*/api/v1/supply-chain/exceptions", () => page([])),
      http.get("*/api/v1/supply-chain/reports/supplier-delivery", ({ request }) => { urls.push(new URL(request.url).search); return HttpResponse.json({ suppliers: [{ supplier: "ACME", on_time_pct: "90" }], lead_time_suggestions: [] }); }));
    renderWithProviders(<LogisticsReportsPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("No open problems")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Report"), "reports/supplier-delivery");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-12-10" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-12-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByText(/before/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-12-31" } });
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByText("ACME")).toBeInTheDocument();
    expect(screen.getByText("Lead time suggestions")).toBeInTheDocument();
    expect(urls[0]).toBe("?from=2026-12-10&to=2026-12-31");
  });
});

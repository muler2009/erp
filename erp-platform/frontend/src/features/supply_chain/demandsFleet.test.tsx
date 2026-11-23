import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { DemandsPage, demandProblem, reviseDemandProblem } from "./DemandsPage";
import { FulfilmentPage } from "./FulfilmentPage";
import { ShipmentsPage } from "./ShipmentsPage";
import { SupplyAnalyticsPage } from "./SupplyAnalyticsPage";
import { VehiclesPage, vehicleProblem } from "./VehiclesPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null });
const prod = { id: "p1", sku: "WIDGET", name: "Widget", uom: "pc", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "0" };
const products = http.get("*/api/v1/inventory/products", () => page([prod]));
const dem = (o = {}) => ({ id: "m1", product: "p1", sku: "WIDGET", warehouse: null, source: "PROJECT", source_ref: "PRJ-1", customer: "", kind: "CONFIRMED", quantity: "300.0000", required_date: "2026-12-10", priority: 3, status: "DRAFT", revision: 1, approved_by: null, cancel_reason: "", ...o });
const consolidated = http.get("*/api/v1/supply-chain/demands/consolidated", () => HttpResponse.json([]));
const DM = ["supply_chain.view", "supply_chain.demand.manage", "supply_chain.plan.approve"];

describe("helpers", () => {
  it("validate", () => {
    expect(demandProblem(null, "1", "2026-12-01", "MANUAL", "3")).toMatch(/product/);
    expect(demandProblem(prod as never, "0", "2026-12-01", "MANUAL", "3")).toMatch(/more than 0/);
    expect(demandProblem(prod as never, "1", "", "MANUAL", "3")).toMatch(/needed/);
    expect(demandProblem(prod as never, "1", "2026-12-01", "SALES_ORDER", "3")).toMatch(/comes from/);
    expect(demandProblem(prod as never, "1", "2026-12-01", "MANUAL", "9")).toMatch(/Priority/);
    expect(demandProblem(prod as never, "1", "2026-12-01", "MANUAL", "3")).toBeNull();
    const cur = { quantity: "300.0000", required_date: "2026-12-10", priority: 3 };
    expect(reviseDemandProblem("", "", "", "r", cur)).toMatch(/Nothing/);
    expect(reviseDemandProblem("300", "", "", "r", cur)).toMatch(/Nothing/);
    expect(reviseDemandProblem("x", "", "", "r", cur)).toMatch(/more than 0/);
    expect(reviseDemandProblem("400", "", "", " ", cur)).toMatch(/reason/);
    expect(reviseDemandProblem("400", "", "", "r", cur)).toBeNull();
    expect(vehicleProblem("", "0", "0")).toMatch(/code/);
    expect(vehicleProblem("T", "x", "0")).toMatch(/Capacity/);
    expect(vehicleProblem("T", "1000", "10")).toBeNull();
  });
});

describe("DemandsPage", () => {
  it("lists demand with filters; read-only users cannot add", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/supply-chain/demands", ({ request }) => { seen.push(new URL(request.url).search); return page([dem()]); }), consolidated);
    renderWithProviders(<DemandsPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("Waiting for approval", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add demand" })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "FORECAST");
    await waitFor(() => expect(seen.some((s) => s.includes("kind=FORECAST"))).toBe(true));
  });

  it("adds demand", async () => {
    let body: unknown = null;
    server.use(products, http.get("*/api/v1/supply-chain/demands", () => page([])), consolidated, http.post("*/api/v1/supply-chain/demands", async ({ request }) => { body = await request.json(); return HttpResponse.json(dem(), { status: 201 }); }));
    renderWithProviders(<DemandsPage />, { permissions: DM });
    await userEvent.click(await screen.findByRole("button", { name: "Add demand" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add demand", description: "" }).catch(() => screen.getAllByRole("button", { name: "Add demand" }).at(-1)!));
    expect(await screen.findByText("Choose the product.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("combobox", { name: "Product" }), "wid");
    await userEvent.click(await screen.findByRole("button", { name: /WIDGET/ }));
    await userEvent.type(screen.getByLabelText("Quantity"), "50");
    fireEvent.change(screen.getByLabelText("Needed by"), { target: { value: "2026-12-20" } });
    await userEvent.click(screen.getAllByRole("button", { name: "Add demand" }).at(-1)!);
    await waitFor(() => expect(body).toEqual({ product: "p1", quantity: "50", required_date: "2026-12-20", source: "MANUAL", kind: "CONFIRMED", priority: 3 }));
  });

  it("opens a demand: shows impact, approves (server refusal shown), revises and cancels", async () => {
    const sent: Record<string, unknown> = {};
    server.use(http.get("*/api/v1/supply-chain/demands", () => page([dem()])), consolidated,
      http.get("*/api/v1/supply-chain/demands/m1", () => HttpResponse.json({ ...dem(), revisions: [{ revision: 2, old_quantity: "200.0000", old_required_date: "2026-12-01", old_priority: 2, reason: "Bigger", by: "u1", at: "x" }] })),
      http.get("*/api/v1/supply-chain/demands/m1/impact", () => HttpResponse.json([{ product: "WIDGET", action: "BUY", quantity_without: "0", quantity_with: "300", change: "300" }])),
      http.post("*/api/v1/supply-chain/demands/m1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve demand you created or revised." } }, { status: 403 })),
      http.patch("*/api/v1/supply-chain/demands/m1", async ({ request }) => { sent.r = await request.json(); return HttpResponse.json(dem()); }),
      http.post("*/api/v1/supply-chain/demands/m1/cancel", async ({ request }) => { sent.c = await request.json(); return HttpResponse.json(dem({ status: "CANCELLED" })); }));
    renderWithProviders(<DemandsPage />, { permissions: DM });
    await userEvent.click(await screen.findByRole("button", { name: "Open WIDGET 2026-12-10" }));
    expect(await screen.findByText(/Revision 2: was 200 by 2026-12-01/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show planning impact" }));
    expect(await screen.findByText("+300")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve demand" }));
    expect(await screen.findByText("You cannot approve demand you created or revised.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Change demand" }));
    await userEvent.type(await screen.findByLabelText("New quantity"), "400");
    await userEvent.click(screen.getAllByRole("button", { name: "Save change" }).at(-1)!);
    expect(await screen.findByText("Give a reason for the change.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Order grew");
    await userEvent.click(screen.getAllByRole("button", { name: "Save change" }).at(-1)!);
    await waitFor(() => expect(sent.r).toEqual({ reason: "Order grew", quantity: "400" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel demand" }));
    await userEvent.type(await screen.findByLabelText("Reason"), "Project dropped");
    await userEvent.click(screen.getAllByRole("button", { name: "Cancel demand" }).at(-1)!);
    await waitFor(() => expect(sent.c).toEqual({ reason: "Project dropped" }));
  });

  it("consolidated view shows rows and rejects a backwards range", async () => {
    server.use(http.get("*/api/v1/supply-chain/demands", () => page([])), http.get("*/api/v1/supply-chain/demands/consolidated", () => HttpResponse.json([{ product: "WIDGET", warehouse: "(any)", month: "2026-12", confirmed: "300.0000", forecast: "50.0000" }])));
    renderWithProviders(<DemandsPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("2026-12")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("From", { selector: "#cd-from" }), { target: { value: "2027-01-10" } });
    fireEvent.change(screen.getByLabelText("To", { selector: "#cd-to" }), { target: { value: "2027-01-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText(/before/)).toBeInTheDocument();
  });
});

describe("VehiclesPage", () => {
  const veh = { id: "v1", code: "TRK-1", plate: "AA123", vehicle_type: "Truck", capacity_kg: "1000.00", capacity_m3: "10.00", carrier: null, is_active: true };
  it("adds and deactivates a vehicle", async () => {
    let body: unknown = null; let patched: unknown = null;
    server.use(http.get("*/api/v1/supply-chain/vehicles", () => page([veh])), http.get("*/api/v1/supply-chain/carriers", () => page([])),
      http.post("*/api/v1/supply-chain/vehicles", async ({ request }) => { body = await request.json(); return HttpResponse.json(veh, { status: 201 }); }),
      http.patch("*/api/v1/supply-chain/vehicles/v1", async ({ request }) => { patched = await request.json(); return HttpResponse.json({ ...veh, is_active: false }); }));
    renderWithProviders(<VehiclesPage />, { permissions: ["supply_chain.view", "supply_chain.logistics.manage"] });
    expect(await screen.findByText("AA123")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add vehicle" }));
    expect(await screen.findByText("Give the vehicle a code.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Vehicle code"), "TRK-2");
    await userEvent.click(screen.getByRole("button", { name: "Add vehicle" }));
    await waitFor(() => expect(body).toEqual({ code: "TRK-2", plate: "", vehicle_type: "", capacity_kg: "0", capacity_m3: "0" }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate TRK-1" }));
    await waitFor(() => expect(patched).toEqual({ is_active: false }));
  });
  it("read-only: no forms", async () => {
    server.use(http.get("*/api/v1/supply-chain/vehicles", () => page([veh])), http.get("*/api/v1/supply-chain/carriers", () => page([])));
    renderWithProviders(<VehiclesPage />, { permissions: ["supply_chain.view"] });
    await screen.findByText("AA123");
    expect(screen.queryByRole("button", { name: "Add vehicle" })).toBeNull();
  });
});

describe("shipment vehicle and consolidation", () => {
  const ship = (o = {}) => ({ id: "s1", number: "SHP-1", kind: "OUTBOUND", status: "PLANNED", carrier: null, route: null, origin: "Addis", destination: "Adama", planned_dispatch: "2026-12-01", planned_arrival: "2026-12-04", actual_dispatch: null, actual_arrival: null, tracking_ref: "", weight_kg: "100", pod_received_by: "", pod_at: null, vehicle_ref: null, consolidated_into: null, ...o });
  const detail = (o = {}) => ({ ...ship(o), lines: [], events: [], costs: [], exceptions: [] });
  const veh = http.get("*/api/v1/supply-chain/vehicles", () => page([{ id: "v1", code: "TRK-1", plate: "AA123", vehicle_type: "", capacity_kg: "1000", capacity_m3: "10", carrier: null, is_active: true }, { id: "v2", code: "OLD", plate: "", vehicle_type: "", capacity_kg: "1", capacity_m3: "1", carrier: null, is_active: false }]));
  const serve = (o = {}) => [veh, http.get("*/api/v1/supply-chain/shipments", ({ request }) => (new URL(request.url).searchParams.get("status") === "PLANNED" ? page([ship(), ship({ id: "s2", number: "SHP-2" })]) : page([ship(o)]))), http.get("*/api/v1/supply-chain/shipments/s1", () => HttpResponse.json(detail(o)))];
  const open = async () => userEvent.click(await screen.findByRole("button", { name: "Open SHP-1" }));

  it("assigns an active vehicle; server refusal (over capacity) is shown", async () => {
    const bodies: unknown[] = [];
    server.use(...serve(), http.post("*/api/v1/supply-chain/shipments/s1/vehicle", async ({ request }) => { bodies.push(await request.json()); return bodies.length === 1 ? HttpResponse.json({ error: { code: "over_capacity", message: "The load of 1200 kg exceeds the vehicle capacity of 1000 kg." } }, { status: 409 }) : HttpResponse.json({}); }));
    renderWithProviders(<ShipmentsPage />, { permissions: ["supply_chain.view", "supply_chain.logistics.manage"] });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Assign vehicle" }));
    await userEvent.click(await screen.findByRole("button", { name: "Assign" }));
    expect(await screen.findByText("Choose a vehicle.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "TRK-1 (AA123)" })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: /OLD/ })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Vehicle"), "v1");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByText(/exceeds the vehicle capacity/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(bodies).toEqual([{ vehicle: "v1" }, { vehicle: "v1" }]));
  });

  it("combines another planned shipment into this load (not itself)", async () => {
    let body: unknown = null;
    server.use(...serve(), http.post("*/api/v1/supply-chain/shipments/s1/consolidate", async ({ request }) => { body = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<ShipmentsPage />, { permissions: ["supply_chain.view", "supply_chain.logistics.manage"] });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Add shipment to this load" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /SHP-2/ })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: /SHP-1/ })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Shipment to add"), "s2");
    await userEvent.click(screen.getByRole("button", { name: "Combine" }));
    await waitFor(() => expect(body).toEqual({ shipments: ["s2"] }));
  });

  it("a consolidated shipment can be separated; no combine button for it", async () => {
    let hit = false;
    server.use(...serve({ consolidated_into: "s9" }), http.post("*/api/v1/supply-chain/shipments/s1/unconsolidate", () => { hit = true; return HttpResponse.json({}); }));
    renderWithProviders(<ShipmentsPage />, { permissions: ["supply_chain.view", "supply_chain.logistics.manage"] });
    await open();
    expect(await screen.findByText("Travels together with another shipment.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add shipment to this load" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Separate from its load" }));
    await waitFor(() => expect(hit).toBe(true));
  });
});

describe("FulfilmentPage", () => {
  const order = { order: "SO-1", order_id: "o1", customer: "Acme", status: "CONFIRMED", fulfilment: "PARTIAL", lines: [{ line: 1, product: "p1", sku: "WIDGET", open: "10.0000", reserved: "6.0000", short: "4.0000" }], in_transit_deliveries: 1, shipments: [{ number: "SHP-9", status: "IN_TRANSIT", planned_arrival: "2026-12-05" }] };
  it("shows orders with shortages and shipments", async () => {
    server.use(http.get("*/api/v1/supply-chain/fulfilment", () => HttpResponse.json([order])));
    renderWithProviders(<FulfilmentPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("SO-1 — Acme")).toBeInTheDocument();
    expect(screen.getByText("Partly covered")).toBeInTheDocument();
    expect(screen.getByText(/SHP-9 \(in transit, due 2026-12-05\)/)).toBeInTheDocument();
    expect(screen.getByText("WIDGET")).toBeInTheDocument();
  });
  it("empty board; stock by warehouse for a chosen product", async () => {
    server.use(products, http.get("*/api/v1/supply-chain/fulfilment", () => HttpResponse.json([])), http.get("*/api/v1/supply-chain/products/p1/availability", () => HttpResponse.json([{ warehouse: "MAIN", on_hand: "20.0000", quarantined: "0.0000", in_transit: "0.0000", reserved: "6.0000", allocated: "0.0000", available: "14.0000" }])));
    renderWithProviders(<FulfilmentPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("Nothing waiting to be fulfilled")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("combobox", { name: "Check a product" }), "wid");
    await userEvent.click(await screen.findByRole("button", { name: /WIDGET/ }));
    expect(await screen.findByText("MAIN")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
  });
});

describe("SupplyAnalyticsPage", () => {
  it("runs a report for the period and rejects a backwards range", async () => {
    const urls: string[] = [];
    server.use(http.get("*/api/v1/supply-chain/analytics/:name", ({ request, params }) => { urls.push(`${params.name}${new URL(request.url).search}`); return HttpResponse.json([{ product: "WIDGET", short: "4" }]); }));
    renderWithProviders(<SupplyAnalyticsPage />, { permissions: ["supply_chain.view"] });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-12-10" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-12-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/before/);
    expect(urls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-12-31" } });
    await userEvent.selectOptions(screen.getByLabelText("Report"), "shortages");
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByText("WIDGET")).toBeInTheDocument();
    expect(urls[0]).toBe("shortages?from=2026-12-10&to=2026-12-31");
  });
});

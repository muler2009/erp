import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AllocationsPage, validateAllocation, validateHours, validateUsagePeriod } from "./AllocationsPage";
import { FleetPage, validateFuel, validateIncident, validateVehicle } from "./FleetPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const FLEET = ["assets.view", "assets.fleet.manage"];
const veh = (o = {}) => ({ id: "v1", asset: { id: "a1", number: "FA-1" }, plate_number: "AA-123", vin: "", fuel_type: "DIESEL", registration_expiry: "2026-12-31", driver_id: null, driver_license_expiry: null, odometer: "1000.0000", ...o });
const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] }));
const fixedAssets = http.get("*/api/v1/assets/assets", () => HttpResponse.json({ results: [{ id: "a1", number: "FA-1", name: "Truck", status: "IN_USE", category: { id: "c", code: "VEH" } }] }));
const projects = http.get("*/api/v1/projects/projects", () => HttpResponse.json({ results: [{ id: "p1", code: "P1", name: "Bridge", status: "ACTIVE" }] }));
const depts = http.get("*/api/v1/org/departments", () => HttpResponse.json({ results: [{ id: "d1", code: "OPS", name: "Operations" }] }));

describe("validators", () => {
  it("vehicle, fuel, incident, allocation, hours, usage period", () => {
    expect(validateVehicle({ asset: "", plate_number: "x", fuel_type: "DIESEL" })).toMatch(/asset/);
    expect(validateVehicle({ asset: "a", plate_number: " ", fuel_type: "DIESEL" })).toMatch(/plate/);
    expect(validateVehicle({ asset: "a", plate_number: "x", fuel_type: "COAL" })).toMatch(/fuel/);
    expect(validateVehicle({ asset: "a", plate_number: "x", fuel_type: "PETROL" })).toBeNull();
    expect(validateFuel("0", "5", "1")).toMatch(/Litres/);
    expect(validateFuel("5", "-1", "1")).toMatch(/Cost/);
    expect(validateFuel("5", "7.5", "1200")).toBeNull();
    expect(validateIncident(" ", "MINOR", "")).toMatch(/Describe/);
    expect(validateIncident("x", "MINOR", "abc")).toMatch(/Damage/);
    const a = { asset: "a", target_kind: "PROJECT", target: "p", start_on: "2026-01-01", end_on: "", share: "50" };
    expect(validateAllocation({ ...a, target: "" })).toMatch(/project/);
    expect(validateAllocation({ ...a, target_kind: "DEPARTMENT", target: "" })).toMatch(/department/);
    expect(validateAllocation({ ...a, end_on: "2025-01-01" })).toMatch(/cannot end before/);
    expect(validateAllocation({ ...a, share: "150" })).toMatch(/at most 100/);
    expect(validateAllocation(a)).toBeNull();
    expect(validateHours("25")).toMatch(/24/);
    expect(validateHours("7.5")).toBeNull();
    expect(validateUsagePeriod("2026-02-01", "2026-01-01", "8", "20")).toMatch(/on or after/);
    expect(validateUsagePeriod("2026-01-01", "2026-02-01", "0", "20")).toMatch(/Daily hours/);
    expect(validateUsagePeriod("2026-01-01", "2026-02-01", "8", "120")).toMatch(/percentage/);
  });
});

describe("FleetPage", () => {
  it("hides management actions from read-only users", async () => {
    server.use(http.get("*/api/v1/assets/vehicles", () => HttpResponse.json({ results: [veh()] })), employees);
    renderWithProviders(<FleetPage />, { permissions: ["assets.view"] });
    expect(await screen.findByText("AA-123")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Register|Log fuel|Assign driver/ })).toBeNull();
    expect(screen.getByRole("button", { name: "History AA-123" })).toBeInTheDocument();
  });

  it("registers a vehicle after validating the plate", async () => {
    server.use(http.get("*/api/v1/assets/vehicles", () => HttpResponse.json({ results: [] })), fixedAssets, employees);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/vehicles", async ({ request }) => { sent = await request.json(); return HttpResponse.json(veh(), { status: 201 }); }));
    renderWithProviders(<FleetPage />, { permissions: FLEET });
    await userEvent.click(await screen.findByRole("button", { name: "Register a vehicle" }));
    const d = within(screen.getByRole("dialog", { name: "Register a vehicle" }));
    await userEvent.selectOptions(await d.findByLabelText("Vehicle asset"), "a1");
    await userEvent.click(d.getByRole("button", { name: "Register" }));
    expect(await d.findByText("Enter the plate number.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText("Plate number"), "AA-123");
    await userEvent.click(d.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(sent).toEqual({ asset: "a1", plate_number: "AA-123", vin: "", fuel_type: "DIESEL" }));
  });

  it("logs fuel, and shows the server's refusal for an electric vehicle", async () => {
    server.use(http.get("*/api/v1/assets/vehicles", () => HttpResponse.json({ results: [veh({ fuel_type: "ELECTRIC" })] })), employees,
      http.post("*/api/v1/assets/vehicles/v1/fuel", () => HttpResponse.json({ error: { code: "invalid_fuel", message: "An electric vehicle has no fuel log; record charging as a cost instead." } }, { status: 400 })));
    renderWithProviders(<FleetPage />, { permissions: FLEET });
    await userEvent.click(await screen.findByRole("button", { name: "Log fuel AA-123" }));
    const d = within(screen.getByRole("dialog", { name: "Log fuel" }));
    await userEvent.type(d.getByLabelText(/Litres/), "10");
    await userEvent.type(d.getByLabelText(/Cost/), "15");
    await userEvent.type(d.getByLabelText(/Odometer/), "1100");
    await userEvent.click(d.getByRole("button", { name: "Record fill-up" }));
    expect(await d.findByText(/electric vehicle has no fuel log/)).toBeInTheDocument();
  });

  it("assigns a driver and rejects a renewal that is not later", async () => {
    server.use(http.get("*/api/v1/assets/vehicles", () => HttpResponse.json({ results: [veh()] })), employees);
    let driver: unknown;
    server.use(http.post("*/api/v1/assets/vehicles/v1/driver", async ({ request }) => { driver = await request.json(); return HttpResponse.json(veh()); }));
    renderWithProviders(<FleetPage />, { permissions: FLEET });
    await userEvent.click(await screen.findByRole("button", { name: "Assign driver to AA-123" }));
    const d = within(screen.getByRole("dialog", { name: "Assign a driver" }));
    await userEvent.selectOptions(await d.findByLabelText(/Driver/), "e1");
    fireChange(d.getByLabelText(/Licence expires/), "2027-05-01");
    await userEvent.click(d.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(driver).toEqual({ driver_id: "e1", license_expiry: "2027-05-01" }));
    await userEvent.click(await screen.findByRole("button", { name: "Renew registration AA-123" }));
    const r = within(screen.getByRole("dialog", { name: "Renew registration" }));
    fireChange(r.getByLabelText(/New expiry/), "2026-06-01");
    await userEvent.click(r.getByRole("button", { name: "Renew" }));
    expect(await r.findByText(/must be later than the current one/)).toBeInTheDocument();
  });

  it("shows history with efficiency and lets a manager close an open incident", async () => {
    server.use(http.get("*/api/v1/assets/vehicles", () => HttpResponse.json({ results: [veh()] })), employees,
      http.get("*/api/v1/assets/vehicles/v1/info/fuel-efficiency", () => HttpResponse.json([{ filled_on: "2026-10-20", km: "500.0000", liters: "40.0000", km_per_liter: "12.50" }])),
      http.get("*/api/v1/assets/vehicles/v1/info/incidents", () => HttpResponse.json({ results: [{ id: "i1", occurred_on: "2026-10-01", description: "Scraped a gate", severity: "MINOR", damage_cost: "40.0000", status: "OPEN", driver_id: null }] })));
    let closed = false;
    server.use(http.post("*/api/v1/assets/incidents/i1/close", () => { closed = true; return HttpResponse.json({ status: "CLOSED" }); }));
    renderWithProviders(<FleetPage />, { permissions: FLEET });
    await userEvent.click(await screen.findByRole("button", { name: "History AA-123" }));
    expect(await screen.findByText("12.50 km/L")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Close incident: Scraped a gate" }));
    await waitFor(() => expect(closed).toBe(true));
  });

  it("shows expiries and costs", async () => {
    server.use(http.get("*/api/v1/assets/vehicles", () => HttpResponse.json({ results: [] })), employees,
      http.get("*/api/v1/assets/vehicles/expiries", () => HttpResponse.json([{ plate: "AA-9", asset: "FA-9", issues: [{ item: "REGISTRATION", date: "2026-11-20", expired: false }, { item: "INSURANCE", date: null, expired: true }] }])),
      http.get("*/api/v1/assets/reports/usage/fleet-costs", () => HttpResponse.json([{ plate: "AA-9", asset: "FA-9", fuel_cost: "100.0000", liters: "50.0000", maintenance_cost: "20.0000", total_cost: "120.0000", km: "600.0000", cost_per_km: "0.2000" }])));
    renderWithProviders(<FleetPage />, { permissions: ["assets.view"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Expiries" }));
    expect(await screen.findByText(/Insurance none in force/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Costs" }));
    expect(await screen.findByText("0.2000")).toBeInTheDocument();
  });
});

describe("AllocationsPage", () => {
  const alloc = (o = {}) => ({ id: "al1", asset: { id: "a1", number: "FA-1" }, target_kind: "PROJECT", target_id: "p1", start_on: "2026-11-01", end_on: null, share_percent: "50.00", status: "ACTIVE", ...o });

  it("allocates to a named project and shows the server's over-allocation refusal", async () => {
    server.use(http.get("*/api/v1/assets/allocations", () => HttpResponse.json({ results: [alloc()] })), fixedAssets, projects, depts);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/allocations", async ({ request }) => { sent = await request.json(); return HttpResponse.json({ error: { code: "over_allocated", message: "The asset is already allocated 50% in this period; only 50% is left to share." } }, { status: 409 }); }));
    renderWithProviders(<AllocationsPage />, { permissions: ["assets.view", "assets.custody.manage"] });
    expect(await screen.findByText("Bridge")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allocate an asset" }));
    const d = within(screen.getByRole("dialog", { name: "Allocate an asset" }));
    await userEvent.selectOptions(await d.findByLabelText("Asset"), "a1");
    await userEvent.selectOptions(await d.findByLabelText("Project"), "p1");
    await userEvent.clear(d.getByLabelText("Share (%)"));
    await userEvent.type(d.getByLabelText("Share (%)"), "80");
    await userEvent.click(d.getByRole("button", { name: "Allocate" }));
    expect(await d.findByText(/only 50% is left to share/)).toBeInTheDocument();
    expect(sent).toMatchObject({ asset: "a1", target_kind: "PROJECT", target_id: "p1", share_percent: "80" });
  });

  it("logs usage against an allocation and rejects more than 24 hours client-side", async () => {
    server.use(http.get("*/api/v1/assets/allocations", () => HttpResponse.json({ results: [alloc()] })), fixedAssets, projects, depts);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/assets/a1/usage", async ({ request }) => { sent = await request.json(); return HttpResponse.json({ id: "u", hours: "6.00" }, { status: 201 }); }));
    renderWithProviders(<AllocationsPage />, { permissions: ["assets.view", "assets.custody.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Log usage FA-1" }));
    const d = within(screen.getByRole("dialog", { name: "Log usage" }));
    await userEvent.type(d.getByLabelText(/Hours/), "25");
    await userEvent.click(d.getByRole("button", { name: "Log hours" }));
    expect(await d.findByText(/at most 24/)).toBeInTheDocument();
    expect(sent).toBeUndefined();
    await userEvent.clear(d.getByLabelText(/Hours/));
    await userEvent.type(d.getByLabelText(/Hours/), "6");
    await userEvent.click(d.getByRole("button", { name: "Log hours" }));
    await waitFor(() => expect(sent).toEqual({ hours: "6", allocation: "al1" }));
    expect(await screen.findByText(/Logged 6.00 hours on FA-1/)).toBeInTheDocument();
  });

  it("flags idle and under-used assets", async () => {
    server.use(http.get("*/api/v1/assets/allocations", () => HttpResponse.json({ results: [] })), fixedAssets, projects, depts,
      http.get("*/api/v1/assets/reports/usage/utilization", () => HttpResponse.json({ rows: [{ asset: "FA-1", name: "Truck", category: "VEH", hours: "0.00", available_hours: "240.00", utilization_percent: "0.00", idle: true, underutilized: false }, { asset: "FA-2", name: "Crane", category: "EQ", hours: "10.00", available_hours: "240.00", utilization_percent: "4.17", idle: false, underutilized: true }], idle: 1, underutilized: 1 })),
      http.get("*/api/v1/assets/reports/usage/project-usage", () => HttpResponse.json([{ target_kind: "PROJECT", target_id: "p1", hours: "10.00" }])));
    renderWithProviders(<AllocationsPage />, { permissions: ["assets.view"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Utilization" }));
    expect(await screen.findByText("Idle")).toBeInTheDocument();
    expect(screen.getByText("Under-used")).toBeInTheDocument();
    expect(await screen.findByText(/Project: Bridge/)).toBeInTheDocument();
  });
});

import { fireEvent } from "@testing-library/react";
function fireChange(el: HTMLElement, value: string) { fireEvent.change(el, { target: { value } }); }

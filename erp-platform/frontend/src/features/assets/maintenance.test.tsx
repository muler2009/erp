import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { MaintenancePage, validateBreakdown, validateLabor, validateMaterial, validateWorkOrder } from "./MaintenancePage";
import { validatePlan, validateReportPeriod } from "./MaintenanceReports";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const wo = (o = {}) => ({ id: "w1", number: "WO-1", asset: { id: "a1", number: "FA-1" }, kind: "CORRECTIVE", status: "OPEN", priority: "HIGH", description: "Fix fan", scheduled_on: null, due_on: "2026-11-20", assigned_to_id: null, provider_supplier_id: null, estimated_cost: "100.0000", labor_hours: "0.00", labor_cost: "0.0000", material_cost: "0.0000", external_cost: "0.0000", total_cost: "0.0000", breakdown_id: null, plan_id: null, requested_by: "u", approved_by: null, completed_by: null, verified_by: null, completed_on: null, materials: [], ...o });
const bd = (o = {}) => ({ id: "b1", number: "BD-1", asset: { id: "a1", number: "FA-1" }, reported_at: "2026-11-10T08:00:00Z", symptoms: "Overheats", cause: "", failure_code: "", severity: "HIGH", status: "REPORTED", restored_at: null, downtime_hours: null, ...o });
function base(orders: unknown[] = [wo()], breakdowns: unknown[] = []) {
  server.use(
    http.get("*/api/v1/assets/work-orders", () => HttpResponse.json({ results: orders })),
    http.get("*/api/v1/assets/breakdowns", () => HttpResponse.json({ results: breakdowns })),
    http.get("*/api/v1/assets/assets", () => HttpResponse.json({ results: [{ id: "a1", number: "FA-1", name: "Press", status: "IN_USE", category: { id: "c", code: "M" } }] })),
    http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] })),
    http.get("*/api/v1/procurement/suppliers", () => HttpResponse.json({ results: [] })));
}
const MAN = ["assets.view", "assets.maintenance.manage"];

describe("validators", () => {
  it("work order, labour, material, breakdown, plan, period", () => {
    expect(validateWorkOrder({ asset: "", kind: "CORRECTIVE", description: "x", estimated_cost: "" })).toMatch(/asset/);
    expect(validateWorkOrder({ asset: "a", kind: "CORRECTIVE", description: " ", estimated_cost: "" })).toMatch(/Describe/);
    expect(validateWorkOrder({ asset: "a", kind: "CORRECTIVE", description: "x", estimated_cost: "1,5" })).toMatch(/number/);
    expect(validateWorkOrder({ asset: "a", kind: "CORRECTIVE", description: "x", estimated_cost: "10" })).toBeNull();
    expect(validateLabor("0", "5")).toMatch(/positive/);
    expect(validateLabor("2", "-1")).toMatch(/zero or more/);
    expect(validateLabor("2.5", "0")).toBeNull();
    expect(validateMaterial({ product: "p", location: "", quantity: "1" })).toMatch(/location/);
    expect(validateMaterial({ product: "p", location: "l", quantity: "0" })).toMatch(/positive/);
    expect(validateBreakdown({ asset: "a", symptoms: " ", severity: "LOW" })).toMatch(/symptoms/);
    const p = { asset: "a", name: "n", trigger: "TIME", kind: "PREVENTIVE", interval_days: "30", interval_usage: "" };
    expect(validatePlan({ ...p, interval_days: "0" })).toMatch(/at least 1/);
    expect(validatePlan({ ...p, trigger: "USAGE" })).toMatch(/positive interval/);
    expect(validatePlan(p)).toBeNull();
    expect(validateReportPeriod("2026-02-01", "2026-01-01")).toMatch(/on or after/);
    expect(validateReportPeriod("2026-01-01", "2026-02-01")).toBeNull();
  });
});

describe("MaintenancePage work orders", () => {
  it("offers only the actions the permissions and state allow", async () => {
    base([wo({ status: "AWAITING_APPROVAL" }), wo({ id: "w2", number: "WO-2", status: "OPEN" })]);
    const { unmount } = renderWithProviders(<MaintenancePage />, { permissions: ["assets.view"] });
    expect(await screen.findByText("WO-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve|Start|New work order/ })).toBeNull();
    unmount();
    renderWithProviders(<MaintenancePage />, { permissions: [...MAN, "assets.maintenance.approve"] });
    expect(await screen.findByRole("button", { name: "Approve WO-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start WO-2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start WO-1" })).toBeNull();
  });

  it("shows the server refusal when approving your own repair", async () => {
    base([wo({ status: "AWAITING_APPROVAL" })]);
    server.use(http.post("*/api/v1/assets/work-orders/w1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: someone else must approve this repair." } }, { status: 403 })));
    renderWithProviders(<MaintenancePage />, { permissions: ["assets.view", "assets.maintenance.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Approve WO-1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/someone else must approve/);
  });

  it("creates a work order after validating", async () => {
    base([]);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/work-orders", async ({ request }) => { sent = await request.json(); return HttpResponse.json(wo(), { status: 201 }); }));
    renderWithProviders(<MaintenancePage />, { permissions: MAN });
    await userEvent.click(await screen.findByRole("button", { name: "New work order" }));
    const d = within(screen.getByRole("dialog", { name: "New work order" }));
    await userEvent.click(d.getByRole("button", { name: "Create work order" }));
    expect(await d.findByText("Choose the asset.")).toBeInTheDocument();
    await userEvent.selectOptions(await d.findByLabelText("Asset"), "a1");
    await userEvent.type(d.getByLabelText("Description"), "Fix fan");
    await userEvent.click(d.getByRole("button", { name: "Create work order" }));
    await waitFor(() => expect(sent).toMatchObject({ asset: "a1", kind: "CORRECTIVE", priority: "MEDIUM", description: "Fix fan" }));
  });

  it("records labour on a running order and rejects bad hours client-side", async () => {
    base([wo({ status: "IN_PROGRESS" })]);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/work-orders/w1/labor", async ({ request }) => { sent = await request.json(); return HttpResponse.json(wo({ status: "IN_PROGRESS" })); }));
    renderWithProviders(<MaintenancePage />, { permissions: MAN });
    await userEvent.click(await screen.findByRole("button", { name: "Add labour WO-1" }));
    const d = within(screen.getByRole("dialog", { name: "Record labour" }));
    await userEvent.type(d.getByLabelText(/Hours/), "0");
    await userEvent.type(d.getByLabelText(/Hourly rate/), "20");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    expect(await d.findByText(/Hours must be a positive/)).toBeInTheDocument();
    expect(sent).toBeUndefined();
    await userEvent.clear(d.getByLabelText(/Hours/));
    await userEvent.type(d.getByLabelText(/Hours/), "2.5");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(sent).toEqual({ hours: "2.5", rate: "20" }));
  });

  it("verifies a completed repair with a pass/fail result", async () => {
    base([wo({ status: "COMPLETED" })]);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/work-orders/w1/verify", async ({ request }) => { sent = await request.json(); return HttpResponse.json(wo({ status: "VERIFIED" })); }));
    renderWithProviders(<MaintenancePage />, { permissions: MAN });
    await userEvent.click(await screen.findByRole("button", { name: "Verify WO-1" }));
    const d = within(screen.getByRole("dialog", { name: "Verify repair" }));
    await userEvent.selectOptions(d.getByLabelText(/Result/), "fail");
    await userEvent.type(d.getByLabelText(/Verification notes/), "Still hot");
    await userEvent.click(d.getByRole("button", { name: "Record verification" }));
    await waitFor(() => expect(sent).toEqual({ passed: false, notes: "Still hot" }));
  });
});

describe("MaintenancePage breakdowns, plans and reports", () => {
  it("diagnoses a reported breakdown", async () => {
    base([], [bd()]);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/breakdowns/b1/diagnose", async ({ request }) => { sent = await request.json(); return HttpResponse.json(bd({ status: "DIAGNOSED" })); }));
    renderWithProviders(<MaintenancePage />, { permissions: MAN });
    await userEvent.click(await screen.findByRole("tab", { name: "Breakdowns" }));
    await userEvent.click(await screen.findByRole("button", { name: "Diagnose BD-1" }));
    const d = within(screen.getByRole("dialog", { name: "Diagnose breakdown" }));
    await userEvent.click(d.getByRole("button", { name: "Record diagnosis" }));
    expect(await d.findByText("Cause is required.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText(/Cause/), "Fan seized");
    await userEvent.click(d.getByRole("button", { name: "Record diagnosis" }));
    await waitFor(() => expect(sent).toEqual({ cause: "Fan seized", failure_code: "" }));
  });

  it("lists plans and checks a usage plan's interval", async () => {
    base();
    server.use(http.get("*/api/v1/assets/maintenance-plans", () => HttpResponse.json({ results: [{ id: "p1", asset: "a1", name: "Oil change", kind: "PREVENTIVE", trigger: "USAGE", interval_days: null, interval_usage: "250.0000", lead_days: 7, next_due_on: null, next_due_meter: "1250.0000", last_done_on: null, is_active: true, estimated_cost: "50.0000" }] })));
    renderWithProviders(<MaintenancePage />, { permissions: MAN });
    await userEvent.click(await screen.findByRole("tab", { name: "Plans and meters" }));
    expect(await screen.findByText("Oil change")).toBeInTheDocument();
    expect(screen.getByText("At meter 1250.0000")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New plan" }));
    const d = within(screen.getByRole("dialog", { name: "New maintenance plan" }));
    await userEvent.selectOptions(await d.findByLabelText("Asset"), "a1");
    await userEvent.type(d.getByLabelText("Name"), "Greasing");
    await userEvent.selectOptions(d.getByLabelText("Triggered by"), "USAGE");
    await userEvent.click(d.getByRole("button", { name: "Create plan" }));
    expect(await d.findByText(/positive interval/)).toBeInTheDocument();
  });

  it("shows the out-of-service list, schedule and cost report", async () => {
    base();
    server.use(
      http.get("*/api/v1/assets/reports/maintenance/unavailable", () => HttpResponse.json([{ asset: "FA-1", name: "Press", since: "2026-11-09", open_work_orders: ["WO-1"] }])),
      http.get("*/api/v1/assets/reports/maintenance/schedule", () => HttpResponse.json([{ plan: "Oil change", asset: "FA-2", trigger: "TIME", next_due_on: "2026-11-30", next_due_meter: null, meter: "0" }])),
      http.get("*/api/v1/assets/reports/maintenance/costs", () => HttpResponse.json([{ key: "FA-1", work_orders: 2, labor: "100.0000", material: "50.0000", external: "0.0000", total: "150.0000" }])),
      http.get("*/api/v1/assets/reports/maintenance/breakdowns", () => HttpResponse.json([{ asset: "FA-1", name: "Press", breakdowns: 3, downtime_hours: "12.00", mttr_hours: "4.00", mtbf_hours: "700.00", repeated_failure_codes: ["BRG"], recurring: true }])));
    renderWithProviders(<MaintenancePage />, { permissions: ["assets.view"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Reports" }));
    expect(await screen.findByText(/since 2026-11-09/)).toBeInTheDocument();
    expect(await screen.findByText(/due 2026-11-30/)).toBeInTheDocument();
    expect(await screen.findByText("Recurring")).toBeInTheDocument();
    expect(await screen.findByText("BRG", { exact: false })).toBeInTheDocument();
  });
});

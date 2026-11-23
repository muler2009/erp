import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { DashboardPage } from "../dashboard/DashboardPage";
import { dashboardProblem, widgetProblem } from "./DashboardEditor";
import { KpisPage, kpiProblem } from "./KpisPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const kpi = (o = {}) => ({ id: "k1", code: "rev", name: "Revenue", description: "", metric: "finance.revenue", module: "finance", params: { period: "LAST_30_DAYS" }, unit: "ETB", direction: "HIGHER", target: "100.0000", warn_at: "50.0000", critical_at: "10.0000", is_active: true, is_system: false, restricted: false, latest: { as_of: "2026-11-21", value: "80.0000", status: "WARN" }, previous: null, change_pct: "5.00", ...o });
const catalog = http.get("*/api/v1/analytics/catalog", () => HttpResponse.json({ datasets: [{ code: "sales.by-customer", title: "Sales by customer", module: "sales", params: {} }], metrics: [{ code: "finance.revenue", label: "Revenue", module: "finance", unit: "ETB", direction: "HIGHER" }, { code: "quality.open_ncrs", label: "Open NCRs", module: "quality", unit: "", direction: "LOWER" }] }));
const MANAGE = ["analytics.view", "analytics.kpi.manage", "analytics.dashboard.manage"];

describe("helpers", () => {
  it("validate", () => {
    expect(kpiProblem("", "HIGHER", "", "", "")).toMatch(/name/);
    expect(kpiProblem("A", "HIGHER", "", "", "", "", "m")).toMatch(/code/);
    expect(kpiProblem("A", "HIGHER", "", "", "", "c", "")).toMatch(/what to measure/);
    expect(kpiProblem("A", "HIGHER", "x", "", "")).toMatch(/Target must be a number/);
    expect(kpiProblem("A", "HIGHER", "100", "50", "10")).toBeNull();
    expect(kpiProblem("A", "HIGHER", "100", "150", "10")).toMatch(/critical, warning, target/);
    expect(kpiProblem("A", "LOWER", "0", "3", "10")).toBeNull();
    expect(kpiProblem("A", "LOWER", "10", "3", "0")).toMatch(/critical, warning, target/);
    expect(kpiProblem("A", "HIGHER", "100", "", "")).toBeNull();
    expect(dashboardProblem("A", "ALL", [], "bad code")).toMatch(/short code/);
    expect(dashboardProblem("", "ALL", [])).toMatch(/name/);
    expect(dashboardProblem("A", "ROLES", [])).toMatch(/roles/);
    expect(dashboardProblem("A", "ROLES", ["x"], "ok_1")).toBeNull();
    expect(widgetProblem("KPI", "", "30", "", "10")).toMatch(/Choose a KPI/);
    expect(widgetProblem("TREND", "a", "0", "", "10")).toMatch(/1 to 730/);
    expect(widgetProblem("DATASET", "", "30", "", "10")).toMatch(/data set/);
    expect(widgetProblem("DATASET", "", "30", "d", "500")).toMatch(/1 to 200/);
    expect(widgetProblem("DATASET", "", "30", "d", "20")).toBeNull();
  });
});

describe("KpisPage", () => {
  it("shows status and hides management from viewers; restricted KPIs say so", async () => {
    server.use(http.get("*/api/v1/analytics/kpis", () => HttpResponse.json([kpi(), kpi({ id: "k2", code: "x", name: "Secret", restricted: true, latest: null })])));
    renderWithProviders(<KpisPage />, { permissions: ["analytics.view"] });
    expect(await screen.findByText("Warning")).toBeInTheDocument();
    expect(screen.getByText("You do not have access to this data.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add KPI" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change Revenue" })).toBeNull();
  });

  it("filters by area and, for managers, includes switched-off KPIs", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/analytics/kpis", ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json([kpi()]); }));
    renderWithProviders(<KpisPage />, { permissions: MANAGE });
    await screen.findByText("Revenue");
    await userEvent.selectOptions(screen.getByLabelText("Area"), "finance");
    await userEvent.click(screen.getByLabelText("Include switched-off KPIs"));
    await waitFor(() => expect(seen.some((s) => s.includes("module=finance") && s.includes("all=1"))).toBe(true));
  });

  it("adds a KPI with checks and takes the measure's better direction", async () => {
    let body: unknown = null;
    server.use(catalog, http.get("*/api/v1/analytics/kpis", () => HttpResponse.json([])), http.post("*/api/v1/analytics/kpis", async ({ request }) => { body = await request.json(); return HttpResponse.json(kpi(), { status: 201 }); }));
    renderWithProviders(<KpisPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Add KPI" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Add KPI" }).at(-1)!);
    expect(await screen.findByText("Give the KPI a code.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Code"), "ncr_open");
    await userEvent.type(screen.getByLabelText("Name"), "Open NCRs");
    await userEvent.click(screen.getAllByRole("button", { name: "Add KPI" }).at(-1)!);
    expect(await screen.findByText("Choose what to measure.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "quality — Open NCRs" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Measure"), "quality.open_ncrs");
    expect(screen.getByLabelText("Better when")).toHaveValue("LOWER");
    await userEvent.type(screen.getByLabelText("Target"), "5");
    await userEvent.type(screen.getByLabelText("Warning level"), "10");
    await userEvent.type(screen.getByLabelText("Critical level"), "20");
    await userEvent.click(screen.getAllByRole("button", { name: "Add KPI" }).at(-1)!);
    await waitFor(() => expect(body).toEqual({ name: "Open NCRs", direction: "LOWER", target: "5", warn_at: "10", critical_at: "20", params: {}, code: "ncr_open", metric: "quality.open_ncrs" }));
  });

  it("changes a KPI's levels (server refusal shown), switches it off, and shows its history", async () => {
    const bodies: unknown[] = [];
    server.use(http.get("*/api/v1/analytics/kpis", () => HttpResponse.json([kpi()])),
      http.get("*/api/v1/analytics/kpis/k1/series", ({ request }) => HttpResponse.json(new URL(request.url).searchParams.get("days") === "30" ? [{ as_of: "2026-11-20", value: "70.0000", status: "WARN" }] : [])),
      http.patch("*/api/v1/analytics/kpis/k1", async ({ request }) => { const b = await request.json(); bodies.push(b); return bodies.length === 1 ? HttpResponse.json({ error: { code: "invalid_thresholds", message: "Thresholds must run critical, warning, target in the better direction." } }, { status: 400 }) : HttpResponse.json(kpi()); }));
    renderWithProviders(<KpisPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "History of Revenue" }));
    expect(await screen.findByText(/2026-11-20/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Change Revenue" }));
    const target = await screen.findByLabelText("Target");
    expect(target).toHaveValue("100.0000");
    await userEvent.clear(target);
    await userEvent.type(target, "120");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Thresholds must run/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]).toMatchObject({ name: "Revenue", direction: "HIGHER", target: "120", warn_at: "50.0000", critical_at: "10.0000", params: { period: "LAST_30_DAYS" } });
    await userEvent.click(screen.getByRole("button", { name: "Switch off Revenue" }));
    await waitFor(() => expect(bodies[2]).toEqual({ is_active: false }));
  });
});

describe("Dashboard editing", () => {
  const dash = { id: "d1", code: "exec", name: "Executive", description: "", is_system: false, visibility: "ALL", roles: [] };
  const w = (id: string, pos: number, title: string) => ({ id, kind: "KPI", title, position: pos, restricted: false, data: { ...kpi(), latest: { as_of: "x", value: "1", status: "GOOD" } } });
  const base = [http.get("*/api/v1/analytics/dashboards", () => HttpResponse.json([dash])), http.get("*/api/v1/analytics/dashboards/d1", () => HttpResponse.json({ ...dash, widgets: [w("w1", 1, "First"), w("w2", 2, "Second")] }))];

  it("viewers see no editing controls", async () => {
    server.use(...base);
    renderWithProviders(<DashboardPage />, { permissions: ["analytics.view"] });
    await screen.findByText("First");
    expect(screen.queryByRole("button", { name: "Add widget" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New dashboard" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove First" })).toBeNull();
  });

  it("reorders by swapping positions, and removes a widget", async () => {
    const patches: unknown[] = []; let removed = false;
    server.use(...base, http.patch("*/api/v1/analytics/widgets/:id", async ({ request, params }) => { patches.push([params.id, await request.json()]); return HttpResponse.json({}); }),
      http.delete("*/api/v1/analytics/widgets/w2", () => { removed = true; return new HttpResponse(null, { status: 204 }); }));
    renderWithProviders(<DashboardPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Move Second earlier" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches).toContainEqual(["w2", { position: 1 }]);
    expect(patches).toContainEqual(["w1", { position: 2 }]);
    await userEvent.click(screen.getByRole("button", { name: "Remove Second" }));
    await waitFor(() => expect(removed).toBe(true));
  });

  it("adds a trend widget and a table widget", async () => {
    const bodies: unknown[] = [];
    server.use(...base, catalog, http.get("*/api/v1/analytics/kpis", () => HttpResponse.json([kpi()])), http.post("*/api/v1/analytics/dashboards/d1/widgets", async ({ request }) => { bodies.push(await request.json()); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<DashboardPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Add widget" }));
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "TREND");
    await userEvent.click(screen.getAllByRole("button", { name: "Add" }).at(-1)!);
    expect(await screen.findByText("Choose a KPI.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "Revenue" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("KPI"), "rev");
    await userEvent.click(screen.getAllByRole("button", { name: "Add" }).at(-1)!);
    await waitFor(() => expect(bodies[0]).toEqual({ kind: "TREND", title: "Revenue", config: { kpi: "rev", days: 30 } }));
    await userEvent.click(screen.getByRole("button", { name: "Add widget" }));
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "DATASET");
    await waitFor(() => expect(screen.getByRole("option", { name: "sales — Sales by customer" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Data set"), "sales.by-customer");
    await userEvent.selectOptions(screen.getByLabelText("Period"), "MTD");
    await userEvent.click(screen.getAllByRole("button", { name: "Add" }).at(-1)!);
    await waitFor(() => expect(bodies[1]).toEqual({ kind: "DATASET", title: "Sales by customer", config: { dataset: "sales.by-customer", limit: 10, period: "MTD" } }));
  });

  it("creates a dashboard for chosen roles, and changes/archives one", async () => {
    const created: unknown[] = []; const patched: unknown[] = [];
    server.use(http.get("*/api/v1/analytics/dashboards", () => HttpResponse.json(created.length ? [dash, { ...dash, id: "d2", code: "fin", name: "Finance board" }] : [dash])),
      http.get("*/api/v1/analytics/dashboards/d1", () => HttpResponse.json({ ...dash, widgets: [] })),
      http.get("*/api/v1/analytics/dashboards/d2", () => HttpResponse.json({ ...dash, id: "d2", name: "Finance board", widgets: [] })), http.get("*/api/v1/roles", () => HttpResponse.json([{ id: "r1", name: "finance_manager", display_name: "Finance Manager", is_system: true, permissions: [] }])),
      http.post("*/api/v1/analytics/dashboards", async ({ request }) => { created.push(await request.json()); return HttpResponse.json({ id: "d2" }, { status: 201 }); }),
      http.patch("*/api/v1/analytics/dashboards/d1", async ({ request }) => { patched.push(await request.json()); return HttpResponse.json({}); }));
    renderWithProviders(<DashboardPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "New dashboard" }));
    await userEvent.type(screen.getByLabelText("Code"), "fin");
    await userEvent.type(screen.getByLabelText("Name"), "Finance board");
    await userEvent.selectOptions(screen.getByLabelText("Who can see it"), "ROLES");
    await userEvent.click(screen.getByRole("button", { name: "Create dashboard" }));
    expect(await screen.findByText("Choose the roles that can see it.")).toBeInTheDocument();
    await userEvent.click(await screen.findByLabelText("Finance Manager"));
    await userEvent.click(screen.getByRole("button", { name: "Create dashboard" }));
    await waitFor(() => expect(created[0]).toEqual({ name: "Finance board", description: "", visibility: "ROLES", roles: ["finance_manager"], code: "fin" }));
    await userEvent.click(await screen.findByRole("tab", { name: "Executive" }));
    await userEvent.click(await screen.findByRole("button", { name: "Change dashboard" }));
    await userEvent.click(await screen.findByRole("button", { name: "Archive dashboard" }));
    await waitFor(() => expect(patched[0]).toMatchObject({ name: "Executive", is_active: false }));
  });
});

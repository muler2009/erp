import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { InsightsPage } from "./InsightsPage";
import { TeamsPage, flattenTeams, parseCountries } from "./TeamsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [
  { id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" },
  { id: "e2", employee_no: "E-2", name: "Sara", status: "ACTIVE", user_id: "u2" }] }));
const tree = [{ id: "t1", name: "Sales EMEA", manager_id: "u1", members: [{ user_id: "u2", is_lead: true }], children: [{ id: "t2", name: "Key accounts", manager_id: null, members: [], children: [] }] }];
const ASSIGN = ["crm.view", "crm.assign"];

describe("helpers", () => {
  it("flattens teams and validates countries", () => {
    expect(flattenTeams(tree as never).map((t) => t.name)).toEqual(["Sales EMEA", "Key accounts"]);
    expect(parseCountries("et, ke")).toEqual(["ET", "KE"]);
    expect(() => parseCountries("ETH")).toThrow();
  });
});

describe("TeamsPage", () => {
  it("shows the hierarchy and members, and a manager can add a team", async () => {
    let body: unknown = null;
    server.use(employees, http.get("*/api/v1/crm/teams", () => HttpResponse.json(tree)),
      http.post("*/api/v1/crm/teams", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<TeamsPage />, { permissions: ASSIGN });
    expect(await screen.findByText("Sales EMEA")).toBeInTheDocument();
    expect(screen.getByText("Key accounts")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New team" }));
    const dlg = within(await screen.findByRole("dialog", { name: "New team" }));
    await userEvent.type(dlg.getByLabelText("Name"), "Inside sales");
    await userEvent.click(dlg.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(body).toMatchObject({ name: "Inside sales" }));
  });

  it("hides management buttons without crm.assign", async () => {
    server.use(employees, http.get("*/api/v1/crm/teams", () => HttpResponse.json(tree)));
    renderWithProviders(<TeamsPage />, { permissions: ["crm.view"] });
    await screen.findByText("Sales EMEA");
    expect(screen.queryByRole("button", { name: "New team" })).toBeNull();
  });

  it("removes a member and shows a server refusal", async () => {
    server.use(employees, http.get("*/api/v1/crm/teams", () => HttpResponse.json(tree)),
      http.delete("*/api/v1/crm/teams/t1/members", () => HttpResponse.json({ error: { code: "not_found", message: "That person is not in a team." } }, { status: 404 })));
    renderWithProviders(<TeamsPage />, { permissions: ASSIGN });
    await userEvent.click(await screen.findByRole("button", { name: "Remove Sara from Sales EMEA" }));
    expect(await screen.findByText("That person is not in a team.")).toBeInTheDocument();
  });

  it("creates a territory and rejects a bad country code before calling the server", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(employees, http.get("*/api/v1/crm/teams", () => HttpResponse.json(tree)), http.get("*/api/v1/crm/territories", () => HttpResponse.json([])),
      http.put("*/api/v1/crm/territories", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}); }));
    renderWithProviders(<TeamsPage />, { permissions: ASSIGN });
    await userEvent.click(await screen.findByRole("tab", { name: "Territories" }));
    await userEvent.click(await screen.findByRole("button", { name: "New territory" }));
    const dlg = within(await screen.findByRole("dialog", { name: "New territory" }));
    await userEvent.type(dlg.getByLabelText("Name"), "East Africa");
    await userEvent.selectOptions(dlg.getByLabelText("Team"), "t1");
    await userEvent.type(dlg.getByLabelText(/Countries/), "ETH");
    await userEvent.click(dlg.getByRole("button", { name: "Save territory" }));
    expect(await dlg.findByRole("alert")).toBeInTheDocument();
    expect(body).toBeNull();
    await userEvent.clear(dlg.getByLabelText(/Countries/));
    await userEvent.type(dlg.getByLabelText(/Countries/), "et, ke");
    await userEvent.click(dlg.getByRole("button", { name: "Save territory" }));
    await waitFor(() => expect(body).toMatchObject({ name: "East Africa", team: "t1", criteria: { country: ["ET", "KE"] } }));
  });

  it("lists portfolios and transfers one", async () => {
    let body: unknown = null;
    server.use(employees, http.get("*/api/v1/crm/portfolio", () => HttpResponse.json([{ owner_id: "u1", accounts: 4, open_opportunities: 2, open_value: { ETB: "1000.00" } }])),
      http.post("*/api/v1/crm/portfolio/transfer", async ({ request }) => { body = await request.json(); return HttpResponse.json({ account: 4, opportunity: 2, lead: 0 }); }));
    renderWithProviders(<TeamsPage />, { permissions: ASSIGN });
    await userEvent.click(await screen.findByRole("tab", { name: "Portfolios" }));
    expect(await screen.findByText("Abel")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Transfer a portfolio" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Transfer a portfolio" }));
    await userEvent.selectOptions(dlg.getByLabelText("From"), "u1");
    await userEvent.selectOptions(dlg.getByLabelText("To"), "u2");
    await userEvent.type(dlg.getByLabelText("Reason"), "Leaver");
    await userEvent.click(dlg.getByRole("button", { name: "Transfer" }));
    await waitFor(() => expect(body).toEqual({ from_user: "u1", to_user: "u2", reason: "Leaver" }));
  });
});

const dash = { lead_sources: { WEB: { leads: 10, converted: 3, conversion_percent: 30 } }, pipeline: { open_count: 5, open_value_by_currency: { ETB: "5000.00" } }, won: 2, lost: 1,
  neglected_opportunities: [{ id: "o1", name: "Big deal", owner_id: "u1", last_activity_at: null, amount: "900.00" }],
  activity_performance: [{ owner_id: "u2", activities: 8, completed: 6, completion_percent: 75 }], overdue_activities: 3, customers: { active: 7, at_risk: 2, churned: 1, churn_rate_percent: 10 } };

describe("InsightsPage", () => {
  it("shows the overview and flags deals nobody has contacted", async () => {
    server.use(employees, http.get("*/api/v1/crm/insights/dashboard", () => HttpResponse.json(dash)));
    renderWithProviders(<InsightsPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText("WEB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Big deal" })).toHaveAttribute("href", "/app/crm/opportunities/o1");
    expect(screen.getByText(/never contacted/)).toBeInTheDocument();
    expect(screen.getByText(/Sara: 6 of 8 done \(75%\)/)).toBeInTheDocument();
  });

  it("shows an error with retry", async () => {
    server.use(employees, http.get("*/api/v1/crm/insights/dashboard", () => HttpResponse.json({ error: { code: "x", message: "Boom" } }, { status: 500 })));
    renderWithProviders(<InsightsPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText(/Boom/)).toBeInTheDocument();
  });

  it("lets a manager refresh lifecycle stages from the retention tab", async () => {
    let called = 0;
    server.use(employees, http.get("*/api/v1/crm/insights/dashboard", () => HttpResponse.json(dash)),
      http.get("*/api/v1/crm/insights/retention", () => HttpResponse.json({ active: [], at_risk: [{ account: "a1", name: "Acme", last_order: "2026-07-01", days_idle: 110, lifetime_value: "500.00" }], churned: [], never_purchased: 2, churn_rate_percent: 0 })),
      http.post("*/api/v1/crm/insights/refresh-lifecycle", () => { called += 1; return HttpResponse.json({ changed: 3 }); }));
    renderWithProviders(<InsightsPage />, { permissions: ASSIGN });
    await userEvent.click(await screen.findByRole("tab", { name: "Retention" }));
    expect(await screen.findByRole("link", { name: "Acme" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Update customer lifecycle stages" }));
    expect(await screen.findByText("3 accounts updated.")).toBeInTheDocument();
    expect(called).toBe(1);
  });

  it("explains tiers, satisfaction and profitability, including the base-currency refusal", async () => {
    server.use(employees, http.get("*/api/v1/crm/insights/dashboard", () => HttpResponse.json(dash)),
      http.get("*/api/v1/crm/insights/segmentation", () => HttpResponse.json({ currency: "ETB", total_revenue: "1000.00", tiers: { A: [{ account: "a1", name: "Acme", revenue: "800.00" }], B: [], C: [], N: [] }, by_segment: { SME: "1000.00" }, by_industry: {} })),
      http.get("*/api/v1/crm/insights/satisfaction", () => HttpResponse.json({ responses: 0, average: null, distribution: {}, promoter_percent: 0, detractor_percent: 0, lowest_accounts: [] })),
      http.get("*/api/v1/crm/insights/profitability", () => HttpResponse.json({ error: { code: "base_currency_only", message: "Profitability is only available in the base currency." } }, { status: 400 })));
    renderWithProviders(<InsightsPage />, { permissions: ["crm.view"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Customer tiers" }));
    expect(await screen.findByText(/Tier A/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Satisfaction" }));
    expect(await screen.findByText("No ratings yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Profitability" }));
    expect(await screen.findByText(/only available in the base currency/)).toBeInTheDocument();
  });
});

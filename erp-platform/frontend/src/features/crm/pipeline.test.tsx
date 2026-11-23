import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ActivitiesPage, toIso } from "./ActivitiesPage";
import { CrmReportsPage, pct } from "./CrmReportsPage";
import { OpportunitiesPage } from "./OpportunitiesPage";
import { OpportunityDetailPage, validateLines } from "./OpportunityDetailPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const act = (o = {}) => ({ id: "ac1", type: "CALL", subject: "Call Dawit", due_at: "2026-11-20T10:00:00Z", done_at: null, owner_id: "u1", lead: null, opportunity: "o1", account: "a1", priority: "HIGH", assignee_id: "u1", outcome: "", notes: "", ...o });
const accounts = http.get("*/api/v1/crm/accounts", () => page([{ id: "a1", name: "Acme Ltd", industry: "", segment: "", owner_id: "u1", is_active: true, credit_status: "OK", lifecycle_stage: "ACTIVE" }]));
const MANAGE = ["crm.view", "crm.manage"];

describe("helpers", () => {
  it("converts local times, validates lines and formats rates", () => {
    expect(toIso("2026-11-20T14:30")).toMatch(/^2026-11-20T\d\d:30:00.000Z$/);
    expect(() => toIso("")).toThrow(/valid date/);
    expect(validateLines([{ product: "", quantity: "1", expected_price: "1" }])).toMatch(/choose a product/);
    expect(validateLines([{ product: "p", quantity: "0", expected_price: "1" }])).toMatch(/greater than zero/);
    expect(validateLines([{ product: "p", quantity: "1", expected_price: "1.234" }])).toMatch(/2 decimals/);
    expect(validateLines([{ product: "p", quantity: "1", expected_price: "1" }, { product: "p", quantity: "1", expected_price: "1" }])).toMatch(/already/);
    expect(validateLines([{ product: "p", quantity: "2.5", expected_price: "10" }])).toBeNull();
    expect(pct(0.25)).toBe("25.0%");
    expect(pct(null)).toBe("–");
  });
});

describe("ActivitiesPage", () => {
  it("shows what is coming up, and asks for the whole team only if allowed", async () => {
    let scope: string | null = "x";
    server.use(http.get("*/api/v1/crm/activities/calendar", ({ request }) => { scope = new URL(request.url).searchParams.get("scope"); return page([act()]); }));
    const { unmount } = renderWithProviders(<ActivitiesPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText("Call Dawit")).toBeInTheDocument();
    expect(scope).toBeNull();
    expect(screen.queryByLabelText("Whole team")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule activity" })).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<ActivitiesPage />, { permissions: ["crm.view", "crm.view_all"] });
    await userEvent.click(await screen.findByLabelText("Whole team"));
    await waitFor(() => expect(scope).toBe("team"));
  });

  it("switches to follow-ups and overdue", async () => {
    server.use(http.get("*/api/v1/crm/activities/calendar", () => page([])), http.get("*/api/v1/crm/followups", () => HttpResponse.json([act({ subject: "Chase quote" })])), http.get("*/api/v1/crm/activities/overdue", () => HttpResponse.json([])));
    renderWithProviders(<ActivitiesPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText("Nothing scheduled in this period")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Follow-ups due" }));
    expect(await screen.findByText("Chase quote")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Overdue" }));
    expect(await screen.findByText("Nothing is overdue")).toBeInTheDocument();
  });

  it("schedules an activity with an absolute time and completes another with an outcome", async () => {
    let created: Record<string, unknown> = {}; let outcome: unknown;
    server.use(accounts, http.get("*/api/v1/crm/activities/calendar", () => page([act()])),
      http.post("*/api/v1/crm/activities", async ({ request }) => { created = (await request.json()) as Record<string, unknown>; return HttpResponse.json(act(), { status: 201 }); }),
      http.post("*/api/v1/crm/activities/ac1/complete", async ({ request }) => { outcome = await request.json(); return HttpResponse.json(act({ done_at: "2026-11-20T11:00:00Z" })); }));
    renderWithProviders(<ActivitiesPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Schedule activity" }));
    const d = within(await screen.findByRole("dialog", { name: "Schedule activity" }));
    await userEvent.click(d.getByRole("button", { name: "Schedule" }));
    expect(await d.findByRole("alert")).toHaveTextContent("Subject is required");
    await userEvent.type(d.getByLabelText("Subject"), "Demo for Acme");
    fireEvent.change(d.getByLabelText("Due"), { target: { value: "2026-11-25T09:00" } });
    await waitFor(() => expect(d.getByRole("option", { name: "Acme Ltd" })).toBeInTheDocument());
    await userEvent.selectOptions(d.getByLabelText("Customer account"), "a1");
    await userEvent.click(d.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(created).toMatchObject({ type: "CALL", subject: "Demo for Acme", priority: "MEDIUM", account: "a1" }));
    expect(String(created.due_at)).toMatch(/^2026-11-25T/);
    await userEvent.click(await screen.findByRole("button", { name: "Complete Call Dawit" }));
    const c = within(await screen.findByRole("dialog", { name: "Complete activity" }));
    await userEvent.type(c.getByLabelText("What was the outcome?"), "Wants a quote");
    await userEvent.click(c.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(outcome).toEqual({ outcome: "Wants a quote" }));
  });
});

const opp = (o = {}) => ({ id: "o1", name: "Big deal", account: "a1", stage: "PROPOSAL", probability: 50, amount: "1000.00", currency: "USD", status: "OPEN", expected_close: "2026-12-31", owner_id: "u1", contact: null, lost_reason: "", competitors: "Rival Co", requirements: "", decision_makers: "", risks: "", next_action: "Send quote", next_action_date: null, last_activity_at: null, ...o });

describe("OpportunityDetailPage", () => {
  function detail(permissions: string[], o: object, extra: Parameters<typeof server.use> = []) {
    server.use(accounts, http.get("*/api/v1/crm/opportunities/o1", () => HttpResponse.json(o)),
      http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/crm/opportunities/o1/history", () => HttpResponse.json([{ from: "", to: "PROSPECTING", at: "2026-11-01T08:00:00Z", actor: null, note: "" }, { from: "PROSPECTING", to: "PROPOSAL", at: "2026-11-05T08:00:00Z", actor: null, note: "Quote requested" }])),
      http.get("*/api/v1/crm/opportunities/o1/lines", () => HttpResponse.json([{ product: "p1", sku: "SKU-1", quantity: "2", expected_price: "50.00" }])), ...extra);
    return renderWithProviders(<Routes><Route path="/app/crm/opportunities/:id" element={<OpportunityDetailPage />} /></Routes>, { permissions, route: "/app/crm/opportunities/o1" });
  }

  it("lets a sales manager change the owner of an open deal", async () => {
    let body: unknown = null;
    detail(["crm.view", "crm.assign"], opp(), []);
    server.use( // after detail(): the newest handler wins
      http.get("*/api/v1/directory/users", () => HttpResponse.json({ results: [{ id: "u1", name: "Abel" }] })),
      http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e2", employee_no: "E-2", name: "Sara", status: "ACTIVE", user_id: "u2" }] })),
      http.post("*/api/v1/crm/opportunity/o1/assign", async ({ request }) => { body = await request.json(); return HttpResponse.json({}); }));
    await userEvent.click(await screen.findByRole("button", { name: "Change owner" }));
    const d = within(await screen.findByRole("dialog", { name: "Change owner" }));
    await d.findByRole("option", { name: /Sara/ });
    await userEvent.selectOptions(d.getByLabelText("New owner"), "u2");
    await userEvent.click(d.getByRole("button", { name: "Change owner" }));
    await waitFor(() => expect(body).toEqual({ owner_id: "u2" }));
  });

  it("shows details, products and stage history", async () => {
    detail(["crm.view"], opp());
    expect(await screen.findByRole("heading", { name: "Big deal" })).toBeInTheDocument();
    expect(await screen.findByText("SKU-1")).toBeInTheDocument();
    expect(await screen.findByText(/PROSPECTING → PROPOSAL/)).toBeInTheDocument();
    expect(screen.getByText(/Opened at PROSPECTING/)).toBeInTheDocument();
    expect(screen.getByText("Rival Co")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit details" })).not.toBeInTheDocument();
  });

  it("is read-only once the opportunity is closed", async () => {
    detail(MANAGE, opp({ status: "WON" }));
    expect(await screen.findByText("won")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit products" })).not.toBeInTheDocument();
  });

  it("edits the details, rejecting a bad amount before calling the server", async () => {
    let body: Record<string, unknown> = {};
    detail(MANAGE, opp(), [http.patch("*/api/v1/crm/opportunities/o1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(opp()); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Edit details" }));
    const d = within(await screen.findByRole("dialog", { name: "Edit details" }));
    await userEvent.clear(d.getByLabelText("Amount"));
    await userEvent.type(d.getByLabelText("Amount"), "12.345");
    await userEvent.click(d.getByRole("button", { name: "Save details" }));
    expect(await d.findByRole("alert")).toHaveTextContent("2 decimals");
    expect(body).toEqual({});
    await userEvent.clear(d.getByLabelText("Amount"));
    await userEvent.type(d.getByLabelText("Amount"), "1500");
    await userEvent.click(d.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(body).toMatchObject({ name: "Big deal", amount: "1500", expected_close: "2026-12-31", next_action_date: null, competitors: "Rival Co" }));
  });

  it("replaces the product list", async () => {
    let body: Record<string, unknown> = {};
    detail(MANAGE, opp(), [http.get("*/api/v1/inventory/products", () => page([{ id: "p1", sku: "SKU-1", name: "Widget", is_active: true }, { id: "p2", sku: "SKU-2", name: "Gadget", is_active: true }])),
      http.put("*/api/v1/crm/opportunities/o1/lines", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json([]); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Edit products" }));
    const d = within(await screen.findByRole("dialog", { name: "Edit products" }));
    await userEvent.click(d.getByRole("button", { name: "Add line" }));
    await waitFor(() => expect(d.getAllByRole("option", { name: "SKU-2 Gadget" }).length).toBeGreaterThan(0));
    await userEvent.selectOptions(d.getByLabelText("Product 2"), "p1");
    await userEvent.click(d.getByRole("button", { name: "Save products" }));
    expect(await d.findByRole("alert")).toHaveTextContent("already on this opportunity");
    await userEvent.selectOptions(d.getByLabelText("Product 2"), "p2");
    await userEvent.clear(d.getByLabelText("Expected price 2"));
    await userEvent.type(d.getByLabelText("Expected price 2"), "75");
    await userEvent.click(d.getByRole("button", { name: "Save products" }));
    await waitFor(() => expect(body).toEqual({ lines: [{ product: "p1", quantity: "2", expected_price: "50.00" }, { product: "p2", quantity: "1", expected_price: "75" }] }));
  });
});

describe("Quotation from an opportunity", () => {
  function detail(permissions: string[], extra: Parameters<typeof server.use> = []) {
    server.use(accounts, http.get("*/api/v1/crm/opportunities/o1", () => HttpResponse.json(opp())), http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/crm/opportunities/o1/history", () => HttpResponse.json([])), http.get("*/api/v1/crm/opportunities/o1/lines", () => HttpResponse.json([])), ...extra);
    return renderWithProviders(<Routes><Route path="/app/crm/opportunities/:id" element={<OpportunityDetailPage />} /></Routes>, { permissions, route: "/app/crm/opportunities/o1" });
  }
  it("creates a draft quotation from an open deal", async () => {
    let body: Record<string, unknown> = {};
    detail(["crm.view", "sales.quote.create"], [http.post("*/api/v1/sales/opportunities/o1/quotation", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "q1", number: "QT-9" }, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Create quotation" }));
    const d = within(await screen.findByRole("dialog", { name: "Create quotation" }));
    await userEvent.type(d.getByLabelText("Payment terms"), "Net 30");
    await userEvent.click(d.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/Quotation QT-9 created/)).toBeInTheDocument();
    expect(body).toEqual({ payment_terms: "Net 30", delivery_terms: "" });
  });
  it("shows the server's reason when the deal has no product lines", async () => {
    detail(["crm.view", "sales.quote.create"], [http.post("*/api/v1/sales/opportunities/o1/quotation", () => HttpResponse.json({ error: { code: "no_lines", message: "The opportunity has no product lines to quote." } }, { status: 422 }))]);
    await userEvent.click(await screen.findByRole("button", { name: "Create quotation" }));
    const d = within(await screen.findByRole("dialog", { name: "Create quotation" }));
    await userEvent.click(d.getByRole("button", { name: "Create" }));
    expect(await d.findByText("The opportunity has no product lines to quote.")).toBeInTheDocument();
  });
  it("is hidden without the permission", async () => {
    detail(["crm.view"]);
    await screen.findByText("Big deal");
    expect(screen.queryByRole("button", { name: "Create quotation" })).toBeNull();
  });
});

describe("OpportunitiesPage creation", () => {
  it("creates an opportunity for a chosen account", async () => {
    let body: Record<string, unknown> = {};
    server.use(accounts, http.get("*/api/v1/crm/opportunities", () => page([])),
      http.get("*/api/v1/crm/stages", () => HttpResponse.json([{ code: "PROSPECTING", name: "Prospecting", probability: 10, is_won: false, is_lost: false }, { code: "WON", name: "Won", probability: 100, is_won: true, is_lost: false }])),
      http.post("*/api/v1/crm/opportunities", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(opp(), { status: 201 }); }));
    renderWithProviders(<OpportunitiesPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "New opportunity" }));
    const d = within(await screen.findByRole("dialog", { name: "New opportunity" }));
    await userEvent.type(d.getByLabelText("Name"), "Renewal");
    await userEvent.click(d.getByRole("button", { name: "Create opportunity" }));
    expect(await d.findByRole("alert")).toHaveTextContent("Customer account is required");
    await waitFor(() => expect(d.getByRole("option", { name: "Acme Ltd" })).toBeInTheDocument());
    await userEvent.selectOptions(d.getByLabelText("Customer account"), "a1");
    await userEvent.type(d.getByLabelText("Amount"), "900");
    await userEvent.type(d.getByLabelText("Currency (3 letters)"), "usd");
    await userEvent.click(d.getByRole("button", { name: "Create opportunity" }));
    await waitFor(() => expect(body).toEqual({ name: "Renewal", account: "a1", amount: "900", currency: "USD", stage: "PROSPECTING" }));
  });
});

describe("CrmReportsPage", () => {
  it("shows the pipeline, regroups it, and names sales reps", async () => {
    let group = "";
    server.use(http.get("*/api/v1/crm/reports/forecast", () => HttpResponse.json([{ month: "2026-12", currency: "USD", count: 2, amount: "3000", weighted: "1500.00" }])),
      http.get("*/api/v1/crm/reports/forecast-by", ({ request }) => { group = new URL(request.url).searchParams.get("group")!; return HttpResponse.json([{ group: group === "owner" ? "u1" : "PROPOSAL", currency: "USD", count: 2, amount: "3000", weighted: "1500.00" }]); }),
      http.get("*/api/v1/crm/reports/conversion", () => HttpResponse.json({ leads: { NEW: 4, CONVERTED: 1 }, lead_to_opportunity_rate: 0.2, won: 3, lost: 1, win_rate: 0.75 })),
      http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] })));
    renderWithProviders(<CrmReportsPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText("2026-12")).toBeInTheDocument();
    expect(await screen.findByText("Abel")).toBeInTheDocument();
    expect(screen.getByText("75.0%")).toBeInTheDocument();
    expect(screen.getByText("20.0%")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Group by"), "stage");
    expect(await screen.findByText("PROPOSAL")).toBeInTheDocument();
    expect(group).toBe("stage");
  });

  it("shows empty and not-enough-data states", async () => {
    server.use(http.get("*/api/v1/crm/reports/forecast", () => HttpResponse.json([])), http.get("*/api/v1/crm/reports/forecast-by", () => HttpResponse.json([])),
      http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/crm/reports/conversion", () => HttpResponse.json({ leads: {}, lead_to_opportunity_rate: null, won: 0, lost: 0, win_rate: null })));
    renderWithProviders(<CrmReportsPage />, { permissions: ["crm.view"] });
    expect(await screen.findAllByText("No open opportunities")).toHaveLength(2);
    expect(screen.getAllByText("–")).toHaveLength(2);
  });
});

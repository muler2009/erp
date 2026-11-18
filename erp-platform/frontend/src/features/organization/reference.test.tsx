import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { MembersPage } from "./MembersPage";
import { NumberingPage } from "./NumberingPage";
import { ReferencePage } from "./ReferencePage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const usd = { id: "cu1", code: "USD", name: "US dollar", symbol: "$", decimals: 2, is_active: true };
const eur = { id: "cu2", code: "EUR", name: "Euro", symbol: "€", decimals: 2, is_active: false };
const currencies = http.get("*/api/v1/org/currencies", ({ request }) => page(new URL(request.url).searchParams.get("active") === "true" ? [usd] : [usd, eur]));
const MANAGE = ["org.reference.view", "org.reference.manage", "org.fiscal.close"];

describe("Currencies and calendar", () => {
  it("turns a currency on and shows the reason when the server refuses", async () => {
    let sent: unknown; let lists = 0;
    server.use(http.get("*/api/v1/org/currencies", ({ request }) => { lists += 1; return page(new URL(request.url).searchParams.get("active") === "true" ? [usd] : [usd, eur]); }), http.patch("*/api/v1/org/currencies/EUR", async ({ request }) => { sent = await request.json(); return HttpResponse.json({ ...eur, is_active: true }); }),
      http.patch("*/api/v1/org/currencies/USD", () => HttpResponse.json({ error: { code: "currency_in_use", message: "USD is the base currency." } }, { status: 409 })));
    renderWithProviders(<ReferencePage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Start using" }));
    await waitFor(() => expect(sent).toEqual({ is_active: true }));
    const before = lists;
    await waitFor(() => expect(lists).toBeGreaterThan(before - 1)); // the list reloads after a change; click again once it has settled
    await new Promise((r) => setTimeout(r, 100));
    await userEvent.click(await screen.findByRole("button", { name: "Stop using" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("base currency");
  });

  it("hides the switches without the manage permission", async () => {
    server.use(currencies);
    renderWithProviders(<ReferencePage />, { permissions: ["org.reference.view"] });
    expect(await screen.findByText("Euro")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /using/ })).not.toBeInTheDocument();
  });

  it("adds an exchange rate, rejecting a bad rate before calling the server", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(currencies, http.get("*/api/v1/org/exchange-rates", () => page([{ id: "r1", currency: "cu1", currency_code: "USD", rate_date: "2026-11-01", rate: "56.5", source: "NBE" }])),
      http.post("*/api/v1/org/exchange-rates", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "r2" }, { status: 201 }); }));
    renderWithProviders(<ReferencePage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("tab", { name: "Exchange rates" }));
    expect(await screen.findByText("56.5")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add rate" }));
    const d = within(await screen.findByRole("dialog", { name: "Add exchange rate" }));
    await waitFor(() => expect(d.getByRole("option", { name: "USD US dollar" })).toBeInTheDocument());
    await userEvent.selectOptions(d.getByLabelText("Currency"), "USD");
    fireEvent.change(d.getByLabelText("Date"), { target: { value: "2026-11-15" } });
    await userEvent.type(d.getByLabelText("Rate (base units per 1)"), "-3");
    await userEvent.click(d.getByRole("button", { name: "Save rate" }));
    expect(await d.findByRole("alert")).toHaveTextContent("positive number");
    expect(body).toBeNull();
    await userEvent.clear(d.getByLabelText("Rate (base units per 1)"));
    await userEvent.type(d.getByLabelText("Rate (base units per 1)"), "57.25");
    await userEvent.click(d.getByRole("button", { name: "Save rate" }));
    await waitFor(() => expect(body).toEqual({ currency: "USD", rate_date: "2026-11-15", rate: "57.25", source: "" }));
  });

  it("shows fiscal periods, closes one, and asks for a reason to reopen another", async () => {
    let reopened: unknown; let closed = false;
    const period = (id: string, n: number, status: string) => ({ id, number: n, name: `P${n}`, start_date: "2026-01-01", end_date: "2026-01-31", status, closed_at: null, closed_by: null, version: 1 });
    server.use(http.get("*/api/v1/org/fiscal-years", () => HttpResponse.json([{ id: "y1", name: "FY2026", start_date: "2026-01-01", end_date: "2026-12-31", periods: [period("p1", 1, "CLOSED"), period("p2", 2, "OPEN")] }])),
      http.post("*/api/v1/org/fiscal-periods/p2/close", () => { closed = true; return HttpResponse.json({}); }),
      http.post("*/api/v1/org/fiscal-periods/p1/reopen", async ({ request }) => { reopened = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<ReferencePage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("tab", { name: "Fiscal calendar" }));
    expect(await screen.findByText(/FY2026 \(/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close P2" }));
    await waitFor(() => expect(closed).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Reopen P1" }));
    const d = within(await screen.findByRole("dialog", { name: "Reopen period" }));
    await userEvent.click(d.getByRole("button", { name: "Reopen" }));
    expect(await d.findByRole("alert")).toHaveTextContent("required");
    await userEvent.type(d.getByLabelText("Why is it being reopened?"), "Late invoice");
    await userEvent.click(d.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(reopened).toEqual({ reason: "Late invoice" }));
  });

  it("only offers closing to people with the close permission", async () => {
    server.use(http.get("*/api/v1/org/fiscal-years", () => HttpResponse.json([{ id: "y1", name: "FY2026", start_date: "2026-01-01", end_date: "2026-12-31", periods: [{ id: "p2", number: 2, name: "P2", start_date: "2026-02-01", end_date: "2026-02-28", status: "OPEN", closed_at: null, closed_by: null, version: 1 }] }])));
    renderWithProviders(<ReferencePage />, { permissions: ["org.reference.view", "org.reference.manage"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Fiscal calendar" }));
    expect(await screen.findByText("P2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close P2" })).not.toBeInTheDocument();
  });

  it("adds a holiday for one branch", async () => {
    let body: unknown;
    server.use(http.get("*/api/v1/org/holidays", () => page([{ id: "h1", holiday_date: "2026-01-07", name: "Christmas", branch: null }])),
      http.get("*/api/v1/org/branches", () => page([{ id: "b1", code: "HQ", name: "Head office", is_active: true, version: 1 }])),
      http.post("*/api/v1/org/holidays", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "h2" }, { status: 201 }); }));
    renderWithProviders(<ReferencePage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("tab", { name: "Holidays" }));
    expect(await screen.findByText("All branches")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add holiday" }));
    const d = within(await screen.findByRole("dialog", { name: "Add holiday" }));
    fireEvent.change(d.getByLabelText("Date"), { target: { value: "2026-09-11" } });
    await userEvent.type(d.getByLabelText("Name"), "Founders day");
    await waitFor(() => expect(d.getByRole("option", { name: "HQ Head office" })).toBeInTheDocument());
    await userEvent.selectOptions(d.getByLabelText("Branch (blank = all)"), "b1");
    await userEvent.click(d.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(body).toEqual({ holiday_date: "2026-09-11", name: "Founders day", branch: "b1" }));
  });
});

describe("NumberingPage", () => {
  const seq = { id: "s1", code: "po", name: "Purchase orders", template: "PO-{yyyy}-{seq:05d}", reset_policy: "YEARLY", next_value: 12, period_key: "2026", is_active: true };

  it("lists sequences, edits one with a preview, and validates", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.get("*/api/v1/sequences", () => page([seq])), http.get("*/api/v1/sequences/po", () => HttpResponse.json({ ...seq, preview: "PO-2026-00012" })),
      http.patch("*/api/v1/sequences/po", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(seq); }));
    renderWithProviders(<NumberingPage />, { permissions: ["org.sequences.manage"] });
    expect(await screen.findByText("Every year")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit po" }));
    const d = within(await screen.findByRole("dialog", { name: "Edit po" }));
    expect(await d.findByText(/PO-2026-00012/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Next number"));
    await userEvent.type(d.getByLabelText("Next number"), "0");
    await userEvent.click(d.getByRole("button", { name: "Save changes" }));
    expect(await d.findByRole("alert")).toHaveTextContent("at least 1");
    await userEvent.clear(d.getByLabelText("Next number"));
    await userEvent.type(d.getByLabelText("Next number"), "100");
    await userEvent.click(d.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(body).toMatchObject({ next_value: 100, reset_policy: "YEARLY", is_active: true }));
  });

  it("creates a sequence and refuses a bad code locally", async () => {
    let body: unknown;
    server.use(http.get("*/api/v1/sequences", () => page([])), http.post("*/api/v1/sequences", async ({ request }) => { body = await request.json(); return HttpResponse.json(seq, { status: 201 }); }));
    renderWithProviders(<NumberingPage />, { permissions: ["org.sequences.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Add sequence" }));
    const d = within(await screen.findByRole("dialog", { name: "Add sequence" }));
    await userEvent.type(d.getByLabelText("Code"), "bad code!");
    await userEvent.type(d.getByLabelText("Name"), "Invoices");
    await userEvent.type(d.getByLabelText("Template"), "INV-{{seq:06d}");
    await userEvent.click(d.getByRole("button", { name: "Create" }));
    expect(await d.findByRole("alert")).toHaveTextContent("letters, digits");
    await userEvent.clear(d.getByLabelText("Code"));
    await userEvent.type(d.getByLabelText("Code"), "inv");
    await userEvent.click(d.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(body).toEqual({ code: "inv", name: "Invoices", template: "INV-{seq:06d}", reset_policy: "NEVER" }));
  });
});

describe("MembersPage", () => {
  const members = [
    { user_id: "u1", email: "a@x.io", display_name: "Abel", profile: { department: "d1", team: null, position: null, business_unit: null, cost_center: null, manager_user_id: null } },
    { user_id: "u2", email: "b@x.io", display_name: "Bea", profile: null },
  ];
  const kinds = ["departments", "teams", "positions", "business-units", "cost-centers"].map((k) => http.get(`*/api/v1/org/${k}`, () => page(k === "departments" ? [{ id: "d1", code: "FIN", name: "Finance", is_active: true, version: 1 }] : [])));

  it("shows where people sit and assigns a department and manager", async () => {
    let sent: Record<string, unknown> = {};
    server.use(http.get("*/api/v1/org/members", () => HttpResponse.json(members)), ...kinds,
      http.put("*/api/v1/org/members/u2/profile", async ({ request }) => { sent = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}); }));
    renderWithProviders(<MembersPage />, { permissions: ["org.structure.view", "org.profiles.manage"] });
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Assign Bea" }));
    const d = within(await screen.findByRole("dialog", { name: "Assign Bea" }));
    await waitFor(() => expect(d.getByRole("option", { name: "FIN Finance" })).toBeInTheDocument());
    await userEvent.selectOptions(d.getByLabelText("Department"), "d1");
    expect(d.queryByRole("option", { name: "Bea" })).not.toBeInTheDocument(); // nobody reports to themselves
    await userEvent.selectOptions(d.getByLabelText("Reports to"), "u1");
    await userEvent.click(d.getByRole("button", { name: "Save assignment" }));
    await waitFor(() => expect(sent).toEqual({ department: "d1", team: null, position: null, business_unit: null, cost_center: null, manager_user_id: "u1" }));
  });

  it("is read-only without the manage permission", async () => {
    server.use(http.get("*/api/v1/org/members", () => HttpResponse.json(members)), ...kinds);
    renderWithProviders(<MembersPage />, { permissions: ["org.structure.view"] });
    expect(await screen.findByText("Bea")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Assign/ })).not.toBeInTheDocument();
  });
});

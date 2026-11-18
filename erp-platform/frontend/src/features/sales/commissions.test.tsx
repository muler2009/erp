import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { CommissionsPage, monthRange, parseCategoryRates, parseTiers } from "./CommissionsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const STAFF = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }, { id: "e2", employee_no: "E-2", name: "Sara", status: "ACTIVE", user_id: "u2" }] }));
const ATT = { owner_id: "u1", net_sales: "8000.00", target: "10000.00", attainment_percent: 80, remaining: "2000.00" };
const stmt = (o = {}) => ({ id: "s1", owner_id: "u1", plan: "Standard", period_start: "2026-10-01", period_end: "2026-10-31", status: "DRAFT", sales_amount: "9000.00", returns_amount: "1000.00", commission: "190.00", details: { Accessories: { net: "2000.00", rate: "5.00", commission: "100.00" }, _tiered: { net: "6000.00", commission: "90.00", tiers: [{ from: "0", rate: "1.5" }] } }, approved_by: null, payroll_input: null, ...o });
const MANAGE = ["crm.view", "crm.assign"];

describe("helpers", () => {
  it("parses tiers", () => {
    expect(parseTiers("0:2\n50000:3.5")).toEqual({ tiers: [{ from: "0", rate: "2" }, { from: "50000", rate: "3.5" }] });
    expect(parseTiers("")).toMatchObject({ problem: expect.stringMatching(/at least one/) });
    expect(parseTiers("100:2")).toEqual({ problem: "The first tier must start at 0." });
    expect(parseTiers("0:2\n0:3")).toMatchObject({ problem: expect.stringMatching(/higher amount/) });
    expect(parseTiers("0:101")).toMatchObject({ problem: expect.stringMatching(/more than 100/) });
    expect(parseTiers("zero:two")).toMatchObject({ problem: expect.stringMatching(/should look like/) });
  });
  it("parses category rates and month ranges", () => {
    expect(parseCategoryRates("")).toEqual({ rates: {} });
    expect(parseCategoryRates("Accessories: 5\nSpare parts:2.5")).toEqual({ rates: { Accessories: "5", "Spare parts": "2.5" } });
    expect(parseCategoryRates("Accessories")).toMatchObject({ problem: expect.any(String) });
    expect(parseCategoryRates("A:1\nA:2")).toMatchObject({ problem: expect.stringMatching(/twice/) });
    expect(monthRange(new Date(2026, 1, 10))).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
});

describe("CommissionsPage", () => {
  it("shows my results, and a rep sees no team or plan tabs", async () => {
    server.use(STAFF, http.get("*/api/v1/sales/targets", () => HttpResponse.json(ATT)), http.get("*/api/v1/sales/commissions", () => page([])));
    renderWithProviders(<CommissionsPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText("80%")).toBeInTheDocument();
    expect(screen.getByText("10,000.00")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Team" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Plans" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Statements" }));
    expect(await screen.findByText("No statements yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Work out a statement" })).toBeNull();
  });

  it("does not ask for a reversed range", async () => {
    const seen: URLSearchParams[] = [];
    server.use(STAFF, http.get("*/api/v1/sales/targets", ({ request }) => { seen.push(new URL(request.url).searchParams); return HttpResponse.json(ATT); }));
    renderWithProviders(<CommissionsPage />, { permissions: ["crm.view"] });
    await screen.findByText("80%");
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2020-01-01" } });
    expect(await screen.findByText(/end date that is not before it/)).toBeInTheDocument();
    expect(seen.every((p) => (p.get("to") as string) >= (p.get("from") as string))).toBe(true);
  });

  it("a manager sees the team and sets a target for the period", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(STAFF, http.get("*/api/v1/sales/targets", () => HttpResponse.json(ATT)), http.get("*/api/v1/sales/targets/team", () => HttpResponse.json([ATT])),
      http.get("*/api/v1/hr/employees/options", () => HttpResponse.json([])),
      http.put("*/api/v1/sales/targets", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}); }));
    renderWithProviders(<CommissionsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("tab", { name: "Team" }));
    expect(await screen.findByText("Abel")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set a target" }));
    const d = within(await screen.findByRole("dialog", { name: "Set a target" }));
    await d.findByRole("option", { name: /Sara/ });
    await userEvent.selectOptions(d.getByLabelText("Salesperson"), "u2");
    await userEvent.type(d.getByLabelText("Target (net sales)"), "0");
    await userEvent.click(d.getByRole("button", { name: "Save target" }));
    expect(await d.findByText("The target must be a number above zero.")).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Target (net sales)"));
    await userEvent.type(d.getByLabelText("Target (net sales)"), "15000");
    await userEvent.click(d.getByRole("button", { name: "Save target" }));
    await waitFor(() => expect(body).toMatchObject({ owner_id: "u2", amount: "15000" }));
  });

  it("creates a plan from the tier text and rejects bad text before sending", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(STAFF, http.get("*/api/v1/sales/targets", () => HttpResponse.json(ATT)), http.get("*/api/v1/sales/commission-plans", () => HttpResponse.json([{ id: "p1", name: "Standard", tiers: [{ from: "0", rate: "2" }, { from: "50000", rate: "3" }], category_rates: { Accessories: "5" }, is_active: true }])),
      http.post("*/api/v1/sales/commission-plans", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<CommissionsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("tab", { name: "Plans" }));
    expect(await screen.findByText(/Accessories 5%/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New plan" }));
    const d = within(await screen.findByRole("dialog", { name: "New commission plan" }));
    await userEvent.type(d.getByLabelText("Name"), "Senior");
    const tiers = d.getByLabelText(/Tiers/);
    await userEvent.clear(tiers);
    await userEvent.type(tiers, "10:2");
    await userEvent.click(d.getByRole("button", { name: "Create plan" }));
    expect(await d.findByText("The first tier must start at 0.")).toBeInTheDocument();
    expect(body).toBeNull();
    await userEvent.clear(tiers);
    await userEvent.type(tiers, "0:2");
    await userEvent.type(d.getByLabelText(/Special rates/), "Parts:4");
    await userEvent.click(d.getByRole("button", { name: "Create plan" }));
    await waitFor(() => expect(body).toEqual({ name: "Senior", tiers: [{ from: "0", rate: "2" }], category_rates: { Parts: "4" }, is_active: true }));
  });

  it("works out a statement, approves it, and shows the separation-of-duties refusal", async () => {
    let calc: Record<string, unknown> | null = null;
    server.use(STAFF, http.get("*/api/v1/sales/targets", () => HttpResponse.json(ATT)), http.get("*/api/v1/sales/commissions", () => page([stmt()])),
      http.post("*/api/v1/sales/commissions", async ({ request }) => { calc = (await request.json()) as Record<string, unknown>; return HttpResponse.json(stmt(), { status: 201 }); }),
      http.post("*/api/v1/sales/commissions/s1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve your own commission." } }, { status: 403 })));
    renderWithProviders(<CommissionsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("tab", { name: "Statements" }));
    await userEvent.click(await screen.findByRole("button", { name: "Work out a statement" }));
    const w = within(await screen.findByRole("dialog", { name: "Work out a statement" }));
    await w.findByRole("option", { name: /Abel/ });
    await userEvent.selectOptions(w.getByLabelText("Salesperson"), "u1");
    await userEvent.click(w.getByRole("button", { name: "Work out" }));
    await waitFor(() => expect(calc).toMatchObject({ owner_id: "u1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Abel" }));
    const d = within(await screen.findByRole("dialog", { name: "Commission for Abel" }));
    expect(d.getByText("Sales on the tiers")).toBeInTheDocument();
    expect(d.getByText("190.00")).toBeInTheDocument();
    await userEvent.click(d.getByRole("button", { name: "Approve" }));
    expect(await d.findByText("You cannot approve your own commission.")).toBeInTheDocument();
  });

  it("sends an approved statement to payroll; a rep only sees it", async () => {
    let body: unknown = null;
    server.use(STAFF, http.get("*/api/v1/sales/targets", () => HttpResponse.json(ATT)), http.get("*/api/v1/sales/commissions", () => page([stmt({ status: "APPROVED" })])),
      http.post("*/api/v1/sales/commissions/s1/transfer", async ({ request }) => { body = await request.json(); return HttpResponse.json(stmt({ status: "TRANSFERRED" })); }));
    const { unmount } = renderWithProviders(<CommissionsPage />, { permissions: ["crm.view"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Statements" }));
    await userEvent.click(await screen.findByRole("button", { name: "Abel" }));
    const rep = within(await screen.findByRole("dialog", { name: "Commission for Abel" }));
    expect(rep.queryByRole("button", { name: "Send to payroll" })).toBeNull();
    unmount();
    renderWithProviders(<CommissionsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("tab", { name: "Statements" }));
    await userEvent.click(await screen.findByRole("button", { name: "Abel" }));
    const d = within(await screen.findByRole("dialog", { name: "Commission for Abel" }));
    await userEvent.click(d.getByRole("button", { name: "Send to payroll" }));
    const p = within(await screen.findByRole("dialog", { name: "Send to payroll" }));
    await userEvent.click(p.getByRole("button", { name: "Send to payroll" }));
    await waitFor(() => expect(body).toEqual({}));
  });
});

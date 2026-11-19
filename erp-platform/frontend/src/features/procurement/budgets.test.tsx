import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { BudgetsPage, budgetProblem, planProblem } from "./BudgetsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const YEAR = new Date().getFullYear();
const brow = (o = {}) => ({ id: "b1", code: "IT", name: "IT spend", fiscal_year: YEAR, category: "IT", cost_center_ref: "", enforcement: "BLOCK", status: "OPEN", budget: "1000.0000", committed: "400.0000", actual: "100.0000", open_commitment: "300.0000", available: "600.0000", utilisation_pct: "40.0", ...o });
const exec = (rows: object[]) => http.get("*/api/v1/procurement/budgets/execution", () => HttpResponse.json({ fiscal_year: YEAR, rows, totals: { budget: "1000.0000", committed: "400.0000", actual: "100.0000", available: "600.0000" } }));
const plan = (o = {}) => ({ id: "p1", code: "P1", name: "Plan", fiscal_year: YEAR, status: "DRAFT", revision: 1, lines: [{ category: "IT", description: "", quarter: 2, planned_amount: "500.0000" }], ...o });
const plans = (rows: object[]) => http.get("*/api/v1/procurement/plans", () => HttpResponse.json({ results: rows }));
const ALL = ["procurement.view", "procurement.budget.manage", "procurement.plan.manage", "procurement.plan.approve"];

describe("helpers", () => {
  it("budgetProblem", () => {
    expect(budgetProblem({ code: "A", name: "B", fiscal_year: "2026", amount: "10" })).toBeNull();
    expect(budgetProblem({ code: "", name: "B", fiscal_year: "2026", amount: "10" })).toMatch(/code/);
    expect(budgetProblem({ code: "A", name: "B", fiscal_year: "26", amount: "10" })).toMatch(/year/);
    expect(budgetProblem({ code: "A", name: "B", fiscal_year: "2026", amount: "-1" })).toMatch(/number/);
  });
  it("planProblem", () => {
    const l = { category: "IT", description: "", quarter: "2", planned_amount: "5" };
    expect(planProblem({ code: "C", name: "N", fiscal_year: "2026" }, [l])).toBeNull();
    expect(planProblem({}, [l])).toBeNull();
    expect(planProblem({}, [])).toMatch(/at least one/);
    expect(planProblem({}, [{ ...l, category: " " }])).toMatch(/category/);
    expect(planProblem({}, [{ ...l, quarter: "5" }])).toMatch(/quarter/);
    expect(planProblem({}, [{ ...l, planned_amount: "x" }])).toMatch(/number/);
  });
});

describe("Budgets tab", () => {
  it("shows use against budget with totals, asks for the chosen year", async () => {
    let year: string | null = null;
    server.use(http.get("*/api/v1/procurement/budgets/execution", ({ request }) => { year = new URL(request.url).searchParams.get("fiscal_year"); return HttpResponse.json({ fiscal_year: YEAR, rows: [brow({ available: "-5.0000" })], totals: { budget: "1000.0000", committed: "400.0000", actual: "100.0000", available: "-5.0000" } }); }));
    renderWithProviders(<BudgetsPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByText("IT spend")).toBeInTheDocument();
    expect(screen.getByText("40.0%")).toBeInTheDocument();
    expect(year).toBe(String(YEAR));
    expect(screen.queryByRole("button", { name: /New budget|Revise|Close/ })).toBeNull();
  });
  it("creates a budget", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(exec([]), http.post("*/api/v1/procurement/budgets", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(brow(), { status: 201 }); }));
    renderWithProviders(<BudgetsPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "New budget" }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText("Code"), "IT");
    await userEvent.type(within(d).getByLabelText("Name"), "IT spend");
    await userEvent.type(within(d).getByLabelText("Amount"), "abc");
    await userEvent.click(within(d).getByRole("button", { name: "Create budget" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("must be a number");
    await userEvent.clear(within(d).getByLabelText("Amount"));
    await userEvent.type(within(d).getByLabelText("Amount"), "5000");
    await userEvent.click(within(d).getByRole("button", { name: "Create budget" }));
    await waitFor(() => expect(body).toEqual({ code: "IT", name: "IT spend", fiscal_year: YEAR, amount: "5000", category: "", cost_center_ref: "", enforcement: "BLOCK" }));
  });
  it("refuses to revise below what is committed, then revises", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(exec([brow()]), http.post("*/api/v1/procurement/budgets/b1/revise", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(brow()); }));
    renderWithProviders(<BudgetsPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Revise IT" }));
    const d = await screen.findByRole("dialog");
    await userEvent.clear(within(d).getByLabelText(/New amount/));
    await userEvent.type(within(d).getByLabelText(/New amount/), "300");
    await userEvent.type(within(d).getByLabelText("Reason"), "Cut");
    await userEvent.click(within(d).getByRole("button", { name: "Save revision" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("below what is already committed");
    await userEvent.clear(within(d).getByLabelText(/New amount/));
    await userEvent.type(within(d).getByLabelText(/New amount/), "1500");
    await userEvent.click(within(d).getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(body).toEqual({ amount: "1500", reason: "Cut" }));
  });
  it("closes a budget and shows the server's refusal when commitments are open", async () => {
    server.use(exec([brow()]), http.post("*/api/v1/procurement/budgets/b1/close", () => HttpResponse.json({ error: { code: "open_commitments", message: "Release or complete the open commitments first." } }, { status: 409 })));
    renderWithProviders(<BudgetsPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Close IT" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Close budget" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("open commitments");
  });
  it("rejects a bad year without asking the server", async () => {
    server.use(exec([]));
    renderWithProviders(<BudgetsPage />, { permissions: ["procurement.view"] });
    await userEvent.clear(screen.getByLabelText("Year"));
    await userEvent.type(screen.getByLabelText("Year"), "26");
    expect(await screen.findByRole("alert")).toHaveTextContent("such as 2026");
  });
});

describe("Plans tab", () => {
  const open = async () => { await userEvent.click(await screen.findByRole("tab", { name: "Plans" })); };
  it("creates a plan", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(plans([]), http.post("*/api/v1/procurement/plans", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "p2", status: "DRAFT" }, { status: 201 }); }));
    renderWithProviders(<BudgetsPage />, { permissions: ALL });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "New plan" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Create plan" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("code and a name");
    await userEvent.type(within(d).getByLabelText("Code"), "P2");
    await userEvent.type(within(d).getByLabelText("Name"), "Next year");
    await userEvent.type(within(d).getByLabelText("Category 1"), "IT");
    await userEvent.clear(within(d).getByLabelText("Quarter 1"));
    await userEvent.type(within(d).getByLabelText("Quarter 1"), "3");
    await userEvent.type(within(d).getByLabelText("Amount 1"), "700");
    await userEvent.click(within(d).getByRole("button", { name: "Create plan" }));
    await waitFor(() => expect(body).toEqual({ code: "P2", name: "Next year", fiscal_year: YEAR, lines: [{ category: "IT", description: "", quarter: 3, planned_amount: "700" }] }));
  });
  it("approves a draft plan, showing the separation-of-duties refusal", async () => {
    server.use(plans([plan()]), http.post("*/api/v1/procurement/plans/p1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you cannot approve your own plan." } }, { status: 403 })));
    renderWithProviders(<BudgetsPage />, { permissions: ALL });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Approve P1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot approve your own plan");
  });
  it("revises a plan starting from its current lines", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(plans([plan({ status: "APPROVED" })]), http.post("*/api/v1/procurement/plans/p1/revise", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "p1", status: "DRAFT", revision: 2 }); }));
    renderWithProviders(<BudgetsPage />, { permissions: ALL });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Revise P1" }));
    const d = await screen.findByRole("dialog");
    expect(within(d).getByLabelText("Category 1")).toHaveValue("IT");
    expect(within(d).getByLabelText("Amount 1")).toHaveValue("500");
    await userEvent.click(within(d).getByRole("button", { name: "Send revision" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Say why");
    await userEvent.type(within(d).getByLabelText("Reason"), "Price rises");
    await userEvent.clear(within(d).getByLabelText("Amount 1"));
    await userEvent.type(within(d).getByLabelText("Amount 1"), "650");
    await userEvent.click(within(d).getByRole("button", { name: "Send revision" }));
    await waitFor(() => expect(body).toEqual({ reason: "Price rises", lines: [{ category: "IT", description: "", quarter: 2, planned_amount: "650" }] }));
  });
  it("compares a plan with actual spend", async () => {
    server.use(plans([plan()]), http.get("*/api/v1/procurement/plans/p1/report", () => HttpResponse.json({ plan: "P1", revision: 1, status: "DRAFT", rows: [{ category: "IT", planned: "500.0000", committed: "600.0000", actual: "100.0000", variance: "-100.0000" }] })));
    renderWithProviders(<BudgetsPage />, { permissions: ["procurement.view"] });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Compare P1 with actual" }));
    const d = await screen.findByRole("dialog");
    expect(await within(d).findByText("-100.00")).toHaveClass("text-red-700");
  });
  it("hides plan actions without permission", async () => {
    server.use(plans([plan()]));
    renderWithProviders(<BudgetsPage />, { permissions: ["procurement.view"] });
    await open();
    expect(await screen.findByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New plan|Approve|Revise/ })).toBeNull();
  });
});

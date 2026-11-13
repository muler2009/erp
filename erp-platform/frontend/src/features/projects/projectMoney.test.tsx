import type { ReactElement } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ProjectExpensesPage, validateExpense } from "./ProjectExpensesPage";
import { ProjectFinancePage, linesTotal, validateLines } from "./ProjectFinancePage";
import { ProjectRegisterPage, scoreTone, validateScale } from "./ProjectRegisterPage";
import { ProjectTeamPage, validateMember } from "./ProjectTeamPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const at = (el: ReactElement, path: string, permissions: string[]) => renderWithProviders(<Routes><Route path={`/app/projects/projects/:id/${path}`} element={el} /></Routes>, { permissions, route: `/app/projects/projects/p1/${path}` });
const budget = (o = {}) => ({ id: "b1", project: "p1", revision: 1, status: "DRAFT", reason: "", total: "1500.00", lines: [{ category: "MATERIAL", description: "Steel", amount: "1500.00" }], ...o });

describe("validators", () => {
  it("covers budget lines, expense, scale, member", () => {
    expect(validateLines([])).toMatch(/at least one/);
    expect(validateLines([{ category: "X", description: "", amount: "5" }])).toMatch(/category/);
    expect(validateLines([{ category: "LABOR", description: "", amount: "0" }])).toMatch(/greater than zero/);
    expect(validateLines([{ category: "LABOR", description: "", amount: "10.25" }])).toBeNull();
    expect(linesTotal([{ category: "LABOR", description: "", amount: "0.10" }, { category: "TRAVEL", description: "", amount: "0.20" }])).toBe(3000n);
    expect(validateExpense({ category: "LABOR", description: "x", amount: "5", incurred_on: "2026-01-01" })).toMatch(/category/);
    expect(validateExpense({ category: "TRAVEL", description: "x", amount: "5", incurred_on: "2099-01-01" }, "2026-11-12")).toMatch(/future/);
    expect(validateExpense({ category: "TRAVEL", description: "Taxi", amount: "5.50", incurred_on: "2026-11-01" }, "2026-11-12")).toBeNull();
    expect(validateScale("0")).toBe(false); expect(validateScale("5")).toBe(true);
    expect(scoreTone(20)).toBe("red"); expect(scoreTone(9)).toBe("amber"); expect(scoreTone(2)).toBe("green");
    expect(validateMember({ user: null, cost_rate: "0", bill_rate: "0", allocation: "100" })).toMatch(/Choose/);
    expect(validateMember({ user: "u", cost_rate: "-1", bill_rate: "0", allocation: "100" })).toMatch(/zero or more/);
    expect(validateMember({ user: "u", cost_rate: "1", bill_rate: "0", allocation: "120" })).toMatch(/0 and 100/);
    expect(validateMember({ user: "u", cost_rate: "1", bill_rate: "2", allocation: "50" })).toBeNull();
  });
});

describe("ProjectFinancePage", () => {
  const costs = { project: "P-1", has_approved_budget: true, budget_revision: 1, rows: [{ category: "MATERIAL", budget: "1500.00", actual: "1800.00", variance: "-300.00", over_budget: true, planned: null }], pending_expenses: "0.00", unmatched_hours: "0", hours: "10", totals: { budget: "1500.00", actual: "1800.00", variance: "-300.00" }, earned_value: { percent_complete: "50", planned_percent: "40", bac: "1500", pv: "600", ev: "750", ac: "1800", cpi: "0.42", spi: "1.25", eac: "3571.43", vac: "-2071.43" } };
  const profit = { project: "P-1", billing_type: "FIXED", revenue_recognized: "2000.00", billed: "2000.00", actual_cost: "1800.00", margin: "200.00", margin_percent: "10.00", forecast: { revenue: "5000.00", cost: "3571.43", margin: "1428.57" }, under_billed: "500.00" };
  const billing = { project: "P-1", rows: [], billed: "2000.00", recognized: "2000.00", paid: "0.00", contract_value: "5000.00", remaining: "3000.00" };
  const base = () => server.use(http.get("*/api/v1/projects/projects/p1/cost-report", () => HttpResponse.json(costs)), http.get("*/api/v1/projects/projects/p1/profitability", () => HttpResponse.json(profit)), http.get("*/api/v1/projects/projects/p1/billing", () => HttpResponse.json(billing)));
  it("flags over-budget categories and shows margin", async () => {
    base(); server.use(http.get("*/api/v1/projects/projects/p1/budgets", () => HttpResponse.json({ results: [budget({ status: "APPROVED" })] })));
    at(<ProjectFinancePage />, "finance", ["projects.view"]);
    expect(await screen.findByText("Over budget")).toBeInTheDocument();
    expect(await screen.findByText(/Margin/)).toBeInTheDocument();
  });
  it("shows the server's refusal when the user may not see costs", async () => {
    server.use(http.get("*/api/v1/projects/projects/p1/budgets", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/projects/projects/p1/cost-report", () => HttpResponse.json({ error: { code: "forbidden", message: "Only the project manager and finance can see project costs." } }, { status: 403 })),
      http.get("*/api/v1/projects/projects/p1/profitability", () => HttpResponse.json({ error: { code: "forbidden", message: "Only the project manager and finance can see profitability." } }, { status: 403 })),
      http.get("*/api/v1/projects/projects/p1/billing", () => HttpResponse.json({ error: { code: "forbidden", message: "no" } }, { status: 403 })));
    at(<ProjectFinancePage />, "finance", ["projects.view"]);
    expect(await screen.findByText(/Only the project manager and finance can see project costs/)).toBeInTheDocument();
  });
  it("approves a submitted budget only with the approve permission and shows separation of duties", async () => {
    base();
    server.use(http.get("*/api/v1/projects/projects/p1/budgets", () => HttpResponse.json({ results: [budget({ status: "SUBMITTED" })] })),
      http.post("*/api/v1/projects/budgets/b1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: someone else must approve this budget." } }, { status: 403 })));
    const { unmount } = at(<ProjectFinancePage />, "finance", ["projects.view"]);
    await screen.findByText(/Revision 1/);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    unmount();
    at(<ProjectFinancePage />, "finance", ["projects.view", "projects.budget.approve"]);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/someone else must approve/)).toBeInTheDocument();
  });
  it("creates a budget with decimal-string amounts and refuses a zero line locally", async () => {
    base(); server.use(http.get("*/api/v1/projects/projects/p1/budgets", () => HttpResponse.json({ results: [] })));
    let sent: unknown;
    server.use(http.post("*/api/v1/projects/projects/p1/budgets", async ({ request }) => { sent = await request.json(); return HttpResponse.json(budget(), { status: 201 }); }));
    at(<ProjectFinancePage />, "finance", ["projects.view"]);
    await userEvent.click(await screen.findByRole("button", { name: "Create budget" }));
    const d = within(screen.getByRole("dialog", { name: "New budget" }));
    await userEvent.type(d.getByLabelText("Amount 1"), "0");
    await userEvent.click(d.getByRole("button", { name: "Save budget" }));
    expect(await screen.findByText(/Line 1: enter an amount greater than zero/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Amount 1")); await userEvent.type(d.getByLabelText("Amount 1"), "2500.75");
    await userEvent.click(d.getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(sent).toEqual({ lines: [{ category: "LABOR", description: "", amount: "2500.75" }], reason: "" }));
  });
});

describe("ProjectExpensesPage", () => {
  const exp = { id: "x1", project: "p1", task: null, category: "TRAVEL", description: "Taxi", amount: "20.00", incurred_on: "2026-11-01", claimant_id: "u1", invoice_id: null, status: "SUBMITTED", decision_note: "" };
  it("submits an expense with a valid date and refuses a future one", async () => {
    server.use(http.get("*/api/v1/projects/projects/p1/expenses", () => HttpResponse.json({ results: [] })));
    let sent: unknown;
    server.use(http.post("*/api/v1/projects/projects/p1/expenses", async ({ request }) => { sent = await request.json(); return HttpResponse.json(exp, { status: 201 }); }));
    at(<ProjectExpensesPage />, "expenses", ["projects.view"]);
    await userEvent.click(await screen.findByRole("button", { name: "New expense" }));
    const d = within(screen.getByRole("dialog", { name: "New project expense" }));
    await userEvent.selectOptions(d.getByLabelText("Category"), "TRAVEL");
    await userEvent.type(d.getByLabelText("Description"), "Taxi"); await userEvent.type(d.getByLabelText("Amount"), "20.00");
    fireEvent.change(d.getByLabelText("Date"), { target: { value: "2099-01-01" } });
    await userEvent.click(d.getByRole("button", { name: "Submit expense" }));
    expect(await screen.findByText(/cannot be in the future/)).toBeInTheDocument();
    fireEvent.change(d.getByLabelText("Date"), { target: { value: "2026-11-01" } });
    await userEvent.click(d.getByRole("button", { name: "Submit expense" }));
    await waitFor(() => expect(sent).toEqual({ category: "TRAVEL", description: "Taxi", amount: "20.00", incurred_on: "2026-11-01" }));
  });
  it("shows the self-approval refusal and requires a reject reason", async () => {
    server.use(http.get("*/api/v1/projects/projects/p1/expenses", () => HttpResponse.json({ results: [exp] })),
      http.post("*/api/v1/projects/expenses/x1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you cannot approve your own expense." } }, { status: 403 })));
    at(<ProjectExpensesPage />, "expenses", ["projects.view"]);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/cannot approve your own expense/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    const d = within(screen.getByRole("dialog", { name: "Reject expense" }));
    await userEvent.click(d.getByRole("button", { name: "Reject expense" }));
    expect(await screen.findByText("Reason is required.")).toBeInTheDocument();
  });
});

describe("ProjectRegisterPage", () => {
  const reg = () => server.use(
    http.get("*/api/v1/projects/projects/p1/risks", () => HttpResponse.json({ results: [{ id: "r1", title: "Supplier delay", description: "", category: "", probability: 4, impact: 5, score: 20, status: "OPEN", owner_id: null, mitigation: "", review_on: null }] })),
    http.get("*/api/v1/projects/projects/p1/issues", () => HttpResponse.json({ results: [{ id: "i1", title: "Crane down", severity: "HIGH", status: "OPEN", assigned_to: null, due_on: null, task: null, risk: null, resolution: "" }] })));
  it("offers only legal moves and requires a note to close a risk", async () => {
    reg();
    let sent: unknown;
    server.use(http.patch("*/api/v1/projects/risks/r1", async ({ request }) => { sent = await request.json(); return HttpResponse.json({}); }));
    at(<ProjectRegisterPage />, "risks", ["projects.view"]);
    expect(await screen.findByText("Score 20 (4×5)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark Open" })).toBeNull();
    await userEvent.click(screen.getAllByRole("button", { name: "Mark Closed" })[0]!);
    const d = within(screen.getByRole("dialog", { name: "Mark risk Closed" }));
    await userEvent.click(d.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Why is it closed? is required.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText("Why is it closed?"), "No longer relevant");
    await userEvent.click(d.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(sent).toEqual({ status: "CLOSED", note: "No longer relevant" }));
  });
  it("rejects a risk scale outside 1 to 5 locally", async () => {
    reg();
    at(<ProjectRegisterPage />, "risks", ["projects.view"]);
    await userEvent.click(await screen.findByRole("button", { name: "Raise risk" }));
    const d = within(screen.getByRole("dialog", { name: "Raise risk" }));
    await userEvent.type(d.getByLabelText("Title"), "X"); await userEvent.type(d.getByLabelText("Probability (1-5)"), "9"); await userEvent.type(d.getByLabelText("Impact (1-5)"), "3");
    await userEvent.click(d.getByRole("button", { name: "Raise risk" }));
    expect(await screen.findByText(/whole numbers from 1 to 5/)).toBeInTheDocument();
  });
  it("sends a resolution when resolving an issue", async () => {
    reg();
    let sent: unknown;
    server.use(http.patch("*/api/v1/projects/issues/i1", async ({ request }) => { sent = await request.json(); return HttpResponse.json({}); }));
    at(<ProjectRegisterPage />, "risks", ["projects.view"]);
    await screen.findByText("Crane down");
    await userEvent.click(screen.getByRole("button", { name: "Mark Resolved" }));
    const d = within(screen.getByRole("dialog", { name: "Mark issue Resolved" }));
    await userEvent.type(d.getByLabelText("Resolution"), "Replaced");
    await userEvent.click(d.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(sent).toEqual({ status: "RESOLVED", resolution: "Replaced" }));
  });
});

describe("ProjectTeamPage", () => {
  it("lists members, hides remove for the manager, and shows server refusals on remove", async () => {
    server.use(http.get("*/api/v1/projects/projects/p1/members", () => HttpResponse.json({ results: [
      { id: "m1", user_id: "aaaaaaaa-1", role: "MANAGER", cost_rate: "10.00", bill_rate: "20.00", allocation_percent: "100.00", is_active: true },
      { id: "m2", user_id: "bbbbbbbb-2", role: "MEMBER", cost_rate: "5.00", bill_rate: "9.00", allocation_percent: "50.00", is_active: true }] })),
      http.delete("*/api/v1/projects/projects/p1/members/bbbbbbbb-2", () => HttpResponse.json({ error: { code: "tasks_assigned", message: "2 open task(s) are still assigned to this person; reassign them first." } }, { status: 409 })));
    at(<ProjectTeamPage />, "team", ["projects.view"]);
    await screen.findByText("User aaaaaaaa");
    expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Remove User bbbbbbbb" }));
    expect(await screen.findByText(/reassign them first/)).toBeInTheDocument();
  });
  it("requires a person before adding", async () => {
    server.use(http.get("*/api/v1/projects/projects/p1/members", () => HttpResponse.json({ results: [] })));
    at(<ProjectTeamPage />, "team", ["projects.view"]);
    await userEvent.click(await screen.findByRole("button", { name: "Add member" }));
    const d = within(screen.getByRole("dialog", { name: "Add team member" }));
    await userEvent.click(d.getByRole("button", { name: "Add member" }));
    expect(await screen.findByText("Choose the person to add.")).toBeInTheDocument();
  });
});

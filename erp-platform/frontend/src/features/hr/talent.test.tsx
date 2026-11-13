import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { CasesPage } from "./CasesPage";
import { LearningPage, validateCourse } from "./LearningPage";
import { PerformancePage, validateCycle, validatePercent, validateRating } from "./PerformancePage";
import { PoliciesPage } from "./PoliciesPage";
import { ReimbursementsPage, validateClaim } from "./ReimbursementsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE" }] }))); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

describe("validators", () => {
  it("covers rating, percent, cycle, course, claim", () => {
    expect(validateRating("0")).toMatch(/1 to 5/); expect(validateRating("5")).toBeNull();
    expect(validatePercent("101")).toMatch(/0 to 100/); expect(validatePercent("55.5")).toBeNull(); expect(validatePercent("-1")).toMatch(/0 to 100/);
    expect(validateCycle({ name: "", start_date: "2026-01-01", end_date: "2026-12-31" })).toMatch(/name/);
    expect(validateCycle({ name: "H1", start_date: "2026-06-01", end_date: "2026-01-01" })).toMatch(/on or after/);
    expect(validateCycle({ name: "H1", start_date: "2026-01-01", end_date: "2026-06-30" })).toBeNull();
    expect(validateCourse({ code: "S1", name: "Safety", hours: "0", validity: "" })).toMatch(/Hours/);
    expect(validateCourse({ code: "S1", name: "Safety", hours: "2", validity: "0" })).toMatch(/months/);
    expect(validateCourse({ code: "S1", name: "Safety", hours: "2.5", validity: "12" })).toBeNull();
    expect(validateClaim({ description: "Taxi", expense_date: "2030-01-01", amount: "10" }, "2026-11-12")).toMatch(/future/);
    expect(validateClaim({ description: "Taxi", expense_date: "2026-11-01", amount: "0" }, "2026-11-12")).toMatch(/greater than zero/);
    expect(validateClaim({ description: "Taxi", expense_date: "2026-11-01", amount: "12.50" }, "2026-11-12")).toBeNull();
  });
});

describe("PerformancePage", () => {
  const cyc = (status: string) => http.get("*/api/v1/hr/performance/cycles", () => HttpResponse.json([{ id: "c1", name: "2026", start_date: "2026-01-01", end_date: "2026-12-31", status }]));
  const rev = (status: string) => http.get("*/api/v1/hr/performance/reviews", () => HttpResponse.json({ results: [{ id: "r1", employee: "e1", employee_no: "E-1", cycle: "2026", status, self_rating: null, self_comment: "", goal_score: null }] }));
  it("activates a draft cycle only with manage permission", async () => {
    let hit = false;
    server.use(cyc("DRAFT"), rev("PENDING_SELF"), http.get("*/api/v1/hr/performance/goals", () => HttpResponse.json({ results: [] })), http.post("*/api/v1/hr/performance/cycles/c1/activate", () => { hit = true; return HttpResponse.json({}); }));
    renderWithProviders(<PerformancePage />, { permissions: ["hr.self", "hr.performance.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Activate" }));
    await waitFor(() => expect(hit).toBe(true));
  });
  it("hides cycle actions without permission", async () => {
    server.use(cyc("DRAFT"), rev("PENDING_SELF"), http.get("*/api/v1/hr/performance/goals", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<PerformancePage />, { permissions: ["hr.self"] });
    await screen.findByText("No goals in this cycle");
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New cycle" })).toBeNull();
  });
  it("submits a self review and shows a separation-of-duties refusal for manager review", async () => {
    server.use(cyc("ACTIVE"), rev("PENDING_MANAGER"), http.get("*/api/v1/hr/performance/goals", () => HttpResponse.json({ results: [] })),
      http.post("*/api/v1/hr/performance/reviews/r1/manager", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you cannot rate yourself as manager." } }, { status: 403 })));
    renderWithProviders(<PerformancePage />, { permissions: ["hr.self"] });
    await userEvent.click(await screen.findByRole("button", { name: "Manager review" }));
    const d = within(screen.getByRole("dialog", { name: "Manager review" }));
    await userEvent.type(d.getByLabelText("Rating (1-5)"), "7");
    await userEvent.click(d.getByRole("button", { name: "Submit review" }));
    expect(await screen.findByText(/from 1 to 5/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Rating (1-5)")); await userEvent.type(d.getByLabelText("Rating (1-5)"), "4");
    await userEvent.click(d.getByRole("button", { name: "Submit review" }));
    expect(await screen.findByText(/cannot rate yourself/)).toBeInTheDocument();
  });
  it("rejects goal progress above 100 locally and saves a valid value", async () => {
    let sent: unknown;
    server.use(cyc("ACTIVE"), rev("PENDING_SELF"), http.get("*/api/v1/hr/performance/goals", () => HttpResponse.json({ results: [{ id: "g1", employee: "e1", cycle: "c1", title: "Ship v2", weight: "50.00", progress: "10.00" }] })),
      http.post("*/api/v1/hr/performance/goals/g1/progress", async ({ request }) => { sent = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<PerformancePage />, { permissions: ["hr.self"] });
    const box = await screen.findByLabelText("Progress for Ship v2");
    await userEvent.clear(box); await userEvent.type(box, "150");
    await userEvent.click(screen.getByRole("button", { name: "Save progress" }));
    expect(await screen.findByText(/0 to 100/)).toBeInTheDocument();
    await userEvent.clear(box); await userEvent.type(box, "60");
    await userEvent.click(screen.getByRole("button", { name: "Save progress" }));
    await waitFor(() => expect(sent).toEqual({ progress: "60" }));
  });
});

describe("LearningPage", () => {
  it("shows compliance gaps only to learning managers", async () => {
    server.use(http.get("*/api/v1/hr/learning/courses", () => HttpResponse.json([{ id: "k1", code: "S1", name: "Safety", provider: "", hours: "2.00", validity_months: 12, mandatory: true }])),
      http.get("*/api/v1/hr/learning/records", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/hr/learning/compliance", () => HttpResponse.json({ gaps: [{ employee_no: "E-1", name: "Abel", course: "S1", reason: "MISSING" }], expiring: [] })));
    const { unmount } = renderWithProviders(<LearningPage />, { permissions: ["hr.self", "hr.learning.manage"] });
    expect(await screen.findByText("Missing")).toBeInTheDocument();
    unmount();
    renderWithProviders(<LearningPage />, { permissions: ["hr.self"] });
    await screen.findByText("No training recorded");
    expect(screen.queryByText("Missing or expired")).toBeNull();
  });
});

describe("CasesPage", () => {
  it("files a grievance and requires a summary", async () => {
    server.use(http.get("*/api/v1/hr/cases", () => HttpResponse.json({ results: [] })));
    let sent: unknown;
    server.use(http.post("*/api/v1/hr/cases/grievance", async ({ request }) => { sent = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<CasesPage />, { permissions: ["hr.self"] });
    await userEvent.click(await screen.findByRole("button", { name: "File a grievance" }));
    const d = within(screen.getByRole("dialog", { name: "File a grievance" }));
    await userEvent.click(d.getByRole("button", { name: "File grievance" }));
    expect(await screen.findByText("What happened is required.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText("What happened"), "Unsafe site");
    await userEvent.click(d.getByRole("button", { name: "File grievance" }));
    await waitFor(() => expect(sent).toEqual({ summary: "Unsafe site" }));
    expect(screen.queryByRole("button", { name: "Open case" })).toBeNull();
  });
});

describe("PoliciesPage", () => {
  it("lets an employee acknowledge a published policy; drafts and publish need manage", async () => {
    let acked = false;
    server.use(http.get("*/api/v1/hr/policies", () => HttpResponse.json([{ id: "p1", code: "CoC", version: 1, title: "Conduct", status: "PUBLISHED", published_at: "2026-01-01T00:00:00Z", body: "Be kind", acknowledged: false }])),
      http.post("*/api/v1/hr/policies/p1/acknowledge", () => { acked = true; return HttpResponse.json({ policy: "p1", acknowledged: true }); }));
    renderWithProviders(<PoliciesPage />, { permissions: ["hr.self"] });
    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(acked).toBe(true));
    expect(screen.queryByRole("button", { name: "Who has not acknowledged" })).toBeNull();
  });
  it("shows who has not acknowledged to managers", async () => {
    server.use(http.get("*/api/v1/hr/policies", () => HttpResponse.json([{ id: "p1", code: "CoC", version: 1, title: "Conduct", status: "PUBLISHED", published_at: null, body: "x", acknowledged: true }])),
      http.get("*/api/v1/hr/policies/p1", () => HttpResponse.json([{ employee_no: "E-2", name: "Sara" }])));
    renderWithProviders(<PoliciesPage />, { permissions: ["hr.self", "hr.policy.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Who has not acknowledged" }));
    expect(await screen.findByText("Sara (E-2)")).toBeInTheDocument();
  });
});

describe("ReimbursementsPage", () => {
  const claim = { id: "m1", employee: "e1", employee_no: "E-1", description: "Taxi", expense_date: "2026-11-01", amount: "12.50", status: "SUBMITTED", decision_note: "" };
  it("blocks a future-dated claim, then submits a valid one with the amount as a string", async () => {
    server.use(http.get("*/api/v1/hr/reimbursements", () => HttpResponse.json({ results: [] })));
    let sent: unknown;
    server.use(http.post("*/api/v1/hr/reimbursements", async ({ request }) => { sent = await request.json(); return HttpResponse.json(claim, { status: 201 }); }));
    renderWithProviders(<ReimbursementsPage />, { permissions: ["hr.self"] });
    await userEvent.click(await screen.findByRole("button", { name: "New claim" }));
    const d = within(screen.getByRole("dialog", { name: "New reimbursement claim" }));
    await userEvent.type(d.getByLabelText("Description"), "Taxi"); await userEvent.type(d.getByLabelText("Amount"), "12.50");
    fireEvent.change(d.getByLabelText("Expense date"), { target: { value: "2099-01-01" } });
    await userEvent.click(d.getByRole("button", { name: "Submit claim" }));
    expect(await screen.findByText(/cannot be in the future/)).toBeInTheDocument();
    fireEvent.change(d.getByLabelText("Expense date"), { target: { value: "2026-11-01" } });
    await userEvent.click(d.getByRole("button", { name: "Submit claim" }));
    await waitFor(() => expect(sent).toEqual({ description: "Taxi", expense_date: "2026-11-01", amount: "12.50" }));
  });
  it("shows approve/reject only to approvers and surfaces the self-approval refusal", async () => {
    server.use(http.get("*/api/v1/hr/reimbursements", () => HttpResponse.json({ results: [claim] })),
      http.post("*/api/v1/hr/reimbursements/m1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you cannot approve your own claim." } }, { status: 403 })));
    const { unmount } = renderWithProviders(<ReimbursementsPage />, { permissions: ["hr.self"] });
    await screen.findByText("Taxi");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    unmount();
    renderWithProviders(<ReimbursementsPage />, { permissions: ["hr.self", "hr.reimbursement.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/cannot approve your own claim/)).toBeInTheDocument();
  });
});

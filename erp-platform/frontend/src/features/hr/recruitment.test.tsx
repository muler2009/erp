import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { CandidatesPage, MyInterviewsPage, validateFeedback, validateOffer } from "./CandidatesPage";
import { RecruitmentPage, validateRequisition } from "./RecruitmentPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const req = (o = {}) => ({ id: "r1", number: "REQ-1", title: "Engineer", department: null, position: null, headcount: 2, justification: "Growth", status: "PENDING", requested_by: "u1", decision_note: "", ...o });
const cand = (o = {}) => ({ id: "c1", requisition: "r1", name: "Sara", email: "s@x.com", phone: "", source: "", stage: "INTERVIEW", reason: "", employee: null, offer: null, interviews: [], ...o });

describe("validators", () => {
  it("requisition", () => {
    expect(validateRequisition({ title: " ", headcount: "1", justification: "x" })).toMatch(/title/);
    expect(validateRequisition({ title: "a", headcount: "0", justification: "x" })).toMatch(/Headcount/);
    expect(validateRequisition({ title: "a", headcount: "1", justification: "" })).toMatch(/why/);
    expect(validateRequisition({ title: "a", headcount: "3", justification: "x" })).toBeNull();
  });
  it("offer and feedback", () => {
    expect(validateOffer({ monthly_salary: "0", currency: "USD", start_date: "2030-01-01" })).toMatch(/greater than zero/);
    expect(validateOffer({ monthly_salary: "100", currency: "usd", start_date: "2030-01-01" })).toMatch(/Currency/);
    expect(validateOffer({ monthly_salary: "100", currency: "USD", start_date: "2020-01-01" }, "2026-11-12")).toMatch(/start date/);
    expect(validateOffer({ monthly_salary: "100.50", currency: "USD", start_date: "2030-01-01" })).toBeNull();
    expect(validateFeedback({ score: "6", recommendation: "HIRE" })).toMatch(/1 to 5/);
    expect(validateFeedback({ score: "4", recommendation: "" })).toMatch(/recommendation/);
    expect(validateFeedback({ score: "4", recommendation: "HIRE" })).toBeNull();
  });
});

describe("RecruitmentPage", () => {
  const base = () => server.use(
    http.get("*/api/v1/hr/recruitment/requisitions", () => HttpResponse.json({ results: [req()] })),
    http.get("*/api/v1/hr/recruitment/funnel", () => HttpResponse.json({ APPLIED: 3, HIRED: 1 })),
  );
  it("approves a pending requisition only with the approve permission", async () => {
    base();
    let called = "";
    server.use(http.post("*/api/v1/hr/recruitment/requisitions/r1/approve", () => { called = "approve"; return HttpResponse.json(req({ status: "APPROVED" })); }));
    renderWithProviders(<RecruitmentPage />, { permissions: ["hr.recruitment.manage", "hr.recruitment.approve"] });
    expect(await screen.findByText("Applied:")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(called).toBe("approve"));
  });
  it("hides approve without permission", async () => {
    base();
    renderWithProviders(<RecruitmentPage />, { permissions: ["hr.recruitment.manage"] });
    await screen.findByText("REQ-1");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
  it("requires a rejection reason and shows server refusals", async () => {
    base();
    server.use(http.post("*/api/v1/hr/recruitment/requisitions/r1/reject", () => HttpResponse.json({ error: { code: "invalid_state", message: "Already decided." } }, { status: 409 })));
    renderWithProviders(<RecruitmentPage />, { permissions: ["hr.recruitment.manage", "hr.recruitment.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const d = within(screen.getByRole("dialog", { name: "Reject requisition" }));
    await userEvent.click(d.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText(/reason is required/)).toBeInTheDocument();
    await userEvent.type(d.getByLabelText("Reason (required)"), "No budget");
    await userEvent.click(d.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText(/Already decided/)).toBeInTheDocument();
  });
  it("blocks an invalid new requisition client-side", async () => {
    base();
    server.use(http.get("*/api/v1/org/departments", () => HttpResponse.json({ results: [] })), http.get("*/api/v1/hr/positions", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<RecruitmentPage />, { permissions: ["hr.recruitment.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New requisition" }));
    const d = within(screen.getByRole("dialog", { name: "New job requisition" }));
    await userEvent.click(d.getByRole("button", { name: "Create requisition" }));
    expect(await screen.findByText("Enter the job title.")).toBeInTheDocument();
  });
});

describe("CandidatesPage", () => {
  const renderIt = (permissions: string[]) => renderWithProviders(<Routes><Route path="/app/hr/recruitment/:id" element={<CandidatesPage />} /></Routes>, { permissions, route: "/app/hr/recruitment/r1" });
  it("moves a candidate to the next stage", async () => {
    server.use(http.get("*/api/v1/hr/recruitment/requisitions/r1/candidates", () => HttpResponse.json({ results: [cand({ stage: "APPLIED" })] })));
    let body: unknown;
    server.use(http.post("*/api/v1/hr/recruitment/candidates/c1/move", async ({ request }) => { body = await request.json(); return HttpResponse.json(cand({ stage: "SCREENING" })); }));
    renderIt(["hr.recruitment.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: "Move to Screening" }));
    await waitFor(() => expect(body).toEqual({ stage: "SCREENING" }));
  });
  it("offers actions by offer state and hires after acceptance", async () => {
    server.use(
      http.get("*/api/v1/hr/recruitment/requisitions/r1/candidates", () => HttpResponse.json({ results: [cand({ offer: { id: "o1", candidate: "c1", monthly_salary: "5000.00", currency: "USD", start_date: "2030-01-01", status: "ACCEPTED" } })] })),
      http.get("*/api/v1/hr/recruitment/candidates/c1/scorecard", () => HttpResponse.json({ candidate: "Sara", stage: "INTERVIEW", interviews: 1, average_score: "4.00", hire_votes: 1, no_hire_votes: 0 })),
      http.post("*/api/v1/hr/recruitment/candidates/c1/hire", () => HttpResponse.json({ employee: "e9", employee_no: "E-0009" }, { status: 201 })),
    );
    renderIt(["hr.recruitment.manage"]);
    expect(await screen.findByText(/average 4.00/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve offer" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Hire" }));
    expect(await screen.findByText("Hired as employee E-0009.")).toBeInTheDocument();
  });
  it("rejects without a reason locally, then sends it", async () => {
    server.use(http.get("*/api/v1/hr/recruitment/requisitions/r1/candidates", () => HttpResponse.json({ results: [cand({ stage: "SCREENING" })] })));
    let sent: Record<string, string> = {};
    server.use(http.post("*/api/v1/hr/recruitment/candidates/c1/move", async ({ request }) => { sent = (await request.json()) as Record<string, string>; return HttpResponse.json(cand({ stage: "REJECTED" })); }));
    renderIt(["hr.recruitment.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const d = within(screen.getByRole("dialog", { name: "Reject Sara" }));
    await userEvent.click(d.getByRole("button", { name: "Reject candidate" }));
    expect(await screen.findByText("Reason is required.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText("Reason"), "Not a fit");
    await userEvent.click(d.getByRole("button", { name: "Reject candidate" }));
    await waitFor(() => expect(sent).toEqual({ stage: "REJECTED", reason: "Not a fit" }));
  });
  it("refuses a past start date on an offer before calling the server", async () => {
    server.use(http.get("*/api/v1/hr/recruitment/requisitions/r1/candidates", () => HttpResponse.json({ results: [cand()] })), http.get("*/api/v1/hr/recruitment/candidates/c1/scorecard", () => HttpResponse.json({ candidate: "Sara", stage: "INTERVIEW", interviews: 0, average_score: null, hire_votes: 0, no_hire_votes: 0 })));
    renderIt(["hr.recruitment.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: "Make offer" }));
    const d = within(screen.getByRole("dialog", { name: "Offer for Sara" }));
    await userEvent.type(d.getByLabelText("Monthly salary"), "5000");
    await userEvent.type(d.getByLabelText("Currency"), "usd");
    fireEvent.change(d.getByLabelText("Start date"), { target: { value: "2020-01-01" } });
    await userEvent.click(d.getByRole("button", { name: "Create offer" }));
    expect(await screen.findByText(/start date that is today or later/)).toBeInTheDocument();
  });
});

describe("MyInterviewsPage", () => {
  it("submits feedback with an integer score", async () => {
    server.use(http.get("*/api/v1/hr/recruitment/interviews/mine", () => HttpResponse.json([{ id: "i1", candidate: "c1", candidate_name: "Sara", interviewer: "u1", scheduled_at: "2030-01-01T09:00:00Z", status: "SCHEDULED", score: null, recommendation: "" }])));
    let sent: unknown;
    server.use(http.post("*/api/v1/hr/recruitment/interviews/i1/feedback", async ({ request }) => { sent = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<MyInterviewsPage />, { permissions: ["hr.self"] });
    await userEvent.click(await screen.findByRole("button", { name: "Give feedback" }));
    const d = within(screen.getByRole("dialog", { name: "Feedback: Sara" }));
    await userEvent.type(d.getByLabelText("Score (1-5)"), "9");
    await userEvent.selectOptions(d.getByLabelText("Recommendation"), "HIRE");
    await userEvent.click(d.getByRole("button", { name: "Submit feedback" }));
    expect(await screen.findByText(/1 to 5/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Score (1-5)"));
    await userEvent.type(d.getByLabelText("Score (1-5)"), "4");
    await userEvent.click(d.getByRole("button", { name: "Submit feedback" }));
    await waitFor(() => expect(sent).toEqual({ score: 4, recommendation: "HIRE", feedback: "" }));
  });
});

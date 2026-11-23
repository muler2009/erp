import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { DocRequirementsPage, requirementProblem } from "./DocRequirementsPage";
import { DaySummary } from "./EmployeePage";
import { Performance } from "./HrAnalyticsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

describe("requirementProblem", () => {
  it("validates", () => {
    expect(requirementProblem("ID", "National ID")).toBeNull();
    expect(requirementProblem(" ", "x")).toMatch(/document type/);
    expect(requirementProblem("x".repeat(21), "x")).toMatch(/20/);
    expect(requirementProblem("ID", " ")).toMatch(/title/);
    expect(requirementProblem("ID", "x".repeat(121))).toMatch(/120/);
  });
});

describe("DocRequirementsPage", () => {
  const REQ = http.get("*/api/v1/hr/document-requirements", () => HttpResponse.json([{ doc_type: "ID", title: "National ID", employment_type: "" }, { doc_type: "CONTRACT", title: "Signed contract", employment_type: "FULL_TIME" }]));
  it("lists requirements and who they apply to, without a form for people who cannot configure", async () => {
    server.use(REQ);
    renderWithProviders(<DocRequirementsPage />, { permissions: ["hr.view"] });
    expect(await screen.findByText("National ID")).toBeInTheDocument();
    expect(screen.getByText("Everyone")).toBeInTheDocument();
    expect(screen.getByText("Full time")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save requirement" })).toBeNull();
  });
  it("saves a requirement for one employment type", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(REQ, http.post("*/api/v1/hr/document-requirements", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ doc_type: "VISA", title: "Work permit" }, { status: 201 }); }));
    renderWithProviders(<DocRequirementsPage />, { permissions: ["hr.view", "hr.config.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Save requirement" }));
    expect(await screen.findByText(/Enter a document type/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Document type"), "VISA");
    await userEvent.type(screen.getByLabelText("Title"), "Work permit");
    await userEvent.selectOptions(screen.getByLabelText("Applies to"), "CONTRACTOR");
    await userEvent.click(screen.getByRole("button", { name: "Save requirement" }));
    await waitFor(() => expect(body).toEqual({ doc_type: "VISA", title: "Work permit", employment_type: "CONTRACTOR" }));
    expect(await screen.findByText("Requirement saved.")).toBeInTheDocument();
  });
  it("shows the server's refusal", async () => {
    server.use(REQ, http.post("*/api/v1/hr/document-requirements", () => HttpResponse.json({ error: { code: "invalid_employment_type", message: "Invalid employment type." } }, { status: 422 })));
    renderWithProviders(<DocRequirementsPage />, { permissions: ["hr.view", "hr.config.manage"] });
    await userEvent.type(await screen.findByLabelText("Document type"), "VISA");
    await userEvent.type(screen.getByLabelText("Title"), "Work permit");
    await userEvent.click(screen.getByRole("button", { name: "Save requirement" }));
    expect(await screen.findByText("Invalid employment type.")).toBeInTheDocument();
  });
});

describe("DaySummary", () => {
  const day = (o = {}) => ({ date: "2026-11-20", day_type: "WORKDAY", scheduled_hours: "8.00", worked_hours: "7.50", late_minutes: 10, early_minutes: 0, overtime_hours: "0", status: "PRESENT", work_mode: "OFFICE", exceptions: [], ...o });
  it("shows a chosen day and asks again when the date changes", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/hr/employees/e1/attendance-summary", ({ request }) => { const d = new URL(request.url).searchParams.get("date") ?? ""; seen.push(d); return HttpResponse.json(d === "2026-11-19" ? day({ status: "ABSENT", worked_hours: "0", exceptions: ["ABSENT"] }) : day()); }));
    renderWithProviders(<DaySummary id="e1" />, { permissions: ["hr.self"] });
    expect(await screen.findByText("Present")).toBeInTheDocument();
    expect(screen.getByText("7.5")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-11-19" } });
    expect((await screen.findAllByText("Absent")).length).toBe(2);
    expect(seen).toContain("2026-11-19");
  });
  it("shows the server's message when the record is not visible", async () => {
    server.use(http.get("*/api/v1/hr/employees/e1/attendance-summary", () => HttpResponse.json({ error: { code: "not_found", message: "Employee not found." } }, { status: 404 })));
    renderWithProviders(<DaySummary id="e1" />, { permissions: ["hr.self"] });
    expect(await screen.findByText("Employee not found.")).toBeInTheDocument();
  });
});

describe("Performance ratings", () => {
  it("loads the distribution only after a cycle is chosen", async () => {
    let hit = "";
    server.use(http.get("*/api/v1/hr/performance/cycles", () => HttpResponse.json([{ id: "cy1", name: "2026 H1", start_date: "2026-01-01", end_date: "2026-06-30", status: "OPEN" }])),
      http.get("*/api/v1/hr/analytics/performance", ({ request }) => { hit = new URL(request.url).searchParams.get("cycle") ?? ""; return HttpResponse.json({ reviews: 10, completed: 7, rating_distribution: { "1": 0, "2": 1, "3": 4, "4": 2, "5": 0 } }); }));
    renderWithProviders(<Performance />, { permissions: ["hr.analytics.view"] });
    expect(hit).toBe("");
    await screen.findByRole("option", { name: "2026 H1" });
    await userEvent.selectOptions(screen.getByLabelText("Review cycle"), "cy1");
    expect(await screen.findByText("7 of 10 review(s) completed.")).toBeInTheDocument();
    expect(hit).toBe("cy1");
    expect(screen.getByRole("list", { name: "Rating distribution" })).toHaveTextContent("Rating 3");
  });
});

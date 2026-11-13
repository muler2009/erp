import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { HrAnalyticsPage } from "./HrAnalyticsPage";
import { ImportPage, parsePunches, validateCsv } from "./ImportPage";
import { MonitoringPage } from "./MonitoringPage";
import { OrgPage, validateGrade } from "./OrgPage";
import { SeparationsPage, validateResignation, validateSettlement } from "./SeparationsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE" }] }))); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

describe("validators", () => {
  it("covers resignation, settlement, grade, csv and punches", () => {
    expect(validateResignation({ last_working_date: "2020-01-01", reason: "x" }, "2026-11-12")).toMatch(/past/);
    expect(validateResignation({ last_working_date: "2030-01-01", reason: " " }, "2026-11-12")).toMatch(/reason/);
    expect(validateResignation({ last_working_date: "2030-01-01", reason: "Moving" }, "2026-11-12")).toBeNull();
    expect(validateSettlement("-5")).toMatch(/zero or more/); expect(validateSettlement("0")).toBeNull(); expect(validateSettlement("1200.50")).toBeNull();
    expect(validateGrade({ code: "G1", name: "Junior", min_salary: "500", max_salary: "400" })).toMatch(/not be below/);
    expect(validateGrade({ code: "", name: "x", min_salary: "1", max_salary: "2" })).toMatch(/code and name/);
    expect(validateGrade({ code: "G1", name: "Junior", min_salary: "400", max_salary: "900" })).toBeNull();
    expect(validateCsv("")).toMatch(/Paste/); expect(validateCsv("a,b\n1,2")).toMatch(/header/); expect(validateCsv("first_name,last_name\nA,B")).toBeNull();
    expect(parsePunches("").error).toMatch(/at least one/);
    expect(parsePunches("E-1,2026-11-02T08:00:00").error).toMatch(/zone/);
    expect(parsePunches("E-1").error).toMatch(/expected/);
    expect(parsePunches("employee_no,timestamp\nE-1,2026-11-02T08:00:00+03:00\nE-1,2026-11-02T17:00:00Z")).toEqual({ punches: [{ employee_no: "E-1", timestamp: "2026-11-02T08:00:00+03:00" }, { employee_no: "E-1", timestamp: "2026-11-02T17:00:00Z" }], error: null });
    expect(parsePunches(Array.from({ length: 5001 }, () => "E-1,2026-11-02T08:00:00Z").join("\n")).error).toMatch(/At most/);
  });
});

describe("SeparationsPage", () => {
  const sep = (o = {}) => ({ id: "s1", employee: "e1", kind: "RESIGNATION", last_working_date: "2030-01-31", reason: "Moving", status: "REQUESTED", settlement_recorded: false, settlement_amount: "0.00", settlement_notes: "", ...o });
  it("lets HR accept a request and requires a note to reject", async () => {
    server.use(http.get("*/api/v1/hr/separations", () => HttpResponse.json({ results: [sep()] })));
    let accepted = false;
    server.use(http.post("*/api/v1/hr/separations/s1/accept", () => { accepted = true; return HttpResponse.json(sep({ status: "ACCEPTED" })); }));
    renderWithProviders(<SeparationsPage />, { permissions: ["hr.self", "hr.employee.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const d = within(screen.getByRole("dialog", { name: "Reject resignation" }));
    await userEvent.click(d.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Note is required.")).toBeInTheDocument();
    await userEvent.click(d.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(accepted).toBe(true));
  });
  it("records a settlement against the employee and refuses a negative amount", async () => {
    server.use(http.get("*/api/v1/hr/separations", () => HttpResponse.json({ results: [sep({ status: "ACCEPTED" })] })));
    let sent: unknown;
    server.use(http.post("*/api/v1/hr/employees/e1/settlement", async ({ request }) => { sent = await request.json(); return HttpResponse.json(sep({ status: "ACCEPTED", settlement_recorded: true })); }));
    renderWithProviders(<SeparationsPage />, { permissions: ["hr.self", "hr.employee.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Record settlement" }));
    const d = within(screen.getByRole("dialog", { name: "Record settlement" }));
    await userEvent.type(d.getByLabelText("Amount"), "-1");
    await userEvent.click(d.getByRole("button", { name: "Record settlement" }));
    expect(await screen.findByText(/zero or more/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Amount")); await userEvent.type(d.getByLabelText("Amount"), "1500.00");
    await userEvent.click(d.getByRole("button", { name: "Record settlement" }));
    await waitFor(() => expect(sent).toEqual({ amount: "1500.00", notes: "" }));
  });
  it("hides the management list from employees and lets them resign then withdraw", async () => {
    server.use(http.post("*/api/v1/hr/me/resignation", () => HttpResponse.json(sep(), { status: 201 })),
      http.post("*/api/v1/hr/me/resignation/s1/withdraw", () => HttpResponse.json(sep({ status: "WITHDRAWN" }))));
    renderWithProviders(<SeparationsPage />, { permissions: ["hr.self"] });
    expect(screen.queryByText("All separations")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Submit my resignation" }));
    const d = within(screen.getByRole("dialog", { name: "Submit resignation" }));
    fireEvent.change(d.getByLabelText("Last working day"), { target: { value: "2030-01-31" } });
    await userEvent.type(d.getByLabelText("Reason"), "Moving");
    await userEvent.click(d.getByRole("button", { name: "Submit resignation" }));
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw resignation" }));
    expect(await screen.findByText("Withdrawn")).toBeInTheDocument();
  });
});

describe("OrgPage", () => {
  it("renders the tree and the plan with over-plan flagged; grade creation needs config permission", async () => {
    server.use(http.get("*/api/v1/hr/org-chart", () => HttpResponse.json([{ id: "a", employee_no: "E-1", name: "Boss", position: "CEO", department: null, reports: [{ id: "b", employee_no: "E-2", name: "Sara", position: null, department: "Ops", reports: [] }] }])),
      http.get("*/api/v1/hr/reports/headcount-plan", () => HttpResponse.json([{ position: "Engineer", position_id: "p1", department: "Ops", grade: "G1", approved: 1, occupied: 3, vacant: 0, over_headcount: 2 }])),
      http.get("*/api/v1/hr/grades", () => HttpResponse.json([{ id: "g", code: "G1", name: "Junior", min_salary: "400.00", max_salary: "900.00", is_active: true }])));
    renderWithProviders(<OrgPage />, { permissions: ["hr.self", "hr.view"] });
    expect(await screen.findByText("Sara")).toBeInTheDocument();
    expect(await screen.findByText("2 over plan")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New grade" })).toBeNull();
  });
  it("sends a grade with money as strings", async () => {
    server.use(http.get("*/api/v1/hr/org-chart", () => HttpResponse.json([])), http.get("*/api/v1/hr/reports/headcount-plan", () => HttpResponse.json([])), http.get("*/api/v1/hr/grades", () => HttpResponse.json([])));
    let sent: unknown;
    server.use(http.post("*/api/v1/hr/grades", async ({ request }) => { sent = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<OrgPage />, { permissions: ["hr.self", "hr.view", "hr.config.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New grade" }));
    const d = within(screen.getByRole("dialog", { name: "New job grade" }));
    await userEvent.type(d.getByLabelText("Code"), "G2"); await userEvent.type(d.getByLabelText("Name"), "Senior");
    await userEvent.type(d.getByLabelText("Minimum salary"), "900"); await userEvent.type(d.getByLabelText("Maximum salary"), "100");
    await userEvent.click(d.getByRole("button", { name: "Create grade" }));
    expect(await screen.findByText(/not be below/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Maximum salary")); await userEvent.type(d.getByLabelText("Maximum salary"), "1500.50");
    await userEvent.click(d.getByRole("button", { name: "Create grade" }));
    await waitFor(() => expect(sent).toEqual({ code: "G2", name: "Senior", min_salary: "900", max_salary: "1500.50" }));
  });
});

describe("MonitoringPage and analytics", () => {
  it("asks for the chosen look-ahead", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/hr/monitoring", ({ request }) => { seen.push(new URL(request.url).searchParams.get("days") ?? ""); return HttpResponse.json({ probation_ending: [{ employee: "E-1", name: "Abel", probation_end: "2026-12-01" }], contracts_expiring: [], documents_expiring: [], qualifications_expiring: [], retirements: [] }); }));
    renderWithProviders(<MonitoringPage />, { permissions: ["hr.self"] });
    expect(await screen.findByText("Abel (E-1) — 2026-12-01")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Look ahead"), "90");
    await waitFor(() => expect(seen).toEqual(["60", "90"]));
  });
  it("shows payroll cost only when the server sends it", async () => {
    const base = { headcount: { as_of: "2026-11-12", total: 12, by_department: { Ops: 12 }, by_employment_type: { FULL_TIME: 12 } }, turnover: { year: 2026, leavers: 1, average_headcount: "12.00", turnover_percent: null, by_type: {} }, tenure: { "<1y": 2 }, absenteeism: [], recruitment: { open_requisitions: 1, funnel: { APPLIED: 4 } } };
    server.use(http.get("*/api/v1/hr/analytics/dashboard", () => HttpResponse.json({ ...base, payroll_cost: null })));
    const { unmount } = renderWithProviders(<HrAnalyticsPage />, { permissions: ["hr.analytics.view"] });
    expect(await screen.findByText("n/a")).toBeInTheDocument();
    expect(screen.queryByText("Payroll cost")).toBeNull();
    unmount();
    server.use(http.get("*/api/v1/hr/analytics/dashboard", () => HttpResponse.json({ ...base, payroll_cost: [{ month: "2026-10", gross: "1000.00", employer_pension: "70.00", employer_cost: "1070.00", net: "800.00" }] })));
    renderWithProviders(<HrAnalyticsPage />, { permissions: ["hr.analytics.view"] });
    expect(await screen.findByText("Payroll cost")).toBeInTheDocument();
  });
});

describe("ImportPage", () => {
  it("checks first and only enables import when every row is valid", async () => {
    const calls: boolean[] = [];
    server.use(http.post("*/api/v1/hr/employees/import", async ({ request }) => {
      const b = (await request.json()) as { commit: boolean };
      calls.push(b.commit);
      return HttpResponse.json(b.commit ? { committed: true, rows: [{ row: 1, ok: true, errors: [] }], created: ["E-9"], valid_rows: 1, error_rows: 0 } : { committed: false, rows: [{ row: 1, ok: true, errors: [] }], created: [], valid_rows: 1, error_rows: 0 });
    }));
    renderWithProviders(<ImportPage />, { permissions: ["hr.employee.manage"] });
    const box = screen.getByLabelText("Employee CSV");
    fireEvent.change(box, { target: { value: "first_name,last_name,hire_date\nA,B,2026-01-01" } });
    expect(screen.getByRole("button", { name: "Import employees" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Check file" }));
    expect(await screen.findByText(/1 valid row/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Import employees" }));
    expect(await screen.findByText(/Imported 1 employee/)).toBeInTheDocument();
    expect(calls).toEqual([false, true]);
  });
  it("keeps import disabled and lists row errors", async () => {
    server.use(http.post("*/api/v1/hr/employees/import", () => HttpResponse.json({ committed: false, rows: [{ row: 2, ok: false, errors: ["hire_date must be YYYY-MM-DD"] }], created: [], valid_rows: 0, error_rows: 1 })));
    renderWithProviders(<ImportPage />, { permissions: ["hr.employee.manage"] });
    fireEvent.change(screen.getByLabelText("Employee CSV"), { target: { value: "first_name,last_name,hire_date\nA,B,x" } });
    await userEvent.click(screen.getByRole("button", { name: "Check file" }));
    expect(await screen.findByText(/hire_date must be/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import employees" })).toBeDisabled();
  });
  it("imports punches and reports unknown employees; sections follow permissions", async () => {
    server.use(http.post("*/api/v1/hr/attendance/import", () => HttpResponse.json({ created: 1, updated: 0, skipped: 0, unknown_employees: ["X-9"], invalid_rows: 0 })));
    renderWithProviders(<ImportPage />, { permissions: ["hr.attendance.import"] });
    expect(screen.queryByText("Import employees")).toBeNull();
    fireEvent.change(screen.getByLabelText("Punches"), { target: { value: "E-1,2026-11-02T08:00:00" } });
    await userEvent.click(screen.getByRole("button", { name: "Import punches" }));
    expect(await screen.findByText(/needs a date, a time and a zone/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Punches"), { target: { value: "E-1,2026-11-02T08:00:00+03:00" } });
    await userEvent.click(screen.getByRole("button", { name: "Import punches" }));
    expect(await screen.findByText(/Unknown employees: X-9/)).toBeInTheDocument();
  });
});

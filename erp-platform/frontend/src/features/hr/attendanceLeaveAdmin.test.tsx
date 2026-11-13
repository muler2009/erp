import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AttendanceAdminPage, toIsoWithZone, validateOvertime } from "./AttendanceAdminPage";
import { LeaveAdminPage, validateDelegation, validateLeaveType } from "./LeaveAdminPage";
import { WorkTimePage, validatePolicy, validateSchedule } from "./WorkTimePage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE" }] }))); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

describe("pure helpers", () => {
  it("overtime hours and ISO conversion", () => {
    expect(validateOvertime("0")).toMatch(/more than 0/);
    expect(validateOvertime("25")).toMatch(/at most 24/);
    expect(validateOvertime("2.5")).toBeNull();
    expect(toIsoWithZone("2026-11-10T08:00")).toMatch(/^2026-11-10T\d\d:00:00\.000Z$/);
    expect(toIsoWithZone("")).toBe("");
  });
  it("delegation, leave type, schedule, policy", () => {
    expect(validateDelegation("", "", "")).toMatch(/Choose who/);
    expect(validateDelegation("u", "2026-12-02", "2026-12-01")).toMatch(/cannot end/);
    expect(validateDelegation("u", "2026-12-01", "2026-12-02")).toBeNull();
    const lt = { name: "A", annual_days: "16", max_carryover_days: "5", eligibility_months: "0", max_consecutive_days: "0", min_notice_days: "0", carryover_expiry_months: "3" };
    expect(validateLeaveType({ ...lt, name: " " })).toMatch(/name/);
    expect(validateLeaveType({ ...lt, annual_days: "-1" })).toMatch(/Annual days/);
    expect(validateLeaveType({ ...lt, min_notice_days: "1.5" })).toMatch(/whole number/);
    expect(validateLeaveType(lt)).toBeNull();
    const s = { code: "STD", name: "Standard", days: [0, 1], start: "08:00", end: "17:00", brk: "60", grace: "10" };
    expect(validateSchedule({ ...s, days: [] })).toMatch(/working day/);
    expect(validateSchedule({ ...s, end: "07:00" })).toMatch(/after the start/);
    expect(validateSchedule({ ...s, brk: "x" })).toMatch(/whole numbers/);
    expect(validateSchedule(s)).toBeNull();
    const p = { weekday_multiplier: "1.5", rest_day_multiplier: "2", holiday_multiplier: "2.5", max_daily_hours: "4", monthly_hours_divisor: "208" };
    expect(validatePolicy({ ...p, weekday_multiplier: "0.5" })).toMatch(/at least 1/);
    expect(validatePolicy({ ...p, max_daily_hours: "30" })).toMatch(/at most 24/);
    expect(validatePolicy(p)).toBeNull();
  });
});

describe("AttendanceAdminPage", () => {
  it("manager approves a correction; employee requests one for themselves with a zoned time", async () => {
    let acted = ""; let body: any = null;
    server.use(http.get("*/api/v1/hr/attendance/corrections", () => HttpResponse.json({ results: [{ id: "c1", employee: "e1", work_date: "2026-11-09", check_in: "2026-11-09T06:00:00Z", check_out: null, work_mode: "OFFICE", reason: "Forgot", status: "PENDING", decision_note: "" }] })),
      http.post("*/api/v1/hr/attendance/corrections/c1/:d", ({ params }) => { acted = String(params.d); return HttpResponse.json({}); }),
      http.post("*/api/v1/hr/attendance/corrections", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<AttendanceAdminPage />, { permissions: ["hr.self", "hr.timesheet.approve"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(acted).toBe("approve"));
    await user.click(screen.getByRole("button", { name: "Request a correction" }));
    const dlg = await screen.findByRole("dialog", { name: "Request attendance correction" });
    expect(within(dlg).queryByLabelText("Employee")).toBeNull();
    fireEvent.change(within(dlg).getByLabelText("Date"), { target: { value: "2026-11-09" } });
    fireEvent.change(within(dlg).getByLabelText("Clock in"), { target: { value: "2026-11-09T08:00" } });
    fireEvent.change(within(dlg).getByLabelText(/Clock out/), { target: { value: "2026-11-09T07:00" } });
    await user.selectOptions(within(dlg).getByLabelText("Work mode"), "OFFICE");
    await user.type(within(dlg).getByLabelText("Reason"), "Forgot to clock in");
    await user.click(within(dlg).getByRole("button", { name: "Submit correction" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/after clock in/);
    fireEvent.change(within(dlg).getByLabelText(/Clock out/), { target: { value: "2026-11-09T17:00" } });
    await user.click(within(dlg).getByRole("button", { name: "Submit correction" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body.check_in).toMatch(/Z$/);
    expect(body.employee).toBeUndefined();
  });
  it("overtime: no decision buttons without hr.timesheet.approve; refuses bad hours", async () => {
    server.use(http.get("*/api/v1/hr/overtime", () => HttpResponse.json({ results: [{ id: "o1", employee: "e1", work_date: "2026-11-09", hours: "2.00", reason: "Release", status: "PENDING", decision_note: "" }] })));
    renderWithProviders(<AttendanceAdminPage />, { permissions: ["hr.self"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Overtime" }));
    await screen.findByText("Release");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Request overtime" }));
    const dlg = await screen.findByRole("dialog", { name: "Request overtime" });
    fireEvent.change(within(dlg).getByLabelText("Date worked"), { target: { value: "2026-11-09" } });
    await user.type(within(dlg).getByLabelText("Hours"), "30");
    await user.type(within(dlg).getByLabelText("Reason"), "Deadline");
    await user.click(within(dlg).getByRole("button", { name: "Submit request" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/at most 24/);
  });
  it("exceptions and report tabs load for the chosen period", async () => {
    server.use(http.get("*/api/v1/hr/reports/attendance-exceptions", () => HttpResponse.json([{ employee_no: "E-1", name: "Abel", date: "2026-11-05", exceptions: ["LATE"], correction_status: null, overtime_request_status: null }])),
      http.get("*/api/v1/hr/reports/attendance", ({ request }) => HttpResponse.json([{ employee_no: "E-1", name: "Abel", period: new URL(request.url).searchParams.get("group"), present_days: 20, absent_days: 1, leave_days: 2, late_count: 3, late_minutes: 45, early_count: 0, worked_hours: "160.00", overtime_hours: "4.00", missed_punches: 0 }])));
    renderWithProviders(<AttendanceAdminPage />, { permissions: ["hr.self"] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Exceptions" }));
    expect(await screen.findByText("Late")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Report" }));
    expect(await screen.findByText("3 (45 min)")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Group by"), "week");
    expect(await screen.findByText("week")).toBeInTheDocument();
  });
});

describe("LeaveAdminPage", () => {
  it("tabs follow permissions", () => {
    server.use(http.get("*/api/v1/hr/leave/calendar", () => HttpResponse.json({ leaves: [], holidays: [] })));
    renderWithProviders(<LeaveAdminPage />, { permissions: ["hr.self"] });
    expect(screen.queryByRole("tab", { name: "Leave types" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Allocations" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Delegations" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Calendar" })).toBeInTheDocument();
  });
  it("shows the calendar with holidays", async () => {
    server.use(http.get("*/api/v1/hr/leave/calendar", () => HttpResponse.json({ leaves: [{ employee_no: "E-1", name: "Abel", department: "Ops", type: "ANNUAL", start_date: "2026-11-20", end_date: "2026-11-22", days: "3", status: "APPROVED" }], holidays: [{ date: "2026-11-25", name: "Founders day" }] })));
    renderWithProviders(<LeaveAdminPage />, { permissions: ["hr.self"] });
    expect(await screen.findByText(/Founders day/)).toBeInTheDocument();
    expect(screen.getByText("E-1 Abel")).toBeInTheDocument();
  });
  it("edits a leave type and shows server refusals", async () => {
    let body: any = null;
    const cfg = { code: "ANNUAL", name: "Annual leave", is_paid: true, annual_days: "16.00", grant_mode: "ACCRUAL", eligibility_months: 0, eligible_employment_types: [], max_carryover_days: "5.00", carryover_expiry_months: 3, allow_half_day: true, max_consecutive_days: 0, min_notice_days: 0, is_active: true };
    server.use(http.get("*/api/v1/hr/leave/calendar", () => HttpResponse.json({ leaves: [], holidays: [] })), http.get("*/api/v1/hr/leave/types", () => HttpResponse.json([{ code: "ANNUAL", name: "Annual leave", is_paid: true, annual_days: "16" }])),
      http.get("*/api/v1/hr/leave/types/ANNUAL", () => HttpResponse.json(cfg)),
      http.put("*/api/v1/hr/leave/types/ANNUAL", async ({ request }) => { body = await request.json(); return HttpResponse.json(cfg); }));
    renderWithProviders(<LeaveAdminPage />, { permissions: ["hr.self", "hr.config.manage"] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Leave types" }));
    await screen.findByRole("option", { name: "Annual leave" });
    await user.selectOptions(await screen.findByLabelText("Leave type"), "ANNUAL");
    const days = await screen.findByLabelText("Annual days");
    await user.clear(days); await user.type(days, "-2");
    await user.click(screen.getByRole("button", { name: "Save leave type" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Annual days/);
    await user.clear(days); await user.type(days, "18");
    await user.click(screen.getByLabelText("Contractor"));
    await user.click(screen.getByRole("button", { name: "Save leave type" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body.annual_days).toBe("18");
    expect(body.eligible_employment_types).toEqual(["CONTRACTOR"]);
    expect(body.eligibility_months).toBe(0);
  });
  it("allocations and jobs: jobs only with hr.config.manage", async () => {
    let job = "";
    server.use(http.get("*/api/v1/hr/leave/calendar", () => HttpResponse.json({ leaves: [], holidays: [] })), http.get("*/api/v1/hr/leave/types", () => HttpResponse.json([])), http.post("*/api/v1/hr/leave/run/:j", ({ params }) => { job = String(params.j); return HttpResponse.json({ created: 4 }); }));
    const v = renderWithProviders(<LeaveAdminPage />, { permissions: ["hr.self", "hr.employee.manage", "hr.config.manage"] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Allocations" }));
    await user.click(await screen.findByRole("button", { name: "Run accrual now" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/4 record/);
    expect(job).toBe("accrue");
    v.unmount();
    renderWithProviders(<LeaveAdminPage />, { permissions: ["hr.self", "hr.employee.manage"] });
    await userEvent.setup().click(screen.getByRole("tab", { name: "Allocations" }));
    await screen.findByRole("button", { name: /Set an employee/ });
    expect(screen.queryByRole("button", { name: "Run accrual now" })).toBeNull();
  });
});

describe("WorkTimePage", () => {
  it("creates a schedule after validation", async () => {
    let body: any = null;
    server.use(http.get("*/api/v1/hr/schedules", () => HttpResponse.json([{ id: "s1", code: "STD", name: "Standard", work_days: [0, 1, 2, 3, 4], start_time: "08:30:00", end_time: "17:30:00", break_minutes: 60, grace_minutes: 10, is_default: true }])),
      http.post("*/api/v1/hr/schedules", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<WorkTimePage />, { permissions: ["hr.self", "hr.config.manage"] });
    const user = userEvent.setup();
    expect(await screen.findByText("Mon Tue Wed Thu Fri")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New schedule" }));
    await user.click(await screen.findByRole("button", { name: "Save schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/code and a name/);
    await user.type(screen.getByLabelText("Code"), "night");
    await user.type(screen.getByLabelText("Name"), "Night shift");
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(body).toEqual({ code: "NIGHT", name: "Night shift", work_days: [0, 1, 2, 3, 4], start_time: "08:30", end_time: "17:30", break_minutes: 60, grace_minutes: 10, is_default: false }));
  });
  it("overtime policy is read-only without hr.config.manage and saves with it", async () => {
    let body: any = null;
    const pol = { weekday_multiplier: "1.50", rest_day_multiplier: "2.00", holiday_multiplier: "2.50", max_daily_hours: "4.00", monthly_hours_divisor: "208.00" };
    server.use(http.get("*/api/v1/hr/overtime-policy", () => HttpResponse.json(pol)), http.put("*/api/v1/hr/overtime-policy", async ({ request }) => { body = await request.json(); return HttpResponse.json(pol); }), http.get("*/api/v1/hr/schedules", () => HttpResponse.json([])));
    const v = renderWithProviders(<WorkTimePage />, { permissions: ["hr.self"] });
    await userEvent.setup().click(screen.getByRole("tab", { name: "Overtime policy" }));
    expect(await screen.findByLabelText("Weekday multiplier")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save policy" })).toBeNull();
    v.unmount();
    renderWithProviders(<WorkTimePage />, { permissions: ["hr.self", "hr.config.manage"] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Overtime policy" }));
    const wd = await screen.findByLabelText("Weekday multiplier");
    await user.clear(wd); await user.type(wd, "0.5");
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 1/);
    await user.clear(wd); await user.type(wd, "1.75");
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(body).toEqual({ ...pol, weekday_multiplier: "1.75" }));
  });
});

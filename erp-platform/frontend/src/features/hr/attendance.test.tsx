import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AttendancePage } from "./AttendancePage";
import { TimesheetsPage, validateTimesheet } from "./TimesheetsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e2", employee_no: "E-2", name: "Sara Bekele", first_name: "Sara", last_name: "Bekele", email: "", status: "ACTIVE", hire_date: "2025-01-01", termination_date: null, department: null, position: null, manager: null, user_id: null }] }))); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const me = http.get("*/api/v1/hr/me", () => HttpResponse.json({ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", leave_balances: [] }));
const att = (...rows: object[]) => http.get("*/api/v1/hr/attendance", () => HttpResponse.json({ results: rows }));
const rec = (o: object = {}) => ({ id: "a1", employee: "e1", work_date: "2026-11-10", check_in: "2026-11-10T06:00:00Z", check_out: "2026-11-10T14:00:00Z", hours: "8.00", ...o });
const sheet = (o: object = {}) => ({ id: "t1", employee: "e2", week_start: "2026-11-02", status: "SUBMITTED", decision_note: "", entries: [{ work_date: "2026-11-02", hours: "8", project_ref: "", description: "" }], total_hours: "8", ...o });
const sheets = (...rows: object[]) => http.get("*/api/v1/hr/timesheets", () => HttpResponse.json({ results: rows }));

describe("validateTimesheet", () => {
  const e = (work_date: string, hours: string) => ({ work_date, hours, project_ref: "", description: "" });
  it("checks Monday, week range, hours and daily total", () => {
    expect(validateTimesheet("", [])).toMatch(/Choose/);
    expect(validateTimesheet("2026-11-03", [e("2026-11-03", "8")])).toMatch(/Monday/);
    expect(validateTimesheet("2026-11-02", [])).toMatch(/at least one/);
    expect(validateTimesheet("2026-11-02", [e("2026-11-09", "8")])).toMatch(/inside the chosen week/);
    expect(validateTimesheet("2026-11-02", [e("2026-11-02", "0")])).toMatch(/more than 0/);
    expect(validateTimesheet("2026-11-02", [e("2026-11-02", "25")])).toMatch(/at most 24/);
    expect(validateTimesheet("2026-11-02", [e("2026-11-02", "14"), e("2026-11-02", "11")])).toMatch(/More than 24/);
    expect(validateTimesheet("2026-11-02", [e("2026-11-02", "7.5"), e("2026-11-08", "2")])).toBeNull();
  });
});

describe("AttendancePage", () => {
  it("clocks in with the chosen work mode when not clocked in", async () => {
    let body: any = null;
    server.use(me, att(rec()), http.post("*/api/v1/hr/me/check-in", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "a2" }, { status: 201 }); }));
    renderWithProviders(<AttendancePage />, { permissions: ["hr.self"] });
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Work mode"), "REMOTE");
    await user.click(screen.getByRole("button", { name: "Check in" }));
    await waitFor(() => expect(body).toEqual({ work_mode: "REMOTE" }));
  });
  it("offers check out when a day is open and shows the server's refusal", async () => {
    server.use(me, att(rec({ check_out: null, hours: null })), http.post("*/api/v1/hr/me/check-out", () => HttpResponse.json({ error: { code: "not_checked_in", message: "You are not clocked in." } }, { status: 409 })));
    renderWithProviders(<AttendancePage />, { permissions: ["hr.self"] });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Check out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not clocked in/);
  });
});

describe("TimesheetsPage", () => {
  it("creates a draft timesheet", async () => {
    let body: any = null;
    server.use(me, sheets(), http.put("*/api/v1/hr/timesheets", async ({ request }) => { body = await request.json(); return HttpResponse.json(sheet({ employee: "e1", status: "DRAFT" })); }));
    renderWithProviders(<TimesheetsPage />, { permissions: ["hr.self"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New timesheet" }));
    const dlg = await screen.findByRole("dialog", { name: "New timesheet" });
    await user.click(within(dlg).getByRole("button", { name: "Save draft" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/Choose the week/);
    fireEvent.change(within(dlg).getByLabelText(/Week starting/), { target: { value: "2026-11-02" } });
    fireEvent.change(within(dlg).getByLabelText("Entry 1 date"), { target: { value: "2026-11-03" } });
    await user.click(within(dlg).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ week_start: "2026-11-02", entries: [{ work_date: "2026-11-03", hours: "8", project_ref: "", description: "" }] });
  });
  it("own draft can be submitted; manager sees approve/reject only for others' submitted sheets", async () => {
    let action = "";
    server.use(me, sheets(sheet({ id: "t1", employee: "e1", status: "DRAFT" }), sheet({ id: "t2", employee: "e2" })), http.post("*/api/v1/hr/timesheets/:id/:a", ({ params }) => { action = `${params.id}:${params.a}`; return HttpResponse.json(sheet()); }));
    renderWithProviders(<TimesheetsPage />, { permissions: ["hr.self", "hr.timesheet.approve"] });
    const user = userEvent.setup();
    await screen.findByText("Me");
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(action).toBe("t1:submit"));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(action).toBe("t2:approve"));
  });
  it("requires a reason to reject; no approve without permission", async () => {
    server.use(me, sheets(sheet()));
    const view = renderWithProviders(<TimesheetsPage />, { permissions: ["hr.self"] });
    await screen.findByText("2026-11-02");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    view.unmount();
    renderWithProviders(<TimesheetsPage />, { permissions: ["hr.self", "hr.timesheet.approve"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    const dlg = await screen.findByRole("dialog", { name: "Reject timesheet" });
    await user.click(within(dlg).getByRole("button", { name: "Reject" }));
    expect(await screen.findByText(/reason is required/)).toBeInTheDocument();
  });
});

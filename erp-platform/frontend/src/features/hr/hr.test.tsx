import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { EmployeesPage } from "./EmployeesPage";
import { LeavePage, validateLeave } from "./LeavePage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e2", employee_no: "E-2", name: "Sara Bekele", first_name: "Sara", last_name: "Bekele", email: "", status: "ACTIVE", hire_date: "2025-01-01", termination_date: null, department: null, position: null, manager: null, user_id: null }] }))); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const emp = (o: object = {}) => ({ id: "e1", employee_no: "E-1", name: "Abel Tesfaye", first_name: "Abel", last_name: "Tesfaye", email: "a@x.com", status: "ACTIVE", hire_date: "2025-01-01", termination_date: null, department: "Ops", position: "Clerk", manager: null, user_id: "u1", ...o });
const me = http.get("*/api/v1/hr/me", () => HttpResponse.json({ ...emp(), leave_balances: [{ leave_type: "ANNUAL", year: 2026, allocated: "16", used: "2", remaining: "14" }] }));
const req = (o: object = {}) => ({ id: "r1", employee: "e2", leave_type: "ANNUAL", start_date: "2026-12-01", end_date: "2026-12-03", days: "3", status: "PENDING", reason: "", decision_note: "", half_day: "", workflow_instance_id: null, ...o });
const reqs = (...rows: object[]) => http.get("*/api/v1/hr/leave/requests", () => HttpResponse.json({ results: rows }));

describe("validateLeave", () => {
  it("checks type, dates, year and half days", () => {
    expect(validateLeave({ type: "", start: "", end: "", half: "" })).toMatch(/type/);
    expect(validateLeave({ type: "A", start: "", end: "", half: "" })).toMatch(/first and last/);
    expect(validateLeave({ type: "A", start: "2026-02-02", end: "2026-02-01", half: "" })).toMatch(/on or after/);
    expect(validateLeave({ type: "A", start: "2026-12-30", end: "2027-01-02", half: "" })).toMatch(/calendar year/);
    expect(validateLeave({ type: "A", start: "2026-02-01", end: "2026-02-02", half: "AM" })).toMatch(/single day/);
    expect(validateLeave({ type: "A", start: "2026-02-01", end: "2026-02-02", half: "" })).toBeNull();
  });
});

describe("LeavePage", () => {
  it("shows balances and submits a request", async () => {
    let body: any = null;
    server.use(me, reqs(), http.get("*/api/v1/hr/leave/types", () => HttpResponse.json([{ code: "ANNUAL", name: "Annual leave", is_paid: true, annual_days: "16" }])),
      http.post("*/api/v1/hr/leave/requests", async ({ request }) => { body = await request.json(); return HttpResponse.json(req({ employee: "e1" }), { status: 201 }); }));
    renderWithProviders(<LeavePage />, { permissions: ["hr.self"] });
    const user = userEvent.setup();
    expect(await screen.findByText("14")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Request leave" }));
    const dlg = await screen.findByRole("dialog", { name: "Request leave" });
    await user.click(within(dlg).getByRole("button", { name: "Submit request" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/leave type/);
    await within(dlg).findByRole("option", { name: "Annual leave" });
    await user.selectOptions(within(dlg).getByLabelText("Leave type"), "ANNUAL");
    fireEvent.change(within(dlg).getByLabelText("First day"), { target: { value: "2026-12-01" } });
    fireEvent.change(within(dlg).getByLabelText("Last day"), { target: { value: "2026-12-03" } });
    await user.click(within(dlg).getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ leave_type: "ANNUAL", start_date: "2026-12-01", end_date: "2026-12-03", reason: "" });
  });

  it("manager approves a report's pending leave but cannot decide their own", async () => {
    let action = ""; 
    server.use(me, reqs(req(), req({ id: "r2", employee: "e1" })), http.post("*/api/v1/hr/leave/requests/:id/:a", ({ params }) => { action = `${params.id}:${params.a}`; return HttpResponse.json(req({ status: "APPROVED" })); }));
    renderWithProviders(<LeavePage />, { permissions: ["hr.self", "hr.leave.approve"] });
    const user = userEvent.setup();
    await screen.findByText("Me");
    expect(await screen.findByText("Sara Bekele")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dlg = await screen.findByRole("dialog", { name: "Approve leave" });
    await user.click(within(dlg).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(action).toBe("r1:approve"));
  });

  it("requires a reason to reject and shows server refusals", async () => {
    server.use(me, reqs(req()), http.post("*/api/v1/hr/leave/requests/r1/reject", () => HttpResponse.json({ error: { code: "forbidden", message: "Not your report." } }, { status: 403 })));
    renderWithProviders(<LeavePage />, { permissions: ["hr.self", "hr.leave.approve"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    const dlg = await screen.findByRole("dialog", { name: "Reject leave" });
    await user.click(within(dlg).getByRole("button", { name: "Reject" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/reason is required/);
    await user.type(within(dlg).getByLabelText(/Reason/), "Busy period");
    await user.click(within(dlg).getByRole("button", { name: "Reject" }));
    expect(await within(dlg).findByText(/Not your report/)).toBeInTheDocument();
  });

  it("hides approve buttons without the permission", async () => {
    server.use(me, reqs(req()));
    renderWithProviders(<LeavePage />, { permissions: ["hr.self"] });
    await screen.findByText("ANNUAL");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});

describe("EmployeesPage", () => {
  it("lists employees and filters the page by search", async () => {
    server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [emp(), emp({ id: "e2", employee_no: "E-2", name: "Sara Bekele", email: "s@x.com" })] })));
    renderWithProviders(<EmployeesPage />, { permissions: ["hr.self"] });
    const user = userEvent.setup();
    expect(await screen.findByText("Abel Tesfaye")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search this page"), "sara");
    expect(screen.queryByText("Abel Tesfaye")).toBeNull();
    expect(screen.getByText("Sara Bekele")).toBeInTheDocument();
  });
});

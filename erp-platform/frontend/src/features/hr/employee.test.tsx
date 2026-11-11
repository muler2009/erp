import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { validateEmployee } from "./EmployeeDialogs";
import { EmployeePage, validateContract } from "./EmployeePage";
import { EmployeesPage } from "./EmployeesPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const emp = (o: object = {}) => ({ id: "e1", employee_no: "E-1", name: "Abel Tesfaye", first_name: "Abel", last_name: "Tesfaye", email: "a@x.com", phone: "0911", status: "ACTIVE", hire_date: "2025-01-01", termination_date: null, department: "Ops", position: "Clerk", manager: null, user_id: "u9", checklist: [{ id: "c1", kind: "ONBOARDING", title: "Sign contract", done_at: null }], ...o });
const prof = (o: object = {}) => ({ ...emp(), employment_type: "FULL_TIME", probation_end: "2026-03-01", probation_status: "IN_PROGRESS", grade: "G3", separation_type: "", emergency_contacts: [], qualifications: [], skills: [{ id: "s1", name: "Excel", level: "ADVANCED" }], documents: [], missing_documents: [{}], ...o });
const base = (e = emp(), p = prof()) => server.use(
  http.get("*/api/v1/hr/employees/e1", () => HttpResponse.json(e)),
  http.get("*/api/v1/hr/employees/e1/profile", () => HttpResponse.json(p)),
  http.get("*/api/v1/org/departments", () => HttpResponse.json({ results: [{ id: "d1", code: "OPS", name: "Ops", parent: null, is_active: true }] })),
  http.get("*/api/v1/org/positions", () => HttpResponse.json({ results: [] })));
const view = (perms: string[]) => renderWithProviders(<Routes><Route path="/app/hr/employees/:id" element={<EmployeePage />} /></Routes>, { permissions: perms, route: "/app/hr/employees/e1" });
const HR = ["hr.self", "hr.employee.manage", "hr.compensation.view", "hr.compensation.manage"];

describe("validators", () => {
  it("employee", () => {
    expect(validateEmployee({ first: "", last: "", hire: "", email: "", phone: "", department: "", position: "", type: "FULL_TIME", dob: "" }, true)).toMatch(/name/);
    expect(validateEmployee({ first: "A", last: "B", hire: "", email: "", phone: "", department: "", position: "", type: "FULL_TIME", dob: "" }, true)).toMatch(/hire date/);
    expect(validateEmployee({ first: "A", last: "B", hire: "2026-01-01", email: "nope", phone: "", department: "", position: "", type: "FULL_TIME", dob: "" }, true)).toMatch(/valid email/);
    expect(validateEmployee({ first: "A", last: "B", hire: "", email: "a@b.co", phone: "", department: "", position: "", type: "FULL_TIME", dob: "" }, false)).toBeNull();
  });
  it("contract", () => {
    expect(validateContract({ start: "", end: "", salary: "1", currency: "ETB" })).toMatch(/start/);
    expect(validateContract({ start: "2026-02-01", end: "2026-01-01", salary: "1", currency: "ETB" })).toMatch(/cannot end/);
    expect(validateContract({ start: "2026-01-01", end: "", salary: "0", currency: "ETB" })).toMatch(/more than 0/);
    expect(validateContract({ start: "2026-01-01", end: "", salary: "100", currency: "BIRR" })).toMatch(/3-letter/);
    expect(validateContract({ start: "2026-01-01", end: "", salary: "100.50", currency: "etb" })).toBeNull();
  });
});

describe("EmployeesPage create", () => {
  it("creates an employee and offers override only after a duplicate refusal", async () => {
    const bodies: any[] = [];
    server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [] })), http.get("*/api/v1/org/departments", () => HttpResponse.json({ results: [] })), http.get("*/api/v1/org/positions", () => HttpResponse.json({ results: [] })),
      http.post("*/api/v1/hr/employees", async ({ request }) => { const b: any = await request.json(); bodies.push(b); return b.allow_duplicate ? HttpResponse.json(emp(), { status: 201 }) : HttpResponse.json({ error: { code: "duplicate_employee", message: "A possible duplicate already exists." } }, { status: 409 }); }));
    renderWithProviders(<EmployeesPage />, { permissions: ["hr.self", "hr.employee.manage"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New employee" }));
    const dlg = await screen.findByRole("dialog", { name: "New employee" });
    await user.type(within(dlg).getByLabelText("First name"), "Abel");
    await user.type(within(dlg).getByLabelText("Last name"), "Tesfaye");
    fireEvent.change(within(dlg).getByLabelText("Hire date"), { target: { value: "2026-11-01" } });
    expect(within(dlg).queryByLabelText(/create anyway/)).toBeNull();
    await user.click(within(dlg).getByRole("button", { name: "Create employee" }));
    expect(await within(dlg).findByText(/possible duplicate/)).toBeInTheDocument();
    await user.click(within(dlg).getByLabelText(/create anyway/));
    await user.click(within(dlg).getByRole("button", { name: "Create employee" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0].allow_duplicate).toBeUndefined();
    expect(bodies[1].allow_duplicate).toBe(true);
  });
  it("hides New employee without hr.employee.manage", async () => {
    server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<EmployeesPage />, { permissions: ["hr.self"] });
    await screen.findByText("No employees");
    expect(screen.queryByRole("button", { name: "New employee" })).toBeNull();
  });
});

describe("EmployeePage", () => {
  it("HR sees lifecycle actions for an active employee and starts offboarding", async () => {
    let body: any = null;
    base();
    server.use(http.post("*/api/v1/hr/employees/e1/offboard", async ({ request }) => { body = await request.json(); return HttpResponse.json(emp({ status: "OFFBOARDING" })); }));
    view(HR);
    const user = userEvent.setup();
    await screen.findByText("E-1 Abel Tesfaye");
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start offboarding" }));
    const dlg = await screen.findByRole("dialog", { name: "Start offboarding" });
    await user.click(within(dlg).getByRole("button", { name: "Start offboarding" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/Last day is required/);
    fireEvent.change(within(dlg).getByLabelText("Last day"), { target: { value: "2026-12-31" } });
    await user.selectOptions(within(dlg).getByLabelText("Type"), "RESIGNATION");
    await user.type(within(dlg).getByLabelText("Reason"), "Moving abroad");
    await user.click(within(dlg).getByRole("button", { name: "Start offboarding" }));
    await waitFor(() => expect(body).toEqual({ termination_date: "2026-12-31", separation_type: "RESIGNATION", reason: "Moving abroad" }));
  });
  it("a plain employee sees no management buttons", async () => {
    base();
    view(["hr.self"]);
    await screen.findByText("E-1 Abel Tesfaye");
    for (const n of ["Edit", "Start offboarding", "Activate", "Evaluate probation"]) expect(screen.queryByRole("button", { name: n })).toBeNull();
  });
  it("evaluates probation and shows the server's refusal for own probation", async () => {
    base();
    server.use(http.post("*/api/v1/hr/employees/e1/probation", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you cannot evaluate your own probation." } }, { status: 403 })));
    view(HR);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Evaluate probation" }));
    const dlg = await screen.findByRole("dialog", { name: "Evaluate probation" });
    await user.selectOptions(within(dlg).getByLabelText("Outcome"), "CONFIRM");
    await user.click(within(dlg).getByRole("button", { name: "Record outcome" }));
    expect(await within(dlg).findByText(/Separation of duties/)).toBeInTheDocument();
  });
  it("marks a checklist item done", async () => {
    let hit = false;
    base();
    server.use(http.post("*/api/v1/hr/checklist/c1/done", () => { hit = true; return HttpResponse.json({ id: "c1", kind: "ONBOARDING", title: "Sign contract", done_at: "2026-11-11T00:00:00Z" }); }));
    view(HR);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(hit).toBe(true));
  });
  it("adds a contract on the employment tab and shows compensation only with access", async () => {
    let body: any = null;
    base();
    server.use(http.get("*/api/v1/hr/employees/e1/contracts", () => HttpResponse.json([{ id: "k1", employee: "e1", kind: "PERMANENT", start_date: "2025-01-01", end_date: null, monthly_salary: "20000.00", currency: "ETB" }])),
      http.post("*/api/v1/hr/employees/e1/contracts", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    const v = view(HR);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Employment" }));
    expect(await screen.findByText(/20,?000\.00 ETB/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add contract" }));
    const dlg = await screen.findByRole("dialog", { name: "Add contract" });
    fireEvent.change(within(dlg).getByLabelText("Start"), { target: { value: "2026-12-01" } });
    await user.type(within(dlg).getByLabelText("Monthly salary"), "25000");
    await user.click(within(dlg).getByRole("button", { name: "Save contract" }));
    await waitFor(() => expect(body).toEqual({ start_date: "2026-12-01", monthly_salary: "25000", currency: "ETB", kind: "PERMANENT" }));
    v.unmount();
    view(["hr.self"]);
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Employment" }));
    expect(await screen.findByText(/do not have access to compensation/)).toBeInTheDocument();
  });
  it("assignment tab: HR requests a change; history tab lists events", async () => {
    let body: any = null;
    base();
    server.use(http.get("*/api/v1/hr/employees/e1/assignment-changes", () => HttpResponse.json([])),
      http.post("*/api/v1/hr/employees/e1/assignment-changes", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }),
      http.get("*/api/v1/hr/employees/e1/history", () => HttpResponse.json([{ kind: "HIRED", effective_date: "2025-01-01", details: { by: "HR" }, actor_id: null, recorded_at: "2025-01-01T00:00:00Z" }])));
    view(HR);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Assignment" }));
    await user.click(await screen.findByRole("button", { name: "Request a change" }));
    const dlg = await screen.findByRole("dialog", { name: "Request a change" });
    await user.selectOptions(within(dlg).getByLabelText("Kind"), "PROMOTION");
    fireEvent.change(within(dlg).getByLabelText("Effective date"), { target: { value: "2027-01-01" } });
    await user.type(within(dlg).getByLabelText("Reason"), "Excellent year");
    await user.click(within(dlg).getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(body).toEqual({ kind: "PROMOTION", effective_date: "2027-01-01", reason: "Excellent year" }));
    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(await screen.findByText(/Hired/)).toBeInTheDocument();
  });
});

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { PayrollPage, validatePeriod } from "./PayrollPage";
import { PayslipsPage } from "./PayslipsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const run = (o: object = {}) => ({ id: "p1", number: "PR-1", period_start: "2026-10-01", period_end: "2026-10-31", status: "DRAFT", gross_total: "1000.00", tax_total: "100.00", pension_employee_total: "70.00", pension_employer_total: "110.00", deduction_total: "0.00", net_total: "830.00", created_by: "u1", approved_by: null, workflow_instance_id: null, version: 1, ...o });
const slip = (o: object = {}) => ({ id: "s1", run: "PR-1", period_start: "2026-10-01", period_end: "2026-10-31", employee: "e1", employee_no: "E-1", working_days: "22", payable_days: "22", unpaid_leave_days: "0", basic: "1000.00", allowances: "0", overtime_pay: "0", other_earnings: "0", gross: "1000.00", taxable_income: "930.00", income_tax: "100.00", pension_employee: "70.00", other_deductions: "0", net: "830.00", ...o });
const setup = (r: object) => server.use(http.get("*/api/v1/hr/payroll/runs", () => HttpResponse.json({ results: [r] })), http.get("*/api/v1/hr/payroll/runs/p1", () => HttpResponse.json({ ...r, payslips: [slip()] })));
const open = async () => { await userEvent.setup().click(await screen.findByRole("button", { name: "PR-1" })); return screen.findByRole("dialog", { name: /Payroll PR-1/ }); };
const ALL = ["hr.payroll.view", "hr.payroll.process", "hr.payroll.approve", "hr.payroll.pay"];

describe("validatePeriod", () => {
  it("needs both dates in order", () => {
    expect(validatePeriod("", "")).toMatch(/Enter/);
    expect(validatePeriod("2026-10-31", "2026-10-01")).toMatch(/on or after/);
    expect(validatePeriod("2026-10-01", "2026-10-31")).toBeNull();
  });
});

describe("PayrollPage", () => {
  it("creates a run for a period and shows server refusals", async () => {
    let body: any = null;
    server.use(http.get("*/api/v1/hr/payroll/runs", () => HttpResponse.json({ results: [] })), http.post("*/api/v1/hr/payroll/runs", async ({ request }) => { body = await request.json(); return HttpResponse.json({ error: { code: "run_exists", message: "A payroll run already exists for this period." } }, { status: 409 }); }));
    renderWithProviders(<PayrollPage />, { permissions: ALL });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New run" }));
    const dlg = await screen.findByRole("dialog", { name: "New payroll run" });
    await user.click(within(dlg).getByRole("button", { name: "Calculate run" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/Enter the first/);
    fireEvent.change(within(dlg).getByLabelText("Period start"), { target: { value: "2026-10-01" } });
    fireEvent.change(within(dlg).getByLabelText("Period end"), { target: { value: "2026-10-31" } });
    await user.click(within(dlg).getByRole("button", { name: "Calculate run" }));
    await waitFor(() => expect(body).toEqual({ period_start: "2026-10-01", period_end: "2026-10-31" }));
    expect(await within(dlg).findByText(/already exists/)).toBeInTheDocument();
  });

  it("a draft run can be submitted by a preparer; approve is not offered", async () => {
    let action = "";
    setup(run());
    server.use(http.post("*/api/v1/hr/payroll/runs/p1/:a", ({ params }) => { action = String(params.a); return HttpResponse.json(run({ status: "PENDING_APPROVAL" })); }));
    renderWithProviders(<PayrollPage />, { permissions: ["hr.payroll.view", "hr.payroll.process"] });
    const dlg = await open();
    await within(dlg).findByText("E-1");
    expect(within(dlg).queryByRole("button", { name: "Approve" })).toBeNull();
    await userEvent.setup().click(within(dlg).getByRole("button", { name: "Submit for approval" }));
    await waitFor(() => expect(action).toBe("submit"));
  });

  it("approver approves or sends back with a note; self-approval refusal is shown", async () => {
    setup(run({ status: "PENDING_APPROVAL" }));
    server.use(http.post("*/api/v1/hr/payroll/runs/p1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you cannot approve a run you prepared." } }, { status: 403 })));
    renderWithProviders(<PayrollPage />, { permissions: ["hr.payroll.view", "hr.payroll.approve"] });
    const user = userEvent.setup();
    const dlg = await open();
    await user.click(await within(dlg).findByRole("button", { name: "Send back" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/note is required/);
    await user.click(within(dlg).getByRole("button", { name: "Approve" }));
    expect(await within(dlg).findByText(/Separation of duties/)).toBeInTheDocument();
  });

  it("workflow-governed runs point to the approval inbox instead of offering approve", async () => {
    setup(run({ status: "PENDING_APPROVAL", workflow_instance_id: "w1" }));
    renderWithProviders(<PayrollPage />, { permissions: ALL });
    const dlg = await open();
    expect(await within(dlg).findByText(/approval inbox/)).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("posts approved runs and pays posted runs only with the right permission", async () => {
    let action = ""; let body: any = null;
    setup(run({ status: "APPROVED" }));
    server.use(http.post("*/api/v1/hr/payroll/runs/p1/:a", async ({ params, request }) => { action = String(params.a); body = await request.json(); return HttpResponse.json(run({ status: "POSTED" })); }));
    const view = renderWithProviders(<PayrollPage />, { permissions: ALL });
    const user = userEvent.setup();
    let dlg = await open();
    await user.click(await within(dlg).findByRole("button", { name: "Post to ledger" }));
    await waitFor(() => expect(action).toBe("post"));
    view.unmount();
    setup(run({ status: "POSTED" }));
    renderWithProviders(<PayrollPage />, { permissions: ["hr.payroll.view", "hr.payroll.process"] });
    dlg = await open();
    await within(dlg).findByText("E-1");
    expect(within(dlg).queryByRole("button", { name: "Record payment" })).toBeNull();
    expect(body).toEqual({});
  });
});

describe("PayslipsPage", () => {
  it("lists my payslips and opens the breakdown", async () => {
    server.use(http.get("*/api/v1/hr/me/payslips", () => HttpResponse.json({ results: [slip({ lines: [{ code: "BASIC", name: "Basic salary", kind: "EARNING", amount: "1000.00" }] })] })));
    renderWithProviders(<PayslipsPage />, { permissions: ["hr.self"] });
    await userEvent.setup().click(await screen.findByRole("button", { name: "View payslip" }));
    const dlg = await screen.findByRole("dialog", { name: /Payslip/ });
    expect(within(dlg).getByText("Basic salary")).toBeInTheDocument();
    expect(within(dlg).getByText("Net pay")).toBeInTheDocument();
  });
});

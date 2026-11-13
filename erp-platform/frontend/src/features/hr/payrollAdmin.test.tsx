import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { CompensationPage, firstOfMonth, validateLoan } from "./CompensationPage";
import { PaySetupPage, validateBrackets } from "./PaySetupPage";
import { PayrollPage, csvCell, toCsv } from "./PayrollPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE" }] }))); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

describe("pure helpers", () => {
  it("validates brackets", () => {
    expect(validateBrackets([])).toMatch(/at least one/);
    expect(validateBrackets([{ lower_bound: "100", rate: "0" }])).toMatch(/start at 0/);
    expect(validateBrackets([{ lower_bound: "0", rate: "0" }, { lower_bound: "0", rate: "10" }])).toMatch(/must rise/);
    expect(validateBrackets([{ lower_bound: "0", rate: "101" }])).toMatch(/between 0 and 100/);
    expect(validateBrackets([{ lower_bound: "0", rate: "0" }, { lower_bound: "600", rate: "10" }])).toBeNull();
  });
  it("validates loans and months", () => {
    expect(validateLoan({ principal: "0", installments: "3", start: "2026-12" })).toMatch(/more than 0/);
    expect(validateLoan({ principal: "100", installments: "61", start: "2026-12" })).toMatch(/1 to 60/);
    expect(validateLoan({ principal: "100", installments: "1.5", start: "2026-12" })).toMatch(/whole number/);
    expect(validateLoan({ principal: "100", installments: "3", start: "" })).toMatch(/month/);
    expect(validateLoan({ principal: "100", installments: "3", start: "2026-12" })).toBeNull();
    expect(firstOfMonth("2026-12-15")).toBe("2026-12-01");
  });
  it("makes safe CSV", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(toCsv(["a", "b"], [["1", "-5"]])).toBe("a,b\n1,'-5");
  });
});

describe("PaySetupPage", () => {
  it("creates a component", async () => {
    let body: any = null;
    server.use(http.get("*/api/v1/hr/payroll/components", () => HttpResponse.json([{ id: "c1", code: "TRN", name: "Transport", kind: "ALLOWANCE", calc: "FIXED", value: "500.00", taxable: false, is_active: true }])),
      http.post("*/api/v1/hr/payroll/components", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<PaySetupPage />, { permissions: ["hr.compensation.view", "hr.compensation.manage"] });
    const user = userEvent.setup();
    expect(await screen.findByText("Transport")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New component" }));
    const dlg = await screen.findByRole("dialog", { name: "New pay component" });
    await user.type(within(dlg).getByLabelText("Code"), "mea");
    await user.type(within(dlg).getByLabelText("Name"), "Meal");
    await user.selectOptions(within(dlg).getByLabelText("Kind"), "ALLOWANCE");
    await user.selectOptions(within(dlg).getByLabelText("Calculation"), "PERCENT_OF_BASIC");
    await user.type(within(dlg).getByLabelText("Value"), "5");
    await user.selectOptions(within(dlg).getByLabelText("Taxable"), "yes");
    await user.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(body).toEqual({ code: "MEA", name: "Meal", kind: "ALLOWANCE", calc: "PERCENT_OF_BASIC", value: "5", taxable: true }));
  });
  it("edits tax brackets: refuses invalid ones, saves valid ones, read-only without manage", async () => {
    let body: any = null;
    server.use(http.get("*/api/v1/hr/payroll/tax-brackets", () => HttpResponse.json([{ lower_bound: "0", rate: "0" }, { lower_bound: "600", rate: "10" }])),
      http.put("*/api/v1/hr/payroll/tax-brackets", async ({ request }) => { body = await request.json(); return HttpResponse.json(body.brackets); }));
    const v = renderWithProviders(<PaySetupPage />, { permissions: ["hr.compensation.view", "hr.compensation.manage"] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Tax brackets" }));
    const from2 = await screen.findByLabelText("Bracket 2 from");
    await user.clear(from2); await user.type(from2, "0");
    await user.click(screen.getByRole("button", { name: "Save brackets" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/must rise/);
    await user.clear(from2); await user.type(from2, "700");
    await user.click(screen.getByRole("button", { name: "Save brackets" }));
    await waitFor(() => expect(body).toEqual({ brackets: [{ lower_bound: "0", rate: "0" }, { lower_bound: "700", rate: "10" }] }));
    v.unmount();
    renderWithProviders(<PaySetupPage />, { permissions: ["hr.compensation.view"] });
    await userEvent.setup().click(screen.getByRole("tab", { name: "Tax brackets" }));
    expect(await screen.findByLabelText("Bracket 1 from")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save brackets" })).toBeNull();
  });
});

describe("CompensationPage", () => {
  it("requests a salary revision and approves another", async () => {
    let body: any = null; let acted = "";
    server.use(http.get("*/api/v1/hr/compensation/revisions", () => HttpResponse.json({ results: [{ id: "r1", employee: "e1", employee_no: "E-1", effective_date: "2027-01-01", old_salary: "20000", new_salary: "24000", reason: "Merit", status: "PENDING", requested_by: "u1", decided_by: null, decision_note: "" }] })),
      http.post("*/api/v1/hr/compensation/revisions", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }),
      http.post("*/api/v1/hr/compensation/revisions/r1/:a", ({ params }) => { acted = String(params.a); return HttpResponse.json({}); }));
    renderWithProviders(<CompensationPage />, { permissions: ["hr.self", "hr.compensation.view", "hr.compensation.manage"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(acted).toBe("approve"));
    await user.click(screen.getByRole("button", { name: "Request revision" }));
    const dlg = await screen.findByRole("dialog", { name: "Request salary revision" });
    await user.click(within(dlg).getByRole("button", { name: "Submit revision" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/Choose the employee/);
    await within(dlg).findByRole("option", { name: /Abel/ });
    await user.selectOptions(within(dlg).getByLabelText("Employee"), "e1");
    fireEvent.change(within(dlg).getByLabelText("Effective date"), { target: { value: "2027-02-01" } });
    await user.type(within(dlg).getByLabelText("New monthly salary"), "0");
    await user.type(within(dlg).getByLabelText("Reason"), "Promotion");
    await user.click(within(dlg).getByRole("button", { name: "Submit revision" }));
    expect(await within(dlg).findByText(/more than 0/)).toBeInTheDocument();
    await user.clear(within(dlg).getByLabelText("New monthly salary")); await user.type(within(dlg).getByLabelText("New monthly salary"), "26000");
    await user.click(within(dlg).getByRole("button", { name: "Submit revision" }));
    await waitFor(() => expect(body).toEqual({ employee: "e1", effective_date: "2027-02-01", new_salary: "26000", reason: "Promotion" }));
  });
  it("shows only loans to an ordinary employee, who requests a loan for themselves", async () => {
    let body: any = null;
    server.use(http.get("*/api/v1/hr/loans", () => HttpResponse.json({ results: [] })), http.post("*/api/v1/hr/loans", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<CompensationPage />, { permissions: ["hr.self"] });
    const user = userEvent.setup();
    expect(screen.queryByRole("tab", { name: "Salary revisions" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Request a loan" }));
    const dlg = await screen.findByRole("dialog", { name: "Request a loan" });
    expect(within(dlg).queryByLabelText("Employee")).toBeNull();
    await user.selectOptions(within(dlg).getByLabelText("Kind"), "ADVANCE");
    await user.type(within(dlg).getByLabelText("Amount"), "5000");
    await user.type(within(dlg).getByLabelText("Installments (1–60)"), "5");
    fireEvent.change(within(dlg).getByLabelText("First deduction month"), { target: { value: "2026-12" } });
    await user.click(within(dlg).getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(body).toEqual({ kind: "ADVANCE", principal: "5000", installments: 5, start_month: "2026-12-01", reason: "" }));
  });
  it("loan approvals are only for compensation managers; the approver of a payroll input needs hr.payroll.approve", async () => {
    server.use(http.get("*/api/v1/hr/payroll/inputs", () => HttpResponse.json({ results: [{ id: "i1", employee: "e1", employee_no: "E-1", kind: "BONUS", month: "2026-12-01", amount: "1000", taxable: true, description: "Q4", status: "PENDING", consumed_by_run: null }] })));
    renderWithProviders(<CompensationPage />, { permissions: ["hr.self", "hr.payroll.view", "hr.compensation.manage"] });
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Variable pay" }));
    await screen.findByText("Q4");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});

describe("PayrollPage extras", () => {
  const run = { id: "p1", number: "PR-1", period_start: "2026-10-01", period_end: "2026-10-31", status: "POSTED", gross_total: "1000", tax_total: "100", pension_employee_total: "70", pension_employer_total: "110", deduction_total: "0", net_total: "830", created_by: "u1", approved_by: "u2", workflow_instance_id: null, version: 1 };
  const setup = () => server.use(http.get("*/api/v1/hr/payroll/runs", () => HttpResponse.json({ results: [run] })), http.get("*/api/v1/hr/payroll/runs/p1", () => HttpResponse.json({ ...run, payslips: [] })));
  it("shows payment instructions with exceptions, and reverses with a reason", async () => {
    let body: any = null;
    setup();
    server.use(http.get("*/api/v1/hr/payroll/runs/p1/payment-instructions", () => HttpResponse.json({ number: "PR-1", total: "830.00", payments: [{ employee_no: "E-1", name: "Abel", bank_account: "123", amount: "830.00", reference: "PR-1" }], missing_bank_account: ["E-7"] })),
      http.post("*/api/v1/hr/payroll/runs/p1/reverse", async ({ request }) => { body = await request.json(); return HttpResponse.json({ ...run, status: "CANCELLED" }); }));
    renderWithProviders(<PayrollPage />, { permissions: ["hr.payroll.view", "hr.payroll.pay"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "PR-1" }));
    const dlg = await screen.findByRole("dialog", { name: /Payroll PR-1/ });
    await user.click(await within(dlg).findByRole("button", { name: "Payment instructions" }));
    expect(await within(dlg).findByText(/E-7/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Reverse run" }));
    const rd = await screen.findByRole("dialog", { name: "Reverse payroll run" });
    await user.click(within(rd).getByRole("button", { name: "Reverse run" }));
    expect(await within(rd).findByRole("alert")).toHaveTextContent(/Reason \(required\) is required/);
    await user.type(within(rd).getByLabelText(/Reason/), "Wrong period");
    await user.click(within(rd).getByRole("button", { name: "Reverse run" }));
    await waitFor(() => expect(body).toEqual({ reason: "Wrong period" }));
  });
  it("hides payment instructions and reversal without hr.payroll.pay", async () => {
    setup();
    renderWithProviders(<PayrollPage />, { permissions: ["hr.payroll.view"] });
    await userEvent.setup().click(await screen.findByRole("button", { name: "PR-1" }));
    const dlg = await screen.findByRole("dialog", { name: /Payroll PR-1/ });
    await within(dlg).findByRole("button", { name: "Payroll register" });
    expect(within(dlg).queryByRole("button", { name: "Payment instructions" })).toBeNull();
    expect(within(dlg).queryByRole("button", { name: "Reverse run" })).toBeNull();
  });
});

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { OrderTools, amendmentProblem, invoiceLinesProblem, milestonesProblem } from "./OrderTools";
import { CustomerStatementPage, statementProblem } from "./StatementPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const order = { id: "o1", number: "SO-1", account: "a1", currency: "USD", order_date: "2026-11-01", status: "PARTIALLY_DELIVERED", subtotal: "100", tax_total: "0", total: "100", approval_required: false, workflow_instance_id: null, version: 1, hold_reason: "", lines: [] } as never;
const OUT = [{ line: "l1", line_no: 1, description: "Widget", ordered: "10.0000", delivered: "6.0000", returned: "0", invoiced: "2.0000", to_deliver: "4.0000", to_invoice: "4.0000", reserved: "0", backordered: "0" }];
const AM = (o = {}) => ({ id: "am1", order: "o1", status: "PENDING", reason: "Customer wants more", changes: { quantities: { l1: "12" }, add: [] }, total_before: "100", total_after: null, requested_by: "u1", decided_by: null, decision_note: "", ...o });
const MS = (o = {}) => ({ id: "m1", description: "Deposit", percent: "30.00", due_date: null, invoice: null, ...o });
const base = (amends: object[] = [], plan: object[] = []) => [
  http.get("*/api/v1/sales/orders/o1/outstanding", () => HttpResponse.json(OUT)),
  http.get("*/api/v1/sales/orders/o1/amendments", () => HttpResponse.json(amends)),
  http.get("*/api/v1/sales/orders/o1/milestones", () => HttpResponse.json(plan)),
  http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E1", name: "Abel", status: "ACTIVE", user_id: "u1" }] })),
];
const ALL = ["sales.view", "sales.order.create", "sales.order.approve", "sales.invoice.create"];

describe("helpers", () => {
  const rows = OUT as never;
  it("checks invoice quantities", () => {
    expect(invoiceLinesProblem(rows, { l1: "4" })).toBeNull();
    expect(invoiceLinesProblem(rows, { l1: "5" })).toMatch(/only 4/);
    expect(invoiceLinesProblem(rows, { l1: "" })).toMatch(/at least one/);
    expect(invoiceLinesProblem(rows, { l1: "x" })).toMatch(/enter a number/);
  });
  it("checks amendments", () => {
    expect(amendmentProblem(rows, { l1: "12" }, null, "", "more")).toBeNull();
    expect(amendmentProblem(rows, { l1: "5" }, null, "", "less")).toMatch(/cannot go below/);
    expect(amendmentProblem(rows, { l1: "10" }, null, "", "x")).toMatch(/at least one/);
    expect(amendmentProblem(rows, { l1: "12" }, null, "", " ")).toMatch(/reason/);
    expect(amendmentProblem(rows, { l1: "10" }, "p9", "0", "x")).toMatch(/quantity above 0/);
  });
  it("checks the billing plan totals exactly 100", () => {
    expect(milestonesProblem([{ description: "A", percent: "30" }, { description: "B", percent: "70" }])).toBeNull();
    expect(milestonesProblem([{ description: "A", percent: "33.33" }, { description: "B", percent: "33.33" }, { description: "C", percent: "33.33" }])).toMatch(/exactly 100/);
    expect(milestonesProblem([])).toMatch(/at least one/);
    expect(milestonesProblem([{ description: "", percent: "100" }])).toMatch(/describe/);
    expect(statementProblem("", "2026-01-01", "2026-02-01")).toMatch(/customer/);
    expect(statementProblem("a", "2026-03-01", "2026-02-01")).toMatch(/after/);
    expect(statementProblem("a", "2026-01-01", "2026-02-01")).toBeNull();
  });
});

describe("OrderTools", () => {
  it("renders nothing for a draft order", () => {
    const { container } = renderWithProviders(<OrderTools order={{ ...(order as object), status: "DRAFT" } as never} />, { permissions: ALL });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows what is left and invoices part of an order", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(...base(), http.post("*/api/v1/sales/orders/o1/invoice", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "i1" }, { status: 201 }); }));
    renderWithProviders(<OrderTools order={order} />, { permissions: ALL });
    expect(await screen.findByText("1. Widget")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Invoice part of the order" }));
    const f = await screen.findByLabelText(/Line 1: Widget/);
    await userEvent.clear(f); await userEvent.type(f, "9");
    await userEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    expect(await screen.findByText(/only .* can still be invoiced/)).toBeInTheDocument();
    await userEvent.clear(f); await userEvent.type(f, "3");
    await userEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() => expect(body).toEqual({ lines: [{ order_line: "l1", quantity: "3" }] }));
  });

  it("hides invoicing without permission", async () => {
    server.use(...base());
    renderWithProviders(<OrderTools order={order} />, { permissions: ["sales.view"] });
    await screen.findByText("1. Widget");
    expect(screen.queryByRole("button", { name: "Invoice part of the order" })).toBeNull();
  });

  it("requests a change and sends it for approval", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(...base(), http.post("*/api/v1/sales/orders/o1/amendments", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(AM(), { status: 201 }); }));
    renderWithProviders(<OrderTools order={order} />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("tab", { name: "Changes" }));
    await userEvent.click(await screen.findByRole("button", { name: "Request a change" }));
    await userEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    expect(await screen.findByText(/Change at least one quantity/)).toBeInTheDocument();
    const q = screen.getByLabelText(/Line 1: Widget/);
    await userEvent.clear(q); await userEvent.type(q, "12");
    await userEvent.type(screen.getByLabelText("Reason"), "Customer wants more");
    await userEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    await waitFor(() => expect(body).toEqual({ quantities: { l1: "12" }, add: [], reason: "Customer wants more" }));
  });

  it("approves a pending change and shows a separation-of-duties refusal", async () => {
    server.use(...base([AM()]), http.post("*/api/v1/sales/amendments/am1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve your own request." } }, { status: 403 })));
    renderWithProviders(<OrderTools order={order} />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("tab", { name: "Changes" }));
    expect(await screen.findByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.getByText(/Asked by E1 Abel|Asked by Abel/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve change" }));
    expect(await screen.findByText("You cannot approve your own request.")).toBeInTheDocument();
  });

  it("rejects a change only with a reason, and approvers only see the buttons with permission", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(...base([AM()]), http.post("*/api/v1/sales/amendments/am1/reject", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(AM({ status: "REJECTED" })); }));
    renderWithProviders(<OrderTools order={order} />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("tab", { name: "Changes" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reject change" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1)!);
    expect(await screen.findByText("Why is required.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Why/), "Too late");
    await userEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1)!);
    await waitFor(() => expect(body).toEqual({ note: "Too late" }));
  });

  it("sets a billing plan, refusing percentages that do not total 100", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(...base(), http.put("*/api/v1/sales/orders/o1/milestones", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json([MS()]); }));
    renderWithProviders(<OrderTools order={order} />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("tab", { name: "Billing plan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Set billing plan" }));
    await userEvent.type(screen.getByLabelText("Step 1"), "Deposit");
    await userEvent.type(screen.getByLabelText("Percent"), "30");
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect(await screen.findByText(/exactly 100/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getByLabelText("Step 2"), "On delivery");
    await userEvent.type(screen.getAllByLabelText("Percent")[1]!, "70");
    fireEvent.change(screen.getAllByLabelText("Due")[1]!, { target: { value: "2026-12-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(body).toEqual({ milestones: [{ description: "Deposit", percent: "30" }, { description: "On delivery", percent: "70", due_date: "2026-12-01" }] }));
  });

  it("invoices a plan step, and shows invoiced steps without a button", async () => {
    let hit = false;
    server.use(...base([], [MS(), MS({ id: "m2", description: "Final", percent: "70.00", invoice: "i9" })]), http.post("*/api/v1/sales/milestones/m1/invoice", () => { hit = true; return HttpResponse.json({ id: "i1" }, { status: 201 }); }));
    renderWithProviders(<OrderTools order={order} />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("tab", { name: "Billing plan" }));
    expect(await screen.findByText("Invoiced")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invoice step Final" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change billing plan" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Invoice step Deposit" }));
    await waitFor(() => expect(hit).toBe(true));
  });
});

describe("CustomerStatementPage", () => {
  const CREDIT = { credit_status: "OK", credit_limit: "1000", receivables: "200", open_orders: "300", exposure: "500", available_credit: "500" };
  const ST = { account: "a1", customer: "Acme", currency: "USD", from: "2026-01-01", to: "2026-11-21", opening_balance: "0", closing_balance: "150", lines: [{ date: "2026-02-01", type: "INVOICE", reference: "INV-1", amount: "200", balance: "200", due: "2026-03-01" }, { date: "2026-03-01", type: "PAYMENT", reference: "PAY-1", amount: "-50", balance: "150", due: null }] };
  const open = (extra: Parameters<typeof server.use> = []) => {
    server.use(http.get("*/api/v1/crm/accounts", () => page([{ id: "a1", name: "Acme" }])), http.get("*/api/v1/sales/accounts/a1/credit", () => HttpResponse.json(CREDIT)), ...extra);
    return renderWithProviders(<CustomerStatementPage />, { permissions: ["sales.view"] });
  };

  it("requires a customer and a sensible date range", async () => {
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Show statement" }));
    expect(await screen.findByText("Choose a customer.")).toBeInTheDocument();
    await screen.findByRole("option", { name: "Acme" });
    await userEvent.selectOptions(screen.getByLabelText("Customer"), "a1");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-12-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Show statement" }));
    expect(await screen.findByText("The start date is after the end date.")).toBeInTheDocument();
  });

  it("shows the statement and the credit position", async () => {
    let url = "";
    open([http.get("*/api/v1/sales/accounts/a1/statement", ({ request }) => { url = request.url; return HttpResponse.json(ST); })]);
    await screen.findByRole("option", { name: "Acme" });
    await userEvent.selectOptions(screen.getByLabelText("Customer"), "a1");
    await userEvent.type(screen.getByLabelText("Currency (optional)"), "usd");
    await userEvent.click(screen.getByRole("button", { name: "Show statement" }));
    expect(await screen.findByText("INV-1")).toBeInTheDocument();
    expect(screen.getByText(/Statement for Acme \(USD\)/)).toBeInTheDocument();
    expect(await screen.findByText("Credit position")).toBeInTheDocument();
    expect(screen.getByText("Still available")).toBeInTheDocument();
    expect(url).toContain("currency=USD");
  });
});

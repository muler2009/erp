import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ReturnsPage, needsQuarantine, returnLines, returnable } from "./ReturnsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const rr = (o = {}) => ({ id: "r1", number: "RR-1", order: "o1", status: "PENDING", reason: "Cracked", reason_code: "DAMAGED", wants_replacement: false, requested_by: "u1", decided_by: null, decision_note: "", sales_return: null, replacement_order: null, lines: [{ order_line: "ol1", quantity: "2.0000", disposition: "RESTOCK" }], ...o });
const order = { id: "o1", number: "SO-1", account: "a1", currency: "USD", order_date: "2026-11-01", status: "DELIVERED", subtotal: "100", tax_total: "0", total: "100", approval_required: false, workflow_instance_id: null, version: 1, hold_reason: "",
  lines: [{ id: "ol1", line_no: 1, product: "p1", description: "Widget", quantity: "10.0000", unit_price: "10", discount_percent: "0", net_unit_price: "10", line_total: "100", tax_amount: "0", delivered_quantity: "10.0000", returned_quantity: "3.0000", invoiced_quantity: "0" }] };
const REPORT = { total: 2, by_status: { PENDING: 1, RECEIVED: 1 }, by_reason: { DAMAGED: 2 }, received_by_disposition: { RESTOCK: "2.0000" } };
const base = [
  http.get("*/api/v1/sales/orders", () => page([order])), http.get("*/api/v1/sales/orders/o1", () => HttpResponse.json(order)),
  http.get("*/api/v1/sales/return-requests/report", () => HttpResponse.json(REPORT)), http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] })),
  http.get("*/api/v1/inventory/warehouses", () => page([{ id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "", address: "", locations: [{ id: "loc1", code: "A1", kind: "", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }, { id: "loc2", code: "Q1", kind: "", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] }])),
];
const list = (rows: object[]) => http.get("*/api/v1/sales/return-requests", () => page(rows));

describe("helpers", () => {
  it("works out what can be returned and validates lines", () => {
    expect(returnable({ delivered_quantity: "10", returned_quantity: "3" })).toBe(7);
    expect(returnable({})).toBe(0);
    expect(needsQuarantine(rr({ lines: [{ order_line: "x", quantity: "1", disposition: "QUARANTINE" }] }) as never)).toBe(true);
    const o = order as never;
    expect(returnLines(o, { ol1: "2" }, {})).toEqual({ lines: [{ order_line: "ol1", quantity: "2", disposition: "RESTOCK" }] });
    expect(returnLines(o, { ol1: "8" }, {})).toEqual({ problem: "Widget: only 7 can still be returned." });
    expect(returnLines(o, { ol1: "-1" }, {})).toMatchObject({ problem: expect.stringMatching(/must be a number/) });
    expect(returnLines(o, {}, {})).toEqual({ problem: "Enter a quantity for at least one item." });
    expect(returnLines(o, { ol1: "1" }, { ol1: "DISPOSE" })).toEqual({ lines: [{ order_line: "ol1", quantity: "1", disposition: "DISPOSE" }] });
  });
});

describe("ReturnsPage", () => {
  it("lists requests with the report, and a viewer has no request button", async () => {
    server.use(...base, list([rr()]));
    renderWithProviders(<ReturnsPage />, { permissions: ["sales.view"] });
    expect(await screen.findByRole("button", { name: "RR-1" })).toBeInTheDocument();
    expect(await screen.findByText("SO-1")).toBeInTheDocument();
    expect(await screen.findByText("Damaged: 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request a return" })).toBeNull();
  });

  it("filters by status", async () => {
    let status = "";
    server.use(...base, http.get("*/api/v1/sales/return-requests", ({ request }) => { status = new URL(request.url).searchParams.get("status") ?? ""; return page([]); }));
    renderWithProviders(<ReturnsPage />, { permissions: ["sales.view"] });
    await screen.findByText("No return requests");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "APPROVED");
    await waitFor(() => expect(status).toBe("APPROVED"));
  });

  it("requests a return with a disposition, refusing more than can be returned", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(...base, list([]), http.post("*/api/v1/sales/return-requests", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(rr(), { status: 201 }); }));
    renderWithProviders(<ReturnsPage />, { permissions: ["sales.view", "sales.order.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "Request a return" }));
    const d = within(await screen.findByRole("dialog", { name: "Request a return" }));
    await userEvent.click(d.getByRole("button", { name: "Send request" }));
    expect(await d.findByText("Choose the order the goods came from.")).toBeInTheDocument();
    await d.findByRole("option", { name: "SO-1" });
    await userEvent.selectOptions(d.getByLabelText("Order"), "o1");
    await userEvent.type(await d.findByLabelText("Return quantity of Widget"), "9");
    await userEvent.click(d.getByRole("button", { name: "Send request" }));
    expect(await d.findByText("Widget: only 7 can still be returned.")).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Return quantity of Widget"));
    await userEvent.type(d.getByLabelText("Return quantity of Widget"), "2");
    await userEvent.selectOptions(d.getByLabelText("Disposition of Widget"), "QUARANTINE");
    await userEvent.click(d.getByRole("button", { name: "Send request" }));
    expect(await d.findByText("Choose a reason.")).toBeInTheDocument();
    await userEvent.selectOptions(d.getByLabelText("Reason"), "DAMAGED");
    await userEvent.type(d.getByLabelText("What is wrong"), "Cracked");
    await userEvent.click(d.getByLabelText("The customer wants a free replacement"));
    await userEvent.click(d.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(body).toEqual({ order: "o1", reason: "Cracked", reason_code: "DAMAGED", replacement: true, lines: [{ order_line: "ol1", quantity: "2", disposition: "QUARANTINE" }] }));
  });

  it("shows server refusals, e.g. the return window", async () => {
    server.use(...base, list([]), http.post("*/api/v1/sales/return-requests", () => HttpResponse.json({ error: { code: "return_window_expired", message: "The 30-day return window has passed; ask a sales manager." } }, { status: 409 })));
    renderWithProviders(<ReturnsPage />, { permissions: ["sales.view", "sales.order.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "Request a return" }));
    const d = within(await screen.findByRole("dialog", { name: "Request a return" }));
    await d.findByRole("option", { name: "SO-1" });
    await userEvent.selectOptions(d.getByLabelText("Order"), "o1");
    await userEvent.type(await d.findByLabelText("Return quantity of Widget"), "1");
    await userEvent.selectOptions(d.getByLabelText("Reason"), "OTHER");
    await userEvent.type(d.getByLabelText("What is wrong"), "x");
    await userEvent.click(d.getByRole("button", { name: "Send request" }));
    expect(await d.findByText(/return window has passed/)).toBeInTheDocument();
  });
});

describe("a return request in detail", () => {
  const open = async (perms: string[], row = rr()) => {
    server.use(...base, list([row]), http.get("*/api/v1/sales/return-requests/r1", () => HttpResponse.json(row)));
    renderWithProviders(<ReturnsPage />, { permissions: perms });
    await userEvent.click(await screen.findByRole("button", { name: "RR-1" }));
    return within(await screen.findByRole("dialog", { name: "Return RR-1" }));
  };

  it("a manager approves, and rejecting needs a reason", async () => {
    let approved: unknown = null; let rejected: unknown = null;
    const d = await open(["sales.view", "sales.order.approve"]);
    server.use(http.post("*/api/v1/sales/return-requests/r1/approve", async ({ request }) => { approved = await request.json(); return HttpResponse.json(rr({ status: "APPROVED" })); }),
      http.post("*/api/v1/sales/return-requests/r1/reject", async ({ request }) => { rejected = await request.json(); return HttpResponse.json(rr({ status: "REJECTED" })); }));
    expect(await d.findByText("Abel")).toBeInTheDocument();
    expect(d.queryByRole("button", { name: "Receive goods" })).toBeNull();
    await userEvent.click(d.getByRole("button", { name: "Reject" }));
    const rj = within(await screen.findByRole("dialog", { name: "Reject return" }));
    await userEvent.click(rj.getByRole("button", { name: "Reject" }));
    expect(await rj.findByText("Why is it rejected? is required.")).toBeInTheDocument();
    await userEvent.type(rj.getByLabelText("Why is it rejected?"), "Outside policy");
    await userEvent.click(rj.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(rejected).toEqual({ note: "Outside policy" }));
    expect(approved).toBeNull();
  });

  it("shows the separation-of-duties refusal when approving your own request", async () => {
    const d = await open(["sales.view", "sales.order.approve"]);
    server.use(http.post("*/api/v1/sales/return-requests/r1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot decide a return request you raised." } }, { status: 403 })));
    await userEvent.click(d.getByRole("button", { name: "Approve" }));
    const a = within(await screen.findByRole("dialog", { name: "Approve return" }));
    await userEvent.click(a.getByRole("button", { name: "Approve" }));
    expect(await a.findByText("You cannot decide a return request you raised.")).toBeInTheDocument();
  });

  it("warehouse receives an approved return, asking for a quarantine location only when needed", async () => {
    let body: Record<string, unknown> | null = null;
    const row = rr({ status: "APPROVED", lines: [{ order_line: "ol1", quantity: "2.0000", disposition: "QUARANTINE" }] });
    const d = await open(["sales.view", "sales.delivery.manage"], row);
    server.use(http.post("*/api/v1/sales/return-requests/r1/receive", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(rr({ status: "RECEIVED" })); }));
    expect(d.queryByRole("button", { name: "Approve" })).toBeNull();
    await userEvent.click(d.getByRole("button", { name: "Receive goods" }));
    const r = within(await screen.findByRole("dialog", { name: "Receive goods for RR-1" }));
    await r.findAllByRole("option", { name: "MAIN / A1" });
    await userEvent.selectOptions(r.getByLabelText("Put back into"), "loc1");
    await userEvent.click(r.getByRole("button", { name: "Receive goods" }));
    expect(await r.findByText("Hold for inspection in is required.")).toBeInTheDocument();
    await userEvent.selectOptions(r.getByLabelText("Hold for inspection in"), "loc2");
    fireEvent.change(r.getByLabelText("Date received"), { target: { value: "2026-11-17" } });
    await userEvent.click(r.getByRole("button", { name: "Receive goods" }));
    await waitFor(() => expect(body).toEqual({ location: "loc1", quarantine_location: "loc2", return_date: "2026-11-17" }));
  });

  it("the requester can cancel a pending request", async () => {
    let called = 0;
    const d = await open(["sales.view", "sales.order.create"]);
    server.use(http.post("*/api/v1/sales/return-requests/r1/cancel", () => { called += 1; return HttpResponse.json(rr({ status: "CANCELLED" })); }));
    await userEvent.click(d.getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(called).toBe(1));
  });
});

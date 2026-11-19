import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { BlanketOrdersPage, blanketProblem, releaseLines } from "./BlanketOrdersPage";
import { PoExtras, amendmentLines, scheduleProblem } from "./PoExtras";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const LINE = { id: "l1", line_no: 1, product: "p1", description: "Widget", quantity: "10.0000", unit_price: "5.0000", received_quantity: "4.0000", released_quantity: "0.0000", schedule: [] };
const po = (o = {}) => ({ id: "o1", number: "PO-1", supplier: { id: "s1", name: "Globex" }, currency: "USD", status: "APPROVED", order_date: "2026-03-15", expected_date: null, total: "50.00", invoiced_value: "0", version: 1, workflow_instance_id: null, kind: "STANDARD", payment_terms: "Net 30", delivery_terms: "", delivery_address: "", acknowledged_at: null, acknowledgment_ref: "", promised_date: null, closed_reason: "", lines: [LINE], ...o });
const AMENDS = (rows: object[] = []) => http.get("*/api/v1/procurement/purchase-orders/o1/amendments", () => HttpResponse.json({ results: rows }));
const ALL = ["procurement.view", "procurement.purchase_order.create", "procurement.purchase_order.approve"];

describe("helpers", () => {
  const lines = [LINE];
  it("amendmentLines keeps only real changes and enforces the receipt rules", () => {
    expect(amendmentLines(lines, {})).toEqual({ lines: [] });
    expect(amendmentLines(lines, { l1: { quantity: "20", unit_price: "" } })).toEqual({ lines: [{ line: "l1", quantity: "20", unit_price: "5" }] });
    expect(amendmentLines(lines, { l1: { quantity: "10", unit_price: "5" } })).toEqual({ lines: [] });
    expect(amendmentLines(lines, { l1: { quantity: "3", unit_price: "" } })).toMatchObject({ problem: expect.stringMatching(/already received/) });
    expect(amendmentLines(lines, { l1: { quantity: "", unit_price: "6" } })).toMatchObject({ problem: expect.stringMatching(/price cannot change/) });
    expect(amendmentLines(lines, { l1: { quantity: "x", unit_price: "" } })).toMatchObject({ problem: expect.stringMatching(/numbers/) });
  });
  it("scheduleProblem", () => {
    expect(scheduleProblem("10", [{ due_date: "2026-04-01", quantity: "4" }, { due_date: "2026-05-01", quantity: "6" }])).toBeNull();
    expect(scheduleProblem("10", [{ due_date: "", quantity: "4" }])).toMatch(/date/);
    expect(scheduleProblem("10", [{ due_date: "2026-04-01", quantity: "0" }])).toMatch(/above zero/);
    expect(scheduleProblem("10", [{ due_date: "2026-04-01", quantity: "11" }])).toMatch(/more than the 10/);
  });
  it("blanketProblem and releaseLines", () => {
    const ok = { supplier: "s", currency: "usd", order_date: "2026-01-01", valid_to: "2026-06-01" };
    expect(blanketProblem(ok, [{ product: "p", quantity: "100", unit_price: "8" }])).toBeNull();
    expect(blanketProblem({ ...ok, valid_to: "2025-01-01" }, [])).toMatch(/cannot end/);
    expect(blanketProblem(ok, [])).toMatch(/at least one/);
    expect(blanketProblem(ok, [{ product: "p", quantity: "0", unit_price: "8" }])).toMatch(/above zero/);
    const o = po({ kind: "BLANKET", lines: [{ ...LINE, quantity: "100", released_quantity: "70" }] }) as never;
    expect(releaseLines(o, { l1: "31" })).toMatchObject({ problem: expect.stringMatching(/only 30/) });
    expect(releaseLines(o, { l1: "" })).toMatchObject({ problem: expect.stringMatching(/at least one/) });
    expect(releaseLines(o, { l1: "30" })).toEqual({ lines: [{ blanket_line: "l1", quantity: "30" }] });
  });
});

describe("PoExtras", () => {
  it("records the supplier's acknowledgement", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(AMENDS(), http.post("*/api/v1/procurement/purchase-orders/o1/acknowledge", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}); }));
    renderWithProviders(<PoExtras order={po() as never} />, { permissions: ALL });
    expect(screen.getByText(/has not confirmed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record acknowledgement" }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText("Supplier's reference"), "ACK-77");
    fireEvent.change(within(d).getByLabelText(/Date the supplier promised/), { target: { value: "2026-04-01" } });
    await userEvent.click(within(d).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(body).toEqual({ reference: "ACK-77", promised_date: "2026-04-01" }));
  });
  it("shows an acknowledged order and hides editing without permission", async () => {
    server.use(AMENDS());
    renderWithProviders(<PoExtras order={po({ acknowledged_at: "2026-03-16T10:00:00Z", acknowledgment_ref: "ACK-1", promised_date: "2026-04-02" }) as never} />, { permissions: ["procurement.view"] });
    expect(screen.getByText(/Acknowledged as ACK-1, promised for 2026-04-02/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("edits terms on a draft only", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.patch("*/api/v1/procurement/purchase-orders/o1/terms", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}); }));
    const { unmount } = renderWithProviders(<PoExtras order={po({ status: "DRAFT" }) as never} />, { permissions: ALL });
    await userEvent.click(screen.getByRole("button", { name: "Edit terms" }));
    const d = await screen.findByRole("dialog");
    await userEvent.clear(within(d).getByLabelText("Payment terms"));
    await userEvent.type(within(d).getByLabelText("Payment terms"), "Net 45");
    await userEvent.click(within(d).getByRole("button", { name: "Save terms" }));
    await waitFor(() => expect(body).toEqual({ payment_terms: "Net 45", delivery_terms: "", delivery_address: "" }));
    unmount();
    server.use(AMENDS());
    renderWithProviders(<PoExtras order={po() as never} />, { permissions: ALL });
    expect(screen.queryByRole("button", { name: "Edit terms" })).toBeNull();
  });
  it("sets delivery dates, refusing more than ordered", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(AMENDS(), http.put("*/api/v1/procurement/po-lines/l1/schedule", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ rows: 2 }); }));
    renderWithProviders(<PoExtras order={po() as never} />, { permissions: ALL });
    await userEvent.click(screen.getByRole("button", { name: "Set dates for Widget" }));
    const d = await screen.findByRole("dialog");
    fireEvent.change(within(d).getByLabelText("Date 1"), { target: { value: "2026-04-01" } });
    await userEvent.type(within(d).getByLabelText("Quantity 1"), "12");
    await userEvent.click(within(d).getByRole("button", { name: "Save dates" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("more than the 10");
    await userEvent.clear(within(d).getByLabelText("Quantity 1"));
    await userEvent.type(within(d).getByLabelText("Quantity 1"), "6");
    await userEvent.click(within(d).getByRole("button", { name: "Save dates" }));
    await waitFor(() => expect(body).toEqual({ rows: [{ due_date: "2026-04-01", quantity: "6" }] }));
  });
  it("requests an amendment, and hides the request while one is pending", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(AMENDS(), http.post("*/api/v1/procurement/purchase-orders/o1/amendments", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "a1" }, { status: 201 }); }));
    const { unmount } = renderWithProviders(<PoExtras order={po() as never} />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Request a change" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Request amendment" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Say why");
    await userEvent.type(within(d).getByLabelText("Reason"), "Need more");
    await userEvent.click(within(d).getByRole("button", { name: "Request amendment" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Change a quantity");
    await userEvent.type(within(d).getByLabelText("Quantity of Widget"), "20");
    await userEvent.click(within(d).getByRole("button", { name: "Request amendment" }));
    await waitFor(() => expect(body).toEqual({ reason: "Need more", lines: [{ line: "l1", quantity: "20", unit_price: "5" }] }));
    unmount();
    server.use(AMENDS([{ id: "a1", number: 1, status: "PENDING", reason: "Need more", old_total: "50", new_total: "100", changes: {} }]));
    renderWithProviders(<PoExtras order={po() as never} />, { permissions: ALL });
    expect(await screen.findByText(/#1: Need more/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request a change" })).toBeNull();
  });
  it("approves one amendment and rejects another with a reason", async () => {
    let approved = false; let rej: Record<string, unknown> | null = null;
    const row = (id: string, n: number) => ({ id, number: n, status: "PENDING", reason: `R${n}`, old_total: "50", new_total: "100", changes: {} });
    server.use(AMENDS([row("a1", 1), row("a2", 2)]),
      http.post("*/api/v1/procurement/amendments/a1/approve", () => { approved = true; return HttpResponse.json({ status: "APPROVED" }); }),
      http.post("*/api/v1/procurement/amendments/a2/reject", async ({ request }) => { rej = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ status: "REJECTED" }); }));
    renderWithProviders(<PoExtras order={po() as never} />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Approve change #1" }));
    await waitFor(() => expect(approved).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Reject change #2" }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText("Reason"), "No budget");
    await userEvent.click(within(d).getByRole("button", { name: "Reject change" }));
    await waitFor(() => expect(rej).toEqual({ note: "No budget" }));
  });
  it("shows the server's refusal to approve your own amendment", async () => {
    server.use(AMENDS([{ id: "a1", number: 1, status: "PENDING", reason: "R", old_total: "50", new_total: "100", changes: {} }]),
      http.post("*/api/v1/procurement/amendments/a1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you cannot approve your own amendment." } }, { status: 403 })));
    renderWithProviders(<PoExtras order={po() as never} />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Approve change #1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot approve your own amendment");
  });
  it("closes an order with a reason", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(AMENDS(), http.post("*/api/v1/procurement/purchase-orders/o1/close", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ status: "CLOSED" }); }));
    renderWithProviders(<PoExtras order={po() as never} />, { permissions: ALL });
    await userEvent.click(screen.getByRole("button", { name: "Close order" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Close order" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("required");
    await userEvent.type(within(d).getByLabelText(/Why is it being closed/), "Supplier cannot deliver");
    await userEvent.click(within(d).getByRole("button", { name: "Close order" }));
    await waitFor(() => expect(body).toEqual({ reason: "Supplier cannot deliver" }));
  });
});

describe("BlanketOrdersPage", () => {
  const B = (o = {}) => po({ id: "b1", number: "BO-1", kind: "BLANKET", valid_to: "2026-09-15", total: "800.00", lines: [{ ...LINE, quantity: "100.0000", released_quantity: "70.0000" }], ...o });
  it("lists only blanket orders and submits a draft", async () => {
    let kind: string | null = null; let hit = false;
    server.use(http.get("*/api/v1/procurement/purchase-orders", ({ request }) => { kind = new URL(request.url).searchParams.get("kind"); return page([B({ status: "DRAFT" })]); }),
      http.post("*/api/v1/procurement/purchase-orders/b1/submit", () => { hit = true; return HttpResponse.json(B()); }));
    renderWithProviders(<BlanketOrdersPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Submit BO-1" }));
    await waitFor(() => expect(hit).toBe(true));
    expect(kind).toBe("BLANKET");
  });
  it("places a release capped at what is left", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.get("*/api/v1/procurement/purchase-orders", () => page([B()])), http.get("*/api/v1/procurement/purchase-orders/b1", () => HttpResponse.json(B())),
      http.post("*/api/v1/procurement/blanket-orders/b1/release", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "o9", number: "PO-9" }, { status: 201 }); }));
    renderWithProviders(<BlanketOrdersPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Order against BO-1" }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(await within(d).findByLabelText("Order Widget"), "31");
    await userEvent.click(within(d).getByRole("button", { name: "Place order" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("only 30");
    await userEvent.clear(within(d).getByLabelText("Order Widget"));
    await userEvent.type(within(d).getByLabelText("Order Widget"), "30");
    await userEvent.click(within(d).getByRole("button", { name: "Place order" }));
    await waitFor(() => expect(body).toEqual({ lines: [{ blanket_line: "l1", quantity: "30" }] }));
  });
  it("creates a blanket order", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.get("*/api/v1/procurement/purchase-orders", () => page([])),
      http.get("*/api/v1/procurement/suppliers", () => page([{ id: "s1", name: "Globex" }])), http.get("*/api/v1/inventory/products", () => page([{ id: "p1", sku: "SKU-1", name: "Widget" }])),
      http.post("*/api/v1/procurement/blanket-orders", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "b1", number: "BO-1", status: "DRAFT" }, { status: 201 }); }));
    renderWithProviders(<BlanketOrdersPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "New blanket order" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Create blanket order" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Choose the supplier");
    await userEvent.selectOptions(within(d).getByLabelText("Supplier"), await within(d).findByRole("option", { name: "Globex" }));
    await userEvent.type(within(d).getByLabelText("Currency"), "usd");
    fireEvent.change(within(d).getByLabelText("Valid until"), { target: { value: "2099-12-31" } });
    await userEvent.selectOptions(within(d).getByLabelText("Product 1"), await within(d).findByRole("option", { name: /Widget/ }));
    await userEvent.type(within(d).getByLabelText("Ceiling quantity 1"), "100");
    await userEvent.type(within(d).getByLabelText("Price 1"), "8");
    await userEvent.click(within(d).getByRole("button", { name: "Create blanket order" }));
    await waitFor(() => expect(body).toMatchObject({ supplier: "s1", currency: "USD", valid_to: "2099-12-31", lines: [{ product: "p1", quantity: "100", unit_price: "8" }] }));
  });
});

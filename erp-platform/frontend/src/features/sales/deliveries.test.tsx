import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { DeliveriesPage, isLate } from "./DeliveriesPage";
import { DeliveryDetailPage, discrepancyProblem } from "./DeliveryDetailPage";
import { dispatchLines, remaining } from "./DispatchDialog";
import { OrdersPage } from "./OrdersPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const del = (o = {}) => ({ id: "d1", number: "DL-1", order: "o1", status: "DISPATCHED", delivery_date: "2026-11-10", expected_date: "2026-11-12", delivered_at: null, carrier: "DHL", tracking_ref: "T123", received_by: "", pod_note: "", failure_reason: "", lines: [{ order_line: "ol1", quantity: "10.0000", lot_code: "" }], discrepancies: [], ...o });
const order = (o = {}) => ({ id: "o1", number: "SO-1", account: "a1", currency: "USD", order_date: "2026-11-01", status: "CONFIRMED", subtotal: "100", tax_total: "0", total: "100", approval_required: false, workflow_instance_id: null, version: 1, hold_reason: "", lines: [{ id: "ol1", line_no: 1, product: "p1", description: "Widget", quantity: "10.0000", unit_price: "10", discount_percent: "0", net_unit_price: "10", line_total: "100", tax_amount: "0", delivered_quantity: "4.0000", invoiced_quantity: "0" }], ...o });
const orders = http.get("*/api/v1/sales/orders", () => page([order()]));
const MANAGE = ["sales.view", "sales.delivery.manage"];

describe("helpers", () => {
  it("knows what is late and what is left to ship", () => {
    expect(isLate({ status: "DISPATCHED", expected_date: "2026-11-01" }, "2026-11-02")).toBe(true);
    expect(isLate({ status: "DISPATCHED", expected_date: "2026-11-02" }, "2026-11-02")).toBe(false);
    expect(isLate({ status: "DELIVERED", expected_date: "2026-11-01" }, "2026-11-02")).toBe(false);
    expect(isLate({ status: "DISPATCHED", expected_date: null }, "2026-11-02")).toBe(false);
    expect(remaining({ quantity: "10.0000", delivered_quantity: "4.0000" })).toBe(6);
    expect(remaining({ quantity: "10", delivered_quantity: "12" })).toBe(0);
  });
  it("checks dispatch quantities", () => {
    const o = order() as never;
    expect(dispatchLines(o, { ol1: "6" })).toEqual({ lines: [{ order_line: "ol1", quantity: "6" }] });
    expect(dispatchLines(o, { ol1: "7" })).toEqual({ problem: "Widget: only 6 left to ship." });
    expect(dispatchLines(o, { ol1: "x" })).toMatchObject({ problem: expect.stringMatching(/must be a number/) });
    expect(dispatchLines(o, { ol1: "" })).toEqual({ problem: "Enter a quantity for at least one line." });
  });
  it("checks reported problems", () => {
    const lines = [{ order_line: "ol1", quantity: "10", lot_code: "" }];
    expect(discrepancyProblem([], lines)).toBeNull();
    expect(discrepancyProblem([{ order_line: "", kind: "SHORT", quantity: "1", note: "" }], lines)).toMatch(/Choose the item/);
    expect(discrepancyProblem([{ order_line: "ol1", kind: "", quantity: "1", note: "" }], lines)).toMatch(/kind/);
    expect(discrepancyProblem([{ order_line: "ol1", kind: "SHORT", quantity: "0", note: "" }], lines)).toMatch(/above zero/);
    expect(discrepancyProblem([{ order_line: "ol1", kind: "SHORT", quantity: "11", note: "" }], lines)).toMatch(/Only 10/);
    expect(discrepancyProblem([{ order_line: "ol1", kind: "SHORT", quantity: "1", note: "" }, { order_line: "ol1", kind: "SHORT", quantity: "2", note: "" }], lines)).toMatch(/twice/);
    expect(discrepancyProblem([{ order_line: "ol1", kind: "SHORT", quantity: "1", note: "" }], lines)).toBeNull();
  });
});

describe("DeliveriesPage", () => {
  it("lists deliveries with late and problem flags, filters by status and shows performance", async () => {
    let status = "";
    server.use(orders, http.get("*/api/v1/sales/deliveries/performance", () => HttpResponse.json({ total: 3, by_status: {}, on_time_percent: 66.7, avg_transit_days: 2.5, late_now: 1, discrepancies: 1, by_carrier: { DHL: { deliveries: 3, failed: 1 } } })),
      http.get("*/api/v1/sales/deliveries", ({ request }) => { status = new URL(request.url).searchParams.get("status") ?? ""; return page([del({ expected_date: "2020-01-01", discrepancies: [{ order_line: "ol1", kind: "SHORT", quantity: "1", note: "", case: null }] })]); }));
    renderWithProviders(<DeliveriesPage />, { permissions: ["sales.view"] });
    expect(await screen.findByRole("link", { name: "DL-1" })).toHaveAttribute("href", "/app/sales/deliveries/d1");
    expect(await screen.findByText("SO-1")).toBeInTheDocument();
    expect(screen.getByText("Late")).toBeInTheDocument();
    expect(screen.getByText("Problem reported")).toBeInTheDocument();
    expect(await screen.findByText("66.7%")).toBeInTheDocument();
    expect(screen.getByText("DHL: 3 deliveries, 1 failed")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "DELIVERED");
    await waitFor(() => expect(status).toBe("DELIVERED"));
  });

  it("does not send a reversed date range", async () => {
    const asked: URLSearchParams[] = [];
    server.use(orders, http.get("*/api/v1/sales/deliveries", () => page([])), http.get("*/api/v1/sales/deliveries/performance", ({ request }) => { asked.push(new URL(request.url).searchParams); return HttpResponse.json({ total: 0, by_status: {}, on_time_percent: null, avg_transit_days: null, late_now: 0, discrepancies: 0, by_carrier: {} }); }));
    renderWithProviders(<DeliveriesPage />, { permissions: ["sales.view"] });
    await screen.findByText("No deliveries");
    await userEvent.type(screen.getByLabelText("From"), "2026-11-10");
    await userEvent.type(screen.getByLabelText("To"), "2026-11-01");
    expect(await screen.findByText("The end date is before the start date.")).toBeInTheDocument();
    expect(asked.every((p) => !(p.get("from") && p.get("to") && (p.get("to") as string) < (p.get("from") as string)))).toBe(true);
  });
});

function detail(permissions: string[], d = del(), extra: Parameters<typeof server.use> = []) {
  server.use(http.get("*/api/v1/sales/deliveries/d1", () => HttpResponse.json(d)), http.get("*/api/v1/sales/orders/o1", () => HttpResponse.json(order())),
    http.get("*/api/v1/sales/deliveries/d1/pod", () => HttpResponse.json([{ id: "f1", name: "pod.png", size: 2048 }])), ...extra);
  return renderWithProviders(<Routes><Route path="/app/sales/deliveries/:id" element={<DeliveryDetailPage />} /></Routes>, { permissions, route: "/app/sales/deliveries/d1" });
}

describe("DeliveryDetailPage", () => {
  it("shows facts and goods; without manage rights there are no actions", async () => {
    detail(["sales.view"]);
    expect(await screen.findByRole("heading", { name: "Delivery DL-1" })).toBeInTheDocument();
    expect(await screen.findByText("Widget")).toBeInTheDocument();
    expect(await screen.findByText("pod.png")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm delivery" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
  });

  it("confirms with a reported problem, validating first", async () => {
    let body: Record<string, unknown> | null = null;
    detail(MANAGE, del(), [http.post("*/api/v1/sales/deliveries/d1/confirm", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(del({ status: "DELIVERED" })); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Confirm delivery" }));
    const d = within(await screen.findByRole("dialog", { name: "Confirm delivery" }));
    await userEvent.click(d.getByRole("button", { name: "Confirm delivered" }));
    expect(await d.findByText("Who received the goods is required.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText("Received by"), "Ann");
    await userEvent.click(d.getByRole("button", { name: "Report a problem with the goods" }));
    await userEvent.click(d.getByRole("button", { name: "Confirm delivered" }));
    expect(await d.findByText("Choose the item each problem is about.")).toBeInTheDocument();
    await userEvent.selectOptions(d.getByLabelText("Item for problem 1"), "ol1");
    await userEvent.selectOptions(d.getByLabelText("Kind of problem 1"), "DAMAGED");
    await userEvent.type(d.getByLabelText("Quantity of problem 1"), "2");
    await userEvent.type(d.getByLabelText("Note for problem 1"), "crushed box");
    await userEvent.click(d.getByRole("button", { name: "Confirm delivered" }));
    await waitFor(() => expect(body).toEqual({ received_by: "Ann", note: "", discrepancies: [{ order_line: "ol1", kind: "DAMAGED", quantity: "2", note: "crushed box" }] }));
  });

  it("marks a delivery failed and shows server refusals", async () => {
    detail(MANAGE, del(), [http.post("*/api/v1/sales/deliveries/d1/fail", () => HttpResponse.json({ error: { code: "invalid_state_transition", message: "Only a dispatched delivery can fail." } }, { status: 409 }))]);
    await userEvent.click(await screen.findByRole("button", { name: "Mark as failed" }));
    const d = within(await screen.findByRole("dialog", { name: "Mark delivery as failed" }));
    await userEvent.type(d.getByLabelText("What went wrong"), "Nobody home");
    await userEvent.click(d.getByRole("button", { name: "Mark as failed" }));
    expect(await d.findByText("Only a dispatched delivery can fail.")).toBeInTheDocument();
  });

  it("sets an expected date, refusing one before dispatch", async () => {
    let body: unknown = null;
    detail(MANAGE, del({ expected_date: null }), [http.put("*/api/v1/sales/deliveries/d1/expected", async ({ request }) => { body = await request.json(); return HttpResponse.json(del()); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Set expected date" }));
    const d = within(await screen.findByRole("dialog", { name: "Set expected date" }));
    const input = d.getByLabelText("Expected delivery date");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(input, { target: { value: "2026-11-01" } });
    await userEvent.click(d.getByRole("button", { name: "Save date" }));
    expect(await d.findByText("The expected date cannot be before the dispatch date.")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "2026-11-15" } });
    await userEvent.click(d.getByRole("button", { name: "Save date" }));
    await waitFor(() => expect(body).toEqual({ expected_date: "2026-11-15" }));
  });

  it("shows no action buttons once delivered, and links a problem to its service case", async () => {
    detail(MANAGE, del({ status: "DELIVERED", received_by: "Ann", delivered_at: "2026-11-11T10:00:00Z", discrepancies: [{ order_line: "ol1", kind: "SHORT", quantity: "2", note: "", case: "c9" }] }));
    expect(await screen.findByText(/Short \(fewer than expected\)/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "service case" })).toHaveAttribute("href", "/app/crm/cases/c9");
    expect(screen.queryByRole("button", { name: "Confirm delivery" })).toBeNull();
  });
});

describe("Dispatch goods from an order", () => {
  function open(permissions: string[], extra: Parameters<typeof server.use> = []) {
    server.use(http.get("*/api/v1/sales/orders", () => page([order()])), http.get("*/api/v1/sales/orders/o1", () => HttpResponse.json(order())), http.get("*/api/v1/crm/accounts", () => page([{ id: "a1", name: "Acme" }])),
      http.get("*/api/v1/inventory/warehouses", () => page([{ id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "", address: "", locations: [{ id: "loc1", code: "A1", kind: "", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] }])), ...extra);
    return renderWithProviders(<OrdersPage />, { permissions });
  }

  it("is only offered to logistics staff", async () => {
    open(["sales.view"]);
    await userEvent.click(await screen.findByRole("button", { name: "SO-1" }));
    await screen.findByText(/Sales order SO-1/);
    expect(screen.queryByRole("button", { name: "Dispatch goods" })).toBeNull();
  });

  it("dispatches the remaining quantity and links to the new delivery", async () => {
    let body: Record<string, unknown> | null = null;
    open(MANAGE, [http.post("*/api/v1/sales/orders/o1/deliver", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "d7", number: "DL-7", order: "o1", status: "DISPATCHED", lines: [] }, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "SO-1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Dispatch goods" }));
    const d = within(await screen.findByRole("dialog", { name: "Dispatch goods for SO-1" }));
    await userEvent.click(d.getByRole("button", { name: "Dispatch" }));
    expect(await d.findByText("Choose where the goods leave from.")).toBeInTheDocument();
    await d.findByRole("option", { name: "MAIN / A1" });
    await userEvent.selectOptions(d.getByLabelText("Dispatch from"), "loc1");
    await userEvent.clear(d.getByLabelText("Quantity of Widget"));
    await userEvent.type(d.getByLabelText("Quantity of Widget"), "9");
    await userEvent.click(d.getByRole("button", { name: "Dispatch" }));
    expect(await d.findByText("Widget: only 6 left to ship.")).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Quantity of Widget"));
    await userEvent.type(d.getByLabelText("Quantity of Widget"), "6");
    await userEvent.type(d.getByLabelText("Carrier"), "DHL");
    await userEvent.click(d.getByRole("button", { name: "Dispatch" }));
    expect(await screen.findByRole("link", { name: "DL-7" })).toHaveAttribute("href", "/app/sales/deliveries/d7");
    expect(body).toMatchObject({ location: "loc1", lines: [{ order_line: "ol1", quantity: "6" }], carrier: "DHL" });
  });
});

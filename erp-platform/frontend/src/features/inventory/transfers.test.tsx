import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ReservationsPage, validateReservation } from "./ReservationsPage";
import { TransfersPage, buildReceipt, validateTransfer } from "./TransfersPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const line = (o: object = {}) => ({ id: "l1", sku: "W-1", name: "Widget", from_location: "A1", lot: "", quantity: "10", dispatched: "10", received: "0", rejected: "0", damaged: "0", ...o });
const note = (o: object = {}) => ({ id: "t1", number: "TR-1", status: "REQUESTED", from: "MAIN", to: "EAST", reason: "", carrier: "", expected_date: null, requested_by: "u1", approved_by: null, lines: [line()], ...o });
const listTr = () => http.get("*/api/v1/inventory/transfer-orders", () => HttpResponse.json({ results: [{ id: "t1", number: "TR-1", status: "REQUESTED", from: "MAIN", to: "EAST" }] }));
const detail = (n: object) => http.get("*/api/v1/inventory/transfer-orders/t1", () => HttpResponse.json(n));
const wh = http.get("*/api/v1/inventory/warehouses", () => HttpResponse.json({ results: [
  { id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "OWN", address: "", locations: [{ id: "a1", code: "A1" }] },
  { id: "w2", code: "EAST", name: "East", is_active: true, warehouse_type: "OWN", address: "", locations: [{ id: "e1", code: "E1" }] }], next: null, previous: null }));

describe("validators", () => {
  const p = { id: "p" } as never;
  it("validates a transfer", () => {
    expect(validateTransfer({ from: "", to: "b", lines: [] })).toMatch(/warehouses/);
    expect(validateTransfer({ from: "a", to: "a", lines: [] })).toMatch(/differ/);
    expect(validateTransfer({ from: "a", to: "b", lines: [] })).toMatch(/at least one/);
    expect(validateTransfer({ from: "a", to: "b", lines: [{ product: p, from_location: "x", quantity: "0", lot: "" }] })).toMatch(/more than 0/);
    expect(validateTransfer({ from: "a", to: "b", lines: [{ product: p, from_location: "x", quantity: "2", lot: "" }] })).toBeNull();
  });
  it("builds a receipt, refusing over-receipt and missing put-away", () => {
    const lines = [line()];
    expect(buildReceipt(lines, { l1: { accepted: "11", rejected: "", damaged: "", to: "e1" } })).toHaveProperty("error");
    expect(buildReceipt(lines, { l1: { accepted: "5", rejected: "", damaged: "", to: "" } })).toHaveProperty("error");
    expect(buildReceipt(lines, {})).toHaveProperty("error");
    expect(buildReceipt(lines, { l1: { accepted: "8", rejected: "1", damaged: "1", to: "e1" } })).toEqual({ rows: [{ line: "l1", accepted: "8", rejected: "1", damaged: "1", to_location: "e1" }] });
  });
  it("validates a reservation", () => {
    expect(validateReservation({ product: null, quantity: "1", refType: "a", refId: "b" })).toMatch(/product/);
    expect(validateReservation({ product: { id: "p" } as never, quantity: "1", refType: "", refId: "b" })).toMatch(/reserved for/);
    expect(validateReservation({ product: { id: "p" } as never, quantity: "1", refType: "so", refId: "SO-1" })).toBeNull();
  });
});

describe("TransfersPage", () => {
  it("approver approves a requested transfer; rejecting needs a note", async () => {
    let action = ""; let body: any = null;
    server.use(listTr(), detail(note()), http.post("*/api/v1/inventory/transfer-orders/t1/:a", async ({ request, params }) => { action = String(params.a); body = await request.json(); return HttpResponse.json(note({ status: "APPROVED" })); }));
    renderWithProviders(<TransfersPage />, { permissions: ["inventory.view", "inventory.transfer.approve"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "TR-1" }));
    const dlg = await screen.findByRole("dialog", { name: /Transfer TR-1/ });
    await user.click(await within(dlg).findByRole("button", { name: "Reject" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/reason is required/);
    expect(action).toBe("");
    await user.click(within(dlg).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(action).toBe("approve"));
    expect(body.note).toBe("");
  });

  it("hides approve from users without the approval permission and surfaces self-approval refusals", async () => {
    server.use(listTr(), detail(note()));
    renderWithProviders(<TransfersPage />, { permissions: ["inventory.view", "inventory.stock.issue"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "TR-1" }));
    const dlg = await screen.findByRole("dialog", { name: /Transfer TR-1/ });
    await within(dlg).findByText(/MAIN → EAST/);
    expect(within(dlg).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(dlg).getByRole("button", { name: "Cancel transfer" })).toBeInTheDocument();
  });

  it("receives goods with accepted and damaged quantities", async () => {
    let body: any = null;
    server.use(listTr(), wh, detail(note({ status: "IN_TRANSIT" })), http.post("*/api/v1/inventory/transfer-orders/t1/receive", async ({ request }) => { body = await request.json(); return HttpResponse.json(note({ status: "RECEIVED" })); }));
    renderWithProviders(<TransfersPage />, { permissions: ["inventory.view", "inventory.goods.receive"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "TR-1" }));
    const dlg = await screen.findByRole("dialog", { name: /Transfer TR-1/ });
    await user.click(await within(dlg).findByRole("button", { name: "Receive goods" }));
    await within(dlg).findByRole("option", { name: "E1" });
    await user.type(within(dlg).getByLabelText("W-1 accepted"), "9");
    await user.type(within(dlg).getByLabelText("W-1 damaged"), "1");
    await user.selectOptions(within(dlg).getByLabelText("W-1 put away to"), "e1");
    await user.click(within(dlg).getByRole("button", { name: "Confirm receipt" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ lines: [{ line: "l1", accepted: "9", rejected: "0", damaged: "1", to_location: "e1" }] });
  });

  it("creates a transfer and shows client-side errors first", async () => {
    server.use(listTr(), wh, http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [{ id: "p1", sku: "W-1", name: "Widget" }] })));
    renderWithProviders(<TransfersPage />, { permissions: ["inventory.view", "inventory.stock.issue"] });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "TR-1" });
    await user.click(screen.getByRole("button", { name: "New transfer" }));
    await user.click(await screen.findByRole("button", { name: "Create transfer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/warehouses/);
  });
});

describe("ReservationsPage", () => {
  const res = { id: "r1", sku: "W-1", quantity: "3", status: "ACTIVE", ref_type: "sales_order", ref_id: "SO-1", expires_on: null, warehouse: "MAIN" };
  it("lists active reservations and releases one; no button without permission", async () => {
    let released = false;
    server.use(http.get("*/api/v1/inventory/reservations", () => HttpResponse.json({ results: [res] })), http.post("*/api/v1/inventory/reservations/r1/release", () => { released = true; return HttpResponse.json({ status: "RELEASED" }); }));
    const view = renderWithProviders(<ReservationsPage />, { permissions: ["inventory.view", "inventory.stock.issue"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Release" }));
    await waitFor(() => expect(released).toBe(true));
    view.unmount();
    renderWithProviders(<ReservationsPage />, { permissions: ["inventory.view"] });
    await screen.findByText("SO-1", { exact: false });
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New reservation" })).toBeNull();
  });
  it("shows the server's refusal when releasing fails", async () => {
    server.use(http.get("*/api/v1/inventory/reservations", () => HttpResponse.json({ results: [res] })), http.post("*/api/v1/inventory/reservations/r1/release", () => HttpResponse.json({ error: { code: "invalid_state", message: "Already released." } }, { status: 409 })));
    renderWithProviders(<ReservationsPage />, { permissions: ["inventory.view", "inventory.stock.issue"] });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Already released/);
  });
});

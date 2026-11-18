import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ReturnsClaimsPage, returnLinesProblem, returnNext } from "./ReturnsClaimsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const ret = (o = {}) => ({ id: "r1", number: "RTS-1", po: "PO-1", supplier: "Globex", status: "DRAFT", reason: "Cracked", return_date: "2026-11-10", return_value: "100.00", credit_due: "0.00", credit_note_id: null, lines: [], ...o });
const claim = (o = {}) => ({ id: "c1", number: "CL-1", supplier: "Globex", kind: "DAMAGE", status: "OPEN", currency: "USD", amount_claimed: "250.00", amount_accepted: null, description: "Broke", decision_note: "", ...o });
const RET = ["procurement.view", "procurement.return.manage", "procurement.return.approve"];
const listReturns = (rows: object[]) => http.get("*/api/v1/procurement/returns", () => HttpResponse.json({ results: rows }));
const listClaims = (rows: object[]) => http.get("*/api/v1/procurement/claims", () => HttpResponse.json({ results: rows }));

describe("helpers", () => {
  it("picks the next step of a return", () => {
    expect(returnNext({ status: "DRAFT", credit_due: "0" })).toBe("approve");
    expect(returnNext({ status: "APPROVED", credit_due: "0" })).toBe("dispatch");
    expect(returnNext({ status: "DISPATCHED", credit_due: "50" })).toBe("credit");
    expect(returnNext({ status: "DISPATCHED", credit_due: "0.00" })).toBe("close");
    expect(returnNext({ status: "CLOSED", credit_due: "0" })).toBeNull();
  });
  it("checks return quantities", () => {
    expect(returnLinesProblem([{ po_line: "a", max: 5, quantity: "" }])).toMatch(/at least one/);
    expect(returnLinesProblem([{ po_line: "a", max: 5, quantity: "x" }])).toMatch(/numbers/);
    expect(returnLinesProblem([{ po_line: "a", max: 5, quantity: "6" }])).toMatch(/Only 5/);
    expect(returnLinesProblem([{ po_line: "a", max: 5, quantity: "5" }])).toBeNull();
  });
});

describe("Returns tab", () => {
  it("approves a draft return", async () => {
    let hit = false;
    server.use(listReturns([ret()]), http.post("*/api/v1/procurement/returns/r1/approve", () => { hit = true; return HttpResponse.json(ret({ status: "APPROVED" })); }));
    renderWithProviders(<ReturnsClaimsPage />, { permissions: RET });
    await userEvent.click(await screen.findByRole("button", { name: "Approve RTS-1" }));
    await waitFor(() => expect(hit).toBe(true));
  });
  it("offers only the steps the user may take", async () => {
    server.use(listReturns([ret()]));
    renderWithProviders(<ReturnsClaimsPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByText("RTS-1")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("sends back goods with serial numbers", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(listReturns([ret({ status: "APPROVED" })]), http.post("*/api/v1/procurement/returns/r1/dispatch", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(ret({ status: "DISPATCHED" })); }));
    renderWithProviders(<ReturnsClaimsPage />, { permissions: RET });
    await userEvent.click(await screen.findByRole("button", { name: "Send back RTS-1" }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText(/Serial numbers/), "S1{enter}S2");
    await userEvent.click(within(d).getByRole("button", { name: "Send back" }));
    await waitFor(() => expect(body).toEqual({ serials: ["S1", "S2"] }));
  });
  it("records the supplier credit note for an invoiced return", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(listReturns([ret({ status: "DISPATCHED", credit_due: "100.00" })]),
      http.get("*/api/v1/finance/invoices", () => page([{ id: "i1", number: "CN-1", total: "120.00", currency: "USD", partner: { id: "p", name: "Globex" } }, { id: "i2", number: "CN-2", total: "9.00", currency: "USD", partner: { id: "q", name: "Other" } }])),
      http.post("*/api/v1/procurement/returns/r1/credit", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(ret({ status: "CREDITED" })); }));
    renderWithProviders(<ReturnsClaimsPage />, { permissions: RET });
    await userEvent.click(await screen.findByRole("button", { name: "Record credit note for RTS-1" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Record credit note" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Choose the supplier's credit note");
    expect(within(d).queryByRole("option", { name: /CN-2/ })).toBeNull();
    await userEvent.selectOptions(within(d).getByLabelText("Credit note"), await within(d).findByRole("option", { name: /CN-1/ }));
    await userEvent.click(within(d).getByRole("button", { name: "Record credit note" }));
    await waitFor(() => expect(body).toEqual({ credit_note: "i1" }));
  });
  it("creates a return from an order's received lines", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(listReturns([]),
      http.get("*/api/v1/procurement/purchase-orders", () => page([{ id: "o1", number: "PO-1", supplier: { id: "s1", name: "Globex" }, status: "RECEIVED" }, { id: "o2", number: "PO-2", supplier: { id: "s1", name: "Globex" }, status: "DRAFT" }])),
      http.get("*/api/v1/procurement/purchase-orders/o1", () => HttpResponse.json({ id: "o1", number: "PO-1", lines: [{ id: "pl1", line_no: 1, description: "Widget", quantity: "10", unit_price: "5", received_quantity: "10" }, { id: "pl2", line_no: 2, description: "Unreceived", quantity: "3", unit_price: "1", received_quantity: "0" }] })),
      http.get("*/api/v1/inventory/warehouses", () => page([{ id: "w1", code: "W", name: "Main", is_active: true, warehouse_type: "", address: "", locations: [{ id: "loc1", code: "A1" }] }])),
      http.post("*/api/v1/procurement/returns", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(ret(), { status: 201 }); }));
    renderWithProviders(<ReturnsClaimsPage />, { permissions: RET });
    await userEvent.click(await screen.findByRole("button", { name: "New return" }));
    const d = await screen.findByRole("dialog");
    expect(within(d).queryByRole("option", { name: /PO-2/ })).toBeNull();
    await userEvent.selectOptions(within(d).getByLabelText("Order"), await within(d).findByRole("option", { name: /PO-1/ }));
    expect(await within(d).findByLabelText("Send back Widget")).toBeInTheDocument();
    expect(within(d).queryByLabelText("Send back Unreceived")).toBeNull();
    await userEvent.selectOptions(within(d).getByLabelText("Goods leave from"), await within(d).findByRole("option", { name: /A1/ }));
    await userEvent.type(within(d).getByLabelText("Reason"), "Cracked");
    await userEvent.type(within(d).getByLabelText("Send back Widget"), "11");
    await userEvent.click(within(d).getByRole("button", { name: "Create return" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Only 10");
    await userEvent.clear(within(d).getByLabelText("Send back Widget"));
    await userEvent.type(within(d).getByLabelText("Send back Widget"), "4");
    await userEvent.click(within(d).getByRole("button", { name: "Create return" }));
    await waitFor(() => expect(body).toEqual({ order: "o1", location: "loc1", reason: "Cracked", lines: [{ po_line: "pl1", quantity: "4" }] }));
  });
});

describe("Claims tab", () => {
  const open = async () => { await userEvent.click(await screen.findByRole("tab", { name: "Claims" })); };
  it("creates a claim, checking the amount", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(listReturns([]), listClaims([]),
      http.get("*/api/v1/procurement/suppliers", () => page([{ id: "s1", name: "Globex" }])),
      http.post("*/api/v1/procurement/claims", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(claim(), { status: 201 }); }));
    renderWithProviders(<ReturnsClaimsPage />, { permissions: RET });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "New claim" }));
    const d = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(d).getByLabelText("Supplier"), await within(d).findByRole("option", { name: "Globex" }));
    await userEvent.selectOptions(within(d).getByLabelText("What kind of claim"), "Shortage");
    await userEvent.type(within(d).getByLabelText("Amount claimed"), "0");
    await userEvent.type(within(d).getByLabelText("What happened"), "Short by 5");
    await userEvent.click(within(d).getByRole("button", { name: "Create claim" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("above zero");
    await userEvent.clear(within(d).getByLabelText("Amount claimed"));
    await userEvent.type(within(d).getByLabelText("Amount claimed"), "250.50");
    await userEvent.click(within(d).getByRole("button", { name: "Create claim" }));
    await waitFor(() => expect(body).toEqual({ supplier: "s1", kind: "SHORTAGE", amount: "250.50", description: "Short by 5" }));
  });
  it("sends an open claim and records an acceptance no larger than the claim", async () => {
    let sent = false; let body: Record<string, unknown> | null = null;
    server.use(listReturns([]), listClaims([claim(), claim({ id: "c2", number: "CL-2", status: "SUBMITTED" })]),
      http.post("*/api/v1/procurement/claims/c1/submit", () => { sent = true; return HttpResponse.json(claim({ status: "SUBMITTED" })); }),
      http.post("*/api/v1/procurement/claims/c2/accept", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(claim({ id: "c2", status: "ACCEPTED" })); }));
    renderWithProviders(<ReturnsClaimsPage />, { permissions: RET });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Send CL-1" }));
    await waitFor(() => expect(sent).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Supplier accepted CL-2" }));
    const d = await screen.findByRole("dialog");
    await userEvent.clear(within(d).getByLabelText("Amount the supplier accepted"));
    await userEvent.type(within(d).getByLabelText("Amount the supplier accepted"), "999");
    await userEvent.click(within(d).getByRole("button", { name: "Record acceptance" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("not more than the claim");
    await userEvent.clear(within(d).getByLabelText("Amount the supplier accepted"));
    await userEvent.type(within(d).getByLabelText("Amount the supplier accepted"), "200");
    await userEvent.click(within(d).getByRole("button", { name: "Record acceptance" }));
    await waitFor(() => expect(body).toEqual({ amount: "200", note: "" }));
  });
  it("rejects with a reason and settles with a credit note", async () => {
    let rej: Record<string, unknown> | null = null; let settle: Record<string, unknown> | null = null;
    server.use(listReturns([]), listClaims([claim({ status: "SUBMITTED" }), claim({ id: "c3", number: "CL-3", status: "ACCEPTED", amount_accepted: "200.00" })]),
      http.get("*/api/v1/finance/invoices", () => page([{ id: "i1", number: "CN-1", total: "250.00", currency: "USD", partner: { id: "p", name: "Globex" } }])),
      http.post("*/api/v1/procurement/claims/c1/reject", async ({ request }) => { rej = (await request.json()) as Record<string, unknown>; return HttpResponse.json(claim({ status: "REJECTED" })); }),
      http.post("*/api/v1/procurement/claims/c3/settle", async ({ request }) => { settle = (await request.json()) as Record<string, unknown>; return HttpResponse.json(claim({ id: "c3", status: "SETTLED" })); }));
    renderWithProviders(<ReturnsClaimsPage />, { permissions: RET });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Supplier rejected CL-1" }));
    let d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText("Reason given"), "Not our fault");
    await userEvent.click(within(d).getByRole("button", { name: "Record rejection" }));
    await waitFor(() => expect(rej).toEqual({ note: "Not our fault" }));
    await userEvent.click(await screen.findByRole("button", { name: "Settle CL-3" }));
    d = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(d).getByLabelText("Credit note"), await within(d).findByRole("option", { name: /CN-1/ }));
    await userEvent.click(within(d).getByRole("button", { name: "Record credit note" }));
    await waitFor(() => expect(settle).toEqual({ credit_note: "i1" }));
  });
  it("shows server errors from a refused step", async () => {
    server.use(listReturns([]), listClaims([claim()]), http.post("*/api/v1/procurement/claims/c1/submit", () => HttpResponse.json({ error: { code: "invalid_state", message: "Only an open claim can be submitted." } }, { status: 409 })));
    renderWithProviders(<ReturnsClaimsPage />, { permissions: RET });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Send CL-1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only an open claim can be submitted.");
  });
});

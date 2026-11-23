import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { QuotationsPage } from "./QuotationsPage";
import { quotationProblem, toLines, type QLine } from "./QuotationEditor";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const Q = (o = {}) => ({ id: "q1", number: "QT-1", account: "a1", currency: "USD", status: "DRAFT", valid_until: "2026-12-31", subtotal: "100", tax_total: "0", total: "100", version: 1, payment_terms: "", delivery_terms: "", terms: "", notes: "", max_discount: "0", approved_by: null,
  lines: [{ id: "l1", line_no: 1, product: "p1", description: "Widget", quantity: "2.0000", unit_price: "50.0000", discount_percent: "0", net_unit_price: "50", line_total: "100", tax_amount: "0" }], ...o });
const line = (o: Partial<QLine> = {}): QLine => ({ key: 1, product: "p1", description: "Widget", quantity: "2", unit_price: "", discount_percent: "", ...o });
const T = { payment_terms: "", delivery_terms: "", terms: "" };
const MGR = ["sales.view", "sales.quote.create", "sales.order.approve", "sales.order.create"];

function open(q: object, permissions = MGR, extra: Parameters<typeof server.use> = []) {
  server.use(http.get("*/api/v1/sales/quotations", () => page([q])), http.get("*/api/v1/sales/quotations/q1", () => HttpResponse.json(q)),
    http.get("*/api/v1/crm/accounts", () => page([{ id: "a1", name: "Acme" }])), http.get("*/api/v1/org/currencies", () => page([{ id: "c1", code: "USD", name: "Dollar", symbol: "$", decimals: 2, is_active: true }])),
    http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E1", name: "Abel", status: "ACTIVE", user_id: "u1" }] })), ...extra);
  return renderWithProviders(<QuotationsPage />, { permissions });
}
const openDetail = async () => { await userEvent.click(await screen.findByRole("button", { name: "QT-1" })); await screen.findByText(/Quotation QT-1/); };

describe("quotationProblem / toLines", () => {
  it("validates", () => {
    expect(quotationProblem("a", "USD", [line()], T, true)).toBeNull();
    expect(quotationProblem("", "USD", [line()], T, true)).toMatch(/customer/);
    expect(quotationProblem("a", "", [line()], T, true)).toMatch(/currency/);
    expect(quotationProblem("", "", [line()], T, false)).toBeNull();
    expect(quotationProblem("a", "USD", [], T, true)).toMatch(/at least one line/);
    expect(quotationProblem("a", "USD", [line({ product: null, description: "" })], T, true)).toMatch(/pick a product/);
    expect(quotationProblem("a", "USD", [line({ product: null, description: "Fee" })], T, true)).toMatch(/needs a price/);
    expect(quotationProblem("a", "USD", [line({ quantity: "0" })], T, true)).toMatch(/above 0/);
    expect(quotationProblem("a", "USD", [line({ discount_percent: "101" })], T, true)).toMatch(/between 0 and 100/);
    expect(quotationProblem("a", "USD", [line()], { ...T, payment_terms: "x".repeat(201) }, true)).toMatch(/200/);
  });
  it("builds the request lines, leaving price blank for the price list", () => {
    expect(toLines([line(), line({ product: null, description: " Fee ", unit_price: "5", discount_percent: "10" })])).toEqual([{ product: "p1", quantity: "2" }, { description: "Fee", quantity: "2", unit_price: "5", discount_percent: "10" }]);
  });
});

describe("Quotations page", () => {
  it("only offers New quotation to people who may create", async () => {
    open(Q(), ["sales.view"]);
    await screen.findByRole("button", { name: "QT-1" });
    expect(screen.queryByRole("button", { name: "New quotation" })).toBeNull();
  });

  it("creates a quotation with a free-text line", async () => {
    let body: Record<string, unknown> | null = null;
    open(Q(), MGR, [http.post("*/api/v1/sales/quotations", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(Q(), { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "New quotation" }));
    await userEvent.click(screen.getByRole("button", { name: "Create quotation" }));
    expect(await screen.findByText("Choose a customer.")).toBeInTheDocument();
    await screen.findByRole("option", { name: "Acme" }); await screen.findByRole("option", { name: "USD" });
    await userEvent.selectOptions(screen.getByLabelText("Customer"), "a1");
    await userEvent.selectOptions(screen.getByLabelText("Currency"), "USD");
    await userEvent.click(screen.getByRole("button", { name: "Add line" }));
    await userEvent.type(screen.getByLabelText("Description for line 1"), "Setup fee");
    await userEvent.type(screen.getByLabelText(/Price 1/), "25");
    await userEvent.type(screen.getByLabelText("Payment terms"), "Net 30");
    fireEvent.change(screen.getByLabelText("Valid until"), { target: { value: "2026-12-15" } });
    await userEvent.click(screen.getByRole("button", { name: "Create quotation" }));
    await waitFor(() => expect(body).toEqual({ account: "a1", currency: "USD", lines: [{ description: "Setup fee", quantity: "1", unit_price: "25" }], valid_until: "2026-12-15", payment_terms: "Net 30", delivery_terms: "", terms: "" }));
  });

  it("edits a draft, sending the version it saw, and shows a version conflict", async () => {
    let body: Record<string, unknown> | null = null;
    open(Q(), MGR, [http.put("*/api/v1/sales/quotations/q1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ error: { code: "version_conflict", message: "The quotation was changed by someone else." } }, { status: 409 }); })]);
    await openDetail();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const qty = await screen.findByLabelText("Quantity 1");
    await userEvent.clear(qty); await userEvent.type(qty, "3");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("The quotation was changed by someone else.")).toBeInTheDocument();
    expect(body).toMatchObject({ expected_version: 1, lines: [{ product: "p1", quantity: "3", unit_price: "50" }] });
  });

  it("does not offer Edit once sent", async () => {
    open(Q({ status: "SENT" }));
    await openDetail();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revise" })).toBeInTheDocument();
  });

  it("approves discounts, and shows the refusal for your own quotation", async () => {
    open(Q({ status: "PENDING_APPROVAL" }), MGR, [http.post("*/api/v1/sales/quotations/q1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve a quotation you created." } }, { status: 403 }))]);
    await openDetail();
    await userEvent.click(screen.getByRole("button", { name: "Approve discounts" }));
    expect(await screen.findByText("You cannot approve a quotation you created.")).toBeInTheDocument();
  });

  it("sends a quotation back only with a reason", async () => {
    let body: Record<string, unknown> | null = null;
    open(Q({ status: "PENDING_APPROVAL" }), MGR, [http.post("*/api/v1/sales/quotations/q1/return", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(Q()); })]);
    await openDetail();
    await userEvent.click(screen.getByRole("button", { name: "Send back" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Send back" }).at(-1)!);
    expect(await screen.findByText("Reason is required.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Reason/), "Discount too high");
    await userEvent.click(screen.getAllByRole("button", { name: "Send back" }).at(-1)!);
    await waitFor(() => expect(body).toEqual({ reason: "Discount too high" }));
  });

  it("hides approval from people without the approve permission", async () => {
    open(Q({ status: "PENDING_APPROVAL" }), ["sales.view", "sales.quote.create"]);
    await openDetail();
    expect(screen.queryByRole("button", { name: "Approve discounts" })).toBeNull();
  });

  it("revises a sent quotation with a reason and lists its history", async () => {
    let body: Record<string, unknown> | null = null;
    open(Q({ status: "SENT" }), MGR, [
      http.post("*/api/v1/sales/quotations/q1/revise", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(Q({ version: 2 })); }),
      http.get("*/api/v1/sales/quotations/q1/revisions", () => HttpResponse.json([{ version: 1, event: "REVISED", created_by: "u1", created_at: "2026-11-01T10:00:00Z", snapshot: {} }])),
    ]);
    await openDetail();
    await userEvent.click(screen.getByRole("button", { name: "Show history" }));
    expect(await screen.findByText(/Version 1: revised by .*Abel on 2026-11-01/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revise" }));
    await userEvent.type(await screen.findByLabelText(/Reason/), "Customer asked for a lower price");
    await userEvent.click(screen.getAllByRole("button", { name: "Revise" }).at(-1)!);
    await waitFor(() => expect(body).toEqual({ reason: "Customer asked for a lower price" }));
  });

  it("opens the printable copy in a new tab", async () => {
    const win = vi.spyOn(window, "open").mockReturnValue(null);
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:doc";
    open(Q({ status: "SENT" }), MGR, [http.get("*/api/v1/sales/quotations/q1/document", () => new HttpResponse("<html>Quote</html>", { headers: { "Content-Type": "text/html" } }))]);
    await openDetail();
    await userEvent.click(screen.getByRole("button", { name: "Printable copy" }));
    await waitFor(() => expect(win).toHaveBeenCalledWith("blob:doc", "_blank", "noopener"));
  });

  it("shows a message when the printable copy is refused", async () => {
    open(Q({ status: "SENT" }), MGR, [http.get("*/api/v1/sales/quotations/q1/document", () => new HttpResponse("no", { status: 403 }))]);
    await openDetail();
    await userEvent.click(screen.getByRole("button", { name: "Printable copy" }));
    expect(await screen.findByText(/could not be opened/)).toBeInTheDocument();
  });
});

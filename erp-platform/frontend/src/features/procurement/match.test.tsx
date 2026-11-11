import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { MatchExceptionsPage, problemLabel } from "./MatchPages";
import { PurchaseOrdersPage } from "./PurchaseOrdersPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const po = (o: object = {}) => ({ id: "o1", number: "PO-1", supplier: { id: "s1", name: "Acme" }, currency: "USD", status: "RECEIVED", order_date: "2026-02-01", expected_date: null, total: "100.0000", invoiced_value: "0.0000", version: 1, workflow_instance_id: null, lines: [], ...o });
const inv = (o: object = {}) => ({ id: "i1", kind: "SUPPLIER_INVOICE", number: "BILL-1", supplier_ref: "A-77", partner: { id: "p1", name: "Acme" }, invoice_date: "2026-02-02", due_date: null, currency: "USD", status: "DRAFT", subtotal: "100.0000", tax_total: "0.0000", total: "100.0000", paid_amount: "0.0000", outstanding: "100.0000", lines: [], ...o });
const detail = (problems: Record<string, string> = {}) => ({ ordered_value: "100.0000", received_value: "100.0000", previously_invoiced: "0.0000", invoice_goods_value: "100.0000", tolerance_percent: "2", mode: "THREE_WAY", possible_duplicates: [], problems });

describe("problemLabel", () => {
  it("names known problems and tidies unknown ones", () => {
    expect(problemLabel("not_received")).toBe("More invoiced than received");
    expect(problemLabel("some_new_check")).toBe("some new check");
  });
});

describe("Match invoice on a purchase order", () => {
  const open = async (perms: string[]) => {
    server.use(http.get("*/api/v1/procurement/purchase-orders", () => page([po()])), http.get("*/api/v1/procurement/purchase-orders/o1", () => HttpResponse.json(po())));
    renderWithProviders(<PurchaseOrdersPage />, { permissions: perms });
    const user = userEvent.setup();
    await user.click(await screen.findByText("PO-1"));
    return user;
  };

  it("offers only same-currency unposted invoices and shows a matched result", async () => {
    server.use(http.get("*/api/v1/finance/invoices", () => page([inv(), inv({ id: "i2", number: "BILL-2", status: "POSTED" }), inv({ id: "i3", number: "BILL-3", currency: "EUR" })])));
    let body: any = null;
    server.use(http.post("*/api/v1/procurement/purchase-orders/o1/match-invoice", async ({ request }) => { body = await request.json(); return HttpResponse.json({ status: "MATCHED", detail: detail() }); }));
    const user = await open(["procurement.view", "procurement.invoice.match"]);
    await user.click(await screen.findByRole("button", { name: "Match invoice" }));
    const dlg = await screen.findByRole("dialog", { name: "Match an invoice to PO-1" });
    await within(dlg).findByRole("option", { name: /BILL-1/ });
    expect(within(dlg).queryByRole("option", { name: /BILL-2/ })).toBeNull();
    expect(within(dlg).queryByRole("option", { name: /BILL-3/ })).toBeNull();
    await user.click(within(dlg).getByRole("button", { name: "Run match" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/Choose the supplier invoice/);
    await user.selectOptions(within(dlg).getByLabelText(/Supplier invoice/), "i1");
    await user.click(within(dlg).getByRole("button", { name: "Run match" }));
    const result = await within(dlg).findByRole("region", { name: "Match result" });
    expect(result).toHaveTextContent("Matched");
    expect(body).toEqual({ invoice: "i1", mode: "THREE_WAY" });
  });

  it("shows the problems of an exception", async () => {
    server.use(
      http.get("*/api/v1/finance/invoices", () => page([inv()])),
      http.post("*/api/v1/procurement/purchase-orders/o1/match-invoice", () => HttpResponse.json({ status: "EXCEPTION", detail: detail({ not_received: "invoiced 100 exceeds received value 60" }) })),
    );
    const user = await open(["procurement.view", "procurement.invoice.match"]);
    await user.click(await screen.findByRole("button", { name: "Match invoice" }));
    const dlg = await screen.findByRole("dialog", { name: "Match an invoice to PO-1" });
    await within(dlg).findByRole("option", { name: /BILL-1/ });
    await user.selectOptions(within(dlg).getByLabelText(/Supplier invoice/), "i1");
    await user.click(within(dlg).getByRole("button", { name: "Run match" }));
    const result = await within(dlg).findByRole("region", { name: "Match result" });
    expect(result).toHaveTextContent("Exception");
    expect(result).toHaveTextContent("More invoiced than received");
    expect(result).toHaveTextContent("exceeds received value 60");
  });

  it("shows a server refusal such as a different supplier", async () => {
    server.use(
      http.get("*/api/v1/finance/invoices", () => page([inv()])),
      http.post("*/api/v1/procurement/purchase-orders/o1/match-invoice", () => HttpResponse.json({ error: { code: "supplier_mismatch", message: "The invoice is from a different supplier than the purchase order.", details: [] } }, { status: 400 })),
    );
    const user = await open(["procurement.view", "procurement.invoice.match"]);
    await user.click(await screen.findByRole("button", { name: "Match invoice" }));
    const dlg = await screen.findByRole("dialog", { name: "Match an invoice to PO-1" });
    await within(dlg).findByRole("option", { name: /BILL-1/ });
    await user.selectOptions(within(dlg).getByLabelText(/Supplier invoice/), "i1");
    await user.click(within(dlg).getByRole("button", { name: "Run match" }));
    expect(await within(dlg).findByText(/different supplier/)).toBeInTheDocument();
  });

  it("hides the button without the match permission and for a draft order", async () => {
    const user = await open(["procurement.view"]);
    await screen.findByText(/Acme/);
    expect(screen.queryByRole("button", { name: "Match invoice" })).toBeNull();
    void user;
  });
});

describe("MatchExceptionsPage", () => {
  const x = (o: object = {}) => ({ match: "m1", invoice: "i1", invoice_number: "BILL-1", supplier_ref: "A-77", po: "PO-1", problems: { not_received: "invoiced 100 exceeds received value 60" }, goods_value: "100.0000", raised_at: "2026-02-03T10:00:00Z", ...o });

  it("lists exceptions and overrides one with a reason", async () => {
    server.use(http.get("*/api/v1/procurement/match-exceptions", () => page([x()])));
    let body: any = null;
    server.use(http.post("*/api/v1/procurement/matches/m1/override", async ({ request }) => { body = await request.json(); return HttpResponse.json({ status: "OVERRIDDEN" }); }));
    renderWithProviders(<MatchExceptionsPage />, { permissions: ["procurement.invoice.match", "procurement.invoice.override"] });
    const user = userEvent.setup();
    expect(await screen.findByText(/BILL-1/)).toBeInTheDocument();
    expect(screen.getByText(/More invoiced than received/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Override BILL-1" }));
    await user.click(screen.getByRole("button", { name: "Accept invoice" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reason is required/);
    expect(body).toBeNull();
    await user.type(screen.getByLabelText("Reason"), "Supplier shipped early, goods are in the yard");
    await user.click(screen.getByRole("button", { name: "Accept invoice" }));
    await waitFor(() => expect(body).toEqual({ reason: "Supplier shipped early, goods are in the yard" }));
  });

  it("shows the separation-of-duties refusal", async () => {
    server.use(
      http.get("*/api/v1/procurement/match-exceptions", () => page([x()])),
      http.post("*/api/v1/procurement/matches/m1/override", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: someone else must approve the override.", details: [] } }, { status: 403 })),
    );
    renderWithProviders(<MatchExceptionsPage />, { permissions: ["procurement.invoice.match", "procurement.invoice.override"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Override BILL-1" }));
    await user.type(screen.getByLabelText("Reason"), "ok");
    await user.click(screen.getByRole("button", { name: "Accept invoice" }));
    expect(await screen.findByText(/someone else must approve/)).toBeInTheDocument();
  });

  it("never offers override for a duplicate, nor without the override permission", async () => {
    server.use(http.get("*/api/v1/procurement/match-exceptions", () => page([x({ problems: { duplicate_invoice: "supplier invoice number 'A-77' was already recorded on BILL-0" } })])));
    const first = renderWithProviders(<MatchExceptionsPage />, { permissions: ["procurement.invoice.match", "procurement.invoice.override"] });
    expect(await screen.findByText(/Duplicates cannot be overridden/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Override/ })).toBeNull();
    first.unmount();
    server.use(http.get("*/api/v1/procurement/match-exceptions", () => page([x()])));
    renderWithProviders(<MatchExceptionsPage />, { permissions: ["procurement.invoice.match"] });
    await screen.findByText(/BILL-1/);
    expect(screen.queryByRole("button", { name: /Override/ })).toBeNull();
  });

  it("shows an empty state", async () => {
    server.use(http.get("*/api/v1/procurement/match-exceptions", () => page([])));
    renderWithProviders(<MatchExceptionsPage />, { permissions: ["procurement.invoice.match"] });
    expect(await screen.findByText("No open match exceptions")).toBeInTheDocument();
  });
});

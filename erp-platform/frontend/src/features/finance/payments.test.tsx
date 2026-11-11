import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { InvoicesPage } from "./InvoicesPage";
import { invoiceSchema } from "./NewInvoiceDialog";
import { validatePayment } from "./PaymentDialog";
import { PaymentsPage } from "./PaymentsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const goodLine = { description: "Widgets", quantity: "2", unit_price: "9.99", account: "a1", tax_rate: "" };
const base = { kind: "CUSTOMER_INVOICE" as const, partner: "p1", invoice_date: "2026-02-01", due_date: "", currency: "", supplier_ref: "", lines: [goodLine] };

describe("invoiceSchema", () => {
  it("accepts a valid invoice", () => expect(invoiceSchema.safeParse(base).success).toBe(true));
  it("rejects bad quantity, price, missing partner/account, no lines, due before invoice date", () => {
    expect(invoiceSchema.safeParse({ ...base, lines: [{ ...goodLine, quantity: "0" }] }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...base, lines: [{ ...goodLine, unit_price: "-1" }] }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...base, lines: [{ ...goodLine, account: "" }] }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...base, partner: "" }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...base, due_date: "2026-01-01" }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...base, currency: "US" }).success).toBe(false);
  });
});

describe("validatePayment", () => {
  const inv = { outstanding: "115.0000", currency: "USD" };
  const bank = { id: "b", name: "Main", currency: "USD", is_cash: false, is_active: true };
  it("allows up to the outstanding amount", () => {
    expect(validatePayment(inv, { bank, date: "2026-02-01", amount: "115" })).toBeNull();
    expect(validatePayment(inv, { bank, date: "2026-02-01", amount: "115.0001" })).toMatch(/cannot exceed/);
  });
  it("rejects missing bank, currency mismatch, zero and malformed amounts", () => {
    expect(validatePayment(inv, { bank: undefined, date: "2026-02-01", amount: "1" })).toMatch(/Choose/);
    expect(validatePayment(inv, { bank: { ...bank, currency: "EUR" }, date: "2026-02-01", amount: "1" })).toMatch(/EUR/);
    expect(validatePayment(inv, { bank, date: "2026-02-01", amount: "0" })).toMatch(/greater than 0/);
    expect(validatePayment(inv, { bank, date: "2026-02-01", amount: "1e2" })).toMatch(/greater than 0/);
  });
});

const refs = () => server.use(
  http.get("*/api/v1/finance/partners", () => page([{ id: "p1", name: "Acme", is_customer: true, is_supplier: false, tax_id: "" }, { id: "p2", name: "Globex", is_customer: false, is_supplier: true, tax_id: "" }])),
  http.get("*/api/v1/finance/tax-rates", () => page([{ id: "t1", code: "VAT", name: "VAT", kind: "SALES", rate: "15.0000", is_active: true }])),
  http.get("*/api/v1/finance/accounts", () => page([{ id: "a1", code: "4000", name: "Sales", type: "REVENUE", parent: null, is_postable: true, is_control: false, system_key: null, is_active: true }])),
  http.get("*/api/v1/finance/invoices", () => page([])),
);

describe("NewInvoiceDialog", () => {
  it("shows an exact estimate and posts the draft with decimal strings", async () => {
    refs();
    let body: any = null;
    server.use(http.post("*/api/v1/finance/invoices", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "i1" }, { status: 201 }); }));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.invoice.create"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New invoice" }));
    await screen.findByRole("option", { name: "Acme" });
    await user.selectOptions(screen.getByLabelText("Customer"), "p1");
    await screen.findByRole("option", { name: /4000 Sales/ });
    await user.type(screen.getByLabelText("Line 1 description"), "Widgets");
    await user.clear(screen.getByLabelText("Line 1 quantity")); await user.type(screen.getByLabelText("Line 1 quantity"), "2");
    await user.clear(screen.getByLabelText("Line 1 price")); await user.type(screen.getByLabelText("Line 1 price"), "9.99");
    await user.selectOptions(screen.getByLabelText("Line 1 account"), "a1");
    await user.selectOptions(screen.getByLabelText("Line 1 tax"), "t1");
    expect(screen.getByText(/Total 22\.977/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body.lines[0]).toMatchObject({ quantity: "2", unit_price: "9.99", account: "a1", tax_rate: "t1" });
    expect(body.partner).toBe("p1");
  });

  it("blocks an incomplete invoice and shows the server refusal", async () => {
    refs();
    server.use(http.post("*/api/v1/finance/invoices", () => HttpResponse.json({ error: { code: "validation_error", message: "Period is closed.", details: [] } }, { status: 400 })));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.invoice.create"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New invoice" }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Choose a customer or supplier")).toBeInTheDocument();
  });

  it("hides the button without the create permission", async () => {
    refs();
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view"] });
    await screen.findByText("No invoices");
    expect(screen.queryByRole("button", { name: "New invoice" })).toBeNull();
  });
});

describe("PaymentDialog", () => {
  const posted = { id: "i1", kind: "CUSTOMER_INVOICE", number: "INV-1", supplier_ref: "", partner: { id: "p1", name: "Acme" }, invoice_date: "2026-01-05", due_date: null, currency: "USD", status: "POSTED", subtotal: "100.0000", tax_total: "15.0000", total: "115.0000", paid_amount: "0.0000", outstanding: "115.0000", lines: [] };
  it("sends the receipt with an Idempotency-Key and the allocation", async () => {
    server.use(
      http.get("*/api/v1/finance/invoices", () => page([posted])),
      http.get("*/api/v1/finance/invoices/i1", () => HttpResponse.json(posted)),
      http.get("*/api/v1/finance/bank-accounts", () => page([{ id: "b1", name: "Main bank", currency: "USD", is_cash: false, is_active: true }, { id: "b2", name: "Euro bank", currency: "EUR", is_cash: false, is_active: true }])),
    );
    let body: any = null; let key: string | null = null;
    server.use(http.post("*/api/v1/finance/payments", async ({ request }) => { key = request.headers.get("Idempotency-Key"); body = await request.json(); return HttpResponse.json({ id: "pay1" }, { status: 201 }); }));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.payment.release"] });
    const user = userEvent.setup();
    await user.click(await screen.findByText("INV-1"));
    await user.click(await screen.findByRole("button", { name: "Record receipt" }));
    await screen.findByRole("option", { name: "Main bank" });
    expect(screen.queryByRole("option", { name: "Euro bank" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Bank or cash account"), "b1");
    await user.click(within(screen.getByRole("dialog", { name: "Record customer receipt" })).getByRole("button", { name: "Record receipt" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(key).toMatch(/[0-9a-f-]{36}/);
    expect(body).toMatchObject({ kind: "RECEIPT", partner: "p1", bank_account: "b1", allocations: [{ invoice: "i1", amount: "115" }] });
  });

  it("does not offer payment without the release permission", async () => {
    server.use(http.get("*/api/v1/finance/invoices", () => page([posted])), http.get("*/api/v1/finance/invoices/i1", () => HttpResponse.json(posted)));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view"] });
    await userEvent.setup().click(await screen.findByText("INV-1"));
    await screen.findByText(/Acme/);
    expect(screen.queryByRole("button", { name: "Record receipt" })).toBeNull();
  });
});

describe("PaymentsPage", () => {
  it("lists payments", async () => {
    server.use(http.get("*/api/v1/finance/payments", () => page([{ id: "x", number: "PAY-1", kind: "RECEIPT", partner: "p1", payment_date: "2026-02-01", currency: "USD", amount: "115.0000", allocations: [{ invoice: "i1", amount: "115.0000" }] }])));
    renderWithProviders(<PaymentsPage />, { permissions: ["finance.invoice.view"] });
    expect(await screen.findByText("PAY-1")).toBeInTheDocument();
    expect(screen.getByText("Receipt")).toBeInTheDocument();
  });
});

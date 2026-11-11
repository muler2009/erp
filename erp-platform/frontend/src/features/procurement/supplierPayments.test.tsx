import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { SupplierPaymentsPage, netEstimate } from "./SupplierPaymentsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const PERMS = ["procurement.view", "procurement.payment.release"];
const row = (o: object = {}) => ({ invoice: "i1", number: "BILL-1", supplier_ref: "A-77", supplier: "Acme", currency: "USD", total: "1000.0000", outstanding: "1000.0000", due_date: "2026-11-01", days_overdue: 10, discount_available: "20.0000", wht: "30.0000", payable: true, standing: "GOOD", ...o });
const banks = () => http.get("*/api/v1/finance/bank-accounts", () => HttpResponse.json({ results: [{ id: "b1", name: "Main bank", currency: "USD", is_cash: false, is_active: true }, { id: "b2", name: "Euro bank", currency: "EUR", is_cash: false, is_active: true }], next: null, previous: null }));

describe("netEstimate", () => {
  it("subtracts discount and withholding exactly", () => {
    expect(netEstimate(row(), true, true)).toBe(9500000n); // 950.0000
    expect(netEstimate(row(), false, true)).toBe(9700000n);
    expect(netEstimate(row(), false, false)).toBe(10000000n);
  });
});

describe("SupplierPaymentsPage: due list and paying", () => {
  it("shows what is due and releases a payment with an idempotency key", async () => {
    server.use(http.get("*/api/v1/procurement/payments/due", () => HttpResponse.json({ results: [row()] })), banks());
    let body: any = null; let key: string | null = null;
    server.use(http.post("*/api/v1/procurement/invoices/i1/pay", async ({ request }) => { body = await request.json(); key = request.headers.get("Idempotency-Key"); return HttpResponse.json({ payment: "PAY-9", amount: "950.0000", replayed: false }, { status: 201 }); }));
    renderWithProviders(<SupplierPaymentsPage />, { permissions: PERMS });
    const user = userEvent.setup();
    expect(await screen.findByText("BILL-1 (A-77)")).toBeInTheDocument();
    expect(screen.getByText("10 days late")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pay BILL-1" }));
    const dlg = await screen.findByRole("dialog", { name: "Pay BILL-1" });
    await within(dlg).findByRole("option", { name: "Main bank" });
    expect(within(dlg).queryByRole("option", { name: "Euro bank" })).toBeNull();
    expect(dlg).toHaveTextContent("950");
    await user.click(within(dlg).getByRole("button", { name: "Release payment" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/Choose the bank/);
    expect(body).toBeNull();
    await user.selectOptions(within(dlg).getByLabelText("Pay from"), "b1");
    await user.click(within(dlg).getByLabelText(/Take the early-payment discount/));
    await user.click(within(dlg).getByRole("button", { name: "Release payment" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ bank_account: "b1", take_discount: false, withhold: true, memo: "" });
    expect(key).toMatch(/[0-9a-f-]{36}/);
    expect(await within(dlg).findByRole("status")).toHaveTextContent("PAY-9");
  });

  it("hides the discount option when none is available, and shows the server refusal", async () => {
    server.use(http.get("*/api/v1/procurement/payments/due", () => HttpResponse.json({ results: [row({ discount_available: "0.0000", wht: "0.0000" })] })), banks());
    server.use(http.post("*/api/v1/procurement/invoices/i1/pay", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you took part in this invoice and cannot release its payment.", details: [] } }, { status: 403 })));
    renderWithProviders(<SupplierPaymentsPage />, { permissions: PERMS });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Pay BILL-1" }));
    const dlg = await screen.findByRole("dialog", { name: "Pay BILL-1" });
    await within(dlg).findByRole("option", { name: "Main bank" });
    expect(within(dlg).queryByLabelText(/early-payment discount/)).toBeNull();
    await user.selectOptions(within(dlg).getByLabelText("Pay from"), "b1");
    await user.click(within(dlg).getByRole("button", { name: "Release payment" }));
    expect(await within(dlg).findByText(/took part in this invoice/)).toBeInTheDocument();
  });

  it("does not offer Pay without a verified bank account or for a blacklisted supplier", async () => {
    server.use(http.get("*/api/v1/procurement/payments/due", () => HttpResponse.json({ results: [row({ payable: false }), row({ invoice: "i2", number: "BILL-2", standing: "BLACKLISTED" })] })));
    renderWithProviders(<SupplierPaymentsPage />, { permissions: PERMS });
    await screen.findByText("BILL-2 (A-77)");
    expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
    expect(screen.getByText("No verified bank account")).toBeInTheDocument();
    expect(screen.getByText("Blacklisted")).toBeInTheDocument();
  });

  it("shows an empty state and refuses a bad number of days without calling the server", async () => {
    server.use(http.get("*/api/v1/procurement/payments/due", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<SupplierPaymentsPage />, { permissions: PERMS });
    expect(await screen.findByText("Nothing due")).toBeInTheDocument();
    const field = screen.getByLabelText("Due within (days)");
    await userEvent.setup().clear(field);
    await userEvent.setup().type(field, "x");
    expect(await screen.findByRole("alert")).toHaveTextContent(/whole days/);
  });
});

describe("SupplierPaymentsPage: ageing and withholding tax", () => {
  it("shows the ageing buckets", async () => {
    server.use(
      http.get("*/api/v1/procurement/payments/due", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/procurement/payments/ageing", () => HttpResponse.json({ results: [{ supplier: "Acme", currency: "USD", current: "100.0000", "1-30": "50.0000", "31-60": "0.0000", "61-90": "0.0000", "90+": "25.5000", total: "175.5000" }] })),
    );
    renderWithProviders(<SupplierPaymentsPage />, { permissions: PERMS });
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Ageing" }));
    const rowEl = (await screen.findByText("Acme")).closest("tr")!;
    expect(rowEl).toHaveTextContent("175.50");
    expect(rowEl).toHaveTextContent("25.50");
  });

  it("shows the withholding report and refuses a reversed period", async () => {
    server.use(
      http.get("*/api/v1/procurement/payments/due", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/procurement/payments/wht-report", () => HttpResponse.json({ results: [{ supplier: "Acme", tax_id: "TIN-1", currency: "USD", withheld: "30.0000" }] })),
    );
    renderWithProviders(<SupplierPaymentsPage />, { permissions: PERMS });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Withholding tax" }));
    expect(await screen.findByText("TIN-1")).toBeInTheDocument();
    const from = screen.getByLabelText("From");
    await user.clear(from); await user.type(from, "2999-01-01");
    expect(await screen.findByRole("alert")).toHaveTextContent(/on or before/);
  });
});

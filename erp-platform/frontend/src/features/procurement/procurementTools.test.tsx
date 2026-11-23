import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ReturnsClaimsPage } from "./ReturnsClaimsPage";
import { SupplierPaymentsPage } from "./SupplierPaymentsPage";
import { ProcurementSettingsPage, ProductSourcingPage, debitNoteProblem, settingsProblem } from "./ProcurementTools";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const SET = { "procurement.match_tolerance_percent": 2, "procurement.allow_two_way_match": false, "procurement.over_receipt_percent": 5 };

describe("helpers", () => {
  it("checks settings", () => {
    expect(settingsProblem("2", "5")).toBeNull();
    expect(settingsProblem("21", "5")).toMatch(/0 to 20/);
    expect(settingsProblem("2", "51")).toMatch(/0 to 50/);
    expect(settingsProblem("x", "5")).toMatch(/0 to 20/);
  });
  it("checks debit notes", () => {
    expect(debitNoteProblem("50", "Price", "a1", "2026-11-01", 100)).toBeNull();
    expect(debitNoteProblem("0", "Price", "a1", "2026-11-01", 100)).toMatch(/above 0/);
    expect(debitNoteProblem("50", " ", "a1", "2026-11-01", 100)).toMatch(/reason/);
    expect(debitNoteProblem("50", "P", "", "2026-11-01", 100)).toMatch(/account/);
    expect(debitNoteProblem("150", "P", "a1", "2026-11-01", 100)).toMatch(/invoice total/);
  });
});

describe("ProcurementSettingsPage", () => {
  it("is read-only without the manage permission", async () => {
    server.use(http.get("*/api/v1/procurement/settings", () => HttpResponse.json(SET)));
    renderWithProviders(<ProcurementSettingsPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByLabelText("Invoice match tolerance (%)")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
  });
  it("validates, then saves all three values", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.get("*/api/v1/procurement/settings", () => HttpResponse.json(SET)), http.patch("*/api/v1/procurement/settings", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ ...SET, ...body }); }));
    renderWithProviders(<ProcurementSettingsPage />, { permissions: ["procurement.view", "procurement.settings.manage"] });
    const tol = await screen.findByLabelText("Invoice match tolerance (%)");
    await userEvent.clear(tol); await userEvent.type(tol, "30");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/0 to 20/)).toBeInTheDocument();
    await userEvent.clear(tol); await userEvent.type(tol, "3.5");
    await userEvent.click(screen.getByLabelText(/Allow two-way matching/));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(body).toEqual({ "procurement.match_tolerance_percent": 3.5, "procurement.over_receipt_percent": 5, "procurement.allow_two_way_match": true }));
    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
  });
  it("shows the server's refusal", async () => {
    server.use(http.get("*/api/v1/procurement/settings", () => HttpResponse.json(SET)), http.patch("*/api/v1/procurement/settings", () => HttpResponse.json({ error: { code: "invalid_setting", message: "Invalid value for 'procurement.match_tolerance_percent'." } }, { status: 422 })));
    renderWithProviders(<ProcurementSettingsPage />, { permissions: ["procurement.view", "procurement.settings.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/Invalid value for/)).toBeInTheDocument();
  });
});

describe("ProductSourcingPage", () => {
  it("shows preferred suppliers and price history for a chosen product", async () => {
    server.use(http.get("*/api/v1/inventory/products", () => page([{ id: "p1", sku: "SKU-1", name: "Widget", uom: "pcs", is_active: true }])),
      http.get("*/api/v1/procurement/products/p1/suppliers", () => HttpResponse.json({
        preferred: [{ supplier: "Acme", supplier_id: "s1", unit_price: "4.50", currency: "USD", lead_time_days: 5, preferred: true }, { supplier: "Beta", supplier_id: "s2", unit_price: "4.80", currency: "USD", lead_time_days: null, preferred: false }],
        history: [{ supplier: "Acme", unit_price: "4.20", currency: "USD", valid_from: "2026-01-01", valid_to: "2026-06-30", lead_time_days: 5 }, { supplier: "Acme", unit_price: "4.50", currency: "USD", valid_from: "2026-07-01", valid_to: null, lead_time_days: 5 }] })));
    renderWithProviders(<ProductSourcingPage />, { permissions: ["procurement.view"] });
    await userEvent.type(screen.getByLabelText("Product"), "Wid");
    await userEvent.click(await screen.findByRole("button", { name: /SKU-1/ }));
    expect(await screen.findByText("preferred")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("2026-06-30")).toBeInTheDocument();
  });
  it("explains when no supplier has a current price", async () => {
    server.use(http.get("*/api/v1/inventory/products", () => page([{ id: "p1", sku: "SKU-1", name: "Widget", uom: "pcs", is_active: true }])), http.get("*/api/v1/procurement/products/p1/suppliers", () => HttpResponse.json({ preferred: [], history: [] })));
    renderWithProviders(<ProductSourcingPage />, { permissions: ["procurement.view"] });
    await userEvent.type(screen.getByLabelText("Product"), "Wid");
    await userEvent.click(await screen.findByRole("button", { name: /SKU-1/ }));
    expect(await screen.findByText("No qualified supplier has a current price")).toBeInTheDocument();
    expect(screen.getByText("No prices recorded")).toBeInTheDocument();
  });
});

describe("Returns summary tab", () => {
  it("lists returns and claims per supplier", async () => {
    server.use(http.get("*/api/v1/procurement/returns", () => page([])), http.get("*/api/v1/procurement/returns/summary", () => HttpResponse.json({ results: [{ supplier: "Acme", returns: 2, return_value: "300.0000", claims: 1, claimed: "100.0000", accepted: "80.0000" }] })));
    renderWithProviders(<ReturnsClaimsPage />, { permissions: ["procurement.view"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Summary" }));
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Value returned")).toBeInTheDocument();
  });
});

describe("Debit note from due invoices", () => {
  const due = { invoice: "i1", number: "BILL-1", supplier_ref: "", supplier: "Acme", currency: "USD", total: "1000.0000", outstanding: "1000.0000", due_date: "2026-11-01", days_overdue: 0, discount_available: "0", wht: "0", payable: true, standing: "GOOD" };
  const open = async (perms: string[], extra: Parameters<typeof server.use> = []) => {
    server.use(http.get("*/api/v1/procurement/payments/due", () => HttpResponse.json({ results: [due] })),
      http.get("*/api/v1/finance/accounts", () => page([{ id: "ac1", code: "5000", name: "Purchases", type: "EXPENSE", parent: null, is_postable: true, is_control: false, system_key: null, is_active: true }, { id: "ac2", code: "4000", name: "Sales", type: "REVENUE", parent: null, is_postable: true, is_control: false, system_key: null, is_active: true }])),
      http.get("*/api/v1/finance/tax-rates", () => page([{ id: "t1", code: "VAT", name: "VAT 15", kind: "PURCHASE", rate: "15.0000", is_active: true }, { id: "t2", code: "OUT", name: "Output VAT", kind: "SALES", rate: "15.0000", is_active: true }])),
      http.get("*/api/v1/finance/bank-accounts", () => page([])), ...extra);
    renderWithProviders(<SupplierPaymentsPage />, { permissions: perms });
  };
  it("is offered only with the debit note permission", async () => {
    await open(["procurement.view", "procurement.payment.release"]);
    await screen.findByText("BILL-1");
    expect(screen.queryByRole("button", { name: "Debit note for BILL-1" })).toBeNull();
  });
  it("raises a single-line debit note using only expense accounts and purchase taxes", async () => {
    let body: Record<string, unknown> | null = null;
    await open(["procurement.view", "procurement.debit_note.create"], [http.post("*/api/v1/procurement/invoices/i1/debit-notes", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "cn1", total: "115.0000", status: "DRAFT" }, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Debit note for BILL-1" }));
    const d = within(await screen.findByRole("dialog", { name: "Debit note against BILL-1" }));
    await d.findByRole("option", { name: "5000 — Purchases" });
    expect(d.queryByRole("option", { name: /Sales/ })).toBeNull();
    expect(d.queryByRole("option", { name: /Output VAT/ })).toBeNull();
    await userEvent.click(d.getByRole("button", { name: "Create debit note" }));
    expect(await d.findByText(/above 0/)).toBeInTheDocument();
    await userEvent.type(d.getByLabelText(/Amount to credit/), "100");
    await userEvent.type(d.getByLabelText("Reason"), "Price correction");
    await userEvent.selectOptions(d.getByLabelText("Expense account"), "ac1");
    await userEvent.selectOptions(d.getByLabelText(/Tax/), "t1");
    fireEvent.change(d.getByLabelText("Date"), { target: { value: "2026-11-20" } });
    await userEvent.click(d.getByRole("button", { name: "Create debit note" }));
    expect(await d.findByText(/Debit note created for 115/)).toBeInTheDocument();
    expect(body).toEqual({ reason: "Price correction", invoice_date: "2026-11-20", lines: [{ description: "Price correction", quantity: "1", unit_price: "100", account: "ac1", tax_rate: "t1" }] });
  });
  it("shows the server's refusal when the credit would exceed the invoice", async () => {
    await open(["procurement.view", "procurement.debit_note.create"], [http.post("*/api/v1/procurement/invoices/i1/debit-notes", () => HttpResponse.json({ error: { code: "credit_exceeds_invoice", message: "Credit would exceed the invoice total (already credited 950)." } }, { status: 409 }))]);
    await userEvent.click(await screen.findByRole("button", { name: "Debit note for BILL-1" }));
    const d = within(await screen.findByRole("dialog", { name: "Debit note against BILL-1" }));
    await d.findByRole("option", { name: "5000 — Purchases" });
    await userEvent.type(d.getByLabelText(/Amount to credit/), "100");
    await userEvent.type(d.getByLabelText("Reason"), "Price correction");
    await userEvent.selectOptions(d.getByLabelText("Expense account"), "ac1");
    await userEvent.click(d.getByRole("button", { name: "Create debit note" }));
    expect(await d.findByText(/already credited 950/)).toBeInTheDocument();
  });
});

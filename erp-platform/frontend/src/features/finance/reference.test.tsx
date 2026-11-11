import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { InvoicesPage } from "./InvoicesPage";
import { PartnersPage, TaxRatesPage, partnerSchema, taxRateSchema } from "./ReferencePages";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });

describe("schemas", () => {
  it("partner needs a name and a role", () => {
    expect(partnerSchema.safeParse({ name: "A", is_customer: true, is_supplier: false, tax_id: "" }).success).toBe(true);
    expect(partnerSchema.safeParse({ name: "A", is_customer: false, is_supplier: false, tax_id: "" }).success).toBe(false);
    expect(partnerSchema.safeParse({ name: " ", is_customer: true, is_supplier: false, tax_id: "" }).success).toBe(false);
  });
  it("tax rate is 0 to 100 with up to 4 decimals", () => {
    const ok = { code: "VAT", name: "VAT", kind: "SALES", rate: "15", account: "a" };
    expect(taxRateSchema.safeParse(ok).success).toBe(true);
    expect(taxRateSchema.safeParse({ ...ok, rate: "100" }).success).toBe(true);
    expect(taxRateSchema.safeParse({ ...ok, rate: "100.0001" }).success).toBe(false);
    expect(taxRateSchema.safeParse({ ...ok, rate: "-1" }).success).toBe(false);
    expect(taxRateSchema.safeParse({ ...ok, rate: "1.23456" }).success).toBe(false);
    expect(taxRateSchema.safeParse({ ...ok, account: "" }).success).toBe(false);
  });
});

describe("PartnersPage", () => {
  it("lists partners and creates one", async () => {
    server.use(http.get("*/api/v1/finance/partners", () => page([{ id: "p1", name: "Acme", is_customer: true, is_supplier: false, tax_id: "T1" }])));
    let body: any = null;
    server.use(http.post("*/api/v1/finance/partners", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "p2" }, { status: 201 }); }));
    renderWithProviders(<PartnersPage />, { permissions: ["finance.invoice.view", "finance.invoice.create"] });
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New partner" }));
    await user.click(screen.getByRole("button", { name: "Save partner" }));
    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Globex");
    await user.click(screen.getByLabelText("Supplier"));
    await user.click(screen.getByRole("button", { name: "Save partner" }));
    await waitFor(() => expect(body).toEqual({ name: "Globex", is_customer: true, is_supplier: true, tax_id: "" }));
  });
  it("hides New partner without the create permission", async () => {
    server.use(http.get("*/api/v1/finance/partners", () => page([])));
    renderWithProviders(<PartnersPage />, { permissions: ["finance.invoice.view"] });
    await screen.findByText("No partners yet");
    expect(screen.queryByRole("button", { name: "New partner" })).toBeNull();
  });
});

describe("TaxRatesPage", () => {
  it("offers liability accounts for sales tax and asset accounts for purchase tax, and shows server refusals", async () => {
    server.use(
      http.get("*/api/v1/finance/tax-rates", () => page([])),
      http.get("*/api/v1/finance/accounts", () => page([
        { id: "l1", code: "2200", name: "VAT payable", type: "LIABILITY", parent: null, is_postable: true, is_control: false, system_key: null, is_active: true },
        { id: "a1", code: "1300", name: "VAT receivable", type: "ASSET", parent: null, is_postable: true, is_control: false, system_key: null, is_active: true },
      ])),
      http.post("*/api/v1/finance/tax-rates", () => HttpResponse.json({ error: { code: "tax_code_taken", message: "A tax rate with this code already exists.", details: [] } }, { status: 409 })),
    );
    renderWithProviders(<TaxRatesPage />, { permissions: ["finance.accounts.view", "finance.accounts.manage"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New tax rate" }));
    expect(await screen.findByRole("option", { name: "2200 VAT payable" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "1300 VAT receivable" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Applies to"), "PURCHASE");
    expect(await screen.findByRole("option", { name: "1300 VAT receivable" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Code"), "VAT");
    await user.type(screen.getByLabelText("Name"), "VAT");
    await user.type(screen.getByLabelText("Rate (%)"), "15");
    await user.selectOptions(screen.getByLabelText("Tax account"), "a1");
    await user.click(screen.getByRole("button", { name: "Save tax rate" }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  });
});

describe("editing a draft invoice", () => {
  const draft = { id: "i1", kind: "CUSTOMER_INVOICE", number: "INV-1", supplier_ref: "", partner: { id: "p1", name: "Acme" }, invoice_date: "2026-02-01", due_date: null, currency: "USD", status: "DRAFT", subtotal: "20.0000", tax_total: "0.0000", total: "20.0000", paid_amount: "0.0000", outstanding: "20.0000", version: 3, lines: [{ line_no: 1, description: "Widgets", quantity: "2.0000", unit_price: "10.0000", account: "4000", tax_rate: null, line_total: "20.0000", tax_amount: "0.0000" }] };
  const refs = () => server.use(
    http.get("*/api/v1/finance/invoices", () => page([draft])),
    http.get("*/api/v1/finance/invoices/i1", () => HttpResponse.json(draft)),
    http.get("*/api/v1/finance/partners", () => page([])),
    http.get("*/api/v1/finance/tax-rates", () => page([])),
    http.get("*/api/v1/finance/accounts", () => page([{ id: "a1", code: "4000", name: "Sales", type: "REVENUE", parent: null, is_postable: true, is_control: false, system_key: null, is_active: true }])),
  );
  it("prefills from the draft, maps the account code back to its id and sends the version", async () => {
    refs();
    let body: any = null;
    server.use(http.put("*/api/v1/finance/invoices/i1", async ({ request }) => { body = await request.json(); return HttpResponse.json(draft); }));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.invoice.create"] });
    const user = userEvent.setup();
    await user.click(await screen.findByText("INV-1"));
    await user.click(await screen.findByRole("button", { name: "Edit draft" }));
    await waitFor(() => expect(screen.getByLabelText("Line 1 description")).toHaveValue("Widgets"));
    await waitFor(() => expect(screen.getByLabelText("Line 1 account")).toHaveValue("a1"));
    await user.clear(screen.getByLabelText("Line 1 quantity")); await user.type(screen.getByLabelText("Line 1 quantity"), "3");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ version: 3, invoice_date: "2026-02-01", due_date: null, lines: [{ description: "Widgets", quantity: "3", unit_price: "10.0000", account: "a1", tax_rate: null }] });
  });
  it("shows the version conflict from the server", async () => {
    refs();
    server.use(http.put("*/api/v1/finance/invoices/i1", () => HttpResponse.json({ error: { code: "version_conflict", message: "The document was changed by someone else.", details: [] } }, { status: 409 })));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.invoice.create"] });
    const user = userEvent.setup();
    await user.click(await screen.findByText("INV-1"));
    await user.click(await screen.findByRole("button", { name: "Edit draft" }));
    await waitFor(() => expect(screen.getByLabelText("Line 1 account")).toHaveValue("a1"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument();
  });
  it("offers no edit for a posted invoice", async () => {
    refs();
    const posted = { ...draft, status: "POSTED" };
    server.use(http.get("*/api/v1/finance/invoices/i1", () => HttpResponse.json(posted)), http.get("*/api/v1/finance/invoices", () => page([posted])));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.invoice.create"] });
    await userEvent.setup().click(await screen.findByText("INV-1"));
    await screen.findByRole("button", { name: "Issue credit note" });
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
  });
});

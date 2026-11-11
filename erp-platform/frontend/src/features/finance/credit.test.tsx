import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { validateCredit } from "./ApplyCreditDialog";
import { InvoicesPage } from "./InvoicesPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const doc = (o: object) => ({ id: "i1", kind: "CUSTOMER_INVOICE", number: "INV-1", supplier_ref: "", partner: { id: "p1", name: "Acme" }, invoice_date: "2026-01-05", due_date: null, currency: "USD", status: "POSTED", subtotal: "100.0000", tax_total: "0.0000", total: "100.0000", paid_amount: "0.0000", outstanding: "100.0000", lines: [], ...o });

describe("validateCredit", () => {
  const cn = { outstanding: "40.0000" };
  it("limits the amount to the smaller outstanding balance", () => {
    expect(validateCredit(cn, { outstanding: "100.0000" }, "40")).toBeNull();
    expect(validateCredit(cn, { outstanding: "100.0000" }, "40.0001")).toMatch(/cannot exceed 40/);
    expect(validateCredit(cn, { outstanding: "10.0000" }, "11")).toMatch(/cannot exceed 10/);
  });
  it("needs a target and a positive amount", () => {
    expect(validateCredit(cn, undefined, "1")).toMatch(/Choose/);
    expect(validateCredit(cn, { outstanding: "10" }, "0")).toMatch(/greater than 0/);
    expect(validateCredit(cn, { outstanding: "10" }, "abc")).toMatch(/greater than 0/);
  });
});

describe("credit notes", () => {
  it("issues a credit note against a posted invoice, tied to it by credit_for", async () => {
    server.use(
      http.get("*/api/v1/finance/invoices", () => page([doc({})])),
      http.get("*/api/v1/finance/invoices/i1", () => HttpResponse.json(doc({}))),
      http.get("*/api/v1/finance/partners", () => page([])),
      http.get("*/api/v1/finance/tax-rates", () => page([])),
      http.get("*/api/v1/finance/accounts", () => page([{ id: "a1", code: "4000", name: "Sales", type: "REVENUE", parent: null, is_postable: true, is_control: false, system_key: null, is_active: true }])),
    );
    let body: any = null;
    server.use(http.post("*/api/v1/finance/invoices", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "c1" }, { status: 201 }); }));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.invoice.create"] });
    const user = userEvent.setup();
    await user.click(await screen.findByText("INV-1"));
    await user.click(await screen.findByRole("button", { name: "Issue credit note" }));
    const dlg = await screen.findByRole("dialog", { name: "Credit note for INV-1" });
    await within(dlg).findByRole("option", { name: /4000 Sales/ });
    await user.type(within(dlg).getByLabelText("Line 1 description"), "Returned goods");
    await user.clear(within(dlg).getByLabelText("Line 1 price")); await user.type(within(dlg).getByLabelText("Line 1 price"), "25");
    await user.selectOptions(within(dlg).getByLabelText("Line 1 account"), "a1");
    await user.click(within(dlg).getByRole("button", { name: "Save credit note draft" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ kind: "CUSTOMER_CREDIT_NOTE", partner: "p1", currency: "USD", credit_for: "i1" });
  });

  it("applies a posted credit note to an open invoice of the same partner and currency", async () => {
    const cn = doc({ id: "c1", kind: "CUSTOMER_CREDIT_NOTE", number: "CN-1", outstanding: "40.0000", total: "40.0000" });
    server.use(
      http.get("*/api/v1/finance/invoices", ({ request }) => {
        const u = new URL(request.url);
        if (u.searchParams.get("kind") === "CUSTOMER_INVOICE") return page([doc({ id: "i1" }), doc({ id: "i2", number: "INV-2", partner: { id: "other", name: "Other" } }), doc({ id: "i3", number: "INV-3", currency: "EUR" })]);
        return page([cn]);
      }),
      http.get("*/api/v1/finance/invoices/c1", () => HttpResponse.json(cn)),
    );
    let body: any = null;
    server.use(http.post("*/api/v1/finance/invoices/c1/apply-credit", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "s", amount: "40.0000" }, { status: 201 }); }));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.invoice.approve"] });
    const user = userEvent.setup();
    await user.click(await screen.findByText("CN-1"));
    expect(screen.queryByRole("button", { name: /receipt|Release payment/ })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Apply to invoice" }));
    const dlg = await screen.findByRole("dialog", { name: "Apply CN-1" });
    await within(dlg).findByRole("option", { name: /INV-1/ });
    expect(within(dlg).queryByRole("option", { name: /INV-2/ })).toBeNull();
    expect(within(dlg).queryByRole("option", { name: /INV-3/ })).toBeNull();
    await user.selectOptions(within(dlg).getByLabelText("Invoice to settle"), "i1");
    await user.type(within(dlg).getByLabelText("Amount"), "50");
    await user.click(within(dlg).getByRole("button", { name: "Apply credit" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/cannot exceed 40/);
    expect(body).toBeNull();
    await user.clear(within(dlg).getByLabelText("Amount")); await user.type(within(dlg).getByLabelText("Amount"), "40");
    await user.click(within(dlg).getByRole("button", { name: "Apply credit" }));
    await waitFor(() => expect(body).toEqual({ invoice: "i1", amount: "40" }));
  });

  it("shows no apply or credit buttons without the permissions", async () => {
    server.use(http.get("*/api/v1/finance/invoices", () => page([doc({})])), http.get("*/api/v1/finance/invoices/i1", () => HttpResponse.json(doc({}))));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view"] });
    await userEvent.setup().click(await screen.findByText("INV-1"));
    await screen.findByText(/Acme/);
    expect(screen.queryByRole("button", { name: "Issue credit note" })).toBeNull();
  });
});

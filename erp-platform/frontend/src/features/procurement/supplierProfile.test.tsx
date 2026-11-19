import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { SupplierProfilePage, priceProblem, profileProblem } from "./SupplierProfilePage";
import { SupplierRiskPage } from "./SupplierRiskPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const profile = (o = {}) => ({ id: "s1", name: "Globex", legal_name: "Globex Ltd", tax_id: "T1", registration_no: "", email: "a@g.com", phone: "123", website: "", category: "Steel", address: {}, payment_terms_days: 30, early_discount_percent: "2.0000", early_discount_days: 10, wht_percent: "5.0000", currency: "USD", risk_level: "LOW", is_preferred: false, status: "QUALIFIED", standing: "GOOD", standing_reason: "", scorecard: { evaluations: 2, delivery: 4, quality: 3.5, price: 4.5, overall: 4 }, contacts: [{ id: "c1", name: "Ann", role: "Sales", email: "ann@g.com", phone: "", primary: true }], documents: [{ id: "d1", type: "TAX", reference: "R1", expiry_date: "2020-01-01" }], ...o });
const BANKS = (rows: object[] = []) => http.get("*/api/v1/procurement/suppliers/s1/bank-accounts", () => HttpResponse.json({ results: rows }));
const CAT = (rows: object[] = []) => http.get("*/api/v1/procurement/suppliers/s1/catalogue", () => HttpResponse.json({ results: rows }));
const PRODS = http.get("*/api/v1/inventory/products", () => page([{ id: "p1", sku: "SKU-1", name: "Steel" }]));
const ALL = ["procurement.view", "procurement.supplier.manage", "procurement.supplier.bank"];
const mount = (o = {}, perms = ALL, extra: Parameters<typeof server.use> = []) => {
  server.use(http.get("*/api/v1/procurement/suppliers/s1/profile", () => HttpResponse.json(profile(o))), PRODS, ...extra);
  renderWithProviders(<Routes><Route path="/app/procurement/suppliers/:id" element={<SupplierProfilePage />} /></Routes>, { permissions: perms, route: "/app/procurement/suppliers/s1" });
};

describe("helpers", () => {
  const ok = { name: "A", payment_terms_days: "30", early_discount_percent: "2", early_discount_days: "10", wht_percent: "5", currency: "usd" };
  it("profileProblem", () => {
    expect(profileProblem(ok)).toBeNull();
    expect(profileProblem({ ...ok, name: " " })).toMatch(/name/);
    expect(profileProblem({ ...ok, payment_terms_days: "400" })).toMatch(/0 to 365/);
    expect(profileProblem({ ...ok, early_discount_percent: "25" })).toMatch(/0 and 20/);
    expect(profileProblem({ ...ok, wht_percent: "51" })).toMatch(/0 and 50/);
    expect(profileProblem({ ...ok, currency: "US" })).toMatch(/three-letter/);
  });
  it("priceProblem", () => {
    const g = { product: "p", unit_price: "4.5", currency: "USD", min_order_quantity: "1", lead_time_days: "3" };
    expect(priceProblem(g)).toBeNull();
    expect(priceProblem({ ...g, product: "" })).toMatch(/product/);
    expect(priceProblem({ ...g, unit_price: "x" })).toMatch(/number/);
    expect(priceProblem({ ...g, min_order_quantity: "0" })).toMatch(/above zero/);
    expect(priceProblem({ ...g, lead_time_days: "1.5" })).toMatch(/whole number/);
  });
});

describe("SupplierProfilePage", () => {
  it("shows details, standing, scorecard, contacts and an expired document", async () => {
    mount({}, ALL, [BANKS(), CAT()]);
    expect(await screen.findByText("Globex Ltd")).toBeInTheDocument();
    expect(screen.getByText("In good standing")).toBeInTheDocument();
    expect(screen.getByText(/Scorecard from 2 evaluations: delivery 4.0/)).toBeInTheDocument();
    expect(screen.getByText(/Ann, Sales/)).toBeInTheDocument();
    expect(screen.getByText("Expired 2020-01-01")).toBeInTheDocument();
  });
  it("hides every editing control and the bank section without permission", async () => {
    mount({}, ["procurement.view"], [CAT()]);
    await screen.findByText("Globex Ltd");
    expect(screen.queryByRole("button", { name: /Edit|Change|Add|Set a price/ })).toBeNull();
    expect(screen.queryByText("Bank accounts")).toBeNull();
  });
  it("saves edited details with numbers as numbers", async () => {
    let body: Record<string, unknown> | null = null;
    mount({}, ALL, [BANKS(), CAT(), http.patch("*/api/v1/procurement/suppliers/s1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(profile()); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Edit details" }));
    const d = await screen.findByRole("dialog");
    await userEvent.clear(within(d).getByLabelText("Payment terms (days)"));
    await userEvent.type(within(d).getByLabelText("Payment terms (days)"), "400");
    await userEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("0 to 365");
    await userEvent.clear(within(d).getByLabelText("Payment terms (days)"));
    await userEvent.type(within(d).getByLabelText("Payment terms (days)"), "45");
    await userEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(body).toMatchObject({ name: "Globex", payment_terms_days: 45, early_discount_percent: "2", wht_percent: "5", risk_level: "LOW", is_preferred: false, currency: "USD" }));
  });
  it("needs a reason to suspend and sends the date", async () => {
    let body: Record<string, unknown> | null = null;
    mount({}, ALL, [BANKS(), CAT(), http.post("*/api/v1/procurement/suppliers/s1/standing", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ standing: "SUSPENDED" }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Change standing" }));
    const d = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(d).getByLabelText("Standing"), "SUSPENDED");
    await userEvent.click(within(d).getByRole("button", { name: "Save standing" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Give a reason");
    await userEvent.type(within(d).getByLabelText(/^Reason/), "Late deliveries");
    fireEvent.change(within(d).getByLabelText(/Suspended until/), { target: { value: "2027-01-31" } });
    await userEvent.click(within(d).getByRole("button", { name: "Save standing" }));
    await waitFor(() => expect(body).toEqual({ standing: "SUSPENDED", reason: "Late deliveries", until: "2027-01-31" }));
  });
  it("adds a contact", async () => {
    let body: Record<string, unknown> | null = null;
    mount({}, ALL, [BANKS(), CAT(), http.post("*/api/v1/procurement/suppliers/s1/contacts", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "c2" }, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Add contact" }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText("Name"), "Bob");
    await userEvent.type(within(d).getByLabelText("Email"), "nope");
    await userEvent.click(within(d).getByRole("button", { name: "Add contact" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("valid email");
    await userEvent.clear(within(d).getByLabelText("Email"));
    await userEvent.type(within(d).getByLabelText("Email"), "bob@g.com");
    await userEvent.click(within(d).getByRole("button", { name: "Add contact" }));
    await waitFor(() => expect(body).toEqual({ name: "Bob", role: "", email: "bob@g.com", phone: "", is_primary: false }));
  });
  it("adds a bank account and verifies another; shows the dual-control refusal", async () => {
    let added: Record<string, unknown> | null = null;
    mount({}, ALL, [BANKS([{ id: "b1", bank_name: "First Bank", account_name: "Globex", account_number: "****1234", currency: "USD", default: true, verified: false }]), CAT(),
      http.post("*/api/v1/procurement/suppliers/s1/bank-accounts", async ({ request }) => { added = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "b2" }, { status: 201 }); }),
      http.post("*/api/v1/procurement/bank-accounts/b1/verify", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Dual control: someone other than the person who entered the bank details must verify them." } }, { status: 403 }))]);
    await userEvent.click(await screen.findByRole("button", { name: "Verify First Bank ****1234" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Dual control");
    await userEvent.click(screen.getByRole("button", { name: "Add bank account" }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText("Bank"), "Second Bank");
    await userEvent.type(within(d).getByLabelText("Account name"), "Globex");
    await userEvent.type(within(d).getByLabelText("Account number"), "99887766");
    await userEvent.click(within(d).getByRole("button", { name: "Add account" }));
    await waitFor(() => expect(added).toEqual({ bank_name: "Second Bank", account_name: "Globex", account_number: "99887766", currency: "", is_default: false }));
  });
  it("adds a document with an expiry", async () => {
    let body: Record<string, unknown> | null = null;
    mount({}, ALL, [BANKS(), CAT(), http.post("*/api/v1/procurement/suppliers/s1/documents", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "d2" }, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Add document" }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText(/^Type/), "Insurance");
    fireEvent.change(within(d).getByLabelText(/^Expires/), { target: { value: "2027-05-01" } });
    await userEvent.click(within(d).getByRole("button", { name: "Add document" }));
    await waitFor(() => expect(body).toEqual({ doc_type: "Insurance", reference: "", expiry_date: "2027-05-01" }));
  });
  it("lists the catalogue and sets a price", async () => {
    let body: Record<string, unknown> | null = null;
    mount({}, ALL, [BANKS(), CAT([{ product: "p1", unit_price: "4.5000", currency: "USD", valid_from: "2026-01-01", valid_to: null }]),
      http.post("*/api/v1/procurement/suppliers/s1/catalogue", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "i1" }, { status: 201 }); })]);
    expect(await screen.findByText("SKU-1 — Steel")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set a price" }));
    const d = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(d).getByLabelText("Product"), await within(d).findByRole("option", { name: /Steel/ }));
    await userEvent.type(within(d).getByLabelText("Price"), "abc");
    await userEvent.click(within(d).getByRole("button", { name: "Save price" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("must be a number");
    await userEvent.clear(within(d).getByLabelText("Price"));
    await userEvent.type(within(d).getByLabelText("Price"), "4.75");
    await userEvent.click(within(d).getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(body).toMatchObject({ product: "p1", unit_price: "4.75", currency: "USD", min_order_quantity: "1", lead_time_days: 0, is_preferred: false }));
  });
});

describe("SupplierRiskPage", () => {
  it("shows risk rows and expiring documents", async () => {
    server.use(http.get("*/api/v1/procurement/supplier-risk", () => HttpResponse.json({ results: [{ supplier: "Globex", status: "QUALIFIED", standing: "SUSPENDED", risk_level: "HIGH", expired_documents: 2, verified_bank: false }] })),
      http.get("*/api/v1/procurement/documents/expiring", () => HttpResponse.json({ results: [{ supplier: "Globex", supplier_id: "s1", doc_type: "TAX", reference: "R1", expiry_date: "2026-01-01", status: "EXPIRED" }] })));
    renderWithProviders(<SupplierRiskPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByText("suspended")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("Not verified")).toBeInTheDocument();
    expect(await screen.findByText("Expired")).toBeInTheDocument();
  });
  it("shows empty states", async () => {
    server.use(http.get("*/api/v1/procurement/supplier-risk", () => HttpResponse.json({ results: [] })), http.get("*/api/v1/procurement/documents/expiring", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<SupplierRiskPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByText("No suppliers yet")).toBeInTheDocument();
    expect(await screen.findByText("Nothing is expiring")).toBeInTheDocument();
  });
});

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { PurchaseContractsPage, contractProblem } from "./PurchaseContractsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const row = (o = {}) => ({ id: "c1", number: "PC-1", title: "Steel supply", supplier: { id: "s1", name: "Globex" }, status: "DRAFT", start_date: "2026-01-01", end_date: "2026-12-31", currency: "USD", value_limit: "50000.00", ...o });
const list = (rows: object[]) => http.get("*/api/v1/procurement/contracts", () => HttpResponse.json({ results: rows }));
const ALL = ["procurement.view", "procurement.contract.manage", "procurement.contract.approve"];
const SUP = http.get("*/api/v1/procurement/suppliers", () => page([{ id: "s1", name: "Globex" }]));
const PRODS = http.get("*/api/v1/inventory/products", () => page([{ id: "p1", sku: "SKU-1", name: "Steel" }]));

describe("contractProblem", () => {
  const ok = { supplier: "s1", title: "T", start_date: "2026-01-01", end_date: "2026-02-01", currency: "usd", value_limit: "", auto_renew: false, renewal_notice_days: "60" };
  const prices = [{ product: "p1", unit_price: "4.5" }];
  it("accepts a good form and flags bad ones", () => {
    expect(contractProblem(ok, prices)).toBeNull();
    expect(contractProblem({ ...ok, supplier: "" }, prices)).toMatch(/supplier/);
    expect(contractProblem({ ...ok, end_date: "2025-01-01" }, prices)).toMatch(/cannot end/);
    expect(contractProblem({ ...ok, currency: "US" }, prices)).toMatch(/currency/);
    expect(contractProblem({ ...ok, value_limit: "0" }, prices)).toMatch(/above zero/);
    expect(contractProblem({ ...ok, auto_renew: true, renewal_notice_days: "x" }, prices)).toMatch(/whole number/);
    expect(contractProblem(ok, [])).toMatch(/at least one/);
    expect(contractProblem(ok, [{ product: "p1", unit_price: "1" }, { product: "p1", unit_price: "2" }])).toMatch(/twice/);
    expect(contractProblem(ok, [{ product: "p1", unit_price: "abc" }])).toMatch(/number/);
  });
});

describe("PurchaseContractsPage", () => {
  it("lists contracts and approves a draft", async () => {
    let hit = false;
    server.use(list([row()]), http.post("*/api/v1/procurement/contracts/c1/activate", () => { hit = true; return HttpResponse.json(row({ status: "ACTIVE" })); }));
    renderWithProviders(<PurchaseContractsPage />, { permissions: ALL });
    expect(await screen.findByText("Globex")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve PC-1" }));
    await waitFor(() => expect(hit).toBe(true));
  });
  it("shows the server's refusal, e.g. your own contract", async () => {
    server.use(list([row()]), http.post("*/api/v1/procurement/contracts/c1/activate", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you cannot approve your own contract." } }, { status: 403 })));
    renderWithProviders(<PurchaseContractsPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Approve PC-1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot approve your own contract");
  });
  it("hides actions without permission", async () => {
    server.use(list([row({ status: "ACTIVE" })]));
    renderWithProviders(<PurchaseContractsPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByText("Steel supply")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve|Extend|End|New contract/ })).toBeNull();
  });
  it("shows spending and prices for a contract", async () => {
    server.use(list([row({ status: "ACTIVE" })]), PRODS, http.get("*/api/v1/procurement/contracts/c1", () => HttpResponse.json({ number: "PC-1", supplier: "Globex", status: "ACTIVE", start_date: "2026-01-01", end_date: "2026-12-31", currency: "USD", value_limit: "50000.00", consumed: "12000.0000", remaining: "38000.0000", days_left: 43, prices: [{ product: "p1", unit_price: "4.5000" }] })));
    renderWithProviders(<PurchaseContractsPage />, { permissions: ["procurement.view"] });
    await userEvent.click(await screen.findByRole("button", { name: "PC-1" }));
    const d = await screen.findByRole("dialog");
    expect(await within(d).findByText(/43 days left/)).toBeInTheDocument();
    expect(within(d).getByText("12,000.00 USD")).toBeInTheDocument();
    expect(await within(d).findByText("SKU-1 — Steel")).toBeInTheDocument();
  });
  it("creates a contract with agreed prices", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(list([]), SUP, PRODS, http.post("*/api/v1/procurement/contracts", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(row(), { status: 201 }); }));
    renderWithProviders(<PurchaseContractsPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "New contract" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Create contract" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Choose the supplier");
    await userEvent.selectOptions(within(d).getByLabelText("Supplier"), await within(d).findByRole("option", { name: "Globex" }));
    await userEvent.type(within(d).getByLabelText("Title"), "Steel supply");
    fireEvent.change(within(d).getByLabelText("Starts"), { target: { value: "2026-01-01" } });
    fireEvent.change(within(d).getByLabelText("Ends"), { target: { value: "2026-12-31" } });
    await userEvent.type(within(d).getByLabelText("Currency"), "usd");
    await userEvent.selectOptions(within(d).getByLabelText("Product 1"), await within(d).findByRole("option", { name: /Steel/ }));
    await userEvent.type(within(d).getByLabelText("Price 1"), "4.50");
    await userEvent.click(within(d).getByRole("button", { name: "Create contract" }));
    await waitFor(() => expect(body).toMatchObject({ supplier: "s1", title: "Steel supply", currency: "USD", auto_renew: false, prices: [{ product: "p1", unit_price: "4.50" }] }));
    expect(body).not.toHaveProperty("value_limit");
  });
  it("extends with a later date and ends early with a reason", async () => {
    let ext: Record<string, unknown> | null = null; let term: Record<string, unknown> | null = null;
    server.use(list([row({ status: "ACTIVE" })]),
      http.post("*/api/v1/procurement/contracts/c1/extend", async ({ request }) => { ext = (await request.json()) as Record<string, unknown>; return HttpResponse.json(row({ status: "ACTIVE" })); }),
      http.post("*/api/v1/procurement/contracts/c1/terminate", async ({ request }) => { term = (await request.json()) as Record<string, unknown>; return HttpResponse.json(row({ status: "TERMINATED" })); }));
    renderWithProviders(<PurchaseContractsPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Extend PC-1" }));
    let d = await screen.findByRole("dialog");
    fireEvent.change(within(d).getByLabelText("New end date"), { target: { value: "2026-06-01" } });
    await userEvent.type(within(d).getByLabelText("Why is it being extended?"), "Good service");
    await userEvent.click(within(d).getByRole("button", { name: "Extend" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("must be after 2026-12-31");
    fireEvent.change(within(d).getByLabelText("New end date"), { target: { value: "2027-06-30" } });
    await userEvent.click(within(d).getByRole("button", { name: "Extend" }));
    await waitFor(() => expect(ext).toEqual({ new_end_date: "2027-06-30", reason: "Good service" }));
    await userEvent.click(await screen.findByRole("button", { name: "End PC-1 early" }));
    d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText("Why is it ending?"), "Supplier failed");
    await userEvent.click(within(d).getByRole("button", { name: "End contract" }));
    await waitFor(() => expect(term).toEqual({ reason: "Supplier failed" }));
  });
});

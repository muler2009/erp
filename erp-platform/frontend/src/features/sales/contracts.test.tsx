import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AgingPage } from "./AgingPage";
import { BackordersPage } from "./BackordersPage";
import { ContractDetailPage } from "./ContractDetailPage";
import { ContractsPage, contractProblem } from "./ContractsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const ACCTS = http.get("*/api/v1/crm/accounts", () => page([{ id: "a1", name: "Acme Ltd" }]));
const PRODS = http.get("*/api/v1/inventory/products", () => page([{ id: "p1", sku: "SKU-1", name: "Widget" }]));
const contract = (o = {}) => ({ id: "c1", number: "CT-1", account: "a1", title: "Annual supply", status: "DRAFT", start_date: "2026-01-01", end_date: "2026-12-31", currency: "USD", committed_value: "50000.00", auto_renew: false, renewal_term_months: null, renewal_notice_days: null, payment_terms: "", delivery_terms: "", terms: "", version: 1, renews: null, items: [{ product: "p1", min_quantity: "10", unit_price: "4.50" }], obligations: [{ id: "o1", description: "Quarterly review", due_date: "2026-03-31", party: "US", done: false }], ...o });

describe("contractProblem", () => {
  const ok = { account: "a1", title: "T", start_date: "2026-01-01", end_date: "2026-02-01", committed_value: "", auto_renew: false, renewal_term_months: "12" };
  it("accepts a good form and flags bad ones", () => {
    expect(contractProblem(ok, [])).toBeNull();
    expect(contractProblem({ ...ok, account: "" }, [])).toMatch(/customer/);
    expect(contractProblem({ ...ok, end_date: "2026-01-01" }, [])).toMatch(/after the start/);
    expect(contractProblem({ ...ok, committed_value: "1e5" }, [])).toMatch(/amount/);
    expect(contractProblem({ ...ok, auto_renew: true, renewal_term_months: "0" }, [])).toMatch(/months/);
    expect(contractProblem(ok, [{ product: "p1", min_quantity: "", unit_price: "0" }])).toMatch(/above zero/);
    expect(contractProblem(ok, [{ product: "p1", min_quantity: "", unit_price: "1" }, { product: "p1", min_quantity: "", unit_price: "2" }])).toMatch(/twice/);
  });
});

describe("BackordersPage", () => {
  const row = { order: "SO-1", order_id: "o1", line: "l1", product: "Widget", backordered: "5", ordered: "8", since: "2026-11-01" };
  it("lists backorders and retries them", async () => {
    server.use(http.get("*/api/v1/sales/backorders", () => HttpResponse.json([row])), http.post("*/api/v1/sales/backorders/retry", () => HttpResponse.json({ lines_filled: 1 })));
    renderWithProviders(<BackordersPage />, { permissions: ["sales.view", "sales.delivery.manage"] });
    expect(await screen.findByText("Widget")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry backorders" }));
    expect(await screen.findByText("1 order line filled from new stock.")).toBeInTheDocument();
  });
  it("hides retry without permission and shows the empty state", async () => {
    server.use(http.get("*/api/v1/sales/backorders", () => HttpResponse.json([])));
    renderWithProviders(<BackordersPage />, { permissions: ["sales.view"] });
    expect(await screen.findByText("No backorders")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry backorders" })).toBeNull();
  });
});

describe("AgingPage", () => {
  it("shows buckets and totals, and passes the chosen date", async () => {
    const seen: (string | null)[] = [];
    server.use(http.get("*/api/v1/sales/receivables/aging", ({ request }) => {
      seen.push(new URL(request.url).searchParams.get("as_of"));
      return HttpResponse.json({ as_of: "2026-11-18", currency: "USD", customers: [{ account: "a1", customer: "Acme Ltd", current: "100.00", "1-30": "50.00", "31-60": "0", "61-90": "0", "90+": "25.00", total: "175.00" }], totals: { current: "100.00", "1-30": "50.00", "31-60": "0", "61-90": "0", "90+": "25.00" }, total: "175.00" });
    }));
    renderWithProviders(<AgingPage />, { permissions: ["sales.view"] });
    expect(await screen.findByText("Acme Ltd")).toBeInTheDocument();
    expect(screen.getAllByText("175.00").length).toBe(2);
    fireEvent.change(screen.getByLabelText("As of"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(seen).toContain("2026-10-01"));
  });
  it("says when nothing is owed", async () => {
    server.use(http.get("*/api/v1/sales/receivables/aging", () => HttpResponse.json({ as_of: "2026-11-18", currency: "USD", customers: [], totals: {}, total: "0" })));
    renderWithProviders(<AgingPage />, { permissions: ["sales.view"] });
    expect(await screen.findByText("Nothing outstanding")).toBeInTheDocument();
  });
});

describe("ContractsPage", () => {
  it("lists contracts with customer names", async () => {
    server.use(ACCTS, http.get("*/api/v1/sales/contracts", () => page([contract({ status: "ACTIVE" })])));
    renderWithProviders(<ContractsPage />, { permissions: ["sales.view"] });
    expect(await screen.findByRole("link", { name: "CT-1" })).toHaveAttribute("href", "/app/sales/contracts/c1");
    expect(await screen.findByText("Acme Ltd")).toBeInTheDocument();
    expect(screen.getAllByText("In force").length).toBe(2);
    expect(screen.queryByRole("button", { name: "New contract" })).toBeNull();
  });
  it("validates then creates a contract with prices", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(ACCTS, PRODS, http.get("*/api/v1/sales/contracts", () => page([])), http.post("*/api/v1/sales/contracts", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(contract(), { status: 201 }); }));
    renderWithProviders(<ContractsPage />, { permissions: ["sales.view", "sales.quote.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "New contract" }));
    await userEvent.click(screen.getByRole("button", { name: "Create contract" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose the customer.");
    await userEvent.selectOptions(screen.getByLabelText("Customer"), await screen.findByRole("option", { name: "Acme Ltd" }));
    await userEvent.type(screen.getByLabelText("Title"), "Annual supply");
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2026-12-31" } });
    await userEvent.click(screen.getByRole("button", { name: "Add a price" }));
    await userEvent.selectOptions(screen.getByLabelText("Product 1"), await screen.findByRole("option", { name: /Widget/ }));
    await userEvent.type(screen.getByLabelText("Price 1"), "4.50");
    await userEvent.click(screen.getByRole("button", { name: "Create contract" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ account: "a1", title: "Annual supply", start_date: "2026-01-01", end_date: "2026-12-31", items: [{ product: "p1", min_quantity: "0", unit_price: "4.50" }] });
  });
});

describe("ContractDetailPage", () => {
  const mount = (c: object, perms: string[]) => {
    server.use(PRODS,
      http.get("*/api/v1/sales/contracts/c1", () => HttpResponse.json(c)),
      http.get("*/api/v1/sales/contracts/c1/utilisation", () => HttpResponse.json({ contract: "c1", currency: "USD", ordered: "12000.00", committed: "50000.00", percent: 24, remaining: "38000.00", obligations_open: 1, obligations_overdue: 1 })),
      http.get("*/api/v1/sales/contracts/c1/history", () => HttpResponse.json([{ version: 1, event: "CREATED", created_at: "2026-01-01T10:00:00Z" }])));
    renderWithProviders(<Routes><Route path="/app/sales/contracts/:id" element={<ContractDetailPage />} /></Routes>, { permissions: perms, route: "/app/sales/contracts/c1" });
  };
  it("shows use, prices, obligations and history", async () => {
    mount(contract(), ["sales.view"]);
    expect(await screen.findByText(/24%/)).toBeInTheDocument();
    expect(screen.getByText(/1 overdue/)).toBeInTheDocument();
    expect(await screen.findByText("SKU-1 — Widget")).toBeInTheDocument();
    expect(screen.getByText(/Quarterly review/)).toBeInTheDocument();
    expect(screen.getByText(/Version 1: Created/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Put in force" })).toBeNull();
  });
  it("activates a draft", async () => {
    let hit = false;
    mount(contract(), ["sales.view", "sales.order.approve"]);
    server.use(http.post("*/api/v1/sales/contracts/c1/activate", () => { hit = true; return HttpResponse.json(contract({ status: "ACTIVE" })); }));
    await userEvent.click(await screen.findByRole("button", { name: "Put in force" }));
    await waitFor(() => expect(hit).toBe(true));
  });
  it("marks an obligation done and adds one", async () => {
    let done = false; let added: Record<string, unknown> | null = null;
    mount(contract({ status: "ACTIVE" }), ["sales.view", "sales.quote.create"]);
    server.use(http.post("*/api/v1/sales/obligations/o1/done", () => { done = true; return HttpResponse.json({ id: "o1", done: true }); }),
      http.post("*/api/v1/sales/contracts/c1/obligations", async ({ request }) => { added = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "o2" }, { status: 201 }); }));
    await userEvent.click(await screen.findByRole("button", { name: "Mark done: Quarterly review" }));
    await waitFor(() => expect(done).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Add obligation" }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText("What must happen"), "Send price list");
    fireEvent.change(within(d).getByLabelText("Due date"), { target: { value: "2026-06-30" } });
    await userEvent.click(within(d).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(added).toEqual({ description: "Send price list", due_date: "2026-06-30", party: "US" }));
  });
  it("ends a contract early with a reason", async () => {
    let body: Record<string, unknown> | null = null;
    mount(contract({ status: "ACTIVE" }), ["sales.view", "sales.order.approve"]);
    server.use(http.post("*/api/v1/sales/contracts/c1/terminate", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(contract({ status: "TERMINATED" })); }));
    await userEvent.click(await screen.findByRole("button", { name: "End early" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "End contract" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("required");
    await userEvent.type(within(d).getByLabelText("Why is it ending?"), "Customer left");
    await userEvent.click(within(d).getByRole("button", { name: "End contract" }));
    await waitFor(() => expect(body).toEqual({ reason: "Customer left" }));
  });
});

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AccountsPage, accountSchema } from "./AccountsPage";
import { InvoicesPage } from "./InvoicesPage";
import { JournalsPage, journalSchema } from "./JournalsPage";
import { TrialBalancePage } from "./TrialBalancePage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const line = (account: string, debit: string, credit: string) => ({ account, debit, credit, description: "" });

describe("journalSchema", () => {
  const base = { entry_date: "2026-01-31", memo: "" };
  it("accepts a balanced entry", () => {
    expect(journalSchema.safeParse({ ...base, lines: [line("1000", "100.10", ""), line("4000", "", "100.10")] }).success).toBe(true);
  });
  it("rejects unbalanced, one-line, both-sided and empty lines", () => {
    expect(journalSchema.safeParse({ ...base, lines: [line("1000", "100", ""), line("4000", "", "99.99")] }).success).toBe(false);
    expect(journalSchema.safeParse({ ...base, lines: [line("1000", "100", "")] }).success).toBe(false);
    expect(journalSchema.safeParse({ ...base, lines: [line("1000", "100", "100"), line("4000", "", "")] }).success).toBe(false);
    expect(journalSchema.safeParse({ ...base, lines: [line("1000", "", ""), line("4000", "", "")] }).success).toBe(false);
  });
  it("is exact where floats are not (0.1 + 0.2 = 0.3)", () => {
    expect(journalSchema.safeParse({ ...base, lines: [line("1", "0.1", ""), line("1", "0.2", ""), line("2", "", "0.3")] }).success).toBe(true);
  });
  it("rejects malformed amounts", () => {
    expect(journalSchema.safeParse({ ...base, lines: [line("1", "1e3", ""), line("2", "", "1000")] }).success).toBe(false);
  });
});

describe("accountSchema", () => {
  it("requires code, name and a valid type", () => {
    expect(accountSchema.safeParse({ code: "1000", name: "Cash", type: "ASSET", is_postable: true }).success).toBe(true);
    expect(accountSchema.safeParse({ code: "", name: "Cash", type: "ASSET", is_postable: true }).success).toBe(false);
    expect(accountSchema.safeParse({ code: "1", name: "x", type: "OTHER", is_postable: true }).success).toBe(false);
  });
});

describe("AccountsPage", () => {
  it("lists accounts; creating needs the manage permission", async () => {
    server.use(http.get("*/api/v1/finance/accounts", () => page([{ id: "a1", code: "1000", name: "Cash", type: "ASSET", parent: null, is_postable: true, is_control: false, system_key: null, is_active: true }])));
    renderWithProviders(<AccountsPage />, { permissions: ["finance.accounts.view"] });
    expect(await screen.findByText("Cash")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New account" })).toBeNull();
  });
});

describe("JournalsPage", () => {
  const entry = { id: "j1", number: "JE-1", entry_date: "2026-01-31", memo: "m", status: "DRAFT", source_type: "", source_id: "", posted_at: null, reversed_by: null };
  it("blocks an unbalanced entry client-side and submits a balanced one", async () => {
    let body: any;
    server.use(
      http.get("*/api/v1/finance/journals", () => page([])),
      http.post("*/api/v1/finance/journals", async ({ request }) => { body = await request.json(); return HttpResponse.json(entry, { status: 201 }); }),
    );
    renderWithProviders(<JournalsPage />, { permissions: ["finance.accounts.view", "finance.journal.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "New entry" }));
    await userEvent.type(screen.getByLabelText("Line 1 account"), "1000");
    await userEvent.type(screen.getByLabelText("Line 1 debit"), "100.10");
    await userEvent.type(screen.getByLabelText("Line 2 account"), "4000");
    await userEvent.type(screen.getByLabelText("Line 2 credit"), "99");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Debits and credits must be equal")).toBeInTheDocument();
    expect(body).toBeUndefined();
    await userEvent.clear(screen.getByLabelText("Line 2 credit"));
    await userEvent.type(screen.getByLabelText("Line 2 credit"), "100.10");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(body.lines).toEqual([
      { account: "1000", debit: "100.10", credit: "0", description: "" },
      { account: "4000", debit: "0", credit: "100.10", description: "" },
    ]));
  });

  it("posts a draft entry from its detail dialog", async () => {
    let posted = false;
    const detail = { ...entry, lines: [{ line_no: 1, account: "1000", account_name: "Cash", debit: "5.0000", credit: "0.0000", description: "" }] };
    server.use(
      http.get("*/api/v1/finance/journals", () => page([entry])),
      http.get("*/api/v1/finance/journals/j1", () => HttpResponse.json(detail)),
      http.post("*/api/v1/finance/journals/j1/post", () => { posted = true; return HttpResponse.json({ ...detail, status: "POSTED" }); }),
    );
    renderWithProviders(<JournalsPage />, { permissions: ["finance.accounts.view", "finance.journal.post"] });
    await userEvent.click(await screen.findByRole("button", { name: "JE-1" }));
    expect(await screen.findByText("5.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(posted).toBe(true));
  });
});

describe("InvoicesPage", () => {
  const inv = (status: string) => ({ id: "i1", kind: "SUPPLIER_INVOICE", number: "INV-9", supplier_ref: "", partner: { id: "p", name: "Globex" }, invoice_date: "2026-01-05", due_date: null, currency: "USD", status, subtotal: "100.0000", tax_total: "15.0000", total: "115.0000", paid_amount: "0.0000", outstanding: "115.0000", lines: [{ line_no: 1, description: "Widgets", quantity: "1", unit_price: "100.0000", account: "5000", tax_rate: null, line_total: "100.0000", tax_amount: "15.0000" }] });
  const setup = (status: string) => server.use(
    http.get("*/api/v1/finance/invoices", () => page([inv(status)])),
    http.get("*/api/v1/finance/invoices/i1", () => HttpResponse.json(inv(status))),
  );

  it("offers only the actions that fit the state and the user's permissions", async () => {
    setup("SUBMITTED");
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.invoice.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "INV-9" }));
    expect(await screen.findByText("Widgets")).toBeInTheDocument();
    expect(screen.getAllByText("115.00", { selector: "dd" })).toHaveLength(2); // total and outstanding
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Void" })).toBeInTheDocument();
  });

  it("approves and surfaces a separation-of-duties error from the server", async () => {
    setup("SUBMITTED");
    server.use(http.post("*/api/v1/finance/invoices/i1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve your own invoice.", details: [] } }, { status: 403 })));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.invoice.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "INV-9" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("You cannot approve your own invoice.")).toBeInTheDocument();
  });

  it("posts an approved invoice", async () => {
    let posted = false;
    setup("APPROVED");
    server.use(http.post("*/api/v1/finance/invoices/i1/post", () => { posted = true; return HttpResponse.json(inv("POSTED")); }));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view", "finance.invoice.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "INV-9" }));
    await userEvent.click(await screen.findByRole("button", { name: "Post to ledger" }));
    await waitFor(() => expect(posted).toBe(true));
  });

  it("filters by status through the API", async () => {
    let seen = "";
    server.use(http.get("*/api/v1/finance/invoices", ({ request }) => { seen = new URL(request.url).search; return page([]); }));
    renderWithProviders(<InvoicesPage />, { permissions: ["finance.invoice.view"] });
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "POSTED");
    await waitFor(() => expect(seen).toContain("status=POSTED"));
  });
});

describe("TrialBalancePage", () => {
  it("shows totals and the balanced flag", async () => {
    server.use(http.get("*/api/v1/finance/reports/trial-balance", () => HttpResponse.json({ as_of: "2026-01-31", total_debit: "1000.0000", total_credit: "1000.0000", balanced: true, rows: [{ code: "1000", name: "Cash", type: "ASSET", debit: "1000.0000", credit: "0.0000", balance_debit: "1000.0000", balance_credit: "0.0000" }] })));
    renderWithProviders(<TrialBalancePage />, { permissions: ["reports.financial.view"] });
    expect(await screen.findByText("Balanced")).toBeInTheDocument();
    expect(screen.getAllByText("1,000.00").length).toBeGreaterThan(0);
  });
  it("shows an error when access is denied", async () => {
    server.use(http.get("*/api/v1/finance/reports/trial-balance", () => HttpResponse.json({ error: { code: "permission_denied", message: "Not allowed.", details: [] } }, { status: 403 })));
    renderWithProviders(<TrialBalancePage />, { permissions: [] });
    expect(await screen.findByRole("alert")).toHaveTextContent("Not allowed.");
  });
});

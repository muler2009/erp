import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { validateStatement } from "./NewStatementDialog";
import { StatementPage, StatementsPage } from "./ReconciliationPages";
import { parseStatementCsv } from "./statementCsv";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });

describe("parseStatementCsv", () => {
  it("reads lines, keeps commas in descriptions, skips a header", () => {
    const r = parseStatementCsv("date,description,amount\n2026-03-16,Acme, Inc payment,40.00\n2026-03-17,Fee,-2.50\n\n");
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([{ date: "2026-03-16", description: "Acme, Inc payment", amount: "40.00" }, { date: "2026-03-17", description: "Fee", amount: "-2.50" }]);
  });
  it("reports bad dates, zero and malformed amounts, and short rows with the line number", () => {
    const r = parseStatementCsv("16/03/2026,x,5\n2026-03-16,x,0\n2026-03-16,x,1e3\njunk");
    expect(r.lines).toEqual([]);
    expect(r.errors.map((e) => e.slice(0, 7))).toEqual(["Line 1:", "Line 2:", "Line 3:", "Line 4:"]);
  });
});

describe("validateStatement", () => {
  const ok = { bank: "b", date: "2026-03-31", opening: "100", closing: "137.5", lines: [{ amount: "40" }, { amount: "-2.50" }] };
  it("accepts a statement that adds up exactly", () => expect(validateStatement(ok)).toBeNull());
  it("is exact where floats are not", () => expect(validateStatement({ ...ok, opening: "0", closing: "0.3", lines: [{ amount: "0.1" }, { amount: "0.2" }] })).toBeNull());
  it("rejects what does not add up, no lines, no bank, bad numbers", () => {
    expect(validateStatement({ ...ok, closing: "138" })).toMatch(/does not equal/);
    expect(validateStatement({ ...ok, lines: [] })).toMatch(/at least one/);
    expect(validateStatement({ ...ok, bank: "" })).toMatch(/bank account/);
    expect(validateStatement({ ...ok, opening: "x" })).toMatch(/Opening/);
  });
});

describe("StatementsPage", () => {
  it("lists statements; creating needs the reconcile permission", async () => {
    server.use(http.get("*/api/v1/finance/bank-statements", () => page([{ id: "s1", bank_account: "b", bank_account_name: "Main", currency: "USD", statement_date: "2026-03-31", opening_balance: "0", closing_balance: "40", status: "OPEN", reconciled_at: null }])));
    renderWithProviders(<StatementsPage />, { permissions: ["finance.accounts.view"] });
    expect(await screen.findByText(/Main · 2026-03-31/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New statement" })).toBeNull();
  });

  it("posts a new statement with decimal strings and blocks one that does not add up", async () => {
    server.use(
      http.get("*/api/v1/finance/bank-statements", () => page([])),
      http.get("*/api/v1/finance/bank-accounts", () => page([{ id: "b1", name: "Main", currency: "USD", is_cash: false, is_active: true }])),
    );
    let body: any = null;
    server.use(http.post("*/api/v1/finance/bank-statements", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "s1" }, { status: 201 }); }));
    renderWithProviders(<StatementsPage />, { permissions: ["finance.accounts.view", "finance.bank.reconcile"] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New statement" }));
    await screen.findByRole("option", { name: "Main (USD)" });
    await user.selectOptions(screen.getByLabelText("Bank account"), "b1");
    await user.clear(screen.getByLabelText("Closing balance")); await user.type(screen.getByLabelText("Closing balance"), "50");
    await user.click(screen.getByLabelText(/^Lines/));
    await user.paste("2026-03-16,Acme,40.00");
    await user.click(screen.getByRole("button", { name: "Save statement" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not equal/);
    expect(body).toBeNull();
    await user.clear(screen.getByLabelText("Closing balance")); await user.type(screen.getByLabelText("Closing balance"), "40");
    await user.click(screen.getByRole("button", { name: "Save statement" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ bank_account: "b1", opening_balance: "0", closing_balance: "40", lines: [{ date: "2026-03-16", description: "Acme", amount: "40.00" }] });
  });
});

describe("StatementPage", () => {
  const stmt = (lines: unknown[], status = "OPEN") => ({ id: "s1", bank_account: "b", bank_account_name: "Main", currency: "USD", statement_date: "2026-03-31", opening_balance: "0.0000", closing_balance: "40.0000", status, reconciled_at: null, lines });
  const ln = (o: object) => ({ id: "l1", line_no: 1, date: "2026-03-16", description: "Acme", amount: "40.0000", matched: false, ledger_entry: null, ...o });
  const view = (perms: string[]) => renderWithProviders(<Routes><Route path="/app/finance/reconciliation/:id" element={<StatementPage />} /></Routes>, { permissions: perms, route: "/app/finance/reconciliation/s1" });

  it("matches a line to a candidate with the same amount", async () => {
    let q = ""; let body: any = null;
    server.use(
      http.get("*/api/v1/finance/bank-statements/s1", () => HttpResponse.json(stmt([ln({})]))),
      http.get("*/api/v1/finance/bank-statements/s1/candidates", ({ request }) => { q = new URL(request.url).search; return page([{ id: "jl1", entry: "JV-2026-000007", date: "2026-03-16", description: "Receipt", amount: "40.0000" }]); }),
      http.post("*/api/v1/finance/bank-statements/s1/lines/l1/match", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "l1", matched: true }); }),
    );
    view(["finance.accounts.view", "finance.bank.reconcile"]);
    const user = userEvent.setup();
    expect(await screen.findByText("0 of 1 lines matched")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconcile statement" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Match line 1" }));
    await user.click(await screen.findByRole("button", { name: "Match JV-2026-000007" }));
    await waitFor(() => expect(body).toEqual({ journal_line: "jl1" }));
    expect(q).toContain("amount=40.0000");
  });

  it("shows the server refusal when a match is rejected", async () => {
    server.use(
      http.get("*/api/v1/finance/bank-statements/s1", () => HttpResponse.json(stmt([ln({})]))),
      http.get("*/api/v1/finance/bank-statements/s1/candidates", () => page([{ id: "jl1", entry: "JV-1", date: "2026-03-16", description: "", amount: "40.0000" }])),
      http.post("*/api/v1/finance/bank-statements/s1/lines/l1/match", () => HttpResponse.json({ error: { code: "already_matched", message: "That ledger line is already matched to another statement line.", details: [] } }, { status: 409 })),
    );
    view(["finance.accounts.view", "finance.bank.reconcile"]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Match line 1" }));
    await user.click(await screen.findByRole("button", { name: "Match JV-1" }));
    expect(await screen.findByText(/already matched/)).toBeInTheDocument();
  });

  it("reconciles when every line is matched, and a reconciled statement has no actions", async () => {
    let called = false;
    server.use(
      http.get("*/api/v1/finance/bank-statements/s1", () => HttpResponse.json(stmt([ln({ matched: true, ledger_entry: "JV-1" })]))),
      http.post("*/api/v1/finance/bank-statements/s1/reconcile", () => { called = true; return HttpResponse.json(stmt([], "RECONCILED")); }),
    );
    view(["finance.accounts.view", "finance.bank.reconcile"]);
    const btn = await screen.findByRole("button", { name: "Reconcile statement" });
    expect(btn).toBeEnabled();
    await userEvent.setup().click(btn);
    await waitFor(() => expect(called).toBe(true));
  });

  it("hides the actions for a viewer and for a reconciled statement", async () => {
    server.use(http.get("*/api/v1/finance/bank-statements/s1", () => HttpResponse.json(stmt([ln({})]))));
    const first = view(["finance.accounts.view"]);
    await screen.findByText("0 of 1 lines matched");
    expect(screen.queryByRole("button", { name: "Match line 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconcile statement" })).toBeNull();
    first.unmount();
    server.use(http.get("*/api/v1/finance/bank-statements/s1", () => HttpResponse.json(stmt([ln({ matched: true, ledger_entry: "JV-1" })], "RECONCILED"))));
    view(["finance.accounts.view", "finance.bank.reconcile"]);
    await screen.findByText("Reconciled", { selector: "span" });
    expect(screen.queryByRole("button", { name: /Unmatch|Reconcile statement/ })).toBeNull();
  });
});

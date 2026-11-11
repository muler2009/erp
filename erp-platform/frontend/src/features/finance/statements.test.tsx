import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { BalanceSheetPage, ProfitLossPage } from "./StatementPages";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

describe("ProfitLossPage", () => {
  it("shows revenue, expenses and net profit and sends the period", async () => {
    let q = "";
    server.use(http.get("*/api/v1/finance/reports/profit-loss", ({ request }) => {
      q = new URL(request.url).search;
      return HttpResponse.json({ from: "2026-01-01", to: "2026-11-10", revenue: [{ code: "4000", name: "Sales", amount: "1000.0000" }], expenses: [{ code: "5000", name: "Rent", amount: "250.5000" }], total_revenue: "1000.0000", total_expenses: "250.5000", net_profit: "749.5000" });
    }));
    renderWithProviders(<ProfitLossPage />, { permissions: ["reports.financial.view"] });
    expect(await screen.findByText("4000 Sales")).toBeInTheDocument();
    expect(screen.getByText("5000 Rent")).toBeInTheDocument();
    expect(screen.getByText("Net profit").closest("tr")).toHaveTextContent("749.50");
    expect(q).toMatch(/from=\d{4}-01-01/);
    expect(q).toMatch(/to=\d{4}-\d{2}-\d{2}/);
  });
  it("refuses a reversed period without calling the server", async () => {
    server.use(http.get("*/api/v1/finance/reports/profit-loss", () => HttpResponse.json({ from: "", to: "", revenue: [], expenses: [], total_revenue: "0", total_expenses: "0", net_profit: "0" })));
    renderWithProviders(<ProfitLossPage />, { permissions: ["reports.financial.view"] });
    await screen.findByText("Net profit");
    const from = screen.getByLabelText("From");
    await userEvent.setup().clear(from);
    await userEvent.setup().type(from, "2999-01-01");
    expect(await screen.findByRole("alert")).toHaveTextContent(/on or before/);
  });
  it("shows the server error", async () => {
    server.use(http.get("*/api/v1/finance/reports/profit-loss", () => HttpResponse.json({ error: { code: "forbidden", message: "No access.", details: [] } }, { status: 403 })));
    renderWithProviders(<ProfitLossPage />, { permissions: ["reports.financial.view"] });
    expect(await screen.findByText("No access.")).toBeInTheDocument();
  });
});

describe("BalanceSheetPage", () => {
  const sheet = (balanced: boolean) => ({ as_of: "2026-11-10", assets: [{ code: "1000", name: "Cash", amount: "500.0000" }], liabilities: [{ code: "2000", name: "Payables", amount: "200.0000" }], equity: [{ code: "3000", name: "Capital", amount: "250.0000" }], current_earnings: "50.0000", total_assets: "500.0000", total_liabilities: "200.0000", total_equity: "300.0000", balanced });
  it("shows the three sections and the balance flag", async () => {
    server.use(http.get("*/api/v1/finance/reports/balance-sheet", () => HttpResponse.json(sheet(true))));
    renderWithProviders(<BalanceSheetPage />, { permissions: ["reports.financial.view"] });
    expect(await screen.findByText("1000 Cash")).toBeInTheDocument();
    expect(screen.getByText("Current earnings (unclosed)")).toBeInTheDocument();
    expect(screen.getByText("Balanced")).toBeInTheDocument();
  });
  it("flags an out-of-balance sheet", async () => {
    server.use(http.get("*/api/v1/finance/reports/balance-sheet", () => HttpResponse.json(sheet(false))));
    renderWithProviders(<BalanceSheetPage />, { permissions: ["reports.financial.view"] });
    expect(await screen.findByText("Out of balance")).toBeInTheDocument();
  });
});

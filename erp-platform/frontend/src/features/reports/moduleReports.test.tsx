import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { CrmSegmentsPage, SalesSummaryPage, SpendReportPage, periodProblem } from "./ModuleReports";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

it("checks the period", () => {
  expect(periodProblem("", "2026-01-01")).toMatch(/both dates/);
  expect(periodProblem("2026-02-01", "2026-01-01")).toMatch(/after the end/);
  expect(periodProblem("2026-01-01", "2026-01-01")).toBeNull();
});

describe("CrmSegmentsPage", () => {
  it("lists segments with totals", async () => {
    server.use(http.get("*/api/v1/crm/segments", () => HttpResponse.json([{ segment: "Enterprise", accounts: 7 }, { segment: "SMB", accounts: 3 }])));
    renderWithProviders(<CrmSegmentsPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText("Enterprise")).toBeInTheDocument();
    expect(screen.getByText("2 segments · 10 accounts")).toBeInTheDocument();
  });
  it("explains an empty list", async () => {
    server.use(http.get("*/api/v1/crm/segments", () => HttpResponse.json([])));
    renderWithProviders(<CrmSegmentsPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText("No segments yet")).toBeInTheDocument();
  });
});

describe("SalesSummaryPage", () => {
  it("shows both tables and re-queries on a new period", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/sales/reports/sales", ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ by_customer: [{ customer: "Acme", currency: "USD", orders: 2, total: "300.00" }], by_product: [{ sku: "W-1", currency: "USD", quantity: "5.0000", revenue: "300.00" }] }); }));
    renderWithProviders(<SalesSummaryPage />, { permissions: ["sales.view"] });
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("W-1")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    await waitFor(() => expect(seen.some((s) => s.includes("from=2026-01-01"))).toBe(true));
  });
  it("does not call the server for a backwards period", async () => {
    let calls = 0;
    server.use(http.get("*/api/v1/sales/reports/sales", () => { calls++; return HttpResponse.json({ by_customer: [], by_product: [] }); }));
    renderWithProviders(<SalesSummaryPage />, { permissions: ["sales.view"] });
    await screen.findByText("No orders in this period");
    const before = calls;
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2000-01-01" } });
    expect(await screen.findByText(/start date is after/)).toBeInTheDocument();
    expect(calls).toBe(before);
  });
});

describe("SpendReportPage", () => {
  it("lists suppliers", async () => {
    server.use(http.get("*/api/v1/procurement/reports/spend", () => HttpResponse.json({ rows: [{ supplier: "Globex", currency: "EUR", ordered: "1000.00", invoiced: "400.00" }] })));
    renderWithProviders(<SpendReportPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByText("Globex")).toBeInTheDocument();
  });
  it("shows the server error", async () => {
    server.use(http.get("*/api/v1/procurement/reports/spend", () => HttpResponse.json({ error: { code: "invalid_date", message: "from and to (YYYY-MM-DD) are required." } }, { status: 400 })));
    renderWithProviders(<SpendReportPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByRole("alert")).toHaveTextContent("required");
  });
});

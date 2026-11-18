import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { SalesAnalyticsPage, concentration, defaultRange, monthLabel, pct } from "./AnalyticsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const PERF = { period: ["2026-08-19", "2026-11-17"], orders: 4, revenue: "4000.00", average_order_value: "1000.00", average_discount_percent: 5.5, win_rate_percent: 60, avg_sales_cycle_days: 12.5, quote_to_order_percent: null,
  trend: { "2026-09": "1000.00", "2026-10": "3000.00" }, top_customers: [{ account: "a1", name: "Acme Ltd", revenue: "3000.00", share_percent: 75 }], top5_share_percent: 100, concentration_hhi: 6250 };
const BACKLOG = { to_deliver: "800.00", to_invoice: "1200.00", orders: 2, oldest: [{ order: "SO-7", customer: "Acme Ltd", age_days: 40, to_deliver: "500.00", to_invoice: "700.00" }] };
const FORECAST = { months: 3, backlog: "800.00", worst: "900.00", likely: "1500.00", best: "2500.00", monthly_run_rate: "1333.33", run_rate_over_horizon: "4000.00", pipeline_by_month: { "2026-12": { worst: "10.00", likely: "50.00", best: "100.00" } } };
const base = [http.get("*/api/v1/sales/analytics/backlog", () => HttpResponse.json(BACKLOG))];

describe("helpers", () => {
  it("formats", () => {
    expect(defaultRange(new Date("2026-11-17T00:00:00Z"))).toEqual({ from: "2026-08-20", to: "2026-11-17" });
    expect(pct(null)).toBe("–");
    expect(pct(12.5)).toBe("12.5%");
    expect(concentration(3000)).toMatch(/dominate/);
    expect(concentration(2000)).toMatch(/Moderately/);
    expect(concentration(900)).toMatch(/spread/);
    expect(monthLabel("2026-09")).toMatch(/2026/);
  });
});

describe("SalesAnalyticsPage", () => {
  it("shows performance, backlog and the forecast", async () => {
    let months = "";
    server.use(...base, http.get("*/api/v1/sales/analytics/performance", () => HttpResponse.json(PERF)),
      http.get("*/api/v1/sales/analytics/forecast", ({ request }) => { months = new URL(request.url).searchParams.get("months") ?? ""; return HttpResponse.json(FORECAST); }));
    renderWithProviders(<SalesAnalyticsPage />, { permissions: ["sales.view"] });
    expect(await screen.findByText("Acme Ltd · 3,000.00 (75%)")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText(/Very concentrated/)).toBeInTheDocument();
    expect(await screen.findByText("SO-7")).toBeInTheDocument();
    expect(await screen.findByText("1,500.00")).toBeInTheDocument();
    expect(months).toBe("3");
  });

  it("asks the forecast for another horizon", async () => {
    const asked: string[] = [];
    server.use(...base, http.get("*/api/v1/sales/analytics/performance", () => HttpResponse.json(PERF)),
      http.get("*/api/v1/sales/analytics/forecast", ({ request }) => { asked.push(new URL(request.url).searchParams.get("months") ?? ""); return HttpResponse.json(FORECAST); }));
    renderWithProviders(<SalesAnalyticsPage />, { permissions: ["sales.view"] });
    await screen.findByText("1,500.00");
    await userEvent.selectOptions(screen.getByLabelText("Months ahead"), "6");
    await waitFor(() => expect(asked).toContain("6"));
  });

  it("does not ask for a reversed range and shows a message instead", async () => {
    const seen: URLSearchParams[] = [];
    server.use(...base, http.get("*/api/v1/sales/analytics/performance", ({ request }) => { seen.push(new URL(request.url).searchParams); return HttpResponse.json(PERF); }), http.get("*/api/v1/sales/analytics/forecast", () => HttpResponse.json(FORECAST)));
    renderWithProviders(<SalesAnalyticsPage />, { permissions: ["sales.view"] });
    await screen.findByText("Acme Ltd · 3,000.00 (75%)");
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2020-01-01" } });
    expect(await screen.findByText(/end date that is not before it/)).toBeInTheDocument();
    expect(seen.every((p) => (p.get("to") as string) >= (p.get("from") as string))).toBe(true);
  });

  it("shows empty states and an error with retry", async () => {
    server.use(http.get("*/api/v1/sales/analytics/backlog", () => HttpResponse.json({ to_deliver: "0.00", to_invoice: "0.00", orders: 0, oldest: [] })),
      http.get("*/api/v1/sales/analytics/performance", () => HttpResponse.json({ error: { code: "x", message: "Boom" } }, { status: 500 })),
      http.get("*/api/v1/sales/analytics/forecast", () => HttpResponse.json({ ...FORECAST, pipeline_by_month: {} })));
    renderWithProviders(<SalesAnalyticsPage />, { permissions: ["sales.view"] });
    expect(await screen.findByText("No open orders")).toBeInTheDocument();
    expect(await screen.findByText(/Boom/)).toBeInTheDocument();
  });
});

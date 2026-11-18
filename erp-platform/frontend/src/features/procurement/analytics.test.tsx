import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ProcurementAnalyticsPage, pct } from "./AnalyticsPage";
import { ProcurementOverviewPage } from "./OverviewPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const WQ = { open_requisitions: 3, orders_awaiting_approval: 0, overdue_delivery_lines: 1, pending_inspections: 2, match_exceptions: 4, contracts_expiring_60d: 0, open_claims: 0, returns_awaiting_credit: 0, supplier_documents_expiring_30d: 1 };
const LATE = { po: "PO-7", supplier: "Globex", line: 1, open_quantity: "6.0000", due_date: "2026-11-01", days_late: 17 };

describe("ProcurementOverviewPage", () => {
  it("shows the work queue with links where a screen exists, and late deliveries", async () => {
    server.use(http.get("*/api/v1/procurement/work-queue", () => HttpResponse.json(WQ)), http.get("*/api/v1/procurement/overdue-deliveries", () => HttpResponse.json({ results: [LATE] })));
    renderWithProviders(<ProcurementOverviewPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByText("Late delivery lines", { selector: "div,span,dd" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Invoices that do not match/ })).toHaveAttribute("href", "/app/procurement/match-exceptions");
    expect(screen.getByRole("link", { name: /waiting for inspection/ })).toHaveAttribute("href", "/app/procurement/receiving");
    expect(screen.queryByRole("link", { name: /Late delivery lines|Supplier documents/ })).toBeNull();
    expect(await screen.findByText("PO-7")).toBeInTheDocument();
    expect(screen.getByText("17 days")).toBeInTheDocument();
    expect(screen.getByText("Globex")).toBeInTheDocument();
  });
  it("says nothing is late", async () => {
    server.use(http.get("*/api/v1/procurement/work-queue", () => HttpResponse.json(WQ)), http.get("*/api/v1/procurement/overdue-deliveries", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<ProcurementOverviewPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByText("Nothing is late")).toBeInTheDocument();
  });
});

describe("ProcurementAnalyticsPage", () => {
  const seen: Record<string, URLSearchParams> = {};
  const handlers = () => [
    http.get("*/api/v1/procurement/analytics/cycle-times", ({ request }) => { seen.cycle = new URL(request.url).searchParams; return HttpResponse.json({ requisition_to_po_days: "2.5", po_to_receipt_days: null, samples: { requisition_to_po: 4, po_to_receipt: 0 } }); }),
    http.get("*/api/v1/procurement/analytics/supplier-performance", () => HttpResponse.json({ results: [{ supplier: "Globex", orders: 5, receipt_lines: 9, on_time_pct: "88.9", rejection_pct: null, defect_pct: "2.0", claims: 1, claimed: "150.00" }] })),
    http.get("*/api/v1/procurement/analytics/spend", ({ request }) => { const g = new URL(request.url).searchParams.get("group_by"); seen.spend = new URL(request.url).searchParams; return HttpResponse.json({ results: [{ key: g === "month" ? "2026-10-01" : "Globex", currency: "USD", orders: 5, ordered: "12000.00" }] }); }),
    http.get("*/api/v1/procurement/analytics/price-variance", () => HttpResponse.json({ results: [{ po: "PO-7", line: 1, estimated: "10.00", actual: "11.00", variance_pct: "10.0" }] })),
  ];
  it("formats percentages", () => { expect(pct(null)).toBe("–"); expect(pct("5.0")).toBe("5.0%"); });
  it("shows all four reports", async () => {
    server.use(...handlers());
    renderWithProviders(<ProcurementAnalyticsPage />, { permissions: ["procurement.view"] });
    expect(await screen.findByText("2.5 days")).toBeInTheDocument();
    expect(screen.getByText("–", { selector: "dd" })).toBeInTheDocument();
    expect(await screen.findByText("88.9%")).toBeInTheDocument();
    expect(await screen.findByText("12,000.00")).toBeInTheDocument();
    expect(await screen.findByText("+10.0%")).toBeInTheDocument();
    expect(seen.cycle?.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("regroups spending and rejects a backwards date range", async () => {
    server.use(...handlers());
    renderWithProviders(<ProcurementAnalyticsPage />, { permissions: ["procurement.view"] });
    await screen.findByText("12,000.00");
    await userEvent.selectOptions(screen.getByLabelText("Group by"), "month");
    await waitFor(() => expect(seen.spend?.get("group_by")).toBe("month"));
    expect(await screen.findByText("2026-10-01")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2000-01-01" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("not before it");
  });
});

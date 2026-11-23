import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AssetSetupPage } from "./AssetSetupPage";
import { AcquisitionsReportPage, AssetLookupPage } from "./AssetTools";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const CAT = { id: "c1", code: "IT", name: "Computers", parent: null, prefix: "IT", asset_class: "IT", capitalization_threshold: "100.00", depreciation_method: "SL", useful_life_months: 36, residual_percent: "5.00", reducing_rate_percent: null, tracking: "NONE", requires_serial: false, requires_insurance: false, is_active: true };

describe("category edit", () => {
  it("is hidden without permission", async () => {
    server.use(http.get("*/api/v1/assets/categories", () => HttpResponse.json({ results: [CAT] })), http.get("*/api/v1/assets/locations", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<AssetSetupPage />, { permissions: ["assets.view"] });
    await screen.findByText(/Computers/);
    expect(screen.queryByRole("button", { name: "Edit category IT" })).toBeNull();
  });
  it("validates, then saves and shows server refusals", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get("*/api/v1/assets/categories", () => HttpResponse.json({ results: [CAT] })),
      http.get("*/api/v1/assets/locations", () => HttpResponse.json({ results: [] })),
      http.patch("*/api/v1/assets/categories/c1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ error: { code: "x", message: "Category cannot be its own ancestor." } }, { status: 400 }); }),
    );
    renderWithProviders(<AssetSetupPage />, { permissions: ["assets.view", "assets.category.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Edit category IT" }));
    const life = await screen.findByLabelText("Useful life (months)");
    await userEvent.clear(life); await userEvent.type(life, "0");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/whole number of months/)).toBeInTheDocument();
    expect(body).toBeNull();
    await userEvent.clear(life); await userEvent.type(life, "48");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Category cannot be its own ancestor.")).toBeInTheDocument();
    expect(body).toMatchObject({ name: "Computers", useful_life_months: 48, depreciation_method: "SL", is_active: true });
  });
});

describe("AssetLookupPage", () => {
  it("asks for a code, finds an asset, and shows a not-found message", async () => {
    server.use(http.get("*/api/v1/assets/lookup", ({ request }) => {
      const c = new URL(request.url).searchParams.get("code");
      return c === "BC1" ? HttpResponse.json({ id: "a1", number: "IT-001", name: "Laptop", category: { id: "c1", code: "IT" }, status: "IN_USE", location: null }) : HttpResponse.json({ error: { code: "not_found", message: "No asset carries this code." } }, { status: 404 });
    }));
    renderWithProviders(<AssetLookupPage />, { permissions: ["assets.view"] });
    await userEvent.click(screen.getByRole("button", { name: "Find asset" }));
    expect(await screen.findByText("Scan or type a code.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Code"), "BC1{enter}");
    expect(await screen.findByRole("link", { name: "IT-001" })).toHaveAttribute("href", "/app/assets/register/a1");
    await userEvent.clear(screen.getByLabelText("Code")); await userEvent.type(screen.getByLabelText("Code"), "ZZ{enter}");
    expect(await screen.findByText("No asset carries this code.")).toBeInTheDocument();
  });
});

describe("AcquisitionsReportPage", () => {
  it("lists rows with a total and rejects a backwards range", async () => {
    let q = "";
    server.use(http.get("*/api/v1/assets/reports/acquisitions", ({ request }) => { q = new URL(request.url).search; return HttpResponse.json({ results: [{ number: "CAP-1", asset: "IT-001", name: "Laptop", category: "IT", date: "2026-03-01", capitalized: true, total_cost: "1000.00", base_amount: "1000.00" }, { number: "CAP-2", asset: "IT-002", name: "Mouse", category: "IT", date: "2026-03-02", capitalized: false, total_cost: "20.00", base_amount: "0.00" }] }); }));
    renderWithProviders(<AcquisitionsReportPage />, { permissions: ["assets.view"] });
    expect(await screen.findByText("CAP-1")).toBeInTheDocument();
    expect(screen.getByText("Expensed")).toBeInTheDocument();
    expect(screen.getByText(/2 acquisitions/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("From (optional)"), { target: { value: "2026-05-01" } });
    fireEvent.change(screen.getByLabelText("To (optional)"), { target: { value: "2026-04-01" } });
    expect(await screen.findByText(/start date is after/)).toBeInTheDocument();
    expect(q).not.toContain("2026-04-01");
  });
});

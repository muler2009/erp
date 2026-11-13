import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AssetPage, MANUAL_NEXT, validateStatusChange } from "./AssetPage";
import { AssetSetupPage, validateCategory } from "./AssetSetupPage";
import { AssetsPage, validateAsset } from "./AssetsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const asset = (o = {}) => ({ id: "a1", number: "FA-0001", name: "Laptop", description: "", category: { id: "c1", code: "IT" }, asset_class: "IT", status: "RECEIVED", manufacturer: "", model: "", serial_number: "SN1", acquisition_date: "2026-01-05", purchase_cost: "1200.00", currency: "USD", location: { id: "l1", code: "HQ" }, department_id: null, custodian_id: null, barcode: "", qr_code: "", rfid_tag: "", version: 3, ...o });
const cat = { id: "c1", code: "IT", name: "IT equipment", parent: null, prefix: "IT", asset_class: "IT", capitalization_threshold: "500.00", depreciation_method: "SL", useful_life_months: 36, residual_percent: "0.00", reducing_rate_percent: null, tracking: "NONE", requires_serial: false, requires_insurance: false, is_active: true };

describe("validators", () => {
  it("asset, status, category", () => {
    expect(validateAsset({ category: "", name: "x", purchase_cost: "", acquisition_date: "" })).toMatch(/category/);
    expect(validateAsset({ category: "c", name: " ", purchase_cost: "", acquisition_date: "" })).toMatch(/name/);
    expect(validateAsset({ category: "c", name: "x", purchase_cost: "-1", acquisition_date: "" })).toMatch(/zero or more/);
    expect(validateAsset({ category: "c", name: "x", purchase_cost: "10.50", acquisition_date: "2026-01-01" })).toBeNull();
    expect(validateStatusChange("RETIRED", " ")).toMatch(/reason/); expect(validateStatusChange("AVAILABLE", "")).toBeNull();
    expect(MANUAL_NEXT.AVAILABLE).toEqual(["RETIRED"]);
    const ok = { code: "IT", name: "IT", method: "SL", life: "36", residual: "5", rate: "", threshold: "500" };
    expect(validateCategory({ ...ok, code: "it" })).toMatch(/capital letters/);
    expect(validateCategory({ ...ok, life: "0" })).toMatch(/whole number/);
    expect(validateCategory({ ...ok, residual: "150" })).toMatch(/0 to 100/);
    expect(validateCategory({ ...ok, method: "RB" })).toMatch(/annual rate/);
    expect(validateCategory({ ...ok, method: "NON", life: "" })).toBeNull();
    expect(validateCategory(ok)).toBeNull();
  });
});

describe("AssetsPage", () => {
  it("lists assets, passes filters to the server and hides New asset without permission", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/assets/categories", () => HttpResponse.json({ results: [cat] })),
      http.get("*/api/v1/assets/assets", ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ results: [asset()] }); }));
    renderWithProviders(<AssetsPage />, { permissions: ["assets.view"] });
    expect(await screen.findByText("FA-0001")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New asset" })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "AVAILABLE");
    await waitFor(() => expect(seen.some((s) => s.includes("status=AVAILABLE"))).toBe(true));
  });
  it("creates an asset sending money as a string and refuses a negative cost locally", async () => {
    server.use(http.get("*/api/v1/assets/categories", () => HttpResponse.json({ results: [cat] })), http.get("*/api/v1/assets/assets", () => HttpResponse.json({ results: [] })));
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/assets", async ({ request }) => { sent = await request.json(); return HttpResponse.json(asset(), { status: 201 }); }));
    renderWithProviders(<AssetsPage />, { permissions: ["assets.view", "assets.asset.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New asset" }));
    const d = within(screen.getByRole("dialog", { name: "New asset" }));
    await userEvent.selectOptions(await d.findByLabelText("Category"), "c1");
    await userEvent.type(d.getByLabelText("Name"), "Laptop"); await userEvent.type(d.getByLabelText("Purchase cost"), "-5");
    await userEvent.click(d.getByRole("button", { name: "Create asset" }));
    expect(await screen.findByText(/zero or more/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Purchase cost")); await userEvent.type(d.getByLabelText("Purchase cost"), "1200.00");
    await userEvent.click(d.getByRole("button", { name: "Create asset" }));
    await waitFor(() => expect(sent).toEqual({ category: "c1", name: "Laptop", purchase_cost: "1200.00" }));
  });
});

describe("AssetPage", () => {
  const view = (a = asset(), permissions = ["assets.view", "assets.asset.manage"]) => {
    server.use(http.get("*/api/v1/assets/assets/a1", () => HttpResponse.json(a)),
      http.get("*/api/v1/assets/assets/a1/acquisition", () => HttpResponse.json({ error: { code: "acquisition_required", message: "Record the asset's acquisition first." } }, { status: 409 })),
      http.get("*/api/v1/assets/assets/a1/warranties", () => HttpResponse.json({ in_force: null, all: [] })),
      http.get("*/api/v1/assets/assets/a1/history", () => HttpResponse.json({ results: [{ at: "2026-01-05T10:00:00Z", event: "STATUS_CHANGED", detail: {}, note: "Received", actor: null }] })),
      http.get("*/api/v1/assets/assets/a1/schedule", () => HttpResponse.json({ error: { code: "not_capitalized", message: "Only a capitalized asset has a depreciation schedule." } }, { status: 409 })),
      http.get("*/api/v1/assets/locations", () => HttpResponse.json({ results: [{ id: "l1", code: "HQ", name: "Head office", parent: null, is_active: true }] })));
    return renderWithProviders(<Routes><Route path="/app/assets/register/:id" element={<AssetPage />} /></Routes>, { permissions, route: "/app/assets/register/a1" });
  };
  it("shows details, history and the server's reason there is no schedule", async () => {
    view();
    expect(await screen.findByText("FA-0001 — Laptop")).toBeInTheDocument();
    expect(await screen.findByText(/Only a capitalized asset has a depreciation schedule/)).toBeInTheDocument();
    expect(await screen.findByText(/Status changed: Received/)).toBeInTheDocument();
  });
  it("offers only the legal manual moves and requires a reason to retire", async () => {
    view(asset({ status: "AVAILABLE" }));
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/assets/a1/status", async ({ request }) => { sent = await request.json(); return HttpResponse.json(asset({ status: "RETIRED" })); }));
    expect(await screen.findByRole("button", { name: "Mark Retired" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark Ordered" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Mark Retired" }));
    const d = within(screen.getByRole("dialog", { name: "Mark Retired" }));
    await userEvent.click(d.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("A reason is required to retire an asset.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText("Reason"), "Beyond repair");
    await userEvent.click(d.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(sent).toEqual({ status: "RETIRED", reason: "Beyond repair" }));
  });
  it("sends the version with an edit and shows a conflict from the server", async () => {
    view();
    let sent: Record<string, unknown> = {};
    server.use(http.patch("*/api/v1/assets/assets/a1", async ({ request }) => { sent = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ error: { code: "version_conflict", message: "Someone else changed this asset; reload and try again." } }, { status: 409 }); }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const d = within(screen.getByRole("dialog", { name: "Edit asset" }));
    await userEvent.type(d.getByLabelText("Name"), "Laptop Pro");
    await userEvent.click(d.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Someone else changed this asset/)).toBeInTheDocument();
    expect(sent).toEqual({ version: 3, name: "Laptop Pro" });
  });
  it("hides actions without manage permission", async () => {
    view(asset({ status: "AVAILABLE" }), ["assets.view"]);
    await screen.findByText("FA-0001 — Laptop");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark Retired" })).toBeNull();
  });
});

describe("AssetSetupPage", () => {
  it("creates a category with decimal strings and refuses an invalid code locally", async () => {
    server.use(http.get("*/api/v1/assets/categories", () => HttpResponse.json({ results: [] })), http.get("*/api/v1/assets/locations", () => HttpResponse.json({ results: [] })));
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/categories", async ({ request }) => { sent = await request.json(); return HttpResponse.json(cat, { status: 201 }); }));
    renderWithProviders(<AssetSetupPage />, { permissions: ["assets.view", "assets.category.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New category" }));
    const d = within(screen.getByRole("dialog", { name: "New asset category" }));
    await userEvent.type(d.getByLabelText("Code"), "it"); await userEvent.type(d.getByLabelText("Name"), "IT equipment");
    await userEvent.selectOptions(d.getByLabelText("Class"), "IT"); await userEvent.selectOptions(d.getByLabelText("Depreciation"), "SL");
    await userEvent.type(d.getByLabelText("Useful life (months)"), "36"); await userEvent.type(d.getByLabelText("Capitalisation threshold"), "500.00");
    await userEvent.click(d.getByRole("button", { name: "Create category" }));
    expect(await screen.findByText(/capital letters/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Code")); await userEvent.type(d.getByLabelText("Code"), "IT");
    await userEvent.click(d.getByRole("button", { name: "Create category" }));
    await waitFor(() => expect(sent).toEqual({ code: "IT", name: "IT equipment", asset_class: "IT", depreciation_method: "SL", useful_life_months: 36, capitalization_threshold: "500.00", requires_serial: false }));
    expect(screen.queryByRole("button", { name: "New location" })).toBeNull();
  });
});

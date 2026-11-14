import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { CountsPage, RESOLUTIONS, validateScan } from "./CountsPage";
import { DisposalsPage, validateDisposal, validateExecution } from "./DisposalsPage";
import { PlanningPage, validateBudget, validateReplacement } from "./PlanningPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const fixedAssets = http.get("*/api/v1/assets/assets", () => HttpResponse.json({ results: [{ id: "a1", number: "FA-1", name: "Press", status: "IN_USE", category: { id: "c", code: "M" } }] }));
const cats = http.get("*/api/v1/assets/categories", () => HttpResponse.json({ results: [{ id: "c1", code: "IT", name: "IT" }] }));
const locs = http.get("*/api/v1/assets/locations", () => HttpResponse.json({ results: [{ id: "l1", code: "HQ", name: "Head office", parent: null, is_active: true }] }));
const disp = (o = {}) => ({ id: "d1", number: "DSP-1", asset: { id: "a1", number: "FA-1" }, method: "SALE", status: "REQUESTED", reason: "Obsolete", proposed_on: "2026-11-01", expected_proceeds: "100.0000", buyer: "Abel", executed_on: null, proceeds: "0.0000", nbv_at_disposal: null, gain_loss: null, requested_by: "u", decided_by: null, ...o });

describe("validators", () => {
  it("disposal, execution, scan, replacement, budget", () => {
    const d = { asset: "a", method: "SALE", reason: "r", expected_proceeds: "", buyer: "B" };
    expect(validateDisposal({ ...d, asset: "" })).toMatch(/asset/);
    expect(validateDisposal({ ...d, reason: " " })).toMatch(/reason/);
    expect(validateDisposal({ ...d, buyer: "" })).toMatch(/buyer/);
    expect(validateDisposal({ ...d, method: "SCRAP", buyer: "" })).toBeNull();
    expect(validateDisposal({ ...d, expected_proceeds: "x" })).toMatch(/number/);
    expect(validateExecution("5", "SCRAP")).toMatch(/Only a sale/);
    expect(validateExecution("-1", "SALE")).toMatch(/zero or more/);
    expect(validateExecution("5", "SALE")).toBeNull();
    expect(validateScan("  ")).toMatch(/barcode/);
    expect(validateScan("FA-1")).toBeNull();
    const r = { asset: "a", planned_year: "2027", estimated_cost: "10", reason: "r" };
    expect(validateReplacement({ ...r, planned_year: "27" })).toMatch(/four digits/);
    expect(validateReplacement({ ...r, estimated_cost: "0" })).toMatch(/positive/);
    expect(validateReplacement(r)).toBeNull();
    expect(validateBudget("2027", "-5")).toMatch(/positive/);
    expect(validateBudget("2027", "5000")).toBeNull();
    expect(RESOLUTIONS.MISSING).toContain("WRITE_OFF_REQUESTED");
  });
});

describe("DisposalsPage", () => {
  it("offers actions by permission and state", async () => {
    server.use(http.get("*/api/v1/assets/disposals", () => HttpResponse.json({ results: [disp(), disp({ id: "d2", number: "DSP-2", status: "APPROVED" })] })));
    const { unmount } = renderWithProviders(<DisposalsPage />, { permissions: ["assets.view"] });
    expect(await screen.findByText("DSP-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve|Execute|Request/ })).toBeNull();
    unmount();
    server.use(fixedAssets);
    renderWithProviders(<DisposalsPage />, { permissions: ["assets.view", "assets.disposal.manage", "assets.disposal.approve"] });
    expect(await screen.findByRole("button", { name: "Approve DSP-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Execute DSP-2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Execute DSP-1" })).toBeNull();
  });

  it("requires a buyer for a sale and sends the request", async () => {
    server.use(http.get("*/api/v1/assets/disposals", () => HttpResponse.json({ results: [] })), fixedAssets);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/disposals", async ({ request }) => { sent = await request.json(); return HttpResponse.json(disp(), { status: 201 }); }));
    renderWithProviders(<DisposalsPage />, { permissions: ["assets.view", "assets.disposal.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Request a disposal" }));
    const d = within(screen.getByRole("dialog", { name: "Request a disposal" }));
    await userEvent.selectOptions(await d.findByLabelText("Asset"), "a1");
    await userEvent.type(d.getByLabelText("Reason"), "Obsolete");
    await userEvent.click(d.getByRole("button", { name: "Submit for approval" }));
    expect(await d.findByText("Name the buyer for a sale.")).toBeInTheDocument();
    expect(sent).toBeUndefined();
    await userEvent.type(d.getByLabelText("Buyer"), "Abel");
    await userEvent.click(d.getByRole("button", { name: "Submit for approval" }));
    await waitFor(() => expect(sent).toEqual({ asset: "a1", method: "SALE", reason: "Obsolete", buyer: "Abel" }));
  });

  it("shows the server's separation-of-duties refusal on approve", async () => {
    server.use(http.get("*/api/v1/assets/disposals", () => HttpResponse.json({ results: [disp()] })),
      http.post("*/api/v1/assets/disposals/d1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: someone else must approve this disposal." } }, { status: 403 })));
    renderWithProviders(<DisposalsPage />, { permissions: ["assets.view", "assets.disposal.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Approve DSP-1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/someone else must approve/);
  });

  it("executes an approved sale and opens the certificate of a completed one", async () => {
    let list = [disp({ status: "APPROVED" })];
    server.use(http.get("*/api/v1/assets/disposals", () => HttpResponse.json({ results: list })));
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/disposals/d1/execute", async ({ request }) => { sent = await request.json(); list = [disp({ status: "COMPLETED", executed_on: "2026-11-13", proceeds: "90.0000", nbv_at_disposal: "70.0000", gain_loss: "20.0000" })]; return HttpResponse.json(list[0]); }),
      http.get("*/api/v1/assets/disposals/d1/certificate", () => HttpResponse.json({ number: "DSP-1", asset: "FA-1", name: "Press", serial_number: "SN1", method: "SALE", executed_on: "2026-11-13", buyer: "Abel", buyer_reference: "", reason: "Obsolete", net_book_value: "70.0000", proceeds: "90.0000", gain_loss: "20.0000", approved_by: "u2", executed_by: "u3" })));
    renderWithProviders(<DisposalsPage />, { permissions: ["assets.view", "assets.disposal.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Execute DSP-1" }));
    const d = within(screen.getByRole("dialog", { name: "Execute disposal" }));
    await userEvent.type(d.getByLabelText(/Proceeds received/), "90");
    await userEvent.click(d.getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(sent).toEqual({ proceeds: "90" }));
    await userEvent.click(await screen.findByRole("button", { name: "Certificate DSP-1" }));
    expect(await screen.findByText("SN1")).toBeInTheDocument();
  });
});

describe("CountsPage", () => {
  const count = (o = {}) => ({ id: "n1", number: "CNT-1", name: "Q4 count", status: "OPEN", started_on: "2026-11-01", lines: 12, ...o });

  it("scans an asset and shows its discrepancy", async () => {
    server.use(http.get("*/api/v1/assets/verification-counts", () => HttpResponse.json({ results: [count()] })), locs);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/verification-counts/n1/scan", async ({ request }) => { sent = await request.json(); return HttpResponse.json({ id: "ln", asset: "FA-1", expected: true, found: true, discrepancy: "FOUND_ELSEWHERE", resolution: "" }, { status: 201 }); }));
    renderWithProviders(<CountsPage />, { permissions: ["assets.view", "assets.verification.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Scan CNT-1" }));
    const d = within(screen.getByRole("dialog", { name: /Scan assets/ }));
    await userEvent.click(d.getByRole("button", { name: "Record scan" }));
    expect(await d.findByText(/Scan or type/)).toBeInTheDocument();
    await userEvent.type(d.getByLabelText("Code"), "FA-1");
    await userEvent.click(d.getByRole("button", { name: "Record scan" }));
    await waitFor(() => expect(sent).toEqual({ code: "FA-1" }));
    expect(await d.findByText("FA-1 — Found elsewhere")).toBeInTheDocument();
  });

  it("resolves a discrepancy only with the allowed choices and blocks closing until all are resolved", async () => {
    server.use(http.get("*/api/v1/assets/verification-counts", () => HttpResponse.json({ results: [count({ status: "IN_REVIEW" })] })),
      http.get("*/api/v1/assets/verification-counts/n1/report", () => HttpResponse.json({ count: "CNT-1", status: "IN_REVIEW", expected: 12, found: 11, accuracy_percent: "91.67", discrepancies: [{ id: "ln1", asset: "FA-9", kind: "MISSING", resolution: "", notes: "" }] })));
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/count-lines/ln1/resolve", async ({ request }) => { sent = await request.json(); return HttpResponse.json({ id: "ln1", resolution: "FOUND" }); }));
    renderWithProviders(<CountsPage />, { permissions: ["assets.view", "assets.verification.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Results CNT-1" }));
    expect(await screen.findByText(/11 of 12 expected assets found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close the count" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Resolve FA-9" }));
    const d = within(screen.getByRole("dialog", { name: "Resolve FA-9" }));
    expect(d.queryByRole("option", { name: "Location updated" })).toBeNull();
    await userEvent.selectOptions(d.getByLabelText(/Resolution/), "FOUND");
    await userEvent.click(d.getByRole("button", { name: "Record resolution" }));
    await waitFor(() => expect(sent).toEqual({ resolution: "FOUND", notes: "" }));
  });
});

const DASH = { assets_by_status: { IN_USE: 7 }, value: { gross_value: "1000.0000", accumulated_depreciation: "100.0000", impairment: "0.0000", net_book_value: "900.0000" }, reconciled: false, maintenance: { open_work_orders: 4, overdue: 2, unavailable_assets: 1 }, inspections: { overdue: 3, open_findings: 5 }, expiring_30_days: { warranties: 1, policies: 1, vehicles: 0 }, uninsured_required: 2, custody: { unreturned: 0, unacknowledged: 1 }, utilization_30d: { idle: 1, underutilized: 2 }, open_disposals: 1, open_counts: 0, replacement_candidates: 6 };
const dashboard = http.get("*/api/v1/assets/dashboard", () => HttpResponse.json(DASH));

describe("PlanningPage", () => {
  it("shows dashboard tiles and flags a ledger mismatch", async () => {
    server.use(http.get("*/api/v1/assets/dashboard", () => HttpResponse.json({ assets_by_status: { IN_USE: 7 }, value: { gross_value: "1000.0000", accumulated_depreciation: "100.0000", impairment: "0.0000", net_book_value: "900.0000" }, reconciled: false, maintenance: { open_work_orders: 4, overdue: 2, unavailable_assets: 1 }, inspections: { overdue: 3, open_findings: 5 }, expiring_30_days: { warranties: 1, policies: 1, vehicles: 0 }, uninsured_required: 2, custody: { unreturned: 0, unacknowledged: 1 }, utilization_30d: { idle: 1, underutilized: 2 }, open_disposals: 1, open_counts: 0, replacement_candidates: 6 })));
    renderWithProviders(<PlanningPage />, { permissions: ["assets.view"] });
    expect(await screen.findByText("Register does not match the ledger")).toBeInTheDocument();
    expect(screen.getByText("Overdue inspections").nextSibling).toHaveTextContent("3");
    expect(screen.getByText((_, el) => el?.tagName === "LI" && el.textContent === "In use: 7")).toBeInTheDocument();
  });

  it("plans a replacement from a candidate and lets an approver reject with a reason", async () => {
    server.use(dashboard, fixedAssets, cats,
      http.get("*/api/v1/assets/replacement-candidates", () => HttpResponse.json([{ asset: "FA-1", name: "Press", category: "M", reasons: ["END_OF_LIFE"], gross_value: "1200.0000", maintenance_cost_12m: "300.0000", breakdowns_12m: 4, already_planned: false }])),
      http.get("*/api/v1/assets/replacement-plan", () => HttpResponse.json({ results: [{ id: "r1", asset: { id: "a1", number: "FA-2" }, planned_year: 2027, estimated_cost: "900.0000", reason: "Old", status: "PLANNED" }] })));
    let created: unknown, rejected: unknown;
    server.use(http.post("*/api/v1/assets/replacement-plan", async ({ request }) => { created = await request.json(); return HttpResponse.json({}, { status: 201 }); }),
      http.post("*/api/v1/assets/replacement-plan/r1/reject", async ({ request }) => { rejected = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<PlanningPage />, { permissions: ["assets.view", "assets.valuation.manage", "assets.valuation.approve"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Replacement" }));
    await userEvent.click(await screen.findByRole("button", { name: "Plan replacement of FA-1" }));
    const d = within(await screen.findByRole("dialog", { name: "Plan a replacement" }));
    await waitFor(() => expect(d.getByLabelText("Asset")).toHaveValue("a1"));
    await userEvent.click(d.getByRole("button", { name: "Add to the plan" }));
    await waitFor(() => expect(created).toEqual({ asset: "a1", planned_year: new Date().getFullYear() + 1, estimated_cost: "1200.0000", reason: "End of life" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reject FA-2 replacement" }));
    const r = within(screen.getByRole("dialog", { name: "Reject replacement" }));
    await userEvent.click(r.getByRole("button", { name: "Reject" }));
    expect(await r.findByText("Reason is required.")).toBeInTheDocument();
    await userEvent.type(r.getByLabelText(/Reason/), "Not yet");
    await userEvent.click(r.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(rejected).toEqual({ note: "Not yet" }));
  });

  it("shows the capex report with an over-budget flag", async () => {
    server.use(dashboard, cats, http.get("*/api/v1/assets/capex-budgets", () => HttpResponse.json({ results: [{ id: "b1", year: new Date().getFullYear(), category: "c1", amount: "5000.0000", status: "PROPOSED", notes: "" }] })),
      http.get("*/api/v1/assets/reports/capex", () => HttpResponse.json({ year: new Date().getFullYear(), rows: [{ category: "IT", budget: "5000.0000", actual: "6000.0000", planned_replacements: "0.0000", remaining: "-1000.0000", over_budget: true }] })));
    renderWithProviders(<PlanningPage />, { permissions: ["assets.view", "assets.valuation.approve"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Capital budget" }));
    expect(await screen.findByText("Over budget")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: new RegExp(`Approve ${new Date().getFullYear()} IT budget`) })).toBeInTheDocument();
  });
});

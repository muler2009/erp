import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { CoveragePage, validateClaim, validatePolicy } from "./CoveragePage";
import { InspectionsPage, validateCompletion, validateTemplate } from "./InspectionsPage";
import { validateWarranty } from "./WarrantyCard";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const MAN = ["assets.view", "assets.maintenance.manage"];
const INS = ["assets.view", "assets.insurance.manage"];
const tpl = { id: "t1", code: "GEN", name: "General", category: null, items: [{ text: "Casing intact", kind: "PASS_FAIL" }, { text: "Hours", kind: "READING" }], is_active: true };
const insp = (o = {}) => ({ id: "i1", asset: { id: "a1", number: "FA-1" }, template: "t1", status: "SCHEDULED", scheduled_on: "2026-11-15", performed_on: null, inspector_id: null, condition_result: "", results: [], notes: "", findings: [], evidence: [], ...o });
const fixedAssets = http.get("*/api/v1/assets/assets", () => HttpResponse.json({ results: [{ id: "a1", number: "FA-1", name: "Press", status: "IN_USE", category: { id: "c", code: "M" } }] }));

function inspBase(list: unknown[]) {
  server.use(http.get("*/api/v1/assets/inspections", () => HttpResponse.json({ results: list })), http.get("*/api/v1/assets/inspection-templates", () => HttpResponse.json({ results: [tpl] })), fixedAssets);
}

describe("validators", () => {
  it("completion, template, policy, claim, warranty", () => {
    const items = tpl.items as never[];
    expect(validateCompletion(items, ["PASS", "10"], "", [])).toMatch(/condition/);
    expect(validateCompletion(items, ["", "10"], "GOOD", [])).toMatch(/pass or fail/);
    expect(validateCompletion(items, ["PASS", " "], "GOOD", [])).toMatch(/reading/);
    expect(validateCompletion(items, ["FAIL", "10"], "POOR", [])).toMatch(/finding/);
    expect(validateCompletion(items, ["FAIL", "10"], "POOR", [{ description: " ", severity: "LOW" }])).toMatch(/description/);
    expect(validateCompletion(items, ["PASS", "10"], "GOOD", [])).toBeNull();
    expect(validateTemplate("", "n", [{ text: "x", kind: "PASS_FAIL" }])).toMatch(/code/);
    expect(validateTemplate("c", "n", [{ text: " ", kind: "PASS_FAIL" }])).toMatch(/item/);
    expect(validatePolicy({ policy_number: "P", insurer: "I", start_on: "2026-02-01", end_on: "2026-01-01", premium: "", coverage_amount: "" })).toMatch(/end on or after/);
    expect(validatePolicy({ policy_number: "P", insurer: "I", start_on: "2026-01-01", end_on: "2026-12-31", premium: "x", coverage_amount: "" })).toMatch(/Premium/);
    expect(validateClaim({ asset: "a", incident_date: "2027-01-01", description: "d", amount: "" }, { start_on: "2026-01-01", end_on: "2026-12-31" })).toMatch(/policy period/);
    expect(validateClaim({ asset: "a", incident_date: "2026-06-01", description: "d", amount: "5" }, { start_on: "2026-01-01", end_on: "2026-12-31" })).toBeNull();
    expect(validateWarranty("Dell", "2026-02-01", "2026-01-01")).toMatch(/end on or after/);
  });
});

describe("InspectionsPage", () => {
  it("hides scheduling and completing from read-only users", async () => {
    inspBase([insp()]);
    renderWithProviders(<InspectionsPage />, { permissions: ["assets.view"] });
    expect(await screen.findByText("FA-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Schedule|Complete/ })).toBeNull();
  });

  it("requires a finding for a failed item, then sends the checklist answers", async () => {
    inspBase([insp()]);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/inspections/i1/complete", async ({ request }) => { sent = await request.json(); return HttpResponse.json(insp({ status: "COMPLETED" })); }));
    renderWithProviders(<InspectionsPage />, { permissions: MAN });
    await userEvent.click(await screen.findByRole("button", { name: "Complete FA-1" }));
    const d = within(screen.getByRole("dialog", { name: /Complete inspection/ }));
    await userEvent.selectOptions(d.getByLabelText("Casing intact"), "FAIL");
    await userEvent.type(d.getByLabelText("Hours"), "1200");
    await userEvent.selectOptions(d.getByLabelText("Condition found"), "POOR");
    await userEvent.click(d.getByRole("button", { name: "Record inspection" }));
    expect(await d.findByText(/must be recorded as a finding/)).toBeInTheDocument();
    expect(sent).toBeUndefined();
    await userEvent.click(d.getByRole("button", { name: "Add a finding" }));
    await userEvent.type(d.getByLabelText("Finding 1 description"), "Cracked casing");
    await userEvent.selectOptions(d.getByLabelText("Finding 1 severity"), "HIGH");
    await userEvent.click(d.getByRole("button", { name: "Record inspection" }));
    await waitFor(() => expect(sent).toEqual({ results: [{ result: "FAIL" }, { result: "1200" }], condition: "POOR", notes: "", findings: [{ description: "Cracked casing", severity: "HIGH" }] }));
  });

  it("raises a repair from an open finding and shows a server refusal", async () => {
    inspBase([insp({ status: "COMPLETED", performed_on: "2026-11-10", condition_result: "POOR", findings: [{ id: "f1", description: "Cracked casing", severity: "HIGH", status: "OPEN", work_order: null }] })]);
    server.use(http.post("*/api/v1/assets/findings/f1/corrective-action", () => HttpResponse.json({ error: { code: "already_pending", message: "A repair is already open for this asset." } }, { status: 409 })));
    renderWithProviders(<InspectionsPage />, { permissions: MAN });
    await userEvent.click(await screen.findByRole("button", { name: "Raise repair for: Cracked casing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already open/);
  });

  it("shows the condition report with overdue inspections", async () => {
    inspBase([]);
    server.use(http.get("*/api/v1/assets/reports/condition", () => HttpResponse.json({ by_category: [{ category: "IT", NEW: 1, GOOD: 4, FAIR: 0, POOR: 2, DAMAGED: 0 }], never_inspected: 3, open_findings: 5, overdue_inspections: [{ id: "i9", asset: "FA-9", scheduled_on: "2026-10-01", days_overdue: 43 }] })));
    renderWithProviders(<InspectionsPage />, { permissions: ["assets.view"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Condition" }));
    expect(await screen.findByText(/3 asset\(s\) never inspected/)).toBeInTheDocument();
    expect(screen.getByText(/FA-9 — due 2026-10-01 \(43 days overdue\)/)).toBeInTheDocument();
  });
});

describe("CoveragePage", () => {
  const policy = { id: "p1", policy_number: "H-1", insurer: "Nyala", start_on: "2026-01-01", end_on: "2026-12-31", premium: "500.0000", coverage_amount: "9000.0000", assets: [{ asset: "a1", insured_value: "1200.0000" }] };
  const claim = (o = {}) => ({ id: "c1", kind: "insurance", status: "FILED", description: "Water damage", amount_claimed: "100.0000", amount_recovered: "0.0000", asset: "FA-1", source: "H-1", date: "2026-06-01", ...o });

  it("lists policies with asset numbers and rejects a claim outside the policy period", async () => {
    server.use(http.get("*/api/v1/assets/insurance-policies", () => HttpResponse.json({ results: [policy] })), fixedAssets);
    renderWithProviders(<CoveragePage />, { permissions: INS });
    expect(await screen.findByText(/FA-1 \(1,?200/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "File a claim on H-1" }));
    const d = within(screen.getByRole("dialog", { name: "File an insurance claim" }));
    await userEvent.selectOptions(d.getByLabelText("Insured asset"), "a1");
    await userEvent.type(d.getByLabelText("What happened"), "Fire");
    await userEvent.type(d.getByLabelText("Incident date"), "2027-03-01");
    await userEvent.click(d.getByRole("button", { name: "File claim" }));
    expect(await d.findByText(/within the policy period/)).toBeInTheDocument();
  });

  it("accepts a filed claim and settles an accepted one with a recovered amount", async () => {
    let list = [claim()];
    server.use(http.get("*/api/v1/assets/claims", () => HttpResponse.json({ results: list })));
    let accepted = false, settled: unknown;
    server.use(
      http.post("*/api/v1/assets/claims/insurance/c1/accept", () => { accepted = true; list = [claim({ status: "ACCEPTED" })]; return HttpResponse.json(claim({ status: "ACCEPTED" })); }),
      http.post("*/api/v1/assets/claims/insurance/c1/settle", async ({ request }) => { settled = await request.json(); return HttpResponse.json(claim({ status: "SETTLED" })); }));
    server.use(http.get("*/api/v1/assets/insurance-policies", () => HttpResponse.json({ results: [] })), fixedAssets);
    renderWithProviders(<CoveragePage />, { permissions: INS });
    await userEvent.click(await screen.findByRole("tab", { name: "Claims" }));
    await userEvent.click(await screen.findByRole("button", { name: "Accept FA-1 claim" }));
    await waitFor(() => expect(accepted).toBe(true));
    await userEvent.click(await screen.findByRole("button", { name: "Settle FA-1 claim" }));
    const d = within(screen.getByRole("dialog", { name: "Settle claim" }));
    await userEvent.type(d.getByLabelText(/Amount recovered/), "80");
    await userEvent.click(d.getByRole("button", { name: "Record settlement" }));
    await waitFor(() => expect(settled).toEqual({ amount_recovered: "80" }));
  });

  it("shows uninsured assets and what expires soon", async () => {
    server.use(http.get("*/api/v1/assets/insurance-policies", () => HttpResponse.json({ results: [] })), fixedAssets,
      http.get("*/api/v1/assets/reports/coverage/uninsured", () => HttpResponse.json([{ asset: "FA-7", name: "Truck", category: "VEH", gross_value: "50000.0000" }])),
      http.get("*/api/v1/assets/reports/coverage/expiring", () => HttpResponse.json({ warranties: [{ asset: "FA-2", provider: "Dell", end_on: "2026-11-30" }], policies: [{ policy: "H-1", insurer: "Nyala", end_on: "2026-12-01", renewed: false }] })));
    renderWithProviders(<CoveragePage />, { permissions: ["assets.view"] });
    await userEvent.click(await screen.findByRole("tab", { name: "Watch list" }));
    expect(await screen.findByText(/FA-7 Truck/)).toBeInTheDocument();
    expect(await screen.findByText(/Warranty on FA-2 \(Dell\) ends 2026-11-30/)).toBeInTheDocument();
    expect(screen.getByText("Not renewed")).toBeInTheDocument();
  });
});

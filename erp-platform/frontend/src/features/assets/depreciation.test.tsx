import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { validateAdjustment, validatePolicy } from "./AssetPage";
import { DepreciationPage, validatePeriod } from "./DepreciationPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const totals = { gross_value: "1200.0000", accumulated_depreciation: "30.0000", impairment: "0.0000", net_book_value: "1170.0000" };
function base(over: { reconciled?: boolean; adjustments?: unknown[] } = {}) {
  server.use(
    http.get("*/api/v1/assets/depreciation/runs", () => HttpResponse.json({ results: [{ id: "r1", period: "2026-03", status: "POSTED", total: "30.0000", assets: 1 }] })),
    http.get("*/api/v1/assets/reports/valuation", () => HttpResponse.json({ as_of: null, rows: [{ asset: "FA-1", name: "Laptop", category: "IT", gross_value: "1200.0000", accumulated_depreciation: "30.0000", impairment: "0.0000", net_book_value: "1170.0000" }], totals })),
    http.get("*/api/v1/assets/reports/reconciliation", () => HttpResponse.json(over.reconciled === false ? { register_cost: "1200", ledger_cost: "1100", cost_difference: "100", register_accumulated: "30", ledger_accumulated: "30", accumulated_difference: "0", reconciled: false } : { register_cost: "1200", ledger_cost: "1200", cost_difference: "0", register_accumulated: "30", ledger_accumulated: "30", accumulated_difference: "0", reconciled: true })),
    http.get("*/api/v1/assets/categories", () => HttpResponse.json({ results: [{ id: "c1", code: "IT", name: "IT" }] })),
    http.get("*/api/v1/assets/adjustments", () => HttpResponse.json({ results: over.adjustments ?? [{ id: "j1", asset: "FA-1", kind: "IMPAIRMENT", status: "REQUESTED", amount: "50.0000", effective_date: "2026-03-31", reason: "Water", extend_life_months: 0, decision_note: "" }] })));
}

describe("validators", () => {
  it("period, adjustment and policy", () => {
    expect(validatePeriod("26", "3")).toMatch(/year/);
    expect(validatePeriod("2026", "13")).toMatch(/month/);
    expect(validatePeriod("2026", "3")).toBeNull();
    const a = { kind: "IMPAIRMENT", amount: "10", effective_date: "2026-03-31", reason: "r", extend: "" };
    expect(validateAdjustment({ ...a, amount: "x" })).toMatch(/number/);
    expect(validateAdjustment({ ...a, amount: "0" })).toMatch(/greater than zero/);
    expect(validateAdjustment({ ...a, kind: "REVALUATION", amount: "0" })).toBeNull();
    expect(validateAdjustment({ ...a, reason: " " })).toMatch(/why/);
    expect(validateAdjustment({ ...a, extend: "1.5" })).toMatch(/whole number/);
    expect(validatePolicy({ reason: "r", life: "", residual: "" })).toMatch(/at least/);
    expect(validatePolicy({ reason: "r", life: "0", residual: "" })).toMatch(/at least 1/);
    expect(validatePolicy({ reason: "r", life: "48", residual: "" })).toBeNull();
  });
});

describe("DepreciationPage", () => {
  it("shows runs, valuation totals and a reconciled badge", async () => {
    base();
    renderWithProviders(<DepreciationPage />, { permissions: ["assets.view"] });
    expect(await screen.findByText("2026-03")).toBeInTheDocument();
    expect(await screen.findByText("Reconciled")).toBeInTheDocument();
    expect(await screen.findByText(/FA-1 Laptop/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run depreciation" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reverse 2026-03/ })).toBeNull();
  });

  it("flags a ledger difference", async () => {
    base({ reconciled: false });
    renderWithProviders(<DepreciationPage />, { permissions: ["assets.view"] });
    expect(await screen.findByText("Does not reconcile")).toBeInTheDocument();
  });

  it("runs depreciation and shows the server refusal for a gap", async () => {
    base();
    let body: unknown;
    let n = 0;
    server.use(http.post("*/api/v1/assets/depreciation/runs", async ({ request }) => {
      body = await request.json();
      return n++ === 0 ? HttpResponse.json({ error: { code: "run_out_of_sequence", message: "Run 2026-04 first." } }, { status: 409 }) : HttpResponse.json({ id: "r2", period: "2026-04", status: "POSTED", total: "30.0000", assets: 1 }, { status: 201 });
    }));
    renderWithProviders(<DepreciationPage />, { permissions: ["assets.view", "assets.depreciation.run"] });
    await userEvent.click(await screen.findByRole("button", { name: "Run depreciation" }));
    const d = within(screen.getByRole("dialog", { name: "Run depreciation" }));
    await userEvent.type(d.getByLabelText(/Year/), "2026");
    await userEvent.type(d.getByLabelText(/Month/), "5");
    await userEvent.click(d.getByRole("button", { name: "Post run" }));
    expect(await within(screen.getByRole("dialog", { name: "Run depreciation" })).findByText(/Run 2026-04 first/)).toBeInTheDocument();
    expect(body).toEqual({ year: 2026, month: 5 });
  });

  it("requires a reason to reverse a run", async () => {
    base();
    let body: unknown;
    server.use(http.post("*/api/v1/assets/depreciation/runs/r1/reverse", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "r1", period: "2026-03", status: "REVERSED", total: "30.0000", assets: 1 }); }));
    renderWithProviders(<DepreciationPage />, { permissions: ["assets.view", "assets.depreciation.run"] });
    await userEvent.click(await screen.findByRole("button", { name: "Reverse 2026-03" }));
    const d = within(screen.getByRole("dialog", { name: "Reverse 2026-03" }));
    await userEvent.click(d.getByRole("button", { name: "Reverse run" }));
    expect(await d.findByText("Reason is required.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText(/Reason/), "Wrong life");
    await userEvent.click(d.getByRole("button", { name: "Reverse run" }));
    await waitFor(() => expect(body).toEqual({ reason: "Wrong life" }));
  });

  it("approves and rejects adjustments only with the approve permission", async () => {
    base();
    const { unmount } = renderWithProviders(<DepreciationPage />, { permissions: ["assets.view"] });
    expect(await screen.findByText(/Impairment 50/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve FA-1/ })).toBeNull();
    unmount();
    let rej: unknown;
    server.use(http.post("*/api/v1/assets/adjustments/j1/reject", async ({ request }) => { rej = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<DepreciationPage />, { permissions: ["assets.view", "assets.valuation.approve"] });
    expect(await screen.findByRole("button", { name: "Approve FA-1 Impairment" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reject FA-1 Impairment" }));
    const d = within(screen.getByRole("dialog", { name: "Reject adjustment" }));
    await userEvent.click(d.getByRole("button", { name: "Reject" }));
    expect(await d.findByText("Reason is required.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText(/Reason/), "No evidence");
    await userEvent.click(d.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(rej).toEqual({ note: "No evidence" }));
  });

  it("shows the server's separation-of-duties refusal on approve", async () => {
    base();
    server.use(http.post("*/api/v1/assets/adjustments/j1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve your own request." } }, { status: 409 })));
    renderWithProviders(<DepreciationPage />, { permissions: ["assets.view", "assets.valuation.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Approve FA-1 Impairment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot approve your own/);
  });
});

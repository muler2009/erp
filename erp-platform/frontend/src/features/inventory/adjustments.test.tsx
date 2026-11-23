import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AdjustmentsPage, adjustmentInput, adjustmentProblem, thresholdProblem, type AdjDraft } from "./AdjustmentsPage";
import { LandedCostsPage, landedCostInput, landedCostProblem } from "./LandedCostsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const prod = { id: "p1", sku: "CH-1", name: "Chain", uom: "pc", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "5" };
const d = (o: Partial<AdjDraft> = {}): AdjDraft => ({ product: prod as never, location: "l1", mode: "delta", amount: "-3", lot: "", unit_cost: "", reason_code: "DAMAGE", reason: "Dropped", ...o });
const row = (o = {}) => ({ id: "a1", number: "ADJ-1", sku: "CH-1", location: "A1", delta: "-3.0000", estimated_value: "30.0000", reason_code: "DAMAGE", reason: "Dropped", status: "PENDING", requested_by: "u1", decided_by: null, ...o });
const list = (rows: object[]) => http.get("*/api/v1/inventory/adjustment-requests", () => HttpResponse.json({ results: rows, next: null }));
const policy = (t: string | null = "100") => http.get("*/api/v1/inventory/adjustment-policy", () => HttpResponse.json({ threshold: t }));

describe("helpers", () => {
  it("adjustmentProblem", () => {
    expect(adjustmentProblem(d())).toBeNull();
    expect(adjustmentProblem(d({ product: null }))).toMatch(/product/);
    expect(adjustmentProblem(d({ location: "" }))).toMatch(/location/);
    expect(adjustmentProblem(d({ amount: "abc" }))).toMatch(/change/);
    expect(adjustmentProblem(d({ mode: "counted", amount: "-1" }))).toMatch(/negative/);
    expect(adjustmentProblem(d({ unit_cost: "x" }))).toMatch(/unit cost/);
    expect(adjustmentProblem(d({ reason: " " }))).toMatch(/reason/);
  });
  it("adjustmentInput sends exactly one of delta / counted", () => {
    expect(adjustmentInput(d())).toMatchObject({ delta: "-3" });
    expect(adjustmentInput(d())).not.toHaveProperty("counted_quantity");
    expect(adjustmentInput(d({ mode: "counted", amount: "7" }))).toMatchObject({ counted_quantity: "7" });
  });
  it("thresholdProblem / landed cost rules", () => {
    expect(thresholdProblem("")).toBeNull();
    expect(thresholdProblem("500")).toBeNull();
    expect(thresholdProblem("-5")).toMatch(/number/);
    const lc = { ref_type: "GoodsReceipt", ref_id: "GR-1", amount: "50", description: "Freight", basis: "VALUE" as const, date: "" };
    expect(landedCostProblem(lc)).toBeNull();
    expect(landedCostProblem({ ...lc, ref_id: "" })).toMatch(/receipt/);
    expect(landedCostProblem({ ...lc, amount: "0" })).toMatch(/more than 0/);
    expect(landedCostProblem({ ...lc, description: "" })).toMatch(/Describe/);
    expect(landedCostInput({ ...lc, date: "2026-11-01" })).toMatchObject({ date: "2026-11-01" });
  });
});

describe("AdjustmentsPage", () => {
  it("approves with the separation-of-duties message surfaced from the server", async () => {
    server.use(policy(), list([row()]), http.post("*/api/v1/inventory/adjustment-requests/a1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you cannot approve your own adjustment." } }, { status: 403 })));
    renderWithProviders(<AdjustmentsPage />, { permissions: ["inventory.view", "inventory.stock.adjust", "inventory.adjustment.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Approve ADJ-1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/cannot approve your own/)).toBeInTheDocument();
  });

  it("rejection needs a reason, then sends it", async () => {
    let body: unknown = null;
    server.use(policy(), list([row()]), http.post("*/api/v1/inventory/adjustment-requests/a1/reject", async ({ request }) => { body = await request.json(); return HttpResponse.json(row({ status: "REJECTED" })); }));
    renderWithProviders(<AdjustmentsPage />, { permissions: ["inventory.view", "inventory.stock.adjust", "inventory.adjustment.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Reject ADJ-1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Give a reason for rejecting.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Reason \(required\)/), "Not verified");
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(body).toEqual({ note: "Not verified" }));
  });

  it("hides approval buttons without permission and explains the policy", async () => {
    server.use(policy("100"), list([row({ status: "POSTED" })]));
    renderWithProviders(<AdjustmentsPage />, { permissions: ["inventory.view", "inventory.stock.adjust"] });
    expect(await screen.findByText("ADJ-1")).toBeInTheDocument();
    expect(await screen.findByText(/up to 100\.00 post straight away/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.queryByLabelText("Limit (empty for none)")).toBeNull();
  });

  it("saves the approval limit, empty meaning none", async () => {
    let body: unknown = null;
    server.use(policy("100"), list([]), http.put("*/api/v1/inventory/adjustment-policy", async ({ request }) => { body = await request.json(); return HttpResponse.json({ threshold: null }); }));
    renderWithProviders(<AdjustmentsPage />, { permissions: ["inventory.view", "inventory.adjustment.approve"] });
    const input = await screen.findByLabelText("Limit (empty for none)");
    await waitFor(() => expect(input).toHaveValue("100"));
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole("button", { name: "Save limit" }));
    await waitFor(() => expect(body).toEqual({ threshold: null }));
  });

  it("creates a request after choosing product and location", async () => {
    let body: unknown = null;
    server.use(policy(), list([]),
      http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [prod], next: null })),
      http.get("*/api/v1/inventory/warehouses", () => HttpResponse.json({ results: [{ id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "MAIN", address: "", locations: [{ id: "l1", code: "A1", kind: "STORAGE", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }, { id: "l2", code: "B1", kind: "STORAGE", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: true }] }], next: null })),
      http.post("*/api/v1/inventory/adjustment-requests", async ({ request }) => { body = await request.json(); return HttpResponse.json(row(), { status: 201 }); }));
    renderWithProviders(<AdjustmentsPage />, { permissions: ["inventory.view", "inventory.stock.adjust"] });
    await userEvent.click(await screen.findByRole("button", { name: "Request adjustment" }));
    await userEvent.click(await screen.findByRole("button", { name: "Send request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/product/);
    await userEvent.type(screen.getByRole("combobox", { name: "Product" }), "ch");
    await userEvent.click(await screen.findByRole("button", { name: /CH-1/ }));
    const loc = await screen.findByLabelText("Location");
    await waitFor(() => expect(Array.from((loc as HTMLSelectElement).options).map((o) => o.text)).toContain("MAIN / A1"));
    expect(Array.from((loc as HTMLSelectElement).options).map((o) => o.text)).not.toContain("MAIN / B1");
    await userEvent.selectOptions(loc, "l1");
    await userEvent.type(screen.getByLabelText("Change"), "-3");
    await userEvent.type(screen.getByLabelText("Explanation"), "Dropped");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(body).toMatchObject({ product: "p1", location: "l1", delta: "-3", reason: "Dropped" }));
  });

  it("attaches evidence as a file upload", async () => {
    let size = 0;
    server.use(policy(), list([row()]), http.post("*/api/v1/inventory/adjustment-requests/a1/evidence", async ({ request }) => { size = ((await request.formData()).get("file") as File).size; return HttpResponse.json({ file_id: "f", name: "x.png" }, { status: 201 }); }));
    renderWithProviders(<AdjustmentsPage />, { permissions: ["inventory.view", "inventory.stock.adjust"] });
    await userEvent.upload(await screen.findByLabelText("Evidence for ADJ-1"), new File(["abc"], "x.png", { type: "image/png" }));
    await waitFor(() => expect(size).toBe(3));
  });
});

describe("LandedCostsPage", () => {
  it("lists allocations and creates a cost", async () => {
    let body: unknown = null;
    server.use(
      http.get("*/api/v1/inventory/landed-costs", () => HttpResponse.json({ results: [{ id: "c1", number: "LC-1", ref_type: "GoodsReceipt", ref_id: "GR-1", description: "Freight", amount: "100.0000", basis: "VALUE", allocations: [{ sku: "CH-1", share: "100.0000", to_inventory: "60.0000", to_cogs: "40.0000" }] }], next: null })),
      http.post("*/api/v1/inventory/landed-costs", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "c2", number: "LC-2" }, { status: 201 }); }));
    renderWithProviders(<LandedCostsPage />, { permissions: ["inventory.view", "inventory.landed_cost.manage"] });
    expect(await screen.findByText(/LC-1/)).toBeInTheDocument();
    expect(screen.getByText("40.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add landed cost" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add cost" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/receipt/);
    await userEvent.type(screen.getByLabelText("Receipt number"), "GR-1");
    await userEvent.type(screen.getByLabelText("Amount"), "50");
    await userEvent.type(screen.getByLabelText("What is it"), "Duty");
    await userEvent.click(screen.getByRole("button", { name: "Add cost" }));
    await waitFor(() => expect(body).toEqual({ ref_type: "GoodsReceipt", ref_id: "GR-1", amount: "50", description: "Duty", basis: "VALUE" }));
  });

  it("empty state and no add button without permission", async () => {
    server.use(http.get("*/api/v1/inventory/landed-costs", () => HttpResponse.json({ results: [], next: null })));
    renderWithProviders(<LandedCostsPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("No landed costs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add landed cost" })).toBeNull();
  });
});

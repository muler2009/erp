import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { BomsPage, bomProblem, type BomDraft } from "./BomsPage";
import { LinesProfilePage, lineProblem, profileProblem } from "./LinesProfilePage";
import { PlansPage, reviseProblem } from "./PlansPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const prod = (id: string, sku: string) => ({ id, sku, name: sku, uom: "pc", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "0" });
const products = http.get("*/api/v1/inventory/products", ({ request }) => { const s = (new URL(request.url).searchParams.get("search") ?? "").toLowerCase(); return HttpResponse.json({ results: [prod("p1", "BIKE"), prod("p2", "CHAIN"), prod("p3", "CHAIN2"), prod("p4", "SCRAPMETAL")].filter((p) => p.sku.toLowerCase().includes(s)), next: null }); });
const MASTER = ["manufacturing.view", "manufacturing.master.manage"];

const draft = (o: Partial<BomDraft> = {}): BomDraft => ({ product: prod("p1", "BIKE") as never, name: "", quantity: "1", lines: [{ component: "p2", label: "CHAIN", quantity: "1", scrap: "0", substitutes: [] }], steps: [], checks: [], byproducts: [], from: "", to: "", ...o });

describe("bom helpers", () => {
  it("validates substitutes, by-products and the effective window", () => {
    const line = (substitutes: { product: string; ratio: string }[]) => [{ component: "p2", label: "CHAIN", quantity: "1", scrap: "0", substitutes }];
    expect(bomProblem(draft({ lines: line([{ product: "p2", ratio: "1" }]) }), true)).toMatch(/substitute cannot repeat/);
    expect(bomProblem(draft({ lines: line([{ product: "p3", ratio: "1" }, { product: "p3", ratio: "1" }]) }), true)).toMatch(/substitute cannot repeat/);
    expect(bomProblem(draft({ lines: line([{ product: "p3", ratio: "0" }]) }), true)).toMatch(/ratio/);
    expect(bomProblem(draft({ byproducts: [{ product: "p1", label: "BIKE", quantity: "1" }] }), true)).toMatch(/different product/);
    expect(bomProblem(draft({ byproducts: [{ product: "p4", label: "S", quantity: "0" }] }), true)).toMatch(/more than 0/);
    expect(bomProblem(draft({ from: "2026-12-31", to: "2026-12-01" }), true)).toMatch(/end date/);
    expect(bomProblem(draft({ lines: line([{ product: "p3", ratio: "1.5" }]), byproducts: [{ product: "p4", label: "S", quantity: "2" }], from: "2026-12-01", to: "2026-12-31" }), true)).toBeNull();
  });
});

describe("BOM editor extras", () => {
  const row = { id: "b1", product: "p1", sku: "BIKE", version: 1, name: "", quantity: "1.0000", status: "DRAFT", created_by: "u1", approved_by: null };
  const detail = { ...row, lines: [{ component: "p2", sku: "CHAIN", quantity: "1.0000", scrap_percent: "0.0000", substitutes: [{ product: "p3", sku: "CHAIN2", ratio: "1.0000" }] }], steps: [], checks: [], standard_cost: "0", effective_from: "2026-12-01", effective_to: null, byproducts: [{ product: "p4", sku: "SCRAPMETAL", quantity: "2.0000" }] };

  it("edits substitutes, by-products and dates and sends them", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(products,
      http.get("*/api/v1/manufacturing/boms", () => HttpResponse.json({ results: [row], next: null })),
      http.get("*/api/v1/manufacturing/boms/b1", () => HttpResponse.json(detail)),
      http.get("*/api/v1/manufacturing/work-centers", () => HttpResponse.json({ results: [], next: null })),
      http.patch("*/api/v1/manufacturing/boms/b1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(detail); }));
    renderWithProviders(<BomsPage />, { permissions: MASTER });
    await userEvent.click(await screen.findByRole("button", { name: "Open BIKE v1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
    // existing values are loaded
    expect(await screen.findByDisplayValue("2026-12-01")).toBeInTheDocument();
    expect(screen.getByLabelText("Quantity of by-product SCRAPMETAL")).toHaveValue("2");
    // change the substitute ratio and remove the by-product
    const ratio = screen.getByLabelText("Ratio of substitute CHAIN2 for CHAIN");
    await userEvent.clear(ratio);
    await userEvent.type(ratio, "1.5");
    await userEvent.click(screen.getByRole("button", { name: "Remove by-product SCRAPMETAL" }));
    fireEvent.change(screen.getByLabelText("Effective until"), { target: { value: "2026-12-31" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ lines: [{ component: "p2", substitutes: [{ product: "p3", ratio: "1.5" }] }], byproducts: [], effective_from: "2026-12-01", effective_to: "2026-12-31" });
  });

  it("adds a substitute and a by-product from the pickers", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(products,
      http.get("*/api/v1/manufacturing/boms", () => HttpResponse.json({ results: [row], next: null })),
      http.get("*/api/v1/manufacturing/boms/b1", () => HttpResponse.json({ ...detail, lines: [{ ...detail.lines[0]!, substitutes: [] }], byproducts: [], effective_from: null })),
      http.get("*/api/v1/manufacturing/work-centers", () => HttpResponse.json({ results: [], next: null })),
      http.patch("*/api/v1/manufacturing/boms/b1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(detail); }));
    renderWithProviders(<BomsPage />, { permissions: MASTER });
    await userEvent.click(await screen.findByRole("button", { name: "Open BIKE v1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
    await userEvent.type(await screen.findByRole("combobox", { name: "Add substitute for CHAIN" }), "chain2");
    await userEvent.click(await screen.findByRole("button", { name: /CHAIN2/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Add a by-product" }), "scrap");
    await userEvent.click(await screen.findByRole("button", { name: /SCRAPMETAL/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ lines: [{ substitutes: [{ product: "p3", ratio: "1" }] }], byproducts: [{ product: "p4", quantity: "1" }], effective_from: null, effective_to: null });
  });
});

describe("plan revision", () => {
  const plan = (o = {}) => ({ id: "pl1", number: "PLN-1", name: "Dec plan", period_start: "2026-12-01", period_end: "2026-12-31", status: "DRAFT", revision: 1, created_by: "u1", approved_by: null, lines: [{ id: "ln1", product: "p1", sku: "BIKE", quantity: "10.0000", required_date: "2026-12-10", priority: 2, order: null }], revisions: [], ...o });
  const serve = (o = {}) => [http.get("*/api/v1/manufacturing/plans", () => HttpResponse.json({ results: [plan(o)], next: null })), http.get("*/api/v1/manufacturing/plans/pl1", () => HttpResponse.json(plan(o)))];

  it("helper needs a reason and valid lines", () => {
    const d = { name: "n", start: "2026-12-01", end: "2026-12-31", lines: [{ product: "p1", sku: "BIKE", quantity: "1", required_date: "2026-12-10" }] };
    expect(reviseProblem(d, " ")).toMatch(/reason/);
    expect(reviseProblem({ ...d, lines: [] }, "why")).toMatch(/at least one/);
    expect(reviseProblem(d, "why")).toBeNull();
  });

  it("revises lines with a reason and keeps priority", async () => {
    let body: unknown = null;
    server.use(...serve(), products, http.post("*/api/v1/manufacturing/plans/pl1/revise", async ({ request }) => { body = await request.json(); return HttpResponse.json(plan()); }));
    renderWithProviders(<PlansPage />, { permissions: ["manufacturing.view", "manufacturing.plan.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Open PLN-1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Revise plan" }));
    const qty = await screen.findByLabelText("Quantity of BIKE");
    await userEvent.clear(qty);
    await userEvent.type(qty, "15");
    await userEvent.click(screen.getByRole("button", { name: "Save revision" }));
    expect(await screen.findByText("Give a reason for the revision.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason for the change"), "Demand rose");
    await userEvent.click(screen.getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(body).toEqual({ reason: "Demand rose", lines: [{ product: "p1", quantity: "15", required_date: "2026-12-10", priority: 2 }] }));
  });

  it("is not offered for a released plan or without permission", async () => {
    server.use(...serve({ status: "RELEASED" }));
    const v = renderWithProviders(<PlansPage />, { permissions: ["manufacturing.view", "manufacturing.plan.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Open PLN-1" }));
    await screen.findByText(/revision 1/);
    expect(screen.queryByRole("button", { name: "Revise plan" })).toBeNull();
    v.unmount();
    server.use(...serve());
    renderWithProviders(<PlansPage />, { permissions: ["manufacturing.view"] });
    await userEvent.click(await screen.findByRole("button", { name: "Open PLN-1" }));
    await screen.findByText(/revision 1/);
    expect(screen.queryByRole("button", { name: "Revise plan" })).toBeNull();
  });
});

describe("lines and item profile", () => {
  it("helpers", () => {
    expect(lineProblem("", "x")).toMatch(/code/);
    expect(lineProblem("L", " ")).toMatch(/name/);
    expect(lineProblem("L", "x")).toBeNull();
    expect(profileProblem(null, "PURCHASED")).toMatch(/product/);
    expect(profileProblem(prod("p1", "B") as never, "X")).toMatch(/supplied/);
    expect(profileProblem(prod("p1", "B") as never, "PURCHASED")).toBeNull();
  });

  it("lists lines, adds one, and the server's refusal is shown", async () => {
    let n = 0;
    const bodies: unknown[] = [];
    server.use(http.get("*/api/v1/manufacturing/lines", () => HttpResponse.json({ results: [{ id: "l1", code: "L1", name: "Assembly 1", facility: "" }], next: null })),
      http.post("*/api/v1/manufacturing/lines", async ({ request }) => { bodies.push(await request.json()); n += 1; return n === 1 ? HttpResponse.json({ error: { code: "duplicate_code", message: "That code is already used." } }, { status: 409 }) : HttpResponse.json({ id: "l2", code: "L2" }, { status: 201 }); }));
    renderWithProviders(<LinesProfilePage />, { permissions: MASTER });
    expect(await screen.findByText("Assembly 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add line" }));
    expect(await screen.findByText("Give the line a code.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Line code"), "L1");
    await userEvent.type(screen.getByLabelText("Line name"), "Dup");
    await userEvent.click(screen.getByRole("button", { name: "Add line" }));
    expect(await screen.findByText("That code is already used.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add line" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ code: "L1", name: "Dup", facility: "" });
  });

  it("view-only users see lines but no forms", async () => {
    server.use(http.get("*/api/v1/manufacturing/lines", () => HttpResponse.json({ results: [], next: null })));
    renderWithProviders(<LinesProfilePage />, { permissions: ["manufacturing.view"] });
    expect(await screen.findByText("No production lines")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add line" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
  });

  it("saves an item supply profile", async () => {
    let body: unknown = null;
    server.use(products, http.get("*/api/v1/manufacturing/lines", () => HttpResponse.json({ results: [], next: null })),
      http.put("*/api/v1/manufacturing/products/p2/profile", async ({ request }) => { body = await request.json(); return HttpResponse.json({ product: "p2", supply_type: "PURCHASED" }); }));
    renderWithProviders(<LinesProfilePage />, { permissions: MASTER });
    await userEvent.click(await screen.findByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Choose the product.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("combobox", { name: "Item" }), "chain");
    await userEvent.click(await screen.findByRole("button", { name: "CHAIN — CHAIN" }));
    await userEvent.selectOptions(screen.getByLabelText("Supplied how"), "PURCHASED");
    await userEvent.type(screen.getByLabelText("Drawing reference"), "DWG-7");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(body).toEqual({ supply_type: "PURCHASED", drawing_ref: "DWG-7", method: "" }));
    expect(await screen.findByText("Saved the supply profile for CHAIN.")).toBeInTheDocument();
  });
});

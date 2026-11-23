import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { BomsPage, bomInput, bomProblem, draftFromBom, type BomDraft } from "./BomsPage";
import { WorkCentersPage, workCenterInput, workCenterProblem } from "./WorkCentersPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const wc = (o = {}) => ({ id: "w1", code: "CNC", name: "CNC machine", capacity_hours_per_day: "8.0000", labor_rate: "20.0000", machine_rate: "35.0000", overhead_rate: "5.0000", efficiency_percent: "90.0000", is_active: true, ...o });
const wcList = (rows: object[]) => http.get("*/api/v1/manufacturing/work-centers", () => HttpResponse.json({ results: rows, next: null }));
const prod = (id: string, sku: string) => ({ id, sku, name: sku, uom: "pc", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "0" });
const products = http.get("*/api/v1/inventory/products", ({ request }) => { const s = (new URL(request.url).searchParams.get("search") ?? "").toLowerCase(); return HttpResponse.json({ results: [prod("p1", "BIKE"), prod("p2", "CHAIN")].filter((p) => p.sku.toLowerCase().includes(s)), next: null }); });

const draft = (o: Partial<BomDraft> = {}): BomDraft => ({ product: prod("p1", "BIKE") as never, name: "", quantity: "1", lines: [{ component: "p2", label: "CHAIN", quantity: "1", scrap: "0", substitutes: [] }], steps: [], checks: [], byproducts: [], from: "", to: "", ...o });

describe("work centre helpers", () => {
  const d = { code: "A", name: "B", capacity: "8", efficiency: "100", labor: "0", machine: "0", overhead: "0" };
  it("validates", () => {
    expect(workCenterProblem(d, true)).toBeNull();
    expect(workCenterProblem({ ...d, code: "" }, true)).toMatch(/code/);
    expect(workCenterProblem({ ...d, code: "" }, false)).toBeNull();
    expect(workCenterProblem({ ...d, capacity: "25" }, true)).toMatch(/24/);
    expect(workCenterProblem({ ...d, efficiency: "0" }, true)).toMatch(/Efficiency/);
    expect(workCenterProblem({ ...d, machine: "x" }, true)).toMatch(/Machine/);
    expect(workCenterInput(d, false)).not.toHaveProperty("code");
  });
});

describe("bom helpers", () => {
  it("bomProblem", () => {
    expect(bomProblem(draft(), true)).toBeNull();
    expect(bomProblem(draft({ product: null }), true)).toMatch(/Choose the product/);
    expect(bomProblem(draft({ product: null }), false)).toBeNull();
    expect(bomProblem(draft({ quantity: "0" }), true)).toMatch(/more than 0/);
    expect(bomProblem(draft({ lines: [] }), true)).toMatch(/at least one/);
    expect(bomProblem(draft({ lines: [{ component: "p1", label: "BIKE", quantity: "1", scrap: "0", substitutes: [] }] }), true)).toMatch(/itself/);
    const l = draft().lines[0]!;
    expect(bomProblem(draft({ lines: [l, l] }), true)).toMatch(/only once/);
    expect(bomProblem(draft({ lines: [{ ...l, scrap: "100" }] }), true)).toMatch(/scrap/);
    const step = { sequence: "10", name: "Cut", work_center: "w1", setup: "0", run: "1" };
    expect(bomProblem(draft({ steps: [step] }), true)).toBeNull();
    expect(bomProblem(draft({ steps: [step, step] }), true)).toMatch(/twice/);
    expect(bomProblem(draft({ steps: [{ ...step, work_center: "" }] }), true)).toMatch(/work centre/);
    expect(bomProblem(draft({ checks: [{ name: "", step: "", spec: "", lower: "", upper: "" }] }), true)).toMatch(/name/);
    expect(bomProblem(draft({ checks: [{ name: "Len", step: "20", spec: "", lower: "", upper: "" }], steps: [step] }), true)).toMatch(/does not exist/);
    expect(bomProblem(draft({ checks: [{ name: "Len", step: "", spec: "", lower: "5", upper: "2" }] }), true)).toMatch(/above/);
  });
  it("bomInput and draftFromBom round-trip keeps substitutes", () => {
    const detail = { id: "b", product: "p1", sku: "BIKE", version: 1, name: "n", quantity: "1.0000", status: "DRAFT" as const, created_by: "u", approved_by: null,
      lines: [{ component: "p2", sku: "CHAIN", quantity: "2.0000", scrap_percent: "5.0000", substitutes: [{ product: "p3", ratio: "1.0000" }] }],
      steps: [{ sequence: 10, name: "Cut", work_center: "w1", setup_hours: "0.5000", run_hours: "1.0000" }],
      checks: [{ name: "Len", step_sequence: null, specification: "", lower_limit: "1.0000", upper_limit: null }], standard_cost: "0", effective_from: null, effective_to: null, byproducts: [] };
    const out = bomInput(draftFromBom(detail), false);
    expect(out.lines[0]).toEqual({ component: "p2", quantity: "2", scrap_percent: "5", substitutes: [{ product: "p3", ratio: "1.0000" }] });
    expect(out.steps[0]).toMatchObject({ sequence: 10, work_center: "w1" });
    expect(out.checks[0]).toEqual({ name: "Len", step_sequence: null, specification: "", lower_limit: "1" });
    expect(out).not.toHaveProperty("product");
  });
});

describe("WorkCentersPage", () => {
  it("lists, creates, and toggles active with permission; read-only otherwise", async () => {
    let created: unknown = null; let patched: unknown = null;
    server.use(wcList([wc()]),
      http.post("*/api/v1/manufacturing/work-centers", async ({ request }) => { created = await request.json(); return HttpResponse.json(wc({ id: "w2" }), { status: 201 }); }),
      http.patch("*/api/v1/manufacturing/work-centers/w1", async ({ request }) => { patched = await request.json(); return HttpResponse.json(wc({ is_active: false })); }));
    const v = renderWithProviders(<WorkCentersPage />, { permissions: ["manufacturing.view", "manufacturing.master.manage"] });
    expect(await screen.findByText("CNC machine")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Deactivate CNC" }));
    await waitFor(() => expect(patched).toEqual({ is_active: false }));
    await userEvent.click(screen.getByRole("button", { name: "New work centre" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/code/);
    await userEvent.type(screen.getByLabelText("Code"), "LATHE");
    await userEvent.type(screen.getByLabelText("Name"), "Lathe");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(created).toMatchObject({ code: "LATHE", name: "Lathe", capacity_hours_per_day: "8", efficiency_percent: "100" }));
    v.unmount();
    renderWithProviders(<WorkCentersPage />, { permissions: ["manufacturing.view"] });
    await screen.findByText("CNC machine");
    expect(screen.queryByRole("button", { name: "New work centre" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
  });
});

describe("BomsPage", () => {
  const row = (o = {}) => ({ id: "b1", product: "p1", sku: "BIKE", version: 1, name: "Std", quantity: "1.0000", status: "DRAFT", created_by: "u1", approved_by: null, ...o });
  const detail = (o = {}) => ({ ...row(), lines: [{ component: "p2", sku: "CHAIN", quantity: "1.0000", scrap_percent: "0.0000", substitutes: [] }], steps: [], checks: [], standard_cost: "12.5000", effective_from: null, effective_to: null, byproducts: [], ...o });
  const list = (rows: object[]) => http.get("*/api/v1/manufacturing/boms", () => HttpResponse.json({ results: rows, next: null }));
  const get = (o = {}) => http.get("*/api/v1/manufacturing/boms/b1", () => HttpResponse.json(detail(o)));

  it("empty state and no create button without permission", async () => {
    server.use(list([]));
    renderWithProviders(<BomsPage />, { permissions: ["manufacturing.view"] });
    expect(await screen.findByText("No bills of materials")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New bill of materials" })).toBeNull();
  });

  it("creates a BOM with a component and a routing step", async () => {
    let body: unknown = null;
    server.use(list([]), wcList([wc()]), products, http.post("*/api/v1/manufacturing/boms", async ({ request }) => { body = await request.json(); return HttpResponse.json(row(), { status: 201 }); }));
    renderWithProviders(<BomsPage />, { permissions: ["manufacturing.view", "manufacturing.master.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New bill of materials" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Choose the product/);
    await userEvent.type(screen.getByRole("combobox", { name: "Product made" }), "bike");
    await userEvent.click(await screen.findByRole("button", { name: /BIKE/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Add a component" }), "chain");
    await userEvent.click(await screen.findByRole("button", { name: /CHAIN/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add a step" }));
    await userEvent.selectOptions(await screen.findByLabelText("Step 1 work centre"), "w1");
    await userEvent.clear(screen.getByLabelText("Step 1 run hours"));
    await userEvent.type(screen.getByLabelText("Step 1 run hours"), "1.5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(body).toMatchObject({ product: "p1", quantity: "1", lines: [{ component: "p2", quantity: "1", scrap_percent: "0" }], steps: [{ sequence: 10, work_center: "w1", setup_hours: "0", run_hours: "1.5" }] }));
  });

  it("approval shows the separation-of-duties message from the server", async () => {
    server.use(list([row()]), get(), http.post("*/api/v1/manufacturing/boms/b1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve a bill of materials you created." } }, { status: 403 })));
    renderWithProviders(<BomsPage />, { permissions: ["manufacturing.view", "manufacturing.bom.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Open BIKE v1" }));
    expect(await screen.findByText(/standard cost 12.50/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/cannot approve a bill of materials you created/)).toBeInTheDocument();
  });

  it("active BOM offers a new version and the materials calculator", async () => {
    let revised = false;
    server.use(list([row({ status: "ACTIVE" })]), get({ status: "ACTIVE" }),
      http.get("*/api/v1/manufacturing/products/p1/explosion", ({ request }) => HttpResponse.json({ requirements: [{ product: "p2", sku: "CHAIN", quantity: "10.0000", level: 1, make: false }], where_used: [], _q: new URL(request.url).searchParams.get("quantity") })),
      http.post("*/api/v1/manufacturing/boms/b1/revise", () => { revised = true; return HttpResponse.json(detail({ version: 2 }), { status: 201 }); }));
    renderWithProviders(<BomsPage />, { permissions: ["manufacturing.view", "manufacturing.master.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Open BIKE v1" }));
    await screen.findByText(/standard cost/);
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
    await userEvent.clear(screen.getByLabelText("For quantity"));
    await userEvent.type(screen.getByLabelText("For quantity"), "10");
    await userEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(await screen.findByText(/CHAIN: 10.00/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create new version" }));
    await waitFor(() => expect(revised).toBe(true));
  });

  it("edits a draft and keeps substitutes in the saved lines", async () => {
    let body: { lines: unknown } | null = null;
    const subs = [{ product: "p3", ratio: "1.0000" }];
    server.use(list([row()]), get({ lines: [{ component: "p2", sku: "CHAIN", quantity: "1.0000", scrap_percent: "0.0000", substitutes: subs }] }), wcList([wc()]),
      http.patch("*/api/v1/manufacturing/boms/b1", async ({ request }) => { body = (await request.json()) as { lines: unknown }; return HttpResponse.json(detail()); }));
    renderWithProviders(<BomsPage />, { permissions: ["manufacturing.view", "manufacturing.master.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Open BIKE v1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
    const qty = await screen.findByLabelText("Quantity of CHAIN");
    await userEvent.clear(qty);
    await userEvent.type(qty, "3");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(body?.lines).toEqual([{ component: "p2", quantity: "3", scrap_percent: "0", substitutes: subs }]));
  });
});

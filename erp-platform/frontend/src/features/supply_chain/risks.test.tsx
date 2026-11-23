import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { RisksPage, actionProblem, alternativeProblem, criticalProblem, disruptionProblem, riskProblem, scoreTone } from "./RisksPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null });
const employees = http.get("*/api/v1/hr/employees", () => page([{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }]));
const MANAGE = ["supply_chain.view", "supply_chain.risk.manage"];
const risk = (o = {}) => ({ id: "k1", number: "RSK-1", category: "SUPPLIER", title: "Single supplier for steel", description: "", supplier: null, product: null, likelihood: 4, impact: 4, score: 16, financial_impact: "5000.00", status: "OPEN", owner: "u1", ...o });
const quiet = [employees, http.get("*/api/v1/supply-chain/risks", () => page([]))];
const tab = (name: string) => userEvent.click(screen.getByRole("tab", { name }));
const prod = { id: "p1", sku: "STEEL", name: "Steel", uom: "kg", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "0" };
const products = http.get("*/api/v1/inventory/products", () => page([prod]));

describe("helpers", () => {
  it("validate", () => {
    const d = { category: "SUPPLIER", title: "t", likelihood: "3", impact: "3", owner: "u1", cost: "" };
    expect(riskProblem({ ...d, category: "" })).toMatch(/kind/);
    expect(riskProblem({ ...d, title: " " })).toMatch(/title/);
    expect(riskProblem({ ...d, likelihood: "6" })).toMatch(/Likelihood/);
    expect(riskProblem({ ...d, impact: "0" })).toMatch(/Impact/);
    expect(riskProblem({ ...d, owner: "" })).toMatch(/owns/);
    expect(riskProblem({ ...d, cost: "x" })).toMatch(/amount/);
    expect(riskProblem(d)).toBeNull();
    expect(actionProblem("", "u", "2026-12-01")).toMatch(/action/);
    expect(actionProblem("a", "", "2026-12-01")).toMatch(/responsible/);
    expect(actionProblem("a", "u", "")).toMatch(/due/);
    expect(disruptionProblem("SUPPLIER", "t", " ", "2026-12-01", "")).toMatch(/caused/);
    expect(disruptionProblem("SUPPLIER", "t", "c", "2026-12-01", "x")).toMatch(/amount/);
    expect(disruptionProblem("SUPPLIER", "t", "c", "2026-12-01", "10")).toBeNull();
    expect(criticalProblem(null, "r", "2")).toMatch(/material/);
    expect(criticalProblem(prod as never, "r", "0")).toMatch(/at least 1/);
    expect(alternativeProblem(prod as never, "", "1", "0")).toMatch(/supplier/);
    expect(alternativeProblem(prod as never, "s", "0", "0")).toMatch(/Rank/);
    expect(alternativeProblem(prod as never, "s", "1", "x")).toMatch(/Lead/);
    expect(alternativeProblem(prod as never, "s", "1", "5")).toBeNull();
    expect([scoreTone(20), scoreTone(10), scoreTone(2)]).toEqual(["red", "amber", "green"]);
  });
});

describe("Risks tab", () => {
  it("lists risks with owner names and critical score; no log button for read-only", async () => {
    server.use(employees, http.get("*/api/v1/supply-chain/risks", () => page([risk()])));
    renderWithProviders(<RisksPage />, { permissions: ["supply_chain.view"] });
    expect(await screen.findByText("Single supplier for steel")).toBeInTheDocument();
    expect(await screen.findByText("Abel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log a risk" })).toBeNull();
  });

  it("logs a risk", async () => {
    let body: unknown = null;
    server.use(employees, http.get("*/api/v1/supply-chain/risks", () => page([])), http.post("*/api/v1/supply-chain/risks", async ({ request }) => { body = await request.json(); return HttpResponse.json(risk(), { status: 201 }); }));
    renderWithProviders(<RisksPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Log a risk" }));
    await userEvent.click(await screen.findByRole("button", { name: "Log risk" }));
    expect(await screen.findByText("Give the risk a title.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Title"), "Port strike");
    await waitFor(() => expect(screen.getByRole("option", { name: "E-1 Abel" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Owner"), "u1");
    await userEvent.click(screen.getByRole("button", { name: "Log risk" }));
    await waitFor(() => expect(body).toEqual({ category: "SUPPLIER", title: "Port strike", likelihood: 3, impact: 3, owner: "u1" }));
  });

  it("opens a risk, changes status, adds and completes an action", async () => {
    const sent: Record<string, unknown> = {};
    server.use(employees, http.get("*/api/v1/supply-chain/risks", () => page([risk()])),
      http.get("*/api/v1/supply-chain/risks/k1", () => HttpResponse.json({ ...risk(), actions: [{ id: "a1", risk: "k1", description: "Qualify a second mill", owner: "u1", due_date: "2026-12-15", status: "OPEN" }], disruptions: [] })),
      http.patch("*/api/v1/supply-chain/risks/k1", async ({ request }) => { sent.s = await request.json(); return HttpResponse.json(risk()); }),
      http.post("*/api/v1/supply-chain/risks/k1/actions", async ({ request }) => { sent.a = await request.json(); return HttpResponse.json({}, { status: 201 }); }),
      http.post("*/api/v1/supply-chain/risk-actions/a1/complete", () => { sent.c = true; return HttpResponse.json({}); }));
    renderWithProviders(<RisksPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Open RSK-1" }));
    expect(await screen.findByText(/Qualify a second mill/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Status", { selector: "#rk-status" }), "MITIGATING");
    await waitFor(() => expect(sent.s).toEqual({ status: "MITIGATING" }));
    await userEvent.click(screen.getByRole("button", { name: /Complete: Qualify/ }));
    await waitFor(() => expect(sent.c).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Add an action" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add action" }));
    expect(await screen.findByText("Describe the action.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Action"), "Stockpile");
    await waitFor(() => expect(screen.getByRole("option", { name: "E-1 Abel" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Responsible"), "u1");
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-20" } });
    await userEvent.click(screen.getByRole("button", { name: "Add action" }));
    await waitFor(() => expect(sent.a).toEqual({ description: "Stockpile", owner: "u1", due_date: "2026-12-20" }));
  });
});

describe("other tabs", () => {
  it("disruptions: record and resolve", async () => {
    const sent: Record<string, unknown> = {};
    server.use(...quiet, http.get("*/api/v1/supply-chain/disruptions", () => HttpResponse.json([{ id: "d1", category: "LOGISTICS", title: "Port closed", cause: "Strike", started_on: "2026-11-01", ended_on: null, financial_impact: "1200.00", status: "OPEN" }, { id: "d2", category: "SUPPLIER", title: "Mill fire", cause: "Fire", started_on: "2026-10-01", ended_on: "2026-10-10", financial_impact: "0", status: "RESOLVED" }])),
      http.post("*/api/v1/supply-chain/disruptions", async ({ request }) => { sent.r = await request.json(); return HttpResponse.json({}, { status: 201 }); }),
      http.post("*/api/v1/supply-chain/disruptions/d1/resolve", async ({ request }) => { sent.s = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<RisksPage />, { permissions: MANAGE });
    await tab("Disruptions");
    expect(await screen.findByText("Port closed")).toBeInTheDocument();
    expect(screen.getByText("1,200.00")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Resolve/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Record a disruption" }));
    await userEvent.click(await screen.findByRole("button", { name: "Record" }));
    expect(await screen.findByText("Choose the kind of disruption.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "SUPPLIER");
    await userEvent.type(screen.getByLabelText("Title"), "Truck strike");
    await userEvent.type(screen.getByLabelText("Cause"), "Union action");
    fireEvent.change(screen.getByLabelText("Started on"), { target: { value: "2026-11-20" } });
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(sent.r).toEqual({ category: "SUPPLIER", title: "Truck strike", cause: "Union action", started_on: "2026-11-20" }));
    await userEvent.click(screen.getByRole("button", { name: "Resolve Port closed" }));
    await userEvent.type(await screen.findByLabelText("How it was resolved"), "Rerouted");
    await userEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
    await waitFor(() => expect(sent.s).toEqual({ resolution: "Rerouted" }));
  });

  it("critical materials: shows coverage, marks critical and adds an alternative source", async () => {
    const sent: Record<string, unknown> = {};
    server.use(...quiet, products, http.get("*/api/v1/procurement/suppliers", () => page([{ id: "s1", name: "ACME", tax_id: "", email: "", status: "QUALIFIED", partner: null, qualified_at: null }])),
      http.get("*/api/v1/supply-chain/critical-materials", () => HttpResponse.json([{ product: "STEEL", reason: "Frames", sources: 1, required_sources: 2, single_source: true, at_risk: true }, { product: "BOLT", reason: "x", sources: 3, required_sources: 2, single_source: false, at_risk: false }])),
      http.post("*/api/v1/supply-chain/critical-materials", async ({ request }) => { sent.m = await request.json(); return HttpResponse.json({}, { status: 201 }); }),
      http.post("*/api/v1/supply-chain/alternative-sources", async ({ request }) => { sent.a = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<RisksPage />, { permissions: MANAGE });
    await tab("Critical materials");
    expect(await screen.findByText("Single source")).toBeInTheDocument();
    expect(screen.getByText("Covered")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark critical" }));
    expect(await screen.findByText("Choose the material.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("combobox", { name: "Critical material" }), "ste");
    await userEvent.click(await screen.findByRole("button", { name: /STEEL/ }));
    await userEvent.type(screen.getByLabelText("Why it is critical"), "Frames");
    await userEvent.click(screen.getByRole("button", { name: "Mark critical" }));
    await waitFor(() => expect(sent.m).toEqual({ product: "p1", reason: "Frames", min_sources: 2 }));
    await userEvent.type(screen.getByRole("combobox", { name: "Material" }), "ste");
    await userEvent.click((await screen.findAllByRole("button", { name: /STEEL/ })).at(-1)!);
    await waitFor(() => expect(screen.getByRole("option", { name: "ACME" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Alternative supplier"), "s1");
    await userEvent.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(sent.a).toEqual({ product: "p1", supplier: "s1", rank: 1, lead_time_days: 0, notes: "" }));
  });

  it("warning signals: empty and populated", async () => {
    let empty = true;
    server.use(...quiet, http.get("*/api/v1/supply-chain/analytics/supply-risks", () => HttpResponse.json(empty ? [] : [{ type: "LATE_SHIPMENT", ref: "SHP-1", detail: "planned arrival 2026-11-01" }])));
    const v = renderWithProviders(<RisksPage />, { permissions: ["supply_chain.view"] });
    await tab("Warning signals");
    expect(await screen.findByText("No warning signals")).toBeInTheDocument();
    v.unmount();
    empty = false;
    renderWithProviders(<RisksPage />, { permissions: ["supply_chain.view"] });
    await tab("Warning signals");
    expect(await screen.findByText("SHP-1")).toBeInTheDocument();
  });
});

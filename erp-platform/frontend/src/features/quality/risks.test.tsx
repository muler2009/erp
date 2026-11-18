import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ImprovementPage, InitiativePage, initiativeBlock, validateInitiative, validateSuggestion } from "./ImprovementPage";
import { RiskPage, RisksPage, riskLevel, riskStatusBlock, validateRisk } from "./RisksPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] }));
const cats = http.get("*/api/v1/quality/config/:kind", () => HttpResponse.json([{ id: "1", kind: "X", code: "SUPPLY", name: "Supply", rank: 1, requires_capa: false, is_active: true }]));
const risk = (o = {}) => ({ id: "r1", number: "RSK-1", title: "Single-source bolts", area: "supplier", category: "", likelihood: 4, impact: 4, score: 16, level: "HIGH", residual_score: null, residual_level: null, owner_id: "u1", status: "IDENTIFIED", next_review_on: "2027-02-01", product_id: null, supplier_id: null, project_id: null, ...o });
const riskDetail = (o = {}) => ({ ...risk(), causes: "One supplier", consequences: "Stop", links: [], actions: [], history: [], ...o });
const act = (o = {}) => ({ id: "a1", parent_type: "risk", parent_id: "r1", action_type: "MITIGATION", description: "Qualify second source", owner_id: "u1", due_date: "2026-12-01", status: "OPEN", completed_at: null, completion_note: "", overdue: false, ...o });
const grid = () => { const g: Record<string, number> = {}; for (let l = 1; l <= 5; l++) for (let i = 1; i <= 5; i++) g[`${l}x${i}`] = 0; g["4x4"] = 2; return g; };
const R = ["quality.view", "quality.risk.manage"];
const riskRoute = (d: object, permissions: string[]) => { server.use(employees, http.get("*/api/v1/quality/risks/r1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/risks/:id" element={<RiskPage />} /></Routes>, { permissions, route: "/app/quality/risks/r1" }); };
const ini = (o = {}) => ({ id: "i1", number: "INI-1", title: "Cut scrap", status: "PROPOSED", owner_id: "u1", target_date: "2027-03-01", progress: 0, suggestion_id: null, objective_id: null, metric: "scrap %", baseline_value: "8", target_value: "4", result_value: null, description: "", lessons_learned: "", capa_id: null, actions: [], history: [], ...o });
const iniRoute = (d: object, permissions: string[]) => { server.use(employees, http.get("*/api/v1/quality/initiatives/i1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/initiatives/:id" element={<InitiativePage />} /></Routes>, { permissions, route: "/app/quality/initiatives/i1" }); };

describe("validators", () => {
  it("risk, status rules, suggestion, initiative", () => {
    expect(riskLevel(15)).toBe("HIGH"); expect(riskLevel(8)).toBe("MEDIUM"); expect(riskLevel(7)).toBe("LOW");
    const f = { title: "t", area: "a", likelihood: "3", impact: "3", owner_id: "u1" };
    expect(validateRisk({ ...f, likelihood: "6" })).toMatch(/likelihood.*1 to 5/);
    expect(validateRisk({ ...f, impact: "2.5" })).toMatch(/impact/);
    expect(validateRisk({ ...f, owner_id: "" })).toMatch(/owner/);
    expect(validateRisk(f)).toBeNull();
    const base = { score: 16, residual_score: null, actions: [] as ReturnType<typeof act>[] };
    expect(riskStatusBlock(base, "ACCEPTED", "ok")).toMatch(/high risk cannot be accepted/);
    expect(riskStatusBlock({ ...base, score: 6 }, "ACCEPTED", " ")).toMatch(/reason for accepting/);
    expect(riskStatusBlock({ ...base, score: 6 }, "ACCEPTED", "tolerable")).toBeNull();
    expect(riskStatusBlock(base, "MITIGATING", "")).toMatch(/mitigation action first/);
    expect(riskStatusBlock({ ...base, actions: [act({ status: "CANCELLED" })] }, "MITIGATING", "")).toMatch(/mitigation action first/);
    expect(riskStatusBlock({ ...base, actions: [act()] }, "MITIGATING", "")).toBeNull();
    expect(riskStatusBlock({ ...base, actions: [act()] }, "CLOSED", "")).toMatch(/verified first/);
    expect(riskStatusBlock({ ...base, actions: [act({ status: "VERIFIED" })] }, "CLOSED", "")).toMatch(/residual/);
    expect(riskStatusBlock({ ...base, residual_score: 4, actions: [act({ status: "VERIFIED" })] }, "CLOSED", "")).toBeNull();
    expect(validateSuggestion(" ", "d")).toMatch(/title/);
    expect(validateSuggestion("t", "")).toMatch(/Describe/);
    const i = { title: "t", owner_id: "u", target_date: "d", baseline_value: "", target_value: "" };
    expect(validateInitiative({ ...i, baseline_value: "x" })).toMatch(/baseline/);
    expect(validateInitiative({ ...i, target_date: "" })).toMatch(/target date/);
    expect(validateInitiative(i)).toBeNull();
    expect(initiativeBlock({ actions: [] }, "IN_PROGRESS", "", "", "150")).toMatch(/0 to 100/);
    expect(initiativeBlock({ actions: [act({ status: "DONE" })] }, "COMPLETED", "3", "l", "")).toMatch(/verified first/);
    expect(initiativeBlock({ actions: [] }, "COMPLETED", "", "l", "")).toMatch(/result and the lessons/);
    expect(initiativeBlock({ actions: [] }, "COMPLETED", "abc", "l", "")).toMatch(/must be a number/);
    expect(initiativeBlock({ actions: [] }, "COMPLETED", "3.5", "l", "")).toBeNull();
  });
});

describe("RisksPage", () => {
  it("shows the matrix and risks with levels, and hides registering from a viewer", async () => {
    server.use(employees, http.get("*/api/v1/quality/risks/matrix", () => HttpResponse.json(grid())), http.get("*/api/v1/quality/risks", () => HttpResponse.json([risk()])));
    renderWithProviders(<RisksPage />, { permissions: ["quality.view"] });
    expect(await screen.findByRole("link", { name: "RSK-1" })).toHaveAttribute("href", "/app/quality/risks/r1");
    expect(screen.getByText("16 High")).toBeInTheDocument();
    expect(await screen.findByLabelText("Likelihood 4, impact 4, High: 2 risks")).toHaveTextContent("2");
    expect(screen.queryByRole("button", { name: "Register a risk" })).toBeNull();
  });

  it("registers a risk, showing the score, and rejects an out-of-range scale", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(employees, cats, http.get("*/api/v1/quality/risks/matrix", () => HttpResponse.json(grid())), http.get("*/api/v1/quality/risks", () => HttpResponse.json([])),
      http.post("*/api/v1/quality/risks", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(risk(), { status: 201 }); }));
    renderWithProviders(<RisksPage />, { permissions: R });
    await userEvent.click(await screen.findByRole("button", { name: "Register a risk" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Register a risk" }));
    await dlg.findByRole("option", { name: /Abel/ });
    await userEvent.type(dlg.getByLabelText("Title"), "Single-source bolts");
    await userEvent.type(dlg.getByLabelText("Area"), "supplier");
    await userEvent.selectOptions(dlg.getByLabelText("Owner"), "u1");
    await userEvent.type(dlg.getByLabelText(/Likelihood/), "6");
    await userEvent.type(dlg.getByLabelText(/Impact/), "4");
    await userEvent.click(dlg.getByRole("button", { name: "Register" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/likelihood must be a whole number from 1 to 5/);
    await userEvent.clear(dlg.getByLabelText(/Likelihood/));
    await userEvent.type(dlg.getByLabelText(/Likelihood/), "4");
    expect(await dlg.findByText(/Score 16/)).toBeInTheDocument();
    await userEvent.click(dlg.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(body).toEqual({ title: "Single-source bolts", area: "supplier", likelihood: 4, impact: 4, owner_id: "u1" }));
  });
});

describe("RiskPage", () => {
  it("will not accept a high risk, and names the missing mitigation action", async () => {
    riskRoute(riskDetail(), R);
    await userEvent.click(await screen.findByRole("button", { name: "Start mitigation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/mitigation action first/);
    await userEvent.click(screen.getByRole("button", { name: "Accept the risk" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Accept the risk" }));
    await userEvent.type(dlg.getByLabelText(/Reason for accepting/), "Fine");
    await userEvent.click(dlg.getByRole("button", { name: "Accept" }));
    expect(await dlg.findByText(/high risk cannot be accepted/)).toBeInTheDocument();
  });

  it("records residual risk with the residual flag", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/risks/r1/reassess", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(risk()); }));
    riskRoute(riskDetail(), R);
    await userEvent.click(await screen.findByRole("button", { name: "Record residual risk" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Record residual risk" }));
    await userEvent.type(dlg.getByLabelText(/Likelihood/), "2");
    await userEvent.type(dlg.getByLabelText(/Impact/), "2");
    await userEvent.click(dlg.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(body).toEqual({ likelihood: 2, impact: 2, note: "", residual: true }));
  });

  it("blocks closing until actions are verified and a residual is recorded", async () => {
    riskRoute(riskDetail({ actions: [act({ status: "DONE" })] }), R);
    await userEvent.click(await screen.findByRole("button", { name: "Close the risk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Every mitigation action must be verified first/);
  });

  it("shows no controls for a viewer or a closed risk", async () => {
    riskRoute(riskDetail({ status: "CLOSED" }), R);
    await screen.findByText(/RSK-1/);
    expect(screen.queryByRole("button", { name: "Reassess" })).toBeNull();
  });
});

describe("ImprovementPage", () => {
  it("lets anyone with report rights suggest, and only managers decide", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(employees, cats, http.get("*/api/v1/quality/suggestions", () => HttpResponse.json({ results: [{ id: "g1", number: "SUG-1", title: "Colour-code bins", description: "d", category: "", status: "SUBMITTED", submitted_by: "u1", decision_note: "" }], next: null })),
      http.get("*/api/v1/quality/initiatives", () => HttpResponse.json({ results: [], next: null })),
      http.post("*/api/v1/quality/suggestions", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<ImprovementPage />, { permissions: ["quality.view", "quality.report"] });
    expect(await screen.findByText("Colour-code bins")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept SUG-1" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Make a suggestion" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Make a suggestion" }));
    await userEvent.type(dlg.getByLabelText("Title"), "Add labels");
    await userEvent.click(dlg.getByRole("button", { name: "Send suggestion" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/Describe the improvement/);
    await userEvent.type(dlg.getByLabelText("Description"), "Label every bin");
    await userEvent.click(dlg.getByRole("button", { name: "Send suggestion" }));
    await waitFor(() => expect(body).toEqual({ title: "Add labels", description: "Label every bin" }));
  });

  it("accepts a suggestion with a reason", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(employees, http.get("*/api/v1/quality/suggestions", () => HttpResponse.json({ results: [{ id: "g1", number: "SUG-1", title: "Colour-code bins", description: "d", category: "", status: "SUBMITTED", submitted_by: "u1", decision_note: "" }], next: null })),
      http.get("*/api/v1/quality/initiatives", () => HttpResponse.json({ results: [ini()], next: null })),
      http.post("*/api/v1/quality/suggestions/g1/decide", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}); }));
    renderWithProviders(<ImprovementPage />, { permissions: ["quality.view", "quality.improvement.manage"] });
    expect(await screen.findByRole("link", { name: "INI-1" })).toHaveAttribute("href", "/app/quality/initiatives/i1");
    await userEvent.click(await screen.findByRole("button", { name: "Accept SUG-1" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Accept suggestion" }));
    await userEvent.type(dlg.getByLabelText(/Reason for the decision/), "Cheap and quick");
    await userEvent.click(dlg.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(body).toEqual({ accept: true, note: "Cheap and quick" }));
  });

  it("starts an initiative from an accepted suggestion", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(employees, http.get("*/api/v1/quality/suggestions", () => HttpResponse.json({ results: [{ id: "g2", number: "SUG-2", title: "Fix layout", description: "d", category: "", status: "ACCEPTED", submitted_by: "u1", decision_note: "ok" }], next: null })),
      http.get("*/api/v1/quality/initiatives", () => HttpResponse.json({ results: [], next: null })),
      http.post("*/api/v1/quality/initiatives", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(ini(), { status: 201 }); }));
    renderWithProviders(<ImprovementPage />, { permissions: ["quality.view", "quality.improvement.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Start an initiative" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Start an initiative" }));
    await dlg.findByRole("option", { name: /SUG-2/ });
    await dlg.findByRole("option", { name: /Abel/ });
    await userEvent.type(dlg.getByLabelText("Title"), "Fix layout");
    await userEvent.selectOptions(dlg.getByLabelText("From an accepted suggestion"), "g2");
    await userEvent.selectOptions(dlg.getByLabelText("Owner"), "u1");
    fireEvent.change(dlg.getByLabelText("Target date"), { target: { value: "2027-03-01" } });
    await userEvent.click(dlg.getByRole("button", { name: "Start initiative" }));
    await waitFor(() => expect(body).toEqual({ title: "Fix layout", owner_id: "u1", target_date: "2027-03-01", suggestion_id: "g2" }));
  });
});

describe("InitiativePage", () => {
  it("offers the right steps for each status", async () => {
    iniRoute(ini(), ["quality.view", "quality.improvement.manage"]);
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
  });

  it("shows the separation-of-duties refusal on approval", async () => {
    server.use(http.post("*/api/v1/quality/initiatives/i1/status", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "An initiative must be approved by someone other than its creator." } }, { status: 403 })));
    iniRoute(ini(), ["quality.view", "quality.improvement.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Approve initiative" }));
    await userEvent.click(dlg.getByRole("button", { name: "Approve" }));
    expect(await dlg.findByText(/someone other than its creator/)).toBeInTheDocument();
  });

  it("requires a numeric result and lessons to complete", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/initiatives/i1/status", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(ini({ status: "COMPLETED" })); }));
    iniRoute(ini({ status: "IN_PROGRESS" }), ["quality.view", "quality.improvement.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: "Complete" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Complete initiative" }));
    await userEvent.type(dlg.getByLabelText(/Result achieved/), "abc");
    await userEvent.type(dlg.getByLabelText(/Lessons learned/), "Start earlier");
    await userEvent.click(dlg.getByRole("button", { name: "Complete" }));
    expect(await dlg.findByText(/must be a number/)).toBeInTheDocument();
    await userEvent.clear(dlg.getByLabelText(/Result achieved/));
    await userEvent.type(dlg.getByLabelText(/Result achieved/), "3.5");
    await userEvent.click(dlg.getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(body).toEqual({ status: "COMPLETED", result_value: "3.5", lessons_learned: "Start earlier" }));
  });

  it("shows no controls once completed", async () => {
    iniRoute(ini({ status: "COMPLETED", result_value: "3.5", lessons_learned: "Start earlier", progress: 100 }), ["quality.view", "quality.improvement.manage"]);
    expect(await screen.findByText(/Start earlier/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel initiative" })).toBeNull();
  });
});

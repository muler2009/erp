import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { WorkflowDefinitionsPage, blankStage, definitionPayload, definitionProblem, formFrom, type DefForm } from "./DefinitionsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const okForm = (): DefForm => ({ code: "po-approval", name: "PO approval", subject: "procurement.purchase_order", sod: true, distinct: false, stages: [{ ...blankStage(), approvers: [{ type: "ROLE", ref: "Procurement Manager" }] }] });

describe("definitionProblem", () => {
  it("accepts a valid form", () => expect(definitionProblem(okForm())).toBeNull());
  it("catches each mistake", () => {
    expect(definitionProblem({ ...okForm(), code: "bad code!" })).toMatch(/code/);
    expect(definitionProblem({ ...okForm(), name: " " })).toMatch(/name/);
    expect(definitionProblem({ ...okForm(), subject: "" })).toMatch(/approves/);
    expect(definitionProblem({ ...okForm(), stages: [] })).toMatch(/at least one approval step/);
    expect(definitionProblem({ ...okForm(), stages: [blankStage()] })).toMatch(/choose a role/);
    const s = (o: object) => ({ ...okForm(), stages: [{ ...okForm().stages[0]!, ...o }] });
    expect(definitionProblem(s({ min: "abc" }))).toMatch(/From amount must be an amount/);
    expect(definitionProblem(s({ min: "100", max: "50" }))).toMatch(/must be below/);
    expect(definitionProblem(s({ due: "1.5" }))).toMatch(/whole number of hours/);
    expect(definitionProblem(s({ approvers: [{ type: "USER", ref: "" }] }))).toMatch(/choose a person/);
    expect(definitionProblem(s({ approvers: [{ type: "MANAGER", ref: "" }] }))).toBeNull();
  });
});

it("builds the payload with positions as order and empty values as null", () => {
  const f = okForm(); f.stages.push({ ...blankStage(), name: "Final", policy: "ALL_OF", approvers: [{ type: "MANAGER", ref: "" }], min: "1000", due: "24", escalate: "u9" });
  const p = definitionPayload(f);
  expect(p.stages[0]).toMatchObject({ order: 1, name: "Step 1", policy: "ANY_OF", approvers: [{ type: "ROLE", ref: "Procurement Manager" }], min_amount: null, due_hours: null, escalate_to_user_id: null });
  expect(p.stages[1]).toMatchObject({ order: 2, name: "Final", approvers: [{ type: "MANAGER" }], min_amount: "1000", due_hours: 24, escalate_to_user_id: "u9" });
});

it("loads a definition back into the form in stage order", () => {
  const f = formFrom({ id: "d", code: "c", version: 2, name: "N", subject_type: "generic", is_active: true, separation_of_duties: false, distinct_approvers: true, stages: [{ order: 2, name: "B", policy: "ALL_OF", approvers: [{ type: "USER", ref: "u1" }], min_amount: null, max_amount: "50.00", due_hours: 8, escalate_to_user_id: null }, { order: 1, name: "A", policy: "ANY_OF", approvers: [{ type: "MANAGER" }], min_amount: null, max_amount: null, due_hours: null, escalate_to_user_id: null }] });
  expect(f.stages.map((s) => s.name)).toEqual(["A", "B"]);
  expect(f.stages[1]).toMatchObject({ max: "50.00", due: "8", approvers: [{ type: "USER", ref: "u1" }] });
  expect(f.sod).toBe(false);
});

describe("WorkflowDefinitionsPage", () => {
  const DEF = { id: "d1", code: "po", version: 1, name: "PO approval", subject_type: "procurement.purchase_order", is_active: true, separation_of_duties: true, distinct_approvers: false, stages: [{ order: 1, name: "Manager", policy: "ANY_OF", approvers: [{ type: "ROLE", ref: "Procurement Manager" }], min_amount: null, max_amount: null, due_hours: 24, escalate_to_user_id: null }] };
  const common = [
    http.get("*/api/v1/workflows/subject-types", () => HttpResponse.json({ subject_types: ["generic", "procurement.purchase_order"] })),
    http.get("*/api/v1/roles", () => HttpResponse.json([{ id: "r1", name: "Procurement Manager", display_name: "Procurement Manager", is_system: false, permissions: [] }])),
    http.get("*/api/v1/org/departments", () => HttpResponse.json({ results: [], next: null, previous: null })),
    http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [], next: null, previous: null })),
  ];
  it("lists definitions with a readable summary", async () => {
    server.use(...common, http.get("*/api/v1/workflows/definitions", () => HttpResponse.json({ results: [DEF, { ...DEF, id: "d0", version: 0, is_active: false }], next: null, previous: null })));
    renderWithProviders(<WorkflowDefinitionsPage />, { permissions: ["workflow.definitions.manage"] });
    expect(await screen.findByText("PO approval · po v1")).toBeInTheDocument();
    expect(screen.getAllByText(/Manager: any of role Procurement Manager · due in 24 h/)).toHaveLength(2);
    expect(screen.getByText("Retired")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /New version of po/ })).toHaveLength(1);
  });
  it("creates a workflow, blocking invalid input and showing server refusals", async () => {
    let body: Record<string, unknown> | null = null; let refuse = true;
    server.use(...common,
      http.get("*/api/v1/workflows/definitions", () => HttpResponse.json({ results: [], next: null, previous: null })),
      http.post("*/api/v1/workflows/definitions", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return refuse ? HttpResponse.json({ error: { code: "unknown_role", message: "Unknown role 'Procurement Manager'." } }, { status: 400 }) : HttpResponse.json(DEF, { status: 201 }); }));
    renderWithProviders(<WorkflowDefinitionsPage />, { permissions: ["workflow.definitions.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    expect(await screen.findByText(/code may use letters/)).toBeInTheDocument();
    expect(body).toBeNull();
    await userEvent.type(screen.getByLabelText("Code"), "po-approval");
    await userEvent.type(screen.getByLabelText("Name"), "PO approval");
    await screen.findByRole("option", { name: "procurement purchase order" });
    await userEvent.selectOptions(screen.getByLabelText("Approves"), "procurement.purchase_order");
    await screen.findByRole("option", { name: "Procurement Manager" });
    await userEvent.selectOptions(screen.getByLabelText("Step 1 approver 1 role"), "Procurement Manager");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.selectOptions(screen.getByLabelText("Step 2 approver 1 type"), "MANAGER");
    await userEvent.type(screen.getByLabelText("Step 2 from amount"), "1000");
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    expect(await screen.findByText(/Unknown role/)).toBeInTheDocument();
    expect(body).toMatchObject({ code: "po-approval", subject_type: "procurement.purchase_order", separation_of_duties: true });
    expect((body as unknown as { stages: unknown[] }).stages).toHaveLength(2);
    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Create workflow" })).toBeNull());
  });
  it("opens a new version with code and subject locked", async () => {
    let body: { code?: string } | null = null;
    server.use(...common, http.get("*/api/v1/workflows/definitions", () => HttpResponse.json({ results: [DEF], next: null, previous: null })), http.post("*/api/v1/workflows/definitions", async ({ request }) => { body = (await request.json()) as { code?: string }; return HttpResponse.json(DEF, { status: 201 }); }));
    renderWithProviders(<WorkflowDefinitionsPage />, { permissions: ["workflow.definitions.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New version of po" }));
    expect(screen.getByText(/creates version 2/)).toBeInTheDocument();
    expect(screen.getByLabelText("Code")).toBeDisabled();
    expect(screen.getByLabelText("Approves")).toBeDisabled();
    await screen.findByRole("option", { name: "Procurement Manager" });
    await userEvent.click(screen.getByRole("button", { name: "Save new version" }));
    await waitFor(() => expect(body?.code).toBe("po"));
  });
  it("moves and removes steps", async () => {
    server.use(...common, http.get("*/api/v1/workflows/definitions", () => HttpResponse.json({ results: [], next: null, previous: null })));
    renderWithProviders(<WorkflowDefinitionsPage />, { permissions: ["workflow.definitions.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    await userEvent.type(screen.getByLabelText("Step name"), "First");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getAllByLabelText("Step name")[1]!, "Second");
    await userEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    expect((screen.getAllByLabelText("Step name")[0] as HTMLInputElement).value).toBe("Second");
    await userEvent.click(screen.getByRole("button", { name: "Remove step 1" }));
    expect(screen.getAllByLabelText("Step name")).toHaveLength(1);
    expect((screen.getByLabelText("Step name") as HTMLInputElement).value).toBe("First");
  });
});

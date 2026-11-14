import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { CapaListPage, validateCapa } from "./CapaListPage";
import { CapaPage, canResubmitCapa, validateCapaSubmit, validateImplemented } from "./CapaPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const capa = (o = {}) => ({ id: "c1", number: "CAPA-1", kind: "CORRECTIVE", title: "Fix supplier process", source_type: "NCR", source_id: "n1", status: "ANALYSIS", owner_id: "u1", reviewer_id: "u2", due_date: "2026-12-01", cycles: 1, overdue: false, effectiveness_due: null, closed_at: null, ...o });
const detail = (o = {}) => ({ ...capa(), problem: "Cracks", justification: "", containment: "", correction: "", corrective: "", preventive: "", analyses: [], reviews: [], actions: [], evidence: [], history: [], costs: [], ...o });
const act = (o = {}) => ({ id: "a1", parent_type: "capa", parent_id: "c1", action_type: "CORRECTIVE", description: "Change supplier", owner_id: "u1", due_date: "2026-12-01", status: "OPEN", completed_at: null, completion_note: "", overdue: false, ...o });
const h = (action: string) => ({ action, from: null, to: null, actor: null, note: "", at: "2026-11-02" });
const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }, { id: "e2", employee_no: "E-2", name: "Sara", status: "ACTIVE", user_id: "u2" }] }));
const methods = http.get("*/api/v1/quality/config/ANALYSIS_METHOD", () => HttpResponse.json([{ code: "FIVE_WHYS", name: "5 Whys" }]));

describe("validators", () => {
  it("capa, submit gate, implemented gate, resubmit", () => {
    const f = { kind: "CORRECTIVE", title: "t", source_type: "OTHER", source_id: "", problem: "p", owner_id: "u1", reviewer_id: "u2", due_date: "2026-12-01" };
    expect(validateCapa({ ...f, title: " " })).toMatch(/title/);
    expect(validateCapa({ ...f, source_type: "NCR" })).toMatch(/Name the record/);
    expect(validateCapa({ ...f, reviewer_id: "u1" })).toMatch(/different person/);
    expect(validateCapa({ ...f, due_date: "" })).toMatch(/due date/);
    expect(validateCapa(f)).toBeNull();
    const base = { analyses: [], corrective: "", preventive: "", actions: [], cycles: 1 };
    expect(validateCapaSubmit(base)).toMatch(/root cause/);
    const an = [{ id: "r", method: "FIVE_WHYS", details: {}, conclusion: "x", cycle: 1 }];
    expect(validateCapaSubmit({ ...base, analyses: an })).toMatch(/corrective or preventive action\./);
    expect(validateCapaSubmit({ ...base, analyses: an, corrective: "x" })).toMatch(/Assign at least one/);
    expect(validateCapaSubmit({ ...base, analyses: [{ ...an[0]!, cycle: 0 }], corrective: "x", actions: [act()] })).toMatch(/root cause/);
    expect(validateCapaSubmit({ ...base, analyses: an, corrective: "x", actions: [act({ status: "CANCELLED" })] })).toMatch(/Assign at least one/);
    expect(validateCapaSubmit({ ...base, analyses: an, corrective: "x", actions: [act()] })).toBeNull();
    expect(validateImplemented({ actions: [act()], evidence: [] })).toMatch(/completed/);
    expect(validateImplemented({ actions: [act({ status: "DONE" })], evidence: [] })).toMatch(/evidence/);
    expect(validateImplemented({ actions: [act({ status: "VERIFIED" })], evidence: [{ id: "e", file_id: "f", file_name: "a.pdf", kind: "", description: "", uploaded_by: "u", at: "" }] })).toBeNull();
    expect(canResubmitCapa({ status: "ANALYSIS", history: [h("SUBMITTED"), h("CHANGES_REQUESTED")] })).toBe(true);
    expect(canResubmitCapa({ status: "ANALYSIS", history: [h("CHANGES_REQUESTED"), h("NOT_EFFECTIVE")] })).toBe(false);
    expect(canResubmitCapa({ status: "APPROVED", history: [h("CHANGES_REQUESTED")] })).toBe(false);
  });
});

describe("CapaListPage", () => {
  it("lists, links and hides New CAPA without quality.capa.manage", async () => {
    server.use(http.get("*/api/v1/quality/capas", () => HttpResponse.json({ results: [capa({ overdue: true })], next: null })), employees);
    renderWithProviders(<CapaListPage />, { permissions: ["quality.view"] });
    expect(await screen.findByRole("link", { name: "CAPA-1" })).toHaveAttribute("href", "/app/quality/capas/c1");
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New CAPA" })).toBeNull();
  });

  it("rejects the same owner and reviewer, then posts", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(employees, http.get("*/api/v1/quality/capas", () => HttpResponse.json({ results: [], next: null })),
      http.post("*/api/v1/quality/capas", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(capa(), { status: 201 }); }));
    renderWithProviders(<CapaListPage />, { permissions: ["quality.view", "quality.capa.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New CAPA" }));
    const dlg = within(await screen.findByRole("dialog", { name: "New CAPA" }));
    await userEvent.type(dlg.getByLabelText("Title"), "Fix process");
    await userEvent.type(dlg.getByLabelText("Problem"), "Cracks");
    await dlg.findAllByRole("option", { name: /Abel/ });
    await userEvent.selectOptions(dlg.getByLabelText("Owner"), "u1");
    await userEvent.selectOptions(dlg.getByLabelText("Effectiveness reviewer"), "u1");
    const due = dlg.getByLabelText("Due date");
    await userEvent.click(dlg.getByRole("button", { name: "Create" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/due date|different person/);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(due, { target: { value: "2026-12-01" } });
    await userEvent.click(dlg.getByRole("button", { name: "Create" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/different person/);
    expect(body).toBeNull();
    await userEvent.selectOptions(dlg.getByLabelText("Effectiveness reviewer"), "u2");
    await userEvent.click(dlg.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ kind: "CORRECTIVE", source_type: "OTHER", owner_id: "u1", reviewer_id: "u2", due_date: "2026-12-01" });
    expect(body).not.toHaveProperty("source_id");
  });
});

describe("CapaPage", () => {
  const view = (d: object, permissions: string[]) => {
    server.use(employees, methods, http.get("*/api/v1/quality/capas/c1", () => HttpResponse.json(d)));
    return renderWithProviders(<Routes><Route path="/app/quality/capas/:id" element={<CapaPage />} /></Routes>, { permissions, route: "/app/quality/capas/c1" });
  };
  const M = ["quality.view", "quality.capa.manage"];

  it("blocks submission until analysis, plan and action exist", async () => {
    view(detail(), M);
    await userEvent.click(await screen.findByRole("button", { name: "Submit for approval" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/root cause analysis first/);
  });

  it("records a root cause", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/capas/c1/root-causes", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "r1" }, { status: 201 }); }));
    view(detail(), M);
    await userEvent.click(await screen.findByRole("button", { name: "Record a root cause analysis" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Record a root cause analysis" }));
    await dlg.findByRole("option", { name: "5 Whys" });
    await userEvent.selectOptions(dlg.getByLabelText("Method"), "FIVE_WHYS");
    await userEvent.type(dlg.getByLabelText(/Conclusion/), "Poor heat control");
    await userEvent.click(dlg.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(body).toEqual({ method: "FIVE_WHYS", conclusion: "Poor heat control" }));
  });

  it("submits when complete", async () => {
    let hit = false;
    server.use(http.post("*/api/v1/quality/capas/c1/submit", () => { hit = true; return HttpResponse.json(capa({ status: "PENDING_APPROVAL" })); }));
    view(detail({ corrective: "Change supplier", analyses: [{ id: "r", method: "FIVE_WHYS", details: {}, conclusion: "x", cycle: 1 }], actions: [act()] }), M);
    await userEvent.click(await screen.findByRole("button", { name: "Submit for approval" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Submit CAPA for approval" }));
    await userEvent.click(dlg.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(hit).toBe(true));
  });

  it("offers resubmit after changes were requested", async () => {
    view(detail({ history: [h("SUBMITTED"), h("CHANGES_REQUESTED")] }), M);
    expect(await screen.findByRole("button", { name: "Resubmit for approval" })).toBeInTheDocument();
  });

  it("gates mark implemented on actions and evidence", async () => {
    view(detail({ status: "IMPLEMENTING", actions: [act()] }), M);
    await userEvent.click(await screen.findByRole("button", { name: "Mark implemented" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Every action must be completed/);
  });

  it("shows the server's refusal on effectiveness", async () => {
    server.use(http.post("*/api/v1/quality/capas/c1/effectiveness", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Only the assigned effectiveness reviewer can verify this CAPA." } }, { status: 403 })));
    view(detail({ status: "VERIFYING", effectiveness_due: "2027-01-01" }), ["quality.view", "quality.capa.verify"]);
    await userEvent.click(await screen.findByRole("button", { name: "Verify effectiveness" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Verify effectiveness" }));
    await userEvent.selectOptions(dlg.getByLabelText(/Was it effective/), "yes");
    await userEvent.type(dlg.getByLabelText(/Effectiveness evidence/), "No recurrence");
    await userEvent.click(dlg.getByRole("button", { name: "Record verification" }));
    expect(await dlg.findByText(/Only the assigned effectiveness reviewer/)).toBeInTheDocument();
  });

  it("gives a viewer no actions and shows past reviews", async () => {
    view(detail({ status: "ANALYSIS", reviews: [{ effective: false, notes: "Recurred", verified_on: "2026-10-01", verified_by: "u2", cycle: 1 }] }), ["quality.view"]);
    expect(await screen.findByText("Not effective")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel CAPA" })).toBeNull();
  });
});

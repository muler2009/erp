import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { MasterPlanPage, MasterPlansPage, changesRequested, submitBlock, validateMasterPlan, validateMeasurement, validateObjective } from "./MasterPlansPage";
import { CompliancePage, StandardPage, StandardsPage, validateAssessment, validateRequirement, validateStandard, validateVersion } from "./StandardsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] }));
const obj = (o = {}) => ({ id: "o1", plan_id: "mp1", name: "Cut scrap", metric: "scrap %", target: "4", direction: "LOWER", unit: "%", owner_id: "u1", latest_value: null, latest_period: null, met: null, ...o });
const plan = (o = {}) => ({ id: "mp1", number: "QP-1", title: "Plant quality plan", scope_type: "DEPARTMENT", scope_ref: "", scope_label: "Assembly", status: "DRAFT", revision: 1, owner_id: "u1", department_id: null, valid_from: null, valid_to: null, approved_at: null, standards: "ISO 9001", objectives: [], control_points: [], revisions: [], history: [], ...o });
const P = ["quality.view", "quality.plan.manage", "quality.standards.manage"];
const planRoute = (d: object, permissions = P) => { server.use(employees, http.get("*/api/v1/quality/plans/mp1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/plans/:id" element={<MasterPlanPage />} /></Routes>, { permissions, route: "/app/quality/plans/mp1" }); };
const req = (o = {}) => ({ id: "rq1", standard_id: "s1", clause: "7.1", text: "Resources", status: "NOT_ASSESSED", owner_id: "u1", department_id: null, next_review_on: null, needs_review: false, documents: [], last_gap: "", ...o });
const std = (o = {}) => ({ id: "s1", code: "ISO-9001", name: "Quality management", kind: "STANDARD", issuer: "ISO", version: "2015", status: "ACTIVE", effective_from: null, requirements: [req()], changes: [], ...o });
const stdRoute = (d: object, permissions = P) => { server.use(employees, http.get("*/api/v1/quality/standards/s1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/standards/:id" element={<StandardPage />} /></Routes>, { permissions, route: "/app/quality/standards/s1" }); };

describe("validators", () => {
  it("plan, objective, measurement and approval rules", () => {
    const f = { title: "t", scope_type: "PROJECT", owner_id: "u1", valid_from: "", valid_to: "" };
    expect(validateMasterPlan({ ...f, title: " " })).toMatch(/title/);
    expect(validateMasterPlan({ ...f, scope_type: "X" })).toMatch(/covers/);
    expect(validateMasterPlan({ ...f, valid_from: "2026-02-01", valid_to: "2026-01-01" })).toMatch(/end before/);
    expect(validateMasterPlan(f)).toBeNull();
    const o = { name: "n", metric: "m", target: "4", direction: "LOWER", owner_id: "u" };
    expect(validateObjective({ ...o, target: "x" })).toMatch(/number/);
    expect(validateObjective({ ...o, direction: "" })).toMatch(/lower or higher/);
    expect(validateObjective(o)).toBeNull();
    expect(validateMeasurement("", "1")).toMatch(/period/);
    expect(validateMeasurement("2026-01-01", "abc")).toMatch(/number/);
    expect(validateMeasurement("2026-01-01", "3.5")).toBeNull();
    expect(submitBlock({ objectives: [], control_points: [] })).toMatch(/at least one/);
    expect(submitBlock({ objectives: [obj()], control_points: [] })).toBeNull();
    const h = (action: string) => ({ action, from: null, to: null, actor: null, note: "", at: "" });
    expect(changesRequested({ status: "DRAFT", history: [h("SUBMITTED"), h("CHANGES_REQUESTED")] })).toBe(true);
    expect(changesRequested({ status: "DRAFT", history: [h("CHANGES_REQUESTED"), h("RESUBMITTED"), h("REJECTED")] })).toBe(false);
    expect(changesRequested({ status: "DRAFT", history: [h("CHANGES_REQUESTED"), h("REVISION_STARTED")] })).toBe(false);
    expect(changesRequested({ status: "PENDING_APPROVAL", history: [h("CHANGES_REQUESTED")] })).toBe(false);
  });
  it("standard, version, requirement and assessment rules", () => {
    expect(validateStandard({ code: "", name: "n" })).toMatch(/code/);
    expect(validateStandard({ code: "c", name: "n" })).toBeNull();
    expect(validateVersion("2015", { version: "2015", summary: "s" })).toMatch(/already/);
    expect(validateVersion("2015", { version: "2026", summary: " " })).toMatch(/Summarise/);
    expect(validateVersion("2015", { version: "2026", summary: "s" })).toBeNull();
    expect(validateRequirement(["7.1"], { clause: "7.1", text: "t", owner_id: "u" })).toMatch(/already/);
    expect(validateRequirement([], { clause: "7.1", text: "t", owner_id: "" })).toMatch(/owner/);
    expect(validateRequirement([], { clause: "7.1", text: "t", owner_id: "u" })).toBeNull();
    expect(validateAssessment("PARTIAL", " ", "")).toMatch(/gap/);
    expect(validateAssessment("NON_COMPLIANT", "g", "")).toBeNull();
    expect(validateAssessment("NOT_APPLICABLE", "", "")).toMatch(/does not apply/);
    expect(validateAssessment("COMPLIANT", "", "")).toBeNull();
    expect(validateAssessment("", "", "")).toMatch(/Choose/);
  });
});

describe("MasterPlansPage", () => {
  it("lists plans, filters, and hides creation without permission", async () => {
    const seen: string[] = [];
    server.use(employees, http.get("*/api/v1/quality/plans", ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ results: [plan()] }); }));
    renderWithProviders(<MasterPlansPage />, { permissions: ["quality.view"] });
    expect(await screen.findByText("Plant quality plan")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New quality plan" })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Plan status"), "APPROVED");
    await waitFor(() => expect(seen.some((s) => s.includes("status=APPROVED"))).toBe(true));
  });

  it("creates a plan after validation", async () => {
    let body: Record<string, unknown> = {};
    server.use(employees, http.get("*/api/v1/quality/plans", () => HttpResponse.json({ results: [] })), http.post("*/api/v1/quality/plans", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(plan(), { status: 201 }); }));
    renderWithProviders(<MasterPlansPage />, { permissions: P });
    await userEvent.click(await screen.findByRole("button", { name: "New quality plan" }));
    const d = within(await screen.findByRole("dialog", { name: "New quality plan" }));
    await userEvent.click(d.getByRole("button", { name: "Create" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/title/);
    await userEvent.type(d.getByLabelText("Title"), "Plant quality plan");
    await userEvent.selectOptions(d.getByLabelText("Covers"), "DEPARTMENT");
    await d.findByRole("option", { name: /Abel/ });
    await userEvent.selectOptions(d.getByLabelText("Owner"), "u1");
    await userEvent.click(d.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(body).toEqual({ title: "Plant quality plan", scope_type: "DEPARTMENT", owner_id: "u1" }));
  });
});

describe("MasterPlanPage", () => {
  it("refuses to submit an empty plan, then submits one with an objective", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/plans/mp1/submit", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(plan({ status: "PENDING_APPROVAL" })); }));
    const { unmount } = planRoute(plan());
    await userEvent.click(await screen.findByRole("button", { name: "Submit for approval" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least one objective or control point/);
    expect(body).toBeNull();
    unmount();
    planRoute(plan({ objectives: [obj()] }));
    await userEvent.click(await screen.findByRole("button", { name: "Submit for approval" }));
    const d = within(await screen.findByRole("dialog", { name: "Submit for approval" }));
    await userEvent.type(d.getByLabelText("Comment"), "Ready");
    await userEvent.click(d.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(body).toEqual({ comment: "Ready" }));
  });

  it("offers resubmit instead of submit when changes were requested", async () => {
    let called = false;
    server.use(http.post("*/api/v1/quality/plans/mp1/resubmit", () => { called = true; return HttpResponse.json(plan({ status: "PENDING_APPROVAL" })); }));
    planRoute(plan({ objectives: [obj()], history: [{ action: "CHANGES_REQUESTED", from: null, to: null, actor: null, note: "", at: "2026-11-01T00:00:00Z" }] }));
    expect(await screen.findByText("Changes requested", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resubmit for approval" }));
    const d = within(await screen.findByRole("dialog", { name: "Resubmit for approval" }));
    await userEvent.click(d.getByRole("button", { name: "Resubmit" }));
    await waitFor(() => expect(called).toBe(true));
  });

  it("adds an objective with a numeric target", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/plans/mp1/objectives", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(obj(), { status: 201 }); }));
    planRoute(plan());
    await userEvent.click(await screen.findByRole("button", { name: "Add an objective" }));
    const d = within(await screen.findByRole("dialog", { name: "Add an objective" }));
    await d.findByRole("option", { name: /Abel/ });
    await userEvent.type(d.getByLabelText("Objective"), "Cut scrap");
    await userEvent.type(d.getByLabelText("Metric"), "scrap %");
    await userEvent.type(d.getByLabelText("Target"), "four");
    await userEvent.selectOptions(d.getByLabelText("Better when"), "LOWER");
    await userEvent.selectOptions(d.getByLabelText("Owner"), "u1");
    await userEvent.click(d.getByRole("button", { name: "Add" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/target must be a number/);
    await userEvent.clear(d.getByLabelText("Target"));
    await userEvent.type(d.getByLabelText("Target"), "4");
    await userEvent.click(d.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(body).toMatchObject({ name: "Cut scrap", metric: "scrap %", target: "4", direction: "LOWER", owner_id: "u1" }));
  });

  it("shows met and not-met results and lets an approved plan record measurements only", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/objectives/o1/measure", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ ok: true }, { status: 201 }); }));
    planRoute(plan({ status: "APPROVED", objectives: [obj({ latest_value: "5", latest_period: "2026-10-01", met: false })] }));
    expect(await screen.findByText("Not met")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add an objective" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record a measurement" }));
    const d = within(await screen.findByRole("dialog", { name: "Record a measurement" }));
    fireEvent.change(d.getByLabelText("Period"), { target: { value: "2026-11-01" } });
    await userEvent.type(d.getByLabelText("Value"), "3.2");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(body).toEqual({ period: "2026-11-01", value: "3.2" }));
  });

  it("starts a revision of an approved plan only with a reason", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/plans/mp1/revise", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(plan({ revision: 2 })); }));
    planRoute(plan({ status: "APPROVED" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start a revision" }));
    const d = within(await screen.findByRole("dialog", { name: "Start a revision" }));
    await userEvent.click(d.getByRole("button", { name: "Start revision" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/Reason for the revision is required/);
    await userEvent.type(d.getByLabelText("Reason for the revision"), "New customer spec");
    await userEvent.click(d.getByRole("button", { name: "Start revision" }));
    await waitFor(() => expect(body).toEqual({ reason: "New customer spec" }));
  });

  it("pending plans offer no editing, and view-only users see no actions", async () => {
    planRoute(plan({ status: "PENDING_APPROVAL" }), ["quality.view"]);
    expect(await screen.findByText(/Waiting for approval/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Submit|Add an|Start a revision/ })).not.toBeInTheDocument();
  });
});

describe("Standards", () => {
  it("adds a standard and shows a duplicate refusal from the server", async () => {
    server.use(employees, http.get("*/api/v1/quality/standards", () => HttpResponse.json({ results: [std()] })), http.post("*/api/v1/quality/standards", () => HttpResponse.json({ error: { code: "duplicate", message: "A standard with this code already exists." } }, { status: 400 })));
    renderWithProviders(<StandardsPage />, { permissions: P });
    expect(await screen.findByText("ISO-9001")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add a standard" }));
    const d = within(await screen.findByRole("dialog", { name: "Add a standard" }));
    await userEvent.type(d.getByLabelText("Code"), "ISO-9001");
    await userEvent.type(d.getByLabelText("Name"), "Quality management");
    await userEvent.click(d.getByRole("button", { name: "Add" }));
    expect(await d.findByText(/already exists/)).toBeInTheDocument();
  });

  it("assesses a requirement: a gap is needed for non-compliance", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/requirements/rq1/assess", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(req({ status: "NON_COMPLIANT" })); }));
    stdRoute(std());
    await userEvent.click(await screen.findByRole("button", { name: "Assess" }));
    const d = within(await screen.findByRole("dialog", { name: "Assess the requirement" }));
    await userEvent.selectOptions(d.getByLabelText("Assessment"), "NON_COMPLIANT");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/Describe the gap/);
    await userEvent.type(d.getByLabelText("Gap"), "No calibration records");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(body).toEqual({ status: "NON_COMPLIANT", gap: "No calibration records" }));
  });

  it("flags requirements for re-assessment after a new version, and records the version", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/standards/s1/new-version", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(std({ version: "2026" })); }));
    stdRoute(std({ requirements: [req({ needs_review: true, status: "COMPLIANT" })], changes: [{ from_version: "2008", to_version: "2015", summary: "Annex SL", effective_on: null, impact: "" }] }));
    expect(await screen.findByText("Re-assess")).toBeInTheDocument();
    expect(screen.getByText(/2008 to 2015: Annex SL/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record a new version" }));
    const d = within(await screen.findByRole("dialog", { name: "Record a new version" }));
    await userEvent.type(d.getByLabelText("New version"), "2015");
    await userEvent.type(d.getByLabelText("What changed"), "Edition");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/already the current version/);
    await userEvent.clear(d.getByLabelText("New version"));
    await userEvent.type(d.getByLabelText("New version"), "2026");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(body).toEqual({ version: "2026", summary: "Edition" }));
  });

  it("refuses a duplicate clause before sending", async () => {
    let sent = false;
    server.use(http.post("*/api/v1/quality/standards/s1/requirements", () => { sent = true; return HttpResponse.json(req(), { status: 201 }); }));
    stdRoute(std());
    await userEvent.click(await screen.findByRole("button", { name: "Add a requirement" }));
    const d = within(await screen.findByRole("dialog", { name: "Add a requirement" }));
    await d.findByRole("option", { name: /Abel/ });
    await userEvent.type(d.getByLabelText("Clause"), "7.1");
    await userEvent.type(d.getByLabelText("Requirement"), "Again");
    await userEvent.selectOptions(d.getByLabelText("Owner"), "u1");
    await userEvent.click(d.getByRole("button", { name: "Add" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/already recorded/);
    expect(sent).toBe(false);
  });

  it("view-only users cannot assess", async () => {
    stdRoute(std(), ["quality.view"]);
    expect(await screen.findByText("Resources")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Assess" })).not.toBeInTheDocument();
  });
});

describe("CompliancePage", () => {
  it("shows the percentage, counts and gaps, and filters by standard", async () => {
    const seen: string[] = [];
    server.use(employees, http.get("*/api/v1/quality/standards", () => HttpResponse.json({ results: [std()] })),
      http.get("*/api/v1/quality/compliance", ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ counts: { NOT_ASSESSED: 1, COMPLIANT: 3, PARTIAL: 0, NON_COMPLIANT: 1, NOT_APPLICABLE: 0 }, total: 5, compliance_percent: 75, gaps: [req({ status: "NON_COMPLIANT", last_gap: "No records" })], due_for_review: 2 }); }));
    renderWithProviders(<CompliancePage />, { permissions: ["quality.view"] });
    expect(await screen.findByText(/75% compliant/)).toBeInTheDocument();
    expect(screen.getByText("No records")).toBeInTheDocument();
    expect(screen.getByText("Compliant: 3")).toBeInTheDocument();
    await screen.findByRole("option", { name: /ISO-9001/ });
    await userEvent.selectOptions(screen.getByLabelText("Standard filter"), "s1");
    await waitFor(() => expect(seen.some((s) => s.includes("standard_id=s1"))).toBe(true));
  });

  it("says so when nothing has been assessed", async () => {
    server.use(employees, http.get("*/api/v1/quality/standards", () => HttpResponse.json({ results: [] })), http.get("*/api/v1/quality/compliance", () => HttpResponse.json({ counts: { NOT_ASSESSED: 2, COMPLIANT: 0, PARTIAL: 0, NON_COMPLIANT: 0, NOT_APPLICABLE: 0 }, total: 2, compliance_percent: null, gaps: [], due_for_review: 0 })));
    renderWithProviders(<CompliancePage />, { permissions: ["quality.view"] });
    expect(await screen.findByText("No assessed requirements yet")).toBeInTheDocument();
    expect(screen.getByText("No open gaps")).toBeInTheDocument();
  });
});

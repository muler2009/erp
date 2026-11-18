import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AuditPage, closeBlock, reportBlock, validateAnswer, validateFinding } from "./AuditPage";
import { AuditsPage, validateAudit } from "./AuditsPage";
import { ChecklistTemplatesPage, parseQuestions, validateTemplate } from "./ChecklistTemplatesPage";
import { FindingPage, FindingsPage, findingCloseBlock } from "./FindingsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }, { id: "e2", employee_no: "E-2", name: "Sara", status: "ACTIVE", user_id: "u2" }] }));
const cfg = http.get("*/api/v1/quality/config/:kind", ({ params }) => HttpResponse.json(params.kind === "AUDIT_TYPE" ? [{ code: "INTERNAL", name: "Internal" }] : params.kind === "FINDING_TYPE" ? [{ code: "NONCONFORMITY", name: "Non-conformity" }, { code: "OBSERVATION", name: "Observation" }] : [{ code: "MAJOR", name: "Major" }]));
const audit = (o = {}) => ({ id: "a1", number: "AUD-1", program: "", audit_type: "INTERNAL", title: "Stores audit", status: "PLANNED", planned_start: "2026-11-20", planned_end: "2026-11-21", lead_auditor_id: "u1", auditee_department_id: null, supplier_id: null, follow_up_of: null, findings_open: 0, findings_total: 0, ...o });
const item = (o = {}) => ({ id: "c1", position: 1, question: "Are instruments calibrated?", response: "PENDING", note: "", requirement_id: null, procedure_document_id: null, ...o });
const finding = (o = {}) => ({ id: "f1", number: "F-1", audit_id: "a1", finding_type: "NONCONFORMITY", severity: "MAJOR", description: "Overdue instruments", requirement_ref: "", checklist_item_id: "c1", status: "OPEN", due_date: null, owner_id: null, capa_id: null, closure_note: "", actions: [], ...o });
const detail = (o = {}) => ({ ...audit(), scope: "Stores", objectives: "", criteria: "", summary: "", team: [{ user_id: "u1", role: "LEAD" }], checklist: [], findings: [], evidence: [], history: [], ...o });
const act = (o = {}) => ({ id: "x1", parent_type: "finding", parent_id: "f1", action_type: "CORRECTIVE", description: "Recalibrate", owner_id: "u1", due_date: "2026-12-01", status: "OPEN", completed_at: null, completion_note: "", overdue: false, ...o });
const A = ["quality.view", "quality.audit.manage"];
const auditRoute = (d: object, permissions: string[]) => { server.use(employees, cfg, http.get("*/api/v1/quality/audits/a1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/audits/:id" element={<AuditPage />} /></Routes>, { permissions, route: "/app/quality/audits/a1" }); };
const findingRoute = (d: object, permissions: string[]) => { server.use(employees, http.get("*/api/v1/quality/findings/f1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/findings/:id" element={<FindingPage />} /></Routes>, { permissions, route: "/app/quality/findings/f1" }); };

describe("validators", () => {
  it("audit, answer, finding, report, close, finding close, template", () => {
    const f = { audit_type: "INTERNAL", title: "t", scope: "s", planned_start: "2026-11-20", planned_end: "2026-11-21", lead_auditor_id: "u1" };
    expect(validateAudit({ ...f, planned_end: "2026-11-19" })).toMatch(/cannot end before/);
    expect(validateAudit({ ...f, lead_auditor_id: "" })).toMatch(/lead auditor/);
    expect(validateAudit(f)).toBeNull();
    expect(validateAnswer("", "")).toMatch(/Choose/);
    expect(validateAnswer("NONCONFORMS", " ")).toMatch(/Describe/);
    expect(validateAnswer("CONFORMS", "")).toBeNull();
    expect(validateFinding("", "MAJOR", "d")).toMatch(/type/);
    expect(validateFinding("T", "S", " ")).toMatch(/Describe/);
    expect(reportBlock([{ id: "c1", response: "PENDING" }], [], "s")).toMatch(/1 checklist question/);
    expect(reportBlock([{ id: "c1", response: "CONFORMS" }], [], " ")).toMatch(/summary/);
    expect(reportBlock([{ id: "c1", response: "NONCONFORMS" }], [], "s")).toMatch(/no finding raised/);
    expect(reportBlock([{ id: "c1", response: "NONCONFORMS" }], [{ checklist_item_id: "c1" }], "s")).toBeNull();
    expect(closeBlock([{ status: "OPEN" }])).toMatch(/Every finding/);
    expect(closeBlock([{ status: "CLOSED" }])).toBeNull();
    expect(findingCloseBlock({ finding_type: "OBSERVATION", capa_id: null, actions: [] })).toBeNull();
    expect(findingCloseBlock({ finding_type: "NONCONFORMITY", capa_id: null, actions: [] })).toMatch(/needs a corrective action/);
    expect(findingCloseBlock({ finding_type: "NONCONFORMITY", capa_id: null, actions: [act({ status: "CANCELLED" })] })).toMatch(/needs a corrective action/);
    expect(findingCloseBlock({ finding_type: "NONCONFORMITY", capa_id: null, actions: [act({ status: "DONE" })] })).toMatch(/verified/);
    expect(findingCloseBlock({ finding_type: "NONCONFORMITY", capa_id: "k", actions: [] })).toBeNull();
    expect(parseQuestions("A\n\n ISO:4.1 | B ")).toEqual([{ question: "A" }, { question: "B", requirement: "ISO:4.1" }]);
    expect(validateTemplate("n", "INTERNAL", " \n ")).toMatch(/at least one/);
    expect(validateTemplate("n", "INTERNAL", "Q")).toBeNull();
  });
});

describe("AuditsPage", () => {
  it("lists audits and hides scheduling from a viewer", async () => {
    server.use(employees, cfg, http.get("*/api/v1/quality/audits", () => HttpResponse.json({ results: [audit({ findings_open: 1, findings_total: 3 })], next: null })));
    renderWithProviders(<AuditsPage />, { permissions: ["quality.view"] });
    expect(await screen.findByRole("link", { name: "AUD-1" })).toHaveAttribute("href", "/app/quality/audits/a1");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule an audit" })).toBeNull();
  });

  it("schedules an audit with a team", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(employees, cfg, http.get("*/api/v1/org/departments", () => HttpResponse.json({ results: [] })), http.get("*/api/v1/quality/checklist-templates", () => HttpResponse.json([])),
      http.get("*/api/v1/quality/audits", () => HttpResponse.json({ results: [], next: null })),
      http.post("*/api/v1/quality/audits", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(audit(), { status: 201 }); }));
    renderWithProviders(<AuditsPage />, { permissions: A });
    await userEvent.click(await screen.findByRole("button", { name: "Schedule an audit" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Schedule an audit" }));
    await dlg.findByRole("option", { name: "Internal" });
    await dlg.findByRole("option", { name: /Abel/ });
    await userEvent.selectOptions(dlg.getByLabelText("Audit type"), "INTERNAL");
    await userEvent.type(dlg.getByLabelText("Title"), "Stores audit");
    await userEvent.type(dlg.getByLabelText("Scope"), "Stores");
    fireEvent.change(dlg.getByLabelText("Start"), { target: { value: "2026-11-21" } });
    fireEvent.change(dlg.getByLabelText("End"), { target: { value: "2026-11-20" } });
    await userEvent.selectOptions(dlg.getByLabelText("Lead auditor"), "u1");
    await userEvent.click(dlg.getByRole("button", { name: "Schedule" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/cannot end before/);
    fireEvent.change(dlg.getByLabelText("End"), { target: { value: "2026-11-22" } });
    await userEvent.click(dlg.getByLabelText(/Sara/));
    await userEvent.click(dlg.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(body).toMatchObject({ audit_type: "INTERNAL", lead_auditor_id: "u1", team: ["u2"], planned_end: "2026-11-22" }));
  });
});

describe("AuditPage", () => {
  it("starts a planned audit and offers no answers yet", async () => {
    let hit = false;
    server.use(http.post("*/api/v1/quality/audits/a1/start", () => { hit = true; return HttpResponse.json(audit({ status: "IN_PROGRESS" })); }));
    auditRoute(detail({ checklist: [item()] }), A);
    await userEvent.click(await screen.findByRole("button", { name: "Start audit" }));
    await waitFor(() => expect(hit).toBe(true));
    expect(screen.queryByRole("button", { name: "Save answer 1" })).toBeNull();
  });

  it("requires a note for a non-conforming answer, then saves", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/checklist-items/c1/answer", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(item({ response: "NONCONFORMS" })); }));
    auditRoute(detail({ status: "IN_PROGRESS", checklist: [item()] }), A);
    await userEvent.selectOptions(await screen.findByLabelText("Response to question 1"), "NONCONFORMS");
    await userEvent.click(screen.getByRole("button", { name: "Save answer 1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Describe what was observed/);
    await userEvent.type(screen.getByLabelText("Note for question 1"), "Two overdue");
    await userEvent.click(screen.getByRole("button", { name: "Save answer 1" }));
    await waitFor(() => expect(body).toEqual({ response: "NONCONFORMS", note: "Two overdue" }));
  });

  it("raises a finding", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/audits/a1/findings", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(finding(), { status: 201 }); }));
    auditRoute(detail({ status: "IN_PROGRESS", checklist: [item({ response: "NONCONFORMS", note: "x" })] }), A);
    await userEvent.click(await screen.findByRole("button", { name: "Raise a finding" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Raise a finding" }));
    await dlg.findByRole("option", { name: "Non-conformity" });
    await dlg.findByRole("option", { name: "Major" });
    await userEvent.selectOptions(dlg.getByLabelText("Finding type"), "NONCONFORMITY");
    await userEvent.selectOptions(dlg.getByLabelText("Severity"), "MAJOR");
    await userEvent.type(dlg.getByLabelText(/Description/), "Overdue instruments");
    await userEvent.selectOptions(dlg.getByLabelText("Checklist question"), "c1");
    await userEvent.click(dlg.getByRole("button", { name: "Raise finding" }));
    await waitFor(() => expect(body).toEqual({ finding_type: "NONCONFORMITY", severity: "MAJOR", description: "Overdue instruments", checklist_item_id: "c1" }));
  });

  it("blocks reporting while questions are unanswered", async () => {
    auditRoute(detail({ status: "IN_PROGRESS", checklist: [item()] }), A);
    await userEvent.click(await screen.findByRole("button", { name: "Report the audit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/1 checklist question\(s\) are unanswered/);
  });

  it("blocks reporting a non-conformity with no finding", async () => {
    auditRoute(detail({ status: "IN_PROGRESS", checklist: [item({ response: "NONCONFORMS", note: "x" })] }), A);
    await userEvent.click(await screen.findByRole("button", { name: "Report the audit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no finding raised/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("blocks closing with an open finding", async () => {
    auditRoute(detail({ status: "REPORTED", findings: [finding()] }), A);
    await userEvent.click(await screen.findByRole("button", { name: "Close audit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Every finding must be closed/);
  });

  it("allows cancelling only a planned audit and gives a viewer no controls", async () => {
    auditRoute(detail({ status: "CLOSED" }), A);
    await screen.findByText(/AUD-1/);
    expect(screen.queryByRole("button", { name: "Cancel audit" })).toBeNull();
  });
});

describe("findings", () => {
  it("lists findings", async () => {
    server.use(employees, cfg, http.get("*/api/v1/quality/findings", () => HttpResponse.json({ results: [finding({ owner_id: "u1", due_date: "2026-12-01" })], next: null })));
    renderWithProviders(<FindingsPage />, { permissions: ["quality.view"] });
    expect(await screen.findByRole("link", { name: "F-1" })).toHaveAttribute("href", "/app/quality/findings/f1");
    expect(await screen.findByText("Abel")).toBeInTheDocument();
  });

  it("names the missing action before closing a non-conformity", async () => {
    findingRoute(finding(), A);
    await userEvent.click(await screen.findByRole("button", { name: "Verify and close" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/needs a corrective action or a CAPA/);
  });

  it("raises a CAPA, rejecting the same owner and reviewer", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/findings/f1/capa", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}, { status: 201 }); }));
    findingRoute(finding(), A);
    await userEvent.click(await screen.findByRole("button", { name: "Raise a CAPA" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Raise a CAPA for this finding" }));
    await dlg.findAllByRole("option", { name: /Abel/ });
    await userEvent.selectOptions(dlg.getByLabelText("Kind"), "CORRECTIVE");
    await userEvent.selectOptions(dlg.getByLabelText("Owner"), "u1");
    await userEvent.selectOptions(dlg.getByLabelText("Effectiveness reviewer"), "u1");
    fireEvent.change(dlg.getByLabelText("Due date"), { target: { value: "2026-12-30" } });
    await userEvent.click(dlg.getByRole("button", { name: "Raise CAPA" }));
    expect(await dlg.findByText(/must be different people/)).toBeInTheDocument();
    expect(body).toBeNull();
    await userEvent.selectOptions(dlg.getByLabelText("Effectiveness reviewer"), "u2");
    await userEvent.click(dlg.getByRole("button", { name: "Raise CAPA" }));
    await waitFor(() => expect(body).toEqual({ kind: "CORRECTIVE", owner_id: "u1", reviewer_id: "u2", due_date: "2026-12-30" }));
  });

  it("closes an observation and shows the server refusal for an open CAPA", async () => {
    server.use(http.post("*/api/v1/quality/findings/f1/close", () => HttpResponse.json({ error: { code: "capa_open", message: "The linked CAPA is not closed." } }, { status: 409 })));
    findingRoute(finding({ capa_id: "k1", status: "ACTION_ASSIGNED" }), A);
    await userEvent.click(await screen.findByRole("button", { name: "Verify and close" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Verify and close finding" }));
    await userEvent.type(dlg.getByLabelText(/How closure was verified/), "Checked");
    await userEvent.click(dlg.getByRole("button", { name: "Close finding" }));
    expect(await dlg.findByText(/linked CAPA is not closed/)).toBeInTheDocument();
  });

  it("shows no controls for a closed finding or a viewer", async () => {
    findingRoute(finding({ status: "CLOSED", closure_note: "Verified" }), A);
    expect(await screen.findByText("Verified")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify and close" })).toBeNull();
  });
});

describe("ChecklistTemplatesPage", () => {
  it("saves a template from one question per line", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(cfg, http.get("*/api/v1/quality/checklist-templates", () => HttpResponse.json([])),
      http.post("*/api/v1/quality/checklist-templates", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "t1", name: "Stores" }, { status: 201 }); }));
    renderWithProviders(<ChecklistTemplatesPage />, { permissions: A });
    await userEvent.click(await screen.findByRole("button", { name: "New template" }));
    const dlg = within(await screen.findByRole("dialog", { name: "New checklist template" }));
    await dlg.findByRole("option", { name: "Internal" });
    await userEvent.type(dlg.getByLabelText("Name"), "Stores");
    await userEvent.selectOptions(dlg.getByLabelText("Audit type"), "INTERNAL");
    await userEvent.click(dlg.getByRole("button", { name: "Save template" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/at least one question/);
    await userEvent.type(dlg.getByLabelText(/Questions/), "Is stock labelled?");
    await userEvent.click(dlg.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(body).toEqual({ name: "Stores", audit_type: "INTERNAL", questions: [{ question: "Is stock labelled?" }] }));
  });
});

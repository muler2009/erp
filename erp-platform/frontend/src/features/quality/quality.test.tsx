import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { MyActionsPage } from "./MyActionsPage";
import { NcrListPage, validateNcr } from "./NcrListPage";
import { NcrPage, canResubmit, validateSubmission } from "./NcrPage";
import { QualityDashboardPage } from "./QualityDashboardPage";
import { validateQAction, validateQCost } from "./panels";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const err = (code: string, message: string, status = 400) => HttpResponse.json({ error: { code, message } }, { status });
const ncr = (o = {}) => ({ id: "n1", number: "NCR-1", title: "Cracked housing", source: "OTHER", source_ref_type: "", source_ref_id: "", category: "MATERIAL", severity: "MAJOR", status: "OPEN", detected_on: "2026-11-01", department_id: null, product_id: null, supplier_id: null, project_id: null, lot_number: "", investigator_id: null, reported_by: "u9", capa_id: null, reopened_count: 0, closed_at: null, ...o });
const detail = (o = {}) => ({ ...ncr(), description: "Housing cracked", affected_items: "", location: "", containment: "", root_cause: "", proposed_correction: "", verification_note: "", actions: [], evidence: [], costs: [], history: [], holds: [], ...o });
const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }, { id: "e2", employee_no: "E-2", name: "Sara", status: "ACTIVE", user_id: "u2" }] }));
const config = http.get("*/api/v1/quality/config/:kind", ({ params }) => HttpResponse.json(params.kind === "SEVERITY" ? [{ code: "MAJOR", name: "Major" }, { code: "MINOR", name: "Minor" }] : [{ code: "MATERIAL", name: "Material" }]));
const none = [
  http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [] })),
  http.get("*/api/v1/procurement/suppliers", () => HttpResponse.json({ results: [] })),
  http.get("*/api/v1/org/departments", () => HttpResponse.json({ results: [] })),
];

describe("validators", () => {
  it("ncr, submission, resubmit, action and cost", () => {
    const f = { title: "t", source: "OTHER", source_ref_id: "", category: "C", severity: "S", description: "d" };
    expect(validateNcr({ ...f, title: " " })).toMatch(/title/);
    expect(validateNcr({ ...f, source: "INSPECTION" })).toMatch(/Name the record/);
    expect(validateNcr({ ...f, category: "" })).toMatch(/category/);
    expect(validateNcr({ ...f, description: "" })).toMatch(/Describe/);
    expect(validateNcr(f)).toBeNull();
    expect(validateSubmission({ investigator_id: null, root_cause: "x", proposed_correction: "y" })).toMatch(/investigator/);
    expect(validateSubmission({ investigator_id: "u", root_cause: "", proposed_correction: "y" })).toMatch(/root cause/);
    expect(validateSubmission({ investigator_id: "u", root_cause: "x", proposed_correction: "y" })).toBeNull();
    const h = (action: string) => ({ action, from: null, to: null, actor: null, note: "", at: "" });
    expect(canResubmit({ status: "INVESTIGATING", history: [h("SUBMITTED"), h("CHANGES_REQUESTED")] })).toBe(true);
    expect(canResubmit({ status: "INVESTIGATING", history: [h("SUBMITTED")] })).toBe(false);
    expect(canResubmit({ status: "OPEN", history: [h("CHANGES_REQUESTED")] })).toBe(false);
    expect(validateQAction("CONTAINMENT", "d", "", "2026-01-01")).toMatch(/owns/);
    expect(validateQAction("CONTAINMENT", "d", "u", "2026-01-01")).toBeNull();
    expect(validateQCost("SCRAP", "0")).toMatch(/positive/);
    expect(validateQCost("SCRAP", "12.50")).toBeNull();
  });
});

describe("NcrListPage", () => {
  it("lists records and hides the raise button without quality.report", async () => {
    server.use(config, http.get("*/api/v1/quality/ncrs", () => HttpResponse.json({ results: [ncr()], next: null })));
    renderWithProviders(<NcrListPage />, { permissions: ["quality.view"] });
    expect(await screen.findByRole("link", { name: /NCR-1/ })).toHaveAttribute("href", "/app/quality/ncrs/n1");
    expect(screen.queryByRole("button", { name: "Raise a non-conformance" })).toBeNull();
  });

  it("requires a source record before raising, then posts", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(config, employees, ...none, http.get("*/api/v1/quality/ncrs", () => HttpResponse.json({ results: [], next: null })),
      http.post("*/api/v1/quality/ncrs", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(ncr(), { status: 201 }); }));
    renderWithProviders(<NcrListPage />, { permissions: ["quality.view", "quality.report"] });
    await userEvent.click(await screen.findByRole("button", { name: "Raise a non-conformance" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Raise a non-conformance" }));
    await userEvent.type(dlg.getByLabelText("Title"), "Cracked housing");
    await userEvent.type(dlg.getByLabelText("Description"), "Housing cracked");
    await dlg.findByRole("option", { name: "Major" });
    await userEvent.selectOptions(dlg.getByLabelText("Category"), "MATERIAL");
    await userEvent.selectOptions(dlg.getByLabelText("Severity"), "MAJOR");
    await userEvent.selectOptions(dlg.getByLabelText("Found in"), "INSPECTION");
    await userEvent.click(dlg.getByRole("button", { name: "Raise" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/Name the record/);
    expect(body).toBeNull();
    await userEvent.type(dlg.getByLabelText("Source record ID"), "abc");
    await userEvent.click(dlg.getByRole("button", { name: "Raise" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ title: "Cracked housing", source: "INSPECTION", source_ref_id: "abc", severity: "MAJOR" });
  });
});

describe("NcrPage", () => {
  const view = (d: object, permissions: string[]) => {
    server.use(employees, http.get("*/api/v1/quality/ncrs/n1", () => HttpResponse.json(d)));
    return renderWithProviders(<Routes><Route path="/app/quality/ncrs/:id" element={<NcrPage />} /></Routes>, { permissions, route: "/app/quality/ncrs/n1" });
  };

  it("blocks submission until the investigation is complete", async () => {
    view(detail(), ["quality.view", "quality.ncr.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: "Submit for approval" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Assign an investigator/);
  });

  it("submits a complete investigation", async () => {
    let hit = false;
    server.use(http.post("*/api/v1/quality/ncrs/n1/submit", () => { hit = true; return HttpResponse.json(detail({ status: "PENDING_APPROVAL" })); }));
    view(detail({ investigator_id: "u1", root_cause: "Heat", proposed_correction: "Change supplier" }), ["quality.view", "quality.ncr.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: "Submit for approval" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Submit for approval" }));
    await userEvent.click(dlg.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(hit).toBe(true));
  });

  it("offers resubmit only after changes were requested", async () => {
    const h = (action: string) => ({ action, from: null, to: null, actor: null, note: "", at: "2026-11-02" });
    view(detail({ status: "INVESTIGATING", history: [h("SUBMITTED"), h("CHANGES_REQUESTED")] }), ["quality.view", "quality.ncr.manage"]);
    expect(await screen.findByRole("button", { name: "Resubmit for approval" })).toBeInTheDocument();
  });

  it("shows holds and pending approval, with no actions for a viewer", async () => {
    view(detail({ status: "PENDING_APPROVAL", holds: ["QH-7"] }), ["quality.view"]);
    expect(await screen.findByText("Hold QH-7")).toBeInTheDocument();
    expect(screen.getByText(/approvals inbox/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify and close" })).toBeNull();
  });

  it("shows the server's refusal when closing", async () => {
    server.use(http.post("*/api/v1/quality/ncrs/n1/close", () => err("SEPARATION_OF_DUTIES", "The verifier cannot be the investigator.", 409)));
    view(detail({ status: "VERIFYING", investigator_id: "u1" }), ["quality.view", "quality.capa.verify"]);
    await userEvent.click(await screen.findByRole("button", { name: "Verify and close" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Verify and close" }));
    await userEvent.type(dlg.getByLabelText(/Verification/), "Checked");
    await userEvent.click(dlg.getByRole("button", { name: "Close non-conformance" }));
    expect(await dlg.findByText(/verifier cannot be the investigator/)).toBeInTheDocument();
  });

  it("only verifiers can reopen a closed record", async () => {
    view(detail({ status: "CLOSED" }), ["quality.view", "quality.ncr.manage"]);
    await screen.findByText("NCR-1 · Cracked housing");
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });
});

describe("dashboard and my actions", () => {
  it("renders dashboard tiles", async () => {
    server.use(http.get("*/api/v1/quality/dashboard", () => HttpResponse.json({ open_ncrs: 4, open_ncrs_by_severity: { MAJOR: 3 }, overdue_capas: 2, open_capas: 5, inspections_scheduled: 1, inspections_overdue: 0, inspection_pass_rate_90d: 92.5, active_holds: 1, open_complaints: 0, open_findings: 0, audits_planned: 0, equipment_overdue: 0, equipment_on_hold: 0, high_risks: 0, overdue_actions: 0, supplier_status: {}, compliance: null, objectives_missed: 0 })));
    renderWithProviders(<QualityDashboardPage />, { permissions: ["quality.view"] });
    expect(await screen.findByText("92.5%")).toBeInTheDocument();
    expect(screen.getByText("Overdue CAPAs").previousSibling).toHaveTextContent("2");
    expect(screen.getByText("No supplier profiles yet.")).toBeInTheDocument();
  });

  it("completes my action with a note", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.get("*/api/v1/quality/actions/mine", () => HttpResponse.json([{ id: "a1", parent_type: "ncr", parent_id: "n1", action_type: "CONTAINMENT", description: "Quarantine lot", owner_id: "u1", due_date: "2026-11-01", status: "OPEN", completed_at: null, completion_note: "", overdue: true }])),
      http.post("*/api/v1/quality/action/a1/done", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}); }));
    renderWithProviders(<MyActionsPage />, { permissions: ["quality.view"] });
    expect(await screen.findByText("Overdue")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Complete: Quarantine lot" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Complete action" }));
    await userEvent.type(dlg.getByLabelText(/What was done/), "Moved to cage");
    await userEvent.click(dlg.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(body).toEqual({ note: "Moved to cage" }));
  });
});

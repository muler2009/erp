import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { HoldPage, HoldsPage, releaseBlock, rejectBlock, validateHold } from "./HoldsPage";
import { InspectionPage, missingResults, validateCompletion, validateDefect, validateResultEntry } from "./InspectionPage";
import { InspectionPlanPage, InspectionPlansPage, validateParameter, validatePlan } from "./InspectionPlansPage";
import { InspectionsPage, validateSchedule } from "./InspectionsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] }));
const products = http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [{ id: "p1", sku: "BOLT", name: "Bolt", is_active: true }] }));
const param = (o = {}) => ({ id: "m1", name: "Length", kind: "NUMERIC", lower: "9.5", upper: "10.5", target: null, unit: "mm", mandatory: true, critical: false, position: 1, ...o });
const plan = (o = {}) => ({ id: "ip1", number: "IP-1", title: "Incoming bolts", stage: "INCOMING", subject_type: "MATERIAL", product_id: null, project_id: null, frequency: "", sampling: "ALL", sample_value: null, is_itp: false, revision: 1, status: "ACTIVE", inspector_id: null, parameters: [param()], ...o });
const insp = (o = {}) => ({ id: "i1", number: "INS-1", plan_id: "ip1", stage: "INCOMING", status: "IN_PROGRESS", result: "", scheduled_for: "2026-11-10", inspector_id: "u1", ref_type: "", ref_id: "", product_id: "p1", supplier_id: null, project_id: null, lot_number: "L7", quantity_total: "100", quantity_inspected: "100", quantity_accepted: "0", quantity_rejected: "0", summary: "", conditional_note: "", reinspection_of: null, completed_at: null, results: [], defects: [], equipment: [], evidence: [], history: [], ncr_ids: [], holds: [], ...o });
const hold = (o = {}) => ({ id: "h1", number: "QH-1", product_id: "p1", lot_number: "L7", quantity: "100", reason: "Failed length", source_type: "inspection", source_id: "i1", status: "ACTIVE", placed_by: "u9", released_by: null, released_at: null, disposition: "", disposition_note: "", reinspection_id: null, created_at: "2026-11-10T00:00:00Z", history: [], ...o });
const planRoute = (permissions: string[], p = plan()) => { server.use(http.get("*/api/v1/quality/inspection-plans/ip1", () => HttpResponse.json(p))); return renderWithProviders(<Routes><Route path="/app/quality/inspection-plans/:id" element={<InspectionPlanPage />} /></Routes>, { permissions, route: "/app/quality/inspection-plans/ip1" }); };
const inspRoute = (d: object, permissions: string[], p = plan()) => { server.use(employees, http.get("*/api/v1/quality/inspection-plans/ip1", () => HttpResponse.json(p)), http.get("*/api/v1/quality/config/DEFECT_TYPE", () => HttpResponse.json([{ code: "SCRATCH", name: "Scratch" }])), http.get("*/api/v1/quality/inspections/i1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/inspections/:id" element={<InspectionPage />} /></Routes>, { permissions, route: "/app/quality/inspections/i1" }); };
const holdRoute = (d: object, permissions: string[]) => { server.use(employees, http.get("*/api/v1/quality/holds/h1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/holds/:id" element={<HoldPage />} /></Routes>, { permissions, route: "/app/quality/holds/h1" }); };
const I = ["quality.view", "quality.inspect"];

describe("validators", () => {
  it("plan, parameter, schedule, results, defect, completion, hold", () => {
    const f = { title: "t", stage: "INCOMING", subject_type: "MATERIAL", sampling: "ALL", sample_value: "" };
    expect(validatePlan({ ...f, stage: "X" })).toMatch(/stage/);
    expect(validatePlan({ ...f, sampling: "PERCENT" })).toMatch(/sample size/);
    expect(validatePlan({ ...f, sampling: "PERCENT", sample_value: "150" })).toMatch(/between 0 and 100/);
    expect(validatePlan({ ...f, sampling: "FIXED", sample_value: "5" })).toBeNull();
    const p = { name: "n", kind: "NUMERIC", lower: "", upper: "", target: "" };
    expect(validateParameter(p)).toMatch(/lower or an upper/);
    expect(validateParameter({ ...p, lower: "5", upper: "2" })).toMatch(/above the upper/);
    expect(validateParameter({ ...p, lower: "a" })).toMatch(/must be a number/);
    expect(validateParameter({ ...p, kind: "BOOLEAN" })).toBeNull();
    expect(validateSchedule({ plan_id: "", scheduled_for: "d", inspector_id: "u", quantity_total: "" })).toMatch(/plan/);
    expect(validateSchedule({ plan_id: "p", scheduled_for: "d", inspector_id: "u", quantity_total: "-1" })).toMatch(/zero or more/);
    expect(validateResultEntry({ kind: "NUMERIC", name: "L" }, "x", "", false, "")).toMatch(/number/);
    expect(validateResultEntry({ kind: "BOOLEAN", name: "B" }, "", "", false, "")).toMatch(/pass or fail/);
    expect(validateResultEntry({ kind: "NUMERIC", name: "L" }, "10", "", true, "")).toMatch(/reason for correcting/);
    expect(validateResultEntry({ kind: "NUMERIC", name: "L" }, "10", "", true, "typo")).toBeNull();
    expect(validateDefect("", "1")).toMatch(/type/);
    expect(validateDefect("S", "0")).toMatch(/positive/);
    expect(missingResults([{ id: "a", name: "A", mandatory: true }, { id: "b", name: "B", mandatory: false }], [])).toEqual(["A"]);
    expect(missingResults([{ id: "a", name: "A", mandatory: true }], [{ parameter_id: "a", is_current: false }])).toEqual(["A"]);
    expect(validateCompletion(["A"], "", "", false, "")).toMatch(/missing: A/);
    expect(validateCompletion([], "", "", true, "")).toMatch(/conditions/);
    expect(validateCompletion([], "-1", "", false, "")).toMatch(/accepted quantity/);
    expect(validateCompletion([], "5", "", false, "")).toBeNull();
    expect(validateHold({ product_id: "", reason: "r", quantity: "" })).toMatch(/product/);
    expect(validateHold({ product_id: "p", reason: " ", quantity: "" })).toMatch(/reason/);
    expect(releaseBlock({ disposition: "SCRAP" })).toMatch(/accepting/);
    expect(releaseBlock({ disposition: "REWORK" })).toBeNull();
    expect(rejectBlock({ disposition: "ACCEPT" })).toMatch(/reject or scrap/);
    expect(rejectBlock({ disposition: "SCRAP" })).toBeNull();
  });
});

describe("plans", () => {
  it("creates a plan, validating the sample size", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(products, http.get("*/api/v1/quality/inspection-plans", () => HttpResponse.json({ results: [], next: null })),
      http.post("*/api/v1/quality/inspection-plans", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(plan(), { status: 201 }); }));
    renderWithProviders(<InspectionPlansPage />, { permissions: I });
    await userEvent.click(await screen.findByRole("button", { name: "New inspection plan" }));
    const dlg = within(await screen.findByRole("dialog", { name: "New inspection plan" }));
    await userEvent.type(dlg.getByLabelText("Title"), "Incoming bolts");
    await userEvent.selectOptions(dlg.getByLabelText("Sampling"), "PERCENT");
    await userEvent.click(dlg.getByRole("button", { name: "Create plan" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/sample size/);
    await userEvent.type(dlg.getByLabelText("Sample size"), "10");
    await userEvent.click(dlg.getByRole("button", { name: "Create plan" }));
    await waitFor(() => expect(body).toMatchObject({ title: "Incoming bolts", sampling: "PERCENT", sample_value: "10", stage: "INCOMING" }));
  });

  it("hides plan management from a viewer", async () => {
    server.use(http.get("*/api/v1/quality/inspection-plans", () => HttpResponse.json({ results: [plan()], next: null })));
    renderWithProviders(<InspectionPlansPage />, { permissions: ["quality.view"] });
    expect(await screen.findByRole("link", { name: "IP-1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New inspection plan" })).toBeNull();
  });

  it("adds a numeric parameter and retires one", async () => {
    let added: Record<string, unknown> | null = null; let retired = false;
    server.use(http.post("*/api/v1/quality/inspection-plans/ip1/parameters", async ({ request }) => { added = (await request.json()) as Record<string, unknown>; return HttpResponse.json(param(), { status: 201 }); }),
      http.post("*/api/v1/quality/parameters/m1/retire", () => { retired = true; return HttpResponse.json({ ok: true }); }));
    planRoute(I);
    await userEvent.click(await screen.findByRole("button", { name: "Add a parameter" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Add a parameter" }));
    await userEvent.type(dlg.getByLabelText("Name"), "Width");
    await userEvent.click(dlg.getByRole("button", { name: "Add parameter" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/lower or an upper/);
    await userEvent.type(dlg.getByLabelText("Upper limit"), "5");
    await userEvent.click(dlg.getByRole("button", { name: "Add parameter" }));
    await waitFor(() => expect(added).toMatchObject({ name: "Width", upper: "5", mandatory: true }));
    await userEvent.click(screen.getByRole("button", { name: "Retire Length" }));
    await waitFor(() => expect(retired).toBe(true));
  });
});

describe("inspections", () => {
  it("lists inspections with results", async () => {
    server.use(employees, http.get("*/api/v1/quality/inspections", () => HttpResponse.json({ results: [insp({ status: "COMPLETED", result: "FAIL" })], next: null })));
    renderWithProviders(<InspectionsPage />, { permissions: ["quality.view"] });
    expect(await screen.findByRole("link", { name: "INS-1" })).toHaveAttribute("href", "/app/quality/inspections/i1");
    expect(within(screen.getByRole("table")).getByText("Fail")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule an inspection" })).toBeNull();
  });

  it("schedules an inspection", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(employees, http.get("*/api/v1/quality/inspections", () => HttpResponse.json({ results: [], next: null })), http.get("*/api/v1/quality/inspection-plans", () => HttpResponse.json({ results: [plan()], next: null })),
      http.post("*/api/v1/quality/inspections", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(insp(), { status: 201 }); }));
    renderWithProviders(<InspectionsPage />, { permissions: I });
    await userEvent.click(await screen.findByRole("button", { name: "Schedule an inspection" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Schedule an inspection" }));
    await dlg.findByRole("option", { name: /IP-1/ });
    await dlg.findByRole("option", { name: /Abel/ });
    await userEvent.selectOptions(dlg.getByLabelText("Inspection plan"), "ip1");
    await userEvent.selectOptions(dlg.getByLabelText("Inspector"), "u1");
    await userEvent.click(dlg.getByRole("button", { name: "Schedule" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/Enter the date/);
    fireEvent.change(dlg.getByLabelText("Scheduled for"), { target: { value: "2026-11-20" } });
    await userEvent.click(dlg.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(body).toEqual({ plan_id: "ip1", scheduled_for: "2026-11-20", inspector_id: "u1" }));
  });

  it("starts a scheduled inspection", async () => {
    let hit = false;
    server.use(http.post("*/api/v1/quality/inspections/i1/start", () => { hit = true; return HttpResponse.json(insp()); }));
    inspRoute(insp({ status: "SCHEDULED" }), I);
    await userEvent.click(await screen.findByRole("button", { name: "Start inspection" }));
    await waitFor(() => expect(hit).toBe(true));
  });

  it("validates then records a measured result", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/inspections/i1/results", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}, { status: 201 }); }));
    inspRoute(insp(), I);
    await userEvent.click(await screen.findByRole("button", { name: "Record Length" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/measured value as a number/);
    await userEvent.type(screen.getByLabelText("Value for Length"), "10.2");
    await userEvent.click(screen.getByRole("button", { name: "Record Length" }));
    await waitFor(() => expect(body).toMatchObject({ parameter_id: "m1", value: "10.2" }));
  });

  it("requires a reason to correct a recorded result", async () => {
    const r = { id: "r1", parameter_id: "m1", parameter: "Length", value: "12.0000", text: "", passed: false, comment: "", is_current: true, correction_reason: "", recorded_by: "u1", at: "" };
    inspRoute(insp({ results: [r] }), I);
    await screen.findByText("Fail");
    await userEvent.type(screen.getByLabelText("Value for Length"), "10");
    await userEvent.click(screen.getByRole("button", { name: "Correct Length" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reason for correcting/);
  });

  it("blocks completion while a mandatory result is missing", async () => {
    inspRoute(insp(), I);
    await screen.findByRole("button", { name: "Record Length" });
    await userEvent.click(await screen.findByRole("button", { name: "Complete inspection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Mandatory results missing: Length/);
  });

  it("completes when results exist and shows the server's refusal", async () => {
    const r = { id: "r1", parameter_id: "m1", parameter: "Length", value: "10.0000", text: "", passed: true, comment: "", is_current: true, correction_reason: "", recorded_by: "u1", at: "" };
    server.use(http.post("*/api/v1/quality/inspections/i1/complete", () => HttpResponse.json({ error: { code: "invalid_quantities", message: "Accepted and rejected quantities must be within the quantity inspected." } }, { status: 400 })));
    inspRoute(insp({ results: [r] }), I);
    await screen.findByRole("button", { name: "Correct Length" });
    await userEvent.click(await screen.findByRole("button", { name: "Complete inspection" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Complete inspection" }));
    await userEvent.type(dlg.getByLabelText("Accepted quantity"), "500");
    await userEvent.click(dlg.getByRole("button", { name: "Complete" }));
    expect(await dlg.findByText(/within the quantity inspected/)).toBeInTheDocument();
  });

  it("offers re-inspection only for a failed inspection and links holds and NCRs", async () => {
    inspRoute(insp({ status: "COMPLETED", result: "FAIL", holds: ["QH-1"], ncr_ids: ["n1"] }), I);
    expect(await screen.findByRole("button", { name: "Schedule re-inspection" })).toBeInTheDocument();
    expect(screen.getByText("Hold QH-1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Raised non-conformance" })).toHaveAttribute("href", "/app/quality/ncrs/n1");
    expect(screen.queryByRole("button", { name: "Start inspection" })).toBeNull();
  });

  it("gives a viewer no controls", async () => {
    inspRoute(insp(), ["quality.view"]);
    await screen.findByText(/INS-1/);
    expect(screen.queryByRole("button", { name: "Complete inspection" })).toBeNull();
    expect(screen.queryByLabelText("Value for Length")).toBeNull();
  });
});

describe("holds", () => {
  it("places a hold", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(products, http.get("*/api/v1/quality/holds", () => HttpResponse.json({ results: [], next: null })),
      http.post("*/api/v1/quality/holds", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(hold(), { status: 201 }); }));
    renderWithProviders(<HoldsPage />, { permissions: I });
    await userEvent.click(await screen.findByRole("button", { name: "Place a hold" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Place a hold" }));
    await dlg.findByRole("option", { name: /BOLT/ });
    await userEvent.selectOptions(dlg.getByLabelText("Product"), "p1");
    await userEvent.click(dlg.getByRole("button", { name: "Place hold" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/reason/);
    await userEvent.type(dlg.getByLabelText("Reason"), "Suspect lot");
    await userEvent.click(dlg.getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(body).toEqual({ product_id: "p1", reason: "Suspect lot" }));
  });

  it("names the missing disposition before releasing", async () => {
    holdRoute(hold(), ["quality.view", "quality.hold.release"]);
    await userEvent.click(await screen.findByRole("button", { name: "Release the stock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/accepting disposition/);
  });

  it("records a disposition and shows the separation-of-duties refusal on release", async () => {
    server.use(http.post("*/api/v1/quality/holds/h1/release", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "The person who placed the hold cannot release it." } }, { status: 403 })));
    holdRoute(hold({ disposition: "ACCEPT", disposition_note: "Retested OK" }), ["quality.view", "quality.hold.release"]);
    await userEvent.click(await screen.findByRole("button", { name: "Release the stock" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Release the stock" }));
    await userEvent.type(dlg.getByLabelText(/Reason for releasing/), "Retested");
    await userEvent.click(dlg.getByRole("button", { name: "Release" }));
    expect(await dlg.findByText(/cannot release it/)).toBeInTheDocument();
  });

  it("shows no decisions without the release permission", async () => {
    holdRoute(hold(), ["quality.view", "quality.inspect"]);
    expect(await screen.findByText(/Only people with the release permission/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release the stock" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open the inspection" })).toHaveAttribute("href", "/app/quality/inspections/i1");
  });

  it("offers no decisions once released", async () => {
    holdRoute(hold({ status: "RELEASED", released_at: "2026-11-12T00:00:00Z", released_by: "u1" }), ["quality.view", "quality.hold.release"]);
    await screen.findByText("Hold QH-1");
    expect(screen.queryByRole("button", { name: "Release the stock" })).toBeNull();
  });
});

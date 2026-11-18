import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { InspectionRequestsPage, PunchListPage, RequestPage, approveBlock, validatePunch, validateRequest } from "./ProjectQaPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] }));
const projects = http.get("*/api/v1/projects/projects", () => HttpResponse.json({ results: [{ id: "p1", code: "PRJ-1", name: "Tower", status: "ACTIVE" }] }));
const tasks = http.get("*/api/v1/projects/projects/p1/tasks", () => HttpResponse.json({ results: [{ id: "t1", wbs: "1.1", name: "Pour slab" }] }));
const plans = http.get("*/api/v1/quality/inspection-plans", () => HttpResponse.json({ results: [{ id: "pl1", number: "ITP-1", title: "Slab ITP", status: "ACTIVE" }] }));
const req = (o = {}) => ({ id: "r1", number: "IRQ-1", project_id: "p1", kind: "WORK", status: "REQUESTED", hold_point: false, location: "Level 2", contractor: "Acme", requested_for: "2026-12-01", activity_task_id: null, plan_id: null, inspection_id: null, drawing_document_id: null, decision_note: "", ...o });
const punch = (o = {}) => ({ id: "k1", number: "PCH-1", project_id: "p1", location: "Level 2", description: "Cracked tile", severity: "MINOR", status: "OPEN", assigned_to: "u1", contractor: "", due_date: "2026-12-10", request_id: null, fixed_note: "", ...o });
const detail = (o = {}) => ({ ...req(), punch_items: [], history: [], evidence: [], ...o });
const P = ["quality.view", "quality.project.manage"];
const route = (d: object, permissions: string[]) => { server.use(employees, projects, plans, http.get("*/api/v1/quality/inspection-requests/r1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/inspection-requests/:id" element={<RequestPage />} /></Routes>, { permissions, route: "/app/quality/inspection-requests/r1" }); };

describe("validators", () => {
  it("request, punch and approval rules", () => {
    const f = { project_id: "p1", kind: "WORK", requested_for: "2026-12-01", hold_point: false, activity_task_id: "" };
    expect(validateRequest({ ...f, project_id: "" })).toMatch(/project/);
    expect(validateRequest({ ...f, kind: "X" })).toMatch(/kind/);
    expect(validateRequest({ ...f, requested_for: "" })).toMatch(/date/);
    expect(validateRequest({ ...f, hold_point: true })).toMatch(/activity/);
    expect(validateRequest({ ...f, hold_point: true, activity_task_id: "t1" })).toBeNull();
    expect(validateRequest(f)).toBeNull();
    expect(validatePunch({ project_id: "", description: "d", severity: "MINOR" })).toMatch(/project/);
    expect(validatePunch({ project_id: "p", description: " ", severity: "MINOR" })).toMatch(/Describe/);
    expect(validatePunch({ project_id: "p", description: "d", severity: "HUGE" })).toMatch(/severity/);
    expect(validatePunch({ project_id: "p", description: "d", severity: "MAJOR" })).toBeNull();
    expect(approveBlock([{ severity: "MAJOR", status: "FIXED" }])).toMatch(/Major/);
    expect(approveBlock([{ severity: "MAJOR", status: "CLOSED" }, { severity: "MINOR", status: "OPEN" }])).toBeNull();
  });
});

describe("InspectionRequestsPage", () => {
  it("lists requests, flags hold points and filters", async () => {
    const seen: string[] = [];
    server.use(employees, projects, http.get("*/api/v1/quality/inspection-requests", ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ results: [req({ hold_point: true })] }); }));
    renderWithProviders(<InspectionRequestsPage />, { permissions: ["quality.view"] });
    expect(await screen.findByText("IRQ-1")).toBeInTheDocument();
    expect(screen.getByText("Hold point", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request an inspection" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Hold points only"));
    await waitFor(() => expect(seen.some((s) => s.includes("hold_point=1"))).toBe(true));
  });

  it("requires an activity for a hold point, then creates the request", async () => {
    let body: Record<string, unknown> = {};
    server.use(employees, projects, tasks, http.get("*/api/v1/quality/inspection-requests", () => HttpResponse.json({ results: [] })),
      http.post("*/api/v1/quality/inspection-requests", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(req(), { status: 201 }); }));
    renderWithProviders(<InspectionRequestsPage />, { permissions: P });
    await userEvent.click(await screen.findByRole("button", { name: "Request an inspection" }));
    const d = within(await screen.findByRole("dialog", { name: "Request an inspection" }));
    await d.findByRole("option", { name: /Tower/ });
    await userEvent.selectOptions(d.getByLabelText("Project"), "p1");
    fireEvent.change(d.getByLabelText("Wanted for"), { target: { value: "2026-12-01" } });
    await userEvent.click(d.getByLabelText(/This is a hold point/));
    await userEvent.click(d.getByRole("button", { name: "Request" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/activity/);
    await d.findByRole("option", { name: /Pour slab/ });
    await userEvent.selectOptions(d.getByLabelText("Activity"), "t1");
    await userEvent.click(d.getByRole("button", { name: "Request" }));
    await waitFor(() => expect(body).toMatchObject({ project_id: "p1", kind: "WORK", requested_for: "2026-12-01", hold_point: true, activity_task_id: "t1" }));
  });
});

describe("RequestPage", () => {
  it("schedules a new request with an inspector and a plan", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/inspection-requests/r1/schedule", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(req({ status: "SCHEDULED" })); }));
    route(detail(), P);
    await userEvent.click(await screen.findByRole("button", { name: "Schedule the inspection" }));
    const d = within(await screen.findByRole("dialog", { name: "Schedule the inspection" }));
    await d.findByRole("option", { name: /Abel/ });
    await d.findByRole("option", { name: /ITP-1/ });
    await userEvent.click(d.getByRole("button", { name: "Schedule" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/required/);
    await userEvent.selectOptions(d.getByLabelText("Inspector"), "u1");
    await userEvent.selectOptions(d.getByLabelText("Inspection plan (ITP)"), "pl1");
    await userEvent.click(d.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(body).toEqual({ inspector_id: "u1", plan_id: "pl1" }));
  });

  it("does not ask for a plan when the request already names one", async () => {
    route(detail({ plan_id: "pl1" }), P);
    await userEvent.click(await screen.findByRole("button", { name: "Schedule the inspection" }));
    const d = within(await screen.findByRole("dialog", { name: "Schedule the inspection" }));
    expect(d.queryByLabelText("Inspection plan (ITP)")).not.toBeInTheDocument();
  });

  it("blocks approval while a major punch item is open, and approves once none is", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/inspection-requests/r1/decide", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(req({ status: "APPROVED" })); }));
    const { unmount } = route(detail({ status: "INSPECTED", punch_items: [punch({ severity: "MAJOR", status: "FIXED" })] }), P);
    await userEvent.click(await screen.findByRole("button", { name: "Approve the work" }));
    expect(await screen.findByText("Major punch items are still open.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unmount();
    route(detail({ status: "INSPECTED", punch_items: [punch({ severity: "MAJOR", status: "CLOSED" })] }), P);
    await userEvent.click(await screen.findByRole("button", { name: "Approve the work" }));
    const d = within(await screen.findByRole("dialog", { name: "Approve the work" }));
    await userEvent.click(d.getByRole("button", { name: "Approve" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/Decision note is required/);
    await userEvent.type(d.getByLabelText("Decision note"), "Meets the drawing");
    await userEvent.click(d.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(body).toEqual({ approve: true, note: "Meets the drawing" }));
  });

  it("shows the server's refusal when approving a failed inspection or as the inspector", async () => {
    server.use(http.post("*/api/v1/quality/inspection-requests/r1/decide", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "A hold point is released by someone other than the inspector." } }, { status: 403 })));
    route(detail({ status: "INSPECTED", hold_point: true }), P);
    await userEvent.click(await screen.findByRole("button", { name: "Approve the work" }));
    const d = within(await screen.findByRole("dialog", { name: "Approve the work" }));
    await userEvent.type(d.getByLabelText("Decision note"), "ok");
    await userEvent.click(d.getByRole("button", { name: "Approve" }));
    expect(await d.findByText(/someone other than the inspector/)).toBeInTheDocument();
  });

  it("rejects with a note and cancels with a reason", async () => {
    const calls: Record<string, unknown>[] = [];
    server.use(http.post("*/api/v1/quality/inspection-requests/r1/decide", async ({ request }) => { calls.push((await request.json()) as Record<string, unknown>); return HttpResponse.json(req()); }));
    route(detail({ status: "INSPECTED" }), P);
    await userEvent.click(await screen.findByRole("button", { name: "Reject the work" }));
    const d = within(await screen.findByRole("dialog", { name: "Reject the work" }));
    await userEvent.type(d.getByLabelText("Decision note"), "Rebar spacing wrong");
    await userEvent.click(d.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(calls).toEqual([{ approve: false, note: "Rebar spacing wrong" }]));
  });

  it("offers cancel only while the request is requested or scheduled", async () => {
    route(detail({ status: "APPROVED" }), P);
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel the request" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule the inspection" })).not.toBeInTheDocument();
  });

  it("view-only users see no actions", async () => {
    route(detail({ status: "INSPECTED", punch_items: [punch()] }), ["quality.view"]);
    expect(await screen.findByText("Cracked tile")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve the work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark fixed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Raise a punch item" })).not.toBeInTheDocument();
  });

  it("raises a punch item against the request's project", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/punch-items", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(punch(), { status: 201 }); }));
    route(detail(), P);
    await userEvent.click(await screen.findByRole("button", { name: "Raise a punch item" }));
    const d = within(await screen.findByRole("dialog", { name: "Raise a punch item" }));
    await userEvent.click(d.getByRole("button", { name: "Raise" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/Describe/);
    await userEvent.type(d.getByLabelText("Defect"), "Cracked tile");
    await userEvent.selectOptions(d.getByLabelText("Severity"), "MAJOR");
    await userEvent.click(d.getByRole("button", { name: "Raise" }));
    await waitFor(() => expect(body).toEqual({ project_id: "p1", description: "Cracked tile", severity: "MAJOR", request_id: "r1" }));
  });
});

describe("PunchListPage", () => {
  it("marks an item fixed with a note", async () => {
    let body: Record<string, unknown> = {};
    server.use(employees, projects, http.get("*/api/v1/quality/punch-items", () => HttpResponse.json({ results: [punch()] })),
      http.post("*/api/v1/quality/punch-items/k1/fixed", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(punch({ status: "FIXED" })); }));
    renderWithProviders(<PunchListPage />, { permissions: P });
    await userEvent.click(await screen.findByRole("button", { name: "Mark fixed" }));
    const d = within(await screen.findByRole("dialog", { name: "Mark the item fixed" }));
    await userEvent.click(d.getByRole("button", { name: "Mark fixed" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/What was done is required/);
    await userEvent.type(d.getByLabelText("What was done"), "Replaced tile");
    await userEvent.click(d.getByRole("button", { name: "Mark fixed" }));
    await waitFor(() => expect(body).toEqual({ note: "Replaced tile" }));
  });

  it("verifies a fix, and needs a note to reopen it", async () => {
    const calls: Record<string, unknown>[] = [];
    server.use(employees, projects, http.get("*/api/v1/quality/punch-items", () => HttpResponse.json({ results: [punch({ status: "FIXED", fixed_note: "Replaced" })] })),
      http.post("*/api/v1/quality/punch-items/k1/verify", async ({ request }) => { calls.push((await request.json()) as Record<string, unknown>); return HttpResponse.json(punch({ status: "CLOSED" })); }));
    renderWithProviders(<PunchListPage />, { permissions: P });
    await userEvent.click(await screen.findByRole("button", { name: "Verify" }));
    const d = within(await screen.findByRole("dialog", { name: "Verify the fix" }));
    await userEvent.selectOptions(d.getByLabelText("Is the fix acceptable?"), "no");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/still wrong/);
    expect(calls).toEqual([]);
    await userEvent.selectOptions(d.getByLabelText("Is the fix acceptable?"), "yes");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(calls).toEqual([{ accept: true, note: "" }]));
  });

  it("shows the server's separation-of-duties refusal", async () => {
    server.use(employees, projects, http.get("*/api/v1/quality/punch-items", () => HttpResponse.json({ results: [punch({ status: "FIXED" })] })),
      http.post("*/api/v1/quality/punch-items/k1/verify", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "The person who fixed an item cannot verify it." } }, { status: 403 })));
    renderWithProviders(<PunchListPage />, { permissions: P });
    await userEvent.click(await screen.findByRole("button", { name: "Verify" }));
    const d = within(await screen.findByRole("dialog", { name: "Verify the fix" }));
    await userEvent.selectOptions(d.getByLabelText("Is the fix acceptable?"), "yes");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    expect(await d.findByText(/cannot verify it/)).toBeInTheDocument();
  });
});

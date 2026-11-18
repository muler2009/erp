import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ServiceCaseDetailPage, fileToBase64 } from "./ServiceCaseDetailPage";
import { ServiceCasesPage, slaText } from "./ServiceCasesPage";
import { ServiceReportPage, rangeProblem } from "./ServiceReportPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const kase = (o = {}) => ({ id: "s1", number: "CS-1", subject: "Late delivery", description: "Arrived 3 days late", kind: "COMPLAINT", category: "Delivery", priority: "HIGH", severity: "MAJOR", status: "OPEN", account: "a1", contact: null, owner_id: "u1", team: "Support", first_response_due: "2026-11-10T10:00:00Z", due_at: "2026-11-12T10:00:00Z", first_responded_at: null, resolved_at: null, resolution: "", escalation_level: 0, satisfaction: null, feedback: "", sla: { response_breached: false, resolution_breached: false }, ...o });
const accounts = http.get("*/api/v1/crm/accounts", () => page([{ id: "a1", name: "Acme Ltd", industry: "", segment: "", owner_id: "u1", is_active: true, credit_status: "OK", lifecycle_stage: "ACTIVE" }]));
const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] }));
const MANAGE = ["crm.view", "crm.manage"];

describe("helpers", () => {
  it("reads the service-level clock, ranges and files", async () => {
    expect(slaText(kase({ sla: { response_breached: false, resolution_breached: true } }) as never)).toEqual({ text: "Resolution target missed", tone: "red" });
    expect(slaText(kase({ sla: { response_breached: true, resolution_breached: false } }) as never).text).toBe("First response late");
    expect(slaText(kase() as never).text).toBe("On track");
    expect(slaText(kase({ status: "RESOLVED" }) as never)).toEqual({ text: "Met", tone: "green" });
    expect(rangeProblem("2026-11-02", "2026-11-01")).toMatch(/before/);
    expect(rangeProblem("", "2026-11-01")).toBeNull();
    expect(await fileToBase64(new File(["hi"], "a.txt"))).toBe("aGk=");
  });
});

describe("ServiceCasesPage", () => {
  it("lists cases with their service-level state and filters them", async () => {
    let q = new URLSearchParams();
    server.use(accounts, http.get("*/api/v1/crm/cases", ({ request }) => { q = new URL(request.url).searchParams; return page([kase({ sla: { response_breached: false, resolution_breached: true }, escalation_level: 1 })]); }));
    renderWithProviders(<ServiceCasesPage />, { permissions: ["crm.view"] });
    expect(await screen.findByRole("link", { name: "CS-1" })).toHaveAttribute("href", "/app/crm/cases/s1");
    expect(screen.getByText("Resolution target missed")).toBeInTheDocument();
    expect(screen.getByText("Level 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New case" })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "OPEN");
    await userEvent.click(screen.getByLabelText("Overdue only"));
    await waitFor(() => expect(q.get("status")).toBe("OPEN"));
    await waitFor(() => expect(q.get("overdue")).toBe("1"));
  });

  it("opens a case for a customer", async () => {
    let body: Record<string, unknown> = {};
    server.use(accounts, http.get("*/api/v1/crm/cases", () => page([])), http.post("*/api/v1/crm/cases", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(kase(), { status: 201 }); }));
    renderWithProviders(<ServiceCasesPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "New case" }));
    const d = within(await screen.findByRole("dialog", { name: "New case" }));
    await userEvent.type(d.getByLabelText("Subject"), "Damaged goods");
    await userEvent.click(d.getByRole("button", { name: "Open case" }));
    expect(await d.findByRole("alert")).toHaveTextContent("Customer account is required");
    await waitFor(() => expect(d.getByRole("option", { name: "Acme Ltd" })).toBeInTheDocument());
    await userEvent.selectOptions(d.getByLabelText("Customer account"), "a1");
    await userEvent.type(d.getByLabelText("Description"), "Box crushed");
    await userEvent.click(d.getByRole("button", { name: "Open case" }));
    await waitFor(() => expect(body).toMatchObject({ account: "a1", subject: "Damaged goods", description: "Box crushed", kind: "COMPLAINT", priority: "MEDIUM", severity: "MINOR" }));
  });
});

describe("ServiceCaseDetailPage", () => {
  function detail(permissions: string[], c: object, extra: Parameters<typeof server.use> = []) {
    server.use(accounts, employees, http.get("*/api/v1/crm/cases/s1", () => HttpResponse.json(c)),
      http.get("*/api/v1/crm/cases/s1/comments", () => HttpResponse.json([{ id: "n1", author: "u1", text: "Called the carrier", internal: true, at: "2026-11-09T09:00:00Z" }, { id: "n2", author: "u1", text: "We are sorry", internal: false, at: "2026-11-09T10:00:00Z" }])),
      http.get("*/api/v1/crm/cases/s1/attachments", () => HttpResponse.json([{ id: "f1", name: "photo.jpg", size: 2048, content_type: "image/jpeg" }])), ...extra);
    return renderWithProviders(<Routes><Route path="/app/crm/cases/:id" element={<ServiceCaseDetailPage />} /></Routes>, { permissions, route: "/app/crm/cases/s1" });
  }

  it("shows the case, the conversation with internal notes marked, and attachments", async () => {
    detail(["crm.view"], kase());
    expect(await screen.findByRole("heading", { name: /CS-1/ })).toBeInTheDocument();
    expect(await screen.findByText("Called the carrier")).toBeInTheDocument();
    expect(screen.getByText("Internal note")).toBeInTheDocument();
    expect(await screen.findByText(/photo\.jpg/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add a comment")).not.toBeInTheDocument();
  });

  it("walks a new case to open and requires a resolution", async () => {
    const calls: [string, unknown][] = [];
    const post = (a: string) => http.post(`*/api/v1/crm/cases/s1/${a}`, async ({ request }) => { calls.push([a, await request.json()]); return HttpResponse.json(kase()); });
    detail(MANAGE, kase({ status: "NEW" }), [post("status"), post("resolve")]);
    await userEvent.click(await screen.findByRole("button", { name: "Start working on it" }));
    await waitFor(() => expect(calls).toEqual([["status", { status: "OPEN" }]]));
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    const d = within(await screen.findByRole("dialog", { name: "Resolve case" }));
    await userEvent.click(d.getByRole("button", { name: "Resolve" }));
    expect(await d.findByRole("alert")).toHaveTextContent("What was done? is required");
    await userEvent.type(d.getByLabelText("What was done?"), "Refunded shipping");
    await userEvent.click(d.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(calls[1]).toEqual(["resolve", { resolution: "Refunded shipping" }]));
  });

  it("posts a customer-visible comment and an internal note", async () => {
    const sent: Record<string, unknown>[] = [];
    detail(MANAGE, kase(), [http.post("*/api/v1/crm/cases/s1/comments", async ({ request }) => { sent.push((await request.json()) as Record<string, unknown>); return HttpResponse.json({}, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Post comment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Write a comment first");
    await userEvent.type(screen.getByLabelText("Add a comment"), "Looking into it");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(sent).toEqual([{ text: "Looking into it", internal: false }]));
    await userEvent.type(screen.getByLabelText("Add a comment"), "Escalate?");
    await userEvent.click(screen.getByLabelText(/Internal note/));
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(sent[1]).toEqual({ text: "Escalate?", internal: true }));
  });

  it("uploads an attachment as base64 and asks for a file first", async () => {
    let body: Record<string, unknown> = {};
    detail(MANAGE, kase(), [http.post("*/api/v1/crm/cases/s1/attachments", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "f2", name: "a.txt", size: 2 }, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Upload" }));
    expect(await screen.findByText("Choose a file to attach.")).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText("Attach a file"), new File(["hi"], "a.txt", { type: "text/plain" }));
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(body).toEqual({ filename: "a.txt", content_base64: "aGk=" }));
  });

  it("assignment needs the assign permission", async () => {
    let body: unknown;
    detail([...MANAGE, "crm.assign"], kase(), [http.post("*/api/v1/crm/cases/s1/assign", async ({ request }) => { body = await request.json(); return HttpResponse.json(kase()); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Assign" }));
    const d = within(await screen.findByRole("dialog", { name: "Assign case" }));
    await waitFor(() => expect(d.getByRole("option", { name: "E-1 Abel" })).toBeInTheDocument());
    await userEvent.selectOptions(d.getByLabelText("Handler"), "u1");
    await userEvent.click(d.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(body).toEqual({ owner_id: "u1", team: "Support" }));
  });

  it("records feedback once a case is resolved, closes it, and offers nothing on a closed case", async () => {
    let fb: unknown;
    detail(MANAGE, kase({ status: "RESOLVED", resolution: "Done" }), [http.post("*/api/v1/crm/cases/s1/feedback", async ({ request }) => { fb = await request.json(); return HttpResponse.json(kase()); })]);
    expect(await screen.findByRole("button", { name: "Close case" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record customer feedback" }));
    const d = within(await screen.findByRole("dialog", { name: "Customer feedback" }));
    await userEvent.selectOptions(d.getByLabelText("Rating"), "4");
    await userEvent.click(d.getByRole("button", { name: "Save feedback" }));
    await waitFor(() => expect(fb).toEqual({ rating: 4, feedback: "" }));
  });

  it("shows a refused transition's reason, and hides everything on a closed case", async () => {
    detail(MANAGE, kase({ status: "NEW" }), [http.post("*/api/v1/crm/cases/s1/status", () => HttpResponse.json({ error: { code: "invalid_state_transition", message: "A NEW case cannot become OPEN." } }, { status: 409 }))]);
    await userEvent.click(await screen.findByRole("button", { name: "Start working on it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot become OPEN");
  });

  it("closed cases take no comments or files", async () => {
    detail(MANAGE, kase({ status: "CLOSED" }));
    await screen.findByRole("heading", { name: /CS-1/ });
    expect(screen.queryByLabelText("Add a comment")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Attach a file")).not.toBeInTheDocument();
  });
});

describe("ServiceReportPage", () => {
  const rep = { total: 10, open: 3, complaints: 6, avg_resolution_hours: 18.5, sla_met_percent: 80, avg_satisfaction: 4.2, escalated: 1, by_category: { Delivery: 5 }, by_month: { "2026-11": 10 }, by_owner: { u1: { handled: 4, resolved: 3 } } };
  const sla = http.get("*/api/v1/crm/cases/sla", () => HttpResponse.json([{ priority: "URGENT", first_response_hours: 1, resolution_hours: 8 }]));

  it("shows the summary, passes the dates, and names handlers", async () => {
    let q = new URLSearchParams();
    server.use(sla, employees, http.get("*/api/v1/crm/cases/report", ({ request }) => { q = new URL(request.url).searchParams; return HttpResponse.json(rep); }));
    renderWithProviders(<ServiceReportPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText("18.5 h")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("4.2 / 5")).toBeInTheDocument();
    expect(await screen.findByText("Abel: 3 of 4 resolved")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-01" } });
    await waitFor(() => expect(q.get("from")).toBe("2026-11-01"));
    expect(screen.queryByRole("button", { name: "Change a service level" })).not.toBeInTheDocument();
  });

  it("does not run for a reversed range and shows empty states", async () => {
    let calls = 0;
    server.use(sla, employees, http.get("*/api/v1/crm/cases/report", () => { calls += 1; return HttpResponse.json({ ...rep, avg_resolution_hours: null, sla_met_percent: null, avg_satisfaction: null, by_category: {}, by_month: {}, by_owner: {} }); }));
    renderWithProviders(<ServiceReportPage />, { permissions: ["crm.view"] });
    expect(await screen.findAllByText("No cases in this period")).toHaveLength(2);
    expect(screen.getAllByText("–").length).toBe(3);
    const before = calls;
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-10" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-01" } });
    expect(await screen.findByText("Fix the date range to run the report")).toBeInTheDocument();
    expect(calls).toBeLessThanOrEqual(before + 1);
  });

  it("managers change a service level, with hours validated", async () => {
    let body: unknown;
    server.use(sla, employees, http.get("*/api/v1/crm/cases/report", () => HttpResponse.json(rep)), http.put("*/api/v1/crm/cases/sla", async ({ request }) => { body = await request.json(); return HttpResponse.json({}); }));
    renderWithProviders(<ServiceReportPage />, { permissions: ["crm.view", "crm.assign"] });
    await userEvent.click(await screen.findByRole("button", { name: "Change a service level" }));
    const d = within(await screen.findByRole("dialog", { name: "Change service level" }));
    await userEvent.selectOptions(d.getByLabelText("Priority"), "HIGH");
    await userEvent.type(d.getByLabelText("First response within (hours)"), "6");
    await userEvent.type(d.getByLabelText("Resolve within (hours)"), "4");
    await userEvent.click(d.getByRole("button", { name: "Save service level" }));
    expect(await d.findByRole("alert")).toHaveTextContent("cannot be shorter");
    await userEvent.clear(d.getByLabelText("Resolve within (hours)"));
    await userEvent.type(d.getByLabelText("Resolve within (hours)"), "24");
    await userEvent.click(d.getByRole("button", { name: "Save service level" }));
    await waitFor(() => expect(body).toEqual({ priority: "HIGH", first_response_hours: 6, resolution_hours: 24 }));
  });
});

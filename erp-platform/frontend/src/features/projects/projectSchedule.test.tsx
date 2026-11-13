import type { ReactElement } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ProjectBillingPage, validateInvoice, validatePeriod } from "./ProjectBillingPage";
import { ProjectSchedulePage, barGeometry, validateLink, validateShift } from "./ProjectSchedulePage";
import { ResourceLoadPage, validateHours } from "./ResourceLoadPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const at = (el: ReactElement, path: string, permissions: string[]) => renderWithProviders(<Routes><Route path={`/app/projects/projects/:id/${path}`} element={el} /></Routes>, { permissions, route: `/app/projects/projects/p1/${path}` });
const gantt = { project: "P-1", start: "2026-01-01", end: "2026-01-31", critical_path: ["1", "2"], tasks: [
  { id: "t1", wbs: "1", name: "Dig", parent: null, milestone: false, status: "IN_PROGRESS", start: "2026-01-01", end: "2026-01-10", percent: "50", assignee: null, summary: false, hours: "40", predecessors: [], slack_days: 0, critical: true },
  { id: "t2", wbs: "2", name: "Pour", parent: null, milestone: false, status: "TODO", start: "2026-01-11", end: "2026-01-20", percent: "0", assignee: null, summary: false, hours: "40", predecessors: [{ id: "d1", task: "t1", kind: "FS", lag_days: 0 }], slack_days: 0, critical: true },
  { id: "t3", wbs: "3", name: "Side", parent: null, milestone: false, status: "TODO", start: "2026-01-01", end: "2026-01-05", percent: "0", assignee: null, summary: false, hours: "8", predecessors: [], slack_days: 20, critical: false }] };

describe("validators", () => {
  it("geometry, link, shift, period, invoice, hours", () => {
    expect(barGeometry("2026-01-01", "2026-01-10", "2026-01-01", "2026-01-20")).toEqual({ left: 0, width: 50 });
    expect(barGeometry("2026-01-11", "2026-01-20", "2026-01-01", "2026-01-20")).toEqual({ left: 50, width: 50 });
    const out = barGeometry("2025-12-01", "2026-03-01", "2026-01-01", "2026-01-20");
    expect(out.left).toBe(0); expect(out.left + out.width).toBeLessThanOrEqual(100);
    expect(validateLink({ predecessor: "", successor: "b", kind: "FS", lag: "0" })).toMatch(/both/);
    expect(validateLink({ predecessor: "a", successor: "a", kind: "FS", lag: "0" })).toMatch(/itself/);
    expect(validateLink({ predecessor: "a", successor: "b", kind: "XX", lag: "0" })).toMatch(/finish-to-start/);
    expect(validateLink({ predecessor: "a", successor: "b", kind: "FS", lag: "1.5" })).toMatch(/whole number/);
    expect(validateLink({ predecessor: "a", successor: "b", kind: "SS", lag: "-2" })).toBeNull();
    expect(validateShift("0")).toMatch(/other than zero/); expect(validateShift("abc")).toMatch(/other than zero/); expect(validateShift("-3")).toBeNull();
    expect(validatePeriod("2026-02-01", "2026-01-01")).toMatch(/before/); expect(validatePeriod("", "2026-01-01")).toMatch(/both/); expect(validatePeriod("2026-01-01", "2026-01-31")).toBeNull();
    const ok = { kind: "TIME", invoice_date: "2026-02-01", amount: "", task: "", period_start: "2026-01-01", period_end: "2026-01-31" };
    expect(validateInvoice({ ...ok, kind: "MILESTONE" })).toMatch(/milestone/);
    expect(validateInvoice({ ...ok, kind: "ADVANCE", amount: "0" })).toMatch(/greater than zero/);
    expect(validateInvoice({ ...ok, period_end: "2025-01-01" })).toMatch(/before/);
    expect(validateInvoice(ok)).toBeNull();
    expect(validateHours("0")).toMatch(/between/); expect(validateHours("40")).toBeNull(); expect(validateHours("169")).toMatch(/between/);
  });
});

describe("ProjectSchedulePage", () => {
  it("shows the critical path, flags critical tasks and renders bars", async () => {
    server.use(http.get("*/api/v1/projects/projects/p1/gantt", () => HttpResponse.json(gantt)));
    at(<ProjectSchedulePage />, "schedule", ["projects.view"]);
    expect(await screen.findByText(/Critical path: 1 → 2/)).toBeInTheDocument();
    expect(screen.getAllByText("Critical")).toHaveLength(2);
    expect(screen.getByText("slack 20d")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "1 Dig from 2026-01-01 to 2026-01-10, 50% done" })).toBeInTheDocument();
  });
  it("removes a dependency by its link id and shows server refusals", async () => {
    let hit = "";
    server.use(http.get("*/api/v1/projects/projects/p1/gantt", () => HttpResponse.json(gantt)), http.delete("*/api/v1/projects/dependencies/d1", () => { hit = "d1"; return new HttpResponse(null, { status: 204 }); }));
    at(<ProjectSchedulePage />, "schedule", ["projects.view"]);
    await userEvent.click(await screen.findByRole("button", { name: "Remove link 1 to 2" }));
    await waitFor(() => expect(hit).toBe("d1"));
  });
  it("adds a link, blocking a self link locally and showing a circular-dependency refusal", async () => {
    server.use(http.get("*/api/v1/projects/projects/p1/gantt", () => HttpResponse.json(gantt)),
      http.post("*/api/v1/projects/dependencies", () => HttpResponse.json({ error: { code: "circular_dependency", message: "This link would create a circular dependency." } }, { status: 409 })));
    at(<ProjectSchedulePage />, "schedule", ["projects.view"]);
    await userEvent.click(await screen.findByRole("button", { name: "Link tasks" }));
    const d = within(screen.getByRole("dialog", { name: "Link tasks" }));
    await userEvent.selectOptions(d.getByLabelText("Predecessor"), "t1"); await userEvent.selectOptions(d.getByLabelText("Successor"), "t1"); await userEvent.selectOptions(d.getByLabelText("Type"), "FS");
    await userEvent.click(d.getByRole("button", { name: "Add link" }));
    expect(await screen.findByText("A task cannot depend on itself.")).toBeInTheDocument();
    await userEvent.selectOptions(d.getByLabelText("Predecessor"), "t2"); await userEvent.selectOptions(d.getByLabelText("Successor"), "t1");
    await userEvent.click(d.getByRole("button", { name: "Add link" }));
    expect(await screen.findByText(/circular dependency/)).toBeInTheDocument();
  });
  it("moves a task with cascade by default", async () => {
    let sent: unknown;
    server.use(http.get("*/api/v1/projects/projects/p1/gantt", () => HttpResponse.json(gantt)), http.post("*/api/v1/projects/tasks/t1/shift", async ({ request }) => { sent = await request.json(); return HttpResponse.json({ moved: [] }); }));
    at(<ProjectSchedulePage />, "schedule", ["projects.view"]);
    await userEvent.click(await screen.findByRole("button", { name: "Move 1" }));
    const d = within(screen.getByRole("dialog", { name: "Move 1" }));
    await userEvent.type(d.getByLabelText("Days"), "0");
    await userEvent.click(d.getByRole("button", { name: "Move" }));
    expect(await screen.findByText(/other than zero/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Days")); await userEvent.type(d.getByLabelText("Days"), "3");
    await userEvent.click(d.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(sent).toEqual({ days: 3, cascade: true }));
  });
});

describe("ProjectBillingPage", () => {
  const billing = { project: "P-1", rows: [{ invoice_id: "i1", kind: "ADVANCE", amount: "100.00", description: "", invoice_status: "POSTED" }], billed: "100.00", recognized: "100.00", paid: "0.00", contract_value: "0.00", remaining: null };
  const base = () => server.use(http.get("*/api/v1/projects/projects/p1/billing", () => HttpResponse.json(billing)), http.get("*/api/v1/projects/projects/p1/tasks", () => HttpResponse.json({ results: [] })));
  it("validates the period then loads time and preview for billing managers", async () => {
    base();
    const seen: string[] = [];
    server.use(http.get("*/api/v1/projects/projects/p1/time", ({ request }) => { seen.push("time:" + new URL(request.url).search); return HttpResponse.json({ rows: [{ user_id: "aaaaaaaa-1", hours: "8.00", cost: "80.00", rate: "10.00" }], hours: "8.00", cost: "80.00", unmatched_hours: "0" }); }),
      http.get("*/api/v1/projects/projects/p1/billing/time-preview", () => HttpResponse.json({ rows: [{ user_id: "aaaaaaaa-1", hours: "8.00", rate: "20.00", amount: "160.00" }], amount: "160.00" })));
    at(<ProjectBillingPage />, "billing", ["projects.view", "projects.billing.manage"]);
    await screen.findByText(/Billed/);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-02-01" } }); fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText(/end date is before/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-02-28" } });
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText("Would bill")).toBeInTheDocument();
    expect(seen).toEqual(["time:?from=2026-02-01&to=2026-02-28"]);
  });
  it("hides the preview and invoice button without the billing permission", async () => {
    base();
    server.use(http.get("*/api/v1/projects/projects/p1/time", () => HttpResponse.json({ rows: [], hours: "0", cost: "0", unmatched_hours: "0" })));
    at(<ProjectBillingPage />, "billing", ["projects.view"]);
    await screen.findByText(/Billed/);
    expect(screen.queryByRole("button", { name: "Create invoice" })).toBeNull();
  });
  it("creates an advance invoice with the amount as a string and shows the result", async () => {
    base();
    let sent: unknown;
    server.use(http.post("*/api/v1/projects/projects/p1/billing", async ({ request }) => { sent = await request.json(); return HttpResponse.json({ invoice_id: "i2", kind: "ADVANCE", amount: "250.00" }, { status: 201 }); }));
    at(<ProjectBillingPage />, "billing", ["projects.view", "projects.billing.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: "Create invoice" }));
    const d = within(screen.getByRole("dialog", { name: "Create project invoice" }));
    await userEvent.selectOptions(d.getByLabelText("Invoice for"), "ADVANCE");
    fireEvent.change(d.getByLabelText("Invoice date"), { target: { value: "2026-02-01" } });
    await userEvent.type(d.getByLabelText("Amount (advance)"), "0");
    await userEvent.click(d.getByRole("button", { name: "Create invoice" }));
    expect(await screen.findByText(/greater than zero/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Amount (advance)")); await userEvent.type(d.getByLabelText("Amount (advance)"), "250.00");
    await userEvent.click(d.getByRole("button", { name: "Create invoice" }));
    await waitFor(() => expect(sent).toEqual({ kind: "ADVANCE", invoice_date: "2026-02-01", description: "", amount: "250.00" }));
    expect(await screen.findByText(/Invoice created for/)).toBeInTheDocument();
  });
});

describe("ResourceLoadPage", () => {
  it("requests the chosen period and flags overloaded people", async () => {
    let q = "";
    server.use(http.get("*/api/v1/projects/resource-load", ({ request }) => { q = new URL(request.url).search; return HttpResponse.json([{ user_id: "aaaaaaaa-1", projects: ["P-1", "P-2"], allocation_percent: "120.00", over_allocated: true, planned_hours: "200.00", capacity_hours: "160.00", load_percent: "125.00", overloaded: true }]); }));
    renderWithProviders(<ResourceLoadPage />, { permissions: ["projects.view"] });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-03-01" } }); fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-03-31" } });
    await userEvent.clear(screen.getByLabelText("Weekly hours")); await userEvent.type(screen.getByLabelText("Weekly hours"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText(/between 1 and 168/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Weekly hours")); await userEvent.type(screen.getByLabelText("Weekly hours"), "40");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText("Overloaded")).toBeInTheDocument();
    expect(screen.getByText("Over-allocated")).toBeInTheDocument();
    expect(q).toBe("?from=2026-03-01&to=2026-03-31&weekly_hours=40");
  });
});

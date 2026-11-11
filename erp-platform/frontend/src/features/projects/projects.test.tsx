import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { MyTasksPage } from "./MyTasksPage";
import { ProjectPage, validPercent, validateTask } from "./ProjectPage";
import { ProjectsPage, validateProject } from "./ProjectsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const prj = (o: object = {}) => ({ id: "p1", code: "PRJ-1", name: "Warehouse build", description: "", status: "ACTIVE", billing_type: "FIXED", contract_value: "5000.00", customer_id: null, manager_id: "u1", department_id: null, cost_center_id: null, priority: "MEDIUM", start_on: "2026-11-01", end_on: "2027-03-01", actual_start: null, actual_end: null, version: 1, ...o });
const task = (o: object = {}) => ({ id: "t1", wbs: "1", name: "Foundations", parent: null, milestone: false, status: "IN_PROGRESS", assignee: "u1", planned_start: "2026-11-01", planned_end: "2026-11-30", planned_hours: "80", percent_complete: "20", actual_start: null, actual_end: null, ...o });
const view = (perms = ["projects.view"]) => renderWithProviders(<Routes><Route path="/app/projects/projects/:id" element={<ProjectPage />} /></Routes>, { permissions: perms, route: "/app/projects/projects/p1" });
const load = (p: object, tasks: object[]) => server.use(http.get("*/api/v1/projects/projects/p1", () => HttpResponse.json(p)), http.get("*/api/v1/projects/projects/p1/tasks", () => HttpResponse.json({ results: tasks })));

describe("validators", () => {
  it("project", () => {
    expect(validateProject({ name: " ", start: "", end: "", billing: "FIXED", value: "" })).toMatch(/Name/);
    expect(validateProject({ name: "A", start: "", end: "", billing: "FIXED", value: "" })).toMatch(/dates/);
    expect(validateProject({ name: "A", start: "2026-02-01", end: "2026-01-01", billing: "FIXED", value: "" })).toMatch(/cannot end/);
    expect(validateProject({ name: "A", start: "2026-01-01", end: "2026-02-01", billing: "NON_BILLABLE", value: "5" })).toMatch(/non-billable/);
    expect(validateProject({ name: "A", start: "2026-01-01", end: "2026-02-01", billing: "FIXED", value: "-1" })).toMatch(/0 or more/);
    expect(validateProject({ name: "A", start: "2026-01-01", end: "2026-02-01", billing: "FIXED", value: "100.5" })).toBeNull();
  });
  it("task and percent", () => {
    expect(validateTask({ name: "", start: "", end: "", hours: "" })).toMatch(/Name/);
    expect(validateTask({ name: "T", start: "2026-02-02", end: "2026-02-01", hours: "" })).toMatch(/cannot end/);
    expect(validateTask({ name: "T", start: "2026-02-01", end: "2026-02-02", hours: "x" })).toMatch(/hours/);
    expect(validateTask({ name: "T", start: "2026-02-01", end: "2026-02-02", hours: "8" })).toBeNull();
    expect(validPercent("0")).toBe(true);
    expect(validPercent("100")).toBe(true);
    expect(validPercent("100.5")).toBe(false);
    expect(validPercent("-1")).toBe(false);
    expect(validPercent("")).toBe(false);
  });
});

describe("ProjectsPage", () => {
  it("lists projects and creates one", async () => {
    let body: any = null;
    server.use(http.get("*/api/v1/projects/projects", () => HttpResponse.json({ results: [prj()] })), http.post("*/api/v1/projects/projects", async ({ request }) => { body = await request.json(); return HttpResponse.json(prj({ id: "p2" }), { status: 201 }); }));
    renderWithProviders(<ProjectsPage />, { permissions: ["projects.view", "projects.create"] });
    const user = userEvent.setup();
    expect(await screen.findByRole("link", { name: "PRJ-1" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const dlg = await screen.findByRole("dialog", { name: "New project" });
    await user.click(within(dlg).getByRole("button", { name: "Create project" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/Name the project/);
    await user.type(within(dlg).getByLabelText("Name"), "Depot");
    fireEvent.change(within(dlg).getByLabelText("Planned start"), { target: { value: "2026-12-01" } });
    fireEvent.change(within(dlg).getByLabelText("Planned end"), { target: { value: "2027-01-01" } });
    await user.click(within(dlg).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ name: "Depot", start_on: "2026-12-01", end_on: "2027-01-01", description: "", billing_type: "FIXED", contract_value: "0" });
  });
  it("hides New project without projects.create", async () => {
    server.use(http.get("*/api/v1/projects/projects", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<ProjectsPage />, { permissions: ["projects.view"] });
    await screen.findByText("No projects");
    expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
  });
});

describe("ProjectPage", () => {
  it("shows tasks and records progress; completed projects offer no updates", async () => {
    let body: any = null;
    load(prj(), [task()]);
    server.use(http.post("*/api/v1/projects/tasks/t1/progress", async ({ request }) => { body = await request.json(); return HttpResponse.json(task({ percent_complete: "60" })); }));
    view();
    const user = userEvent.setup();
    await screen.findByText("Foundations");
    await user.click(screen.getByRole("button", { name: "Update progress" }));
    const dlg = await screen.findByRole("dialog", { name: /Progress/ });
    const pct = within(dlg).getByLabelText("Percent complete");
    await user.clear(pct); await user.type(pct, "150");
    await user.click(within(dlg).getByRole("button", { name: "Save progress" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/between 0 and 100/);
    await user.clear(pct); await user.type(pct, "60");
    await user.click(within(dlg).getByRole("button", { name: "Save progress" }));
    await waitFor(() => expect(body).toEqual({ percent: "60", note: "" }));
  });
  it("offers only valid next statuses and shows the server's refusal", async () => {
    load(prj(), []);
    server.use(http.post("*/api/v1/projects/projects/p1/status", () => HttpResponse.json({ error: { code: "tasks_open", message: "2 task(s) are still open." } }, { status: 409 })));
    view();
    const user = userEvent.setup();
    await screen.findByText("No tasks yet");
    expect(screen.queryByRole("button", { name: "Mark Planning" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mark Completed" }));
    const dlg = await screen.findByRole("dialog", { name: /Move project to Completed/ });
    await user.click(within(dlg).getByRole("button", { name: "Confirm" }));
    expect(await within(dlg).findByText(/2 task\(s\)/)).toBeInTheDocument();
  });
  it("adds a milestone task", async () => {
    let body: any = null;
    load(prj(), []);
    server.use(http.post("*/api/v1/projects/projects/p1/tasks", async ({ request }) => { body = await request.json(); return HttpResponse.json(task(), { status: 201 }); }));
    view();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add task" }));
    const dlg = await screen.findByRole("dialog", { name: "New task" });
    await user.type(within(dlg).getByLabelText("Name"), "Handover");
    fireEvent.change(within(dlg).getByLabelText("Planned start"), { target: { value: "2027-02-01" } });
    fireEvent.change(within(dlg).getByLabelText("Planned end"), { target: { value: "2027-02-01" } });
    await user.click(within(dlg).getByLabelText(/milestone/));
    await user.click(within(dlg).getByRole("button", { name: "Add task" }));
    await waitFor(() => expect(body).toEqual({ name: "Handover", planned_start: "2027-02-01", planned_end: "2027-02-01", milestone: true, planned_hours: "0" }));
  });
  it("no progress button when the project is not active", async () => {
    load(prj({ status: "ON_HOLD" }), [task()]);
    view();
    await screen.findByText("Foundations");
    expect(screen.queryByRole("button", { name: "Update progress" })).toBeNull();
  });
});

describe("MyTasksPage", () => {
  it("lists my tasks", async () => {
    server.use(http.get("*/api/v1/projects/my-tasks", () => HttpResponse.json({ results: [{ ...task(), project: "PRJ-1" }] })));
    renderWithProviders(<MyTasksPage />, { permissions: ["projects.view"] });
    expect(await screen.findByText("Foundations")).toBeInTheDocument();
    expect(screen.getByText("PRJ-1")).toBeInTheDocument();
  });
});

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ProjectPage } from "./ProjectPage";
import { taskChanges } from "./TaskEdit";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const PRJ = { id: "p1", code: "PRJ-1", name: "Build", description: "", status: "ACTIVE", billing_type: "FIXED", contract_value: "0", customer_id: null, manager_id: "u1", department_id: null, cost_center_id: null, priority: "MEDIUM", start_on: "2026-01-01", end_on: "2026-12-31", actual_start: null, actual_end: null, version: 1 };
const T = (o: object = {}) => ({ id: "t1", wbs: "1", name: "Foundations", parent: null, milestone: false, status: "TODO", assignee: null, planned_start: "2026-11-01", planned_end: "2026-11-30", planned_hours: "40.0000", percent_complete: "0.00", actual_start: null, actual_end: null, ...o });
const base = [
  http.get("*/api/v1/projects/projects/p1/health", () => HttpResponse.json({ error: { code: "x", message: "n/a" } }, { status: 404 })),
  http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [], next: null, previous: null })),
];
const view = () => renderWithProviders(<Routes><Route path="/app/projects/projects/:id" element={<ProjectPage />} /></Routes>, { permissions: ["projects.view"], route: "/app/projects/projects/p1" });
const load = (tasks: object[], project: object = PRJ) => server.use(...base, http.get("*/api/v1/projects/projects/p1", () => HttpResponse.json(project)), http.get("*/api/v1/projects/projects/p1/tasks", () => HttpResponse.json({ results: tasks })));

it("sends only changed fields", () => {
  const t = T() as never;
  const same = { name: "Foundations", start: "2026-11-01", end: "2026-11-30", hours: "40" };
  expect(taskChanges(t, same, null, false)).toEqual({});
  expect(taskChanges(t, { ...same, name: " New ", hours: "50" }, "u9", false)).toEqual({ name: "New", planned_hours: "50", assignee: "u9" });
  expect(taskChanges(t, { ...same, start: "2026-11-02", end: "2026-12-01" }, null, true)).toEqual({});
});

describe("task edit and delete", () => {
  it("edits a task, validating first and showing server refusals", async () => {
    let body: Record<string, unknown> | null = null; let refuse = true;
    load([T()]);
    server.use(http.patch("*/api/v1/projects/tasks/t1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return refuse ? HttpResponse.json({ error: { code: "dependency_violated", message: "This would break a dependency: 2 must start after 1." } }, { status: 409 }) : HttpResponse.json(T()); }));
    view();
    await userEvent.click(await screen.findByRole("button", { name: "Edit task 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Nothing has changed.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "2026-10-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/cannot end before it starts/)).toBeInTheDocument();
    expect(body).toBeNull();
    fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "2026-12-05" } });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/break a dependency/)).toBeInTheDocument();
    expect(body).toEqual({ planned_end: "2026-12-05" });
    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull());
  });
  it("locks dates and hours for a task that groups sub-tasks", async () => {
    load([T(), T({ id: "t2", wbs: "1.1", parent: "t1" })]);
    view();
    await userEvent.click((await screen.findAllByRole("button", { name: "Edit task 1" }))[0]!);
    expect(screen.getByText(/come from them/)).toBeInTheDocument();
    expect(screen.getByLabelText("Planned start")).toBeDisabled();
    expect(screen.getByLabelText("Planned hours")).toBeDisabled();
  });
  it("hides hours for a milestone and hides Edit/Delete where they cannot apply", async () => {
    load([T({ milestone: true }), T({ id: "t3", wbs: "2", status: "DONE", percent_complete: "100" }), T({ id: "t4", wbs: "3", status: "IN_PROGRESS", percent_complete: "20" })]);
    view();
    await userEvent.click(await screen.findByRole("button", { name: "Edit task 1" }));
    expect(screen.queryByLabelText("Planned hours")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Edit task 2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete task 2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit task 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete task 3" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete task 1" })).toBeInTheDocument();
  });
  it("deletes after confirmation, and shows a server refusal", async () => {
    let deleted = false; let refuse = true;
    load([T()]);
    server.use(http.delete("*/api/v1/projects/tasks/t1", () => { if (refuse) return HttpResponse.json({ error: { code: "task_in_use", message: "Records (time, expenses) refer to this task; cancel it instead." } }, { status: 409 }); deleted = true; return new HttpResponse(null, { status: 204 }); }));
    view();
    await userEvent.click(await screen.findByRole("button", { name: "Delete task 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete task" }));
    expect(await screen.findByText("Records (time, expenses) refer to this task; cancel it instead.")).toBeInTheDocument();
    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Delete task" }));
    await waitFor(() => expect(deleted).toBe(true));
  });
  it("offers nothing on a completed project", async () => {
    load([T()], { ...PRJ, status: "COMPLETED" });
    view();
    await screen.findByText("Foundations");
    expect(screen.queryByRole("button", { name: /Edit task|Delete task/ })).toBeNull();
  });
});

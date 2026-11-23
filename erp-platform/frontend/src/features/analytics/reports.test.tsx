import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import * as dl from "../../shared/lib/fileDownload";
import { renderWithProviders } from "../../test/utils";
import { ReportsPage, reportProblem, scheduleProblem } from "./ReportsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[], next: string | null = null) => HttpResponse.json({ results: rows, next, previous: null });
const catalog = http.get("*/api/v1/analytics/catalog", () => HttpResponse.json({
  datasets: [
    { code: "sales.backlog", title: "Sales backlog", module: "sales", params: { date_from: "date", date_to: "date", region: ["N", "S"] } },
    { code: "inventory.stock", title: "Stock levels", module: "inventory", params: { as_of: "date" } },
  ], metrics: [],
}));
const employees = http.get("*/api/v1/hr/employees", () => page([{ id: "e1", employee_no: "E1", name: "Abel", user_id: "u1", status: "ACTIVE" }, { id: "e2", employee_no: "E2", name: "Sara", user_id: "u2", status: "ACTIVE" }]));
const runRows = [{ customer: "Acme", amount: "100" }, { customer: "Beta", amount: "50" }];
const VIEW = ["analytics.view"];
const ALL = ["analytics.view", "analytics.export", "analytics.report.manage"];
const rep = (o = {}) => ({ id: "r1", name: "Weekly backlog", description: "d", dataset: "sales.backlog", params: {}, columns: [], filters: [], sort: [], owner_id: "u1", shared: false, is_active: true, ...o });

describe("helpers", () => {
  it("validate", () => {
    const ds = { code: "x", title: "X", module: "m", params: {} };
    expect(reportProblem(undefined, {}, [])).toMatch(/Choose a dataset/);
    expect(reportProblem(ds, { date_from: "2026-02-01", date_to: "2026-01-01" }, [])).toMatch(/after/);
    expect(reportProblem(ds, { period: "MTD", date_from: "2026-02-01", date_to: "2026-01-01" }, [])).toBeNull();
    expect(reportProblem(ds, {}, [{ column: "", op: "eq", value: "x" }])).toMatch(/Choose a column/);
    expect(reportProblem(ds, {}, [{ column: "a", op: "eq", value: " " }])).toMatch(/Give a value/);
    expect(reportProblem(ds, {}, [{ column: "a", op: "eq", value: "1" }])).toBeNull();
    expect(scheduleProblem("", "", "", ["u"])).toMatch(/how often/);
    expect(scheduleProblem("WEEKLY", "", "", ["u"])).toMatch(/weekday/);
    expect(scheduleProblem("MONTHLY", "", "29", ["u"])).toMatch(/1 to 28/);
    expect(scheduleProblem("DAILY", "", "", [])).toMatch(/recipient/);
    expect(scheduleProblem("MONTHLY", "", "15", ["u"])).toBeNull();
  });
});

describe("Build a report", () => {
  it("runs with a period, filters, sort and columns; shows rows; can be saved", async () => {
    const urls: URL[] = []; let saved: unknown = null;
    server.use(catalog, http.get("*/api/v1/analytics/datasets/sales.backlog", ({ request }) => { urls.push(new URL(request.url)); return HttpResponse.json({ dataset: "sales.backlog", title: "Sales backlog", params: {}, row_count: 2, rows: runRows, truncated: false }); }),
      http.post("*/api/v1/analytics/reports", async ({ request }) => { saved = await request.json(); return HttpResponse.json(rep(), { status: 201 }); }));
    renderWithProviders(<ReportsPage />, { permissions: VIEW });
    await screen.findByRole("option", { name: "Sales backlog" });
    await userEvent.selectOptions(screen.getByLabelText("Data set"), "sales.backlog");
    await userEvent.click(screen.getByRole("button", { name: "Run report" }));
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Period"), "LAST_30_DAYS");
    await userEvent.click(screen.getByRole("button", { name: "Add filter" }));
    await userEvent.click(screen.getByRole("button", { name: "Run report" }));
    expect(await screen.findByText("Choose a column for each filter.")).toBeInTheDocument();
    // column list comes from the first run
    await userEvent.selectOptions(screen.getByLabelText("Column"), "amount");
    await userEvent.selectOptions(screen.getByLabelText("Condition"), "ge");
    await userEvent.type(screen.getByLabelText("Value"), "60");
    await userEvent.selectOptions(screen.getByLabelText("Sort by"), "amount");
    await userEvent.click(screen.getByLabelText("Highest first"));
    await userEvent.click(screen.getByLabelText("customer"));
    await userEvent.click(screen.getByRole("button", { name: "Run report" }));
    await waitFor(() => expect(urls).toHaveLength(2));
    const q = (urls[1] as URL).searchParams;
    expect(q.get("period")).toBe("LAST_30_DAYS");
    expect(JSON.parse(q.get("filters")!)).toEqual([{ column: "amount", op: "ge", value: "60" }]);
    expect(JSON.parse(q.get("sort")!)).toEqual([{ column: "amount", desc: true }]);
    expect(q.get("columns")).toBe("customer");
    await userEvent.click(await screen.findByRole("button", { name: "Save as report" }));
    await userEvent.click(screen.getByRole("button", { name: "Save report" }));
    expect(await screen.findByText("Report name is required.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Report name"), "Big orders");
    await userEvent.selectOptions(screen.getByLabelText("Who can see it"), "yes");
    await userEvent.click(screen.getByRole("button", { name: "Save report" }));
    await waitFor(() => expect(saved).toMatchObject({ name: "Big orders", dataset: "sales.backlog", params: { period: "LAST_30_DAYS" }, columns: ["customer"], shared: true, sort: [{ column: "amount", desc: true }] }));
  });

  it("blocks a backwards date range before asking the server", async () => {
    let hits = 0;
    server.use(catalog, http.get("*/api/v1/analytics/datasets/sales.backlog", () => { hits++; return HttpResponse.json({}); }));
    renderWithProviders(<ReportsPage />, { permissions: VIEW });
    await screen.findByRole("option", { name: "Sales backlog" });
    await userEvent.selectOptions(screen.getByLabelText("Data set"), "sales.backlog");
    fireEvent.change(screen.getByLabelText("date from"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("date to"), { target: { value: "2026-02-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Run report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/after/);
    expect(hits).toBe(0);
  });

  it("warns when the result was cut off, and downloads in the chosen format for people who may export", async () => {
    const spy = vi.spyOn(dl, "downloadFromApi").mockResolvedValue();
    const call = () => spy.mock.calls[0] as [string, string];
    server.use(catalog, http.get("*/api/v1/analytics/datasets/inventory.stock", () => HttpResponse.json({ title: "Stock levels", params: {}, row_count: 5000, rows: runRows, truncated: true })));
    renderWithProviders(<ReportsPage />, { permissions: ALL });
    await screen.findByRole("option", { name: "Stock levels" });
    await userEvent.selectOptions(screen.getByLabelText("Data set"), "inventory.stock");
    await userEvent.click(screen.getByRole("button", { name: "Run report" }));
    expect(await screen.findByText(/first 2 of 5000 rows/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download Excel" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(call()[0]).toContain("/api/v1/analytics/datasets/inventory.stock/export?");
    expect(call()[0]).toContain("fmt=XLSX");
    expect(call()[1]).toBe("inventory.stock.xlsx");
  });

  it("shows the server's refusal", async () => {
    server.use(catalog, http.get("*/api/v1/analytics/datasets/sales.backlog", () => HttpResponse.json({ error: { code: "permission_denied", message: "You do not have access to this data." } }, { status: 403 })));
    renderWithProviders(<ReportsPage />, { permissions: VIEW });
    await screen.findByRole("option", { name: "Sales backlog" });
    await userEvent.selectOptions(screen.getByLabelText("Data set"), "sales.backlog");
    await userEvent.click(screen.getByRole("button", { name: "Run report" }));
    expect(await screen.findByText(/do not have access to this data/)).toBeInTheDocument();
  });
});

describe("Saved reports and schedules", () => {
  const quiet = [catalog, http.get("*/api/v1/analytics/schedules", () => HttpResponse.json([]))];
  it("runs a saved report, archives it, and shows a refusal", async () => {
    server.use(...quiet, http.get("*/api/v1/analytics/reports", () => HttpResponse.json([rep()])),
      http.get("*/api/v1/analytics/reports/r1/run", () => HttpResponse.json({ report: "Weekly backlog", params: {}, row_count: 2, rows: runRows, truncated: false })),
      http.delete("*/api/v1/analytics/reports/r1", () => HttpResponse.json({ error: { code: "not_found", message: "Report not found." } }, { status: 404 })));
    renderWithProviders(<ReportsPage />, { permissions: ALL });
    await userEvent.click(screen.getByRole("tab", { name: "Saved reports" }));
    await userEvent.click(await screen.findByRole("button", { name: "Run Weekly backlog" }));
    expect(await screen.findByText("Beta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Archive Weekly backlog" }));
    expect(await screen.findByText("Report not found.")).toBeInTheDocument();
  });

  it("schedules a saved report: checks, then posts weekly details", async () => {
    let body: unknown = null;
    server.use(...quiet, employees, http.get("*/api/v1/analytics/reports", () => HttpResponse.json([rep()])),
      http.post("*/api/v1/analytics/schedules", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<ReportsPage />, { permissions: ALL });
    await userEvent.click(screen.getByRole("tab", { name: "Saved reports" }));
    await userEvent.click(await screen.findByRole("button", { name: "Schedule Weekly backlog" }));
    await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Choose at least one recipient.")).toBeInTheDocument();
    await userEvent.click(await screen.findByLabelText("E1 Abel"));
    await userEvent.selectOptions(screen.getByLabelText("Weekday"), "4");
    await userEvent.selectOptions(screen.getByLabelText("File type"), "PDF");
    await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(body).toEqual({ report_id: "r1", frequency: "WEEKLY", fmt: "PDF", recipients: ["u1"], weekday: 4 }));
  });

  it("lists schedules; send now and stop; export permission needed for the tab", async () => {
    const hits: string[] = [];
    const sch = { id: "s1", report_id: "r1", report: "Weekly backlog", frequency: "WEEKLY", weekday: 4, day_of_month: null, fmt: "PDF", recipients: ["u1"], next_run_on: "2026-11-27", last_run_on: "2026-11-20", last_status: "FAILED", last_error: "No data", owner_id: "u1", is_active: true };
    server.use(catalog, http.get("*/api/v1/analytics/schedules", () => HttpResponse.json([sch])),
      http.post("*/api/v1/analytics/schedules/s1/run", () => { hits.push("run"); return HttpResponse.json({ id: "x" }, { status: 201 }); }),
      http.patch("*/api/v1/analytics/schedules/s1", async ({ request }) => { hits.push(JSON.stringify(await request.json())); return HttpResponse.json({ ...sch, is_active: false }); }));
    const { unmount } = renderWithProviders(<ReportsPage />, { permissions: ALL });
    await userEvent.click(screen.getByRole("tab", { name: "Schedules" }));
    expect(await screen.findByText(/Every Friday as PDF, to 1 person/)).toBeInTheDocument();
    expect(screen.getByText("Last run failed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send Weekly backlog now" }));
    expect(await screen.findByText("Weekly backlog was sent.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop Weekly backlog" }));
    await waitFor(() => expect(hits).toEqual(["run", '{"is_active":false}']));
    unmount();
    renderWithProviders(<ReportsPage />, { permissions: VIEW });
    expect(screen.queryByRole("tab", { name: "Schedules" })).toBeNull();
  });
});

describe("History", () => {
  it("lists runs and pages to older ones", async () => {
    const seen: (string | null)[] = [];
    const run = (id: string, o = {}) => ({ id, report_id: null, schedule_id: null, dataset: "sales.backlog", fmt: "CSV", row_count: 3, status: "OK", error: "", file_id: null, requested_by: "u1", delivered_to: [], created_at: "2026-11-20T10:00:00Z", ...o });
    server.use(catalog, http.get("*/api/v1/analytics/runs", ({ request }) => { const c = new URL(request.url).searchParams.get("cursor"); seen.push(c); return c ? page([run("b", { dataset: "old.set" })]) : page([run("a", { status: "FAILED", error: "Timed out" })], "http://x/api/v1/analytics/runs?cursor=NEXT"); }));
    renderWithProviders(<ReportsPage />, { permissions: VIEW });
    await userEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(await screen.findByText("Timed out")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(await screen.findByText("old.set")).toBeInTheDocument();
    expect(seen).toEqual([null, "NEXT"]);
  });
});

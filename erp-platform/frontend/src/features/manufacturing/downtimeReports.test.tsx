import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AnalyticsPage, cell } from "./AnalyticsPage";
import { DowntimePage, downtimeProblem, maintenanceProblem } from "./DowntimePage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const wcs = http.get("*/api/v1/manufacturing/work-centers", () => HttpResponse.json({ results: [{ id: "wc1", code: "CNC", name: "Cutter", is_active: true }], next: null }));
const dt = (rows: object[], next: string | null = null) => http.get("*/api/v1/manufacturing/downtime", () => HttpResponse.json({ results: rows, next }));
const row = (o = {}) => ({ id: "d1", work_center: "CNC", category: "BREAKDOWN", reason: "Belt snapped", started_at: "2026-11-20T08:00:00+03:00", ended_at: null, minutes: null, breakdown_id: null, ...o });
const FULL = ["manufacturing.view", "manufacturing.downtime.manage"];

describe("helpers", () => {
  it("validation and formatting", () => {
    expect(downtimeProblem("", "OTHER", "x")).toMatch(/work centre/);
    expect(downtimeProblem("w", "", "x")).toMatch(/kind/);
    expect(downtimeProblem("w", "OTHER", " ")).toMatch(/why/);
    expect(downtimeProblem("w", "OTHER", "x")).toBeNull();
    expect(maintenanceProblem("w", " ")).toMatch(/wrong/);
    expect(maintenanceProblem("w", "noise")).toBeNull();
    expect(cell(null)).toBe("—");
    expect(cell({ a_b: 1, c: null })).toBe("A b: 1, C: —");
  });
});

describe("DowntimePage", () => {
  it("empty state and no buttons without permission", async () => {
    server.use(dt([]), wcs);
    renderWithProviders(<DowntimePage />, { permissions: ["manufacturing.view"] });
    expect(await screen.findByText("No downtime recorded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record stoppage" })).toBeNull();
  });

  it("records a stoppage", async () => {
    let body: unknown = null;
    server.use(dt([]), wcs, http.post("*/api/v1/manufacturing/downtime", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "d9" }, { status: 201 }); }));
    renderWithProviders(<DowntimePage />, { permissions: FULL });
    await userEvent.click(await screen.findByRole("button", { name: "Record stoppage" }));
    await userEvent.click(await screen.findByRole("button", { name: "Record" }));
    expect(await screen.findByText("Choose the work centre.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "CNC — Cutter" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Work centre"), "wc1");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "SETUP");
    await userEvent.type(screen.getByLabelText("Reason"), "Changeover");
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(body).toEqual({ work_center: "wc1", category: "SETUP", reason: "Changeover" }));
  });

  it("ends an open stoppage; closed ones show minutes", async () => {
    let hit = false;
    server.use(dt([row(), row({ id: "d2", work_center: "LATHE", ended_at: "2026-11-20T09:00:00+03:00", minutes: 60 })]), wcs,
      http.post("*/api/v1/manufacturing/downtime/d1/end", () => { hit = true; return HttpResponse.json({ id: "d1", minutes: 30 }); }));
    renderWithProviders(<DowntimePage />, { permissions: FULL });
    expect(await screen.findByText("60 min")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /End stoppage/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "End stoppage CNC" }));
    await waitFor(() => expect(hit).toBe(true));
  });

  it("maintenance request shows affected orders; server refusal is shown", async () => {
    let n = 0;
    server.use(dt([]), wcs, http.post("*/api/v1/manufacturing/maintenance-requests", () => {
      n += 1;
      return n === 1 ? HttpResponse.json({ error: { code: "no_asset", message: "This work centre has no machine linked." } }, { status: 400 })
        : HttpResponse.json({ downtime: "d", breakdown: "b", affected_orders: ["MO-1", "MO-2"] }, { status: 201 });
    }));
    renderWithProviders(<DowntimePage />, { permissions: FULL });
    await userEvent.click(await screen.findByRole("button", { name: "Request maintenance" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "CNC — Cutter" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Work centre"), "wc1");
    await userEvent.type(screen.getByLabelText("What is wrong"), "Grinding noise");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("This work centre has no machine linked.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText(/Orders affected: MO-1, MO-2/)).toBeInTheDocument();
  });
});

describe("AnalyticsPage", () => {
  it("rejects a backwards range, then shows a table report", async () => {
    const urls: string[] = [];
    server.use(http.get("*/api/v1/manufacturing/analytics/:name", ({ request, params }) => { urls.push(`${params.name}?${new URL(request.url).search}`); return HttpResponse.json([{ product: "BIKE", planned: "5", actual_qty: "4" }]); }));
    renderWithProviders(<AnalyticsPage />, { permissions: ["manufacturing.view"] });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-12-10" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-12-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/before/);
    expect(urls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-12-31" } });
    await userEvent.selectOptions(screen.getByLabelText("Report"), "output");
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByText("BIKE")).toBeInTheDocument();
    expect(screen.getByText("Actual qty")).toBeInTheDocument();
    expect(urls[0]).toBe("output??from=2026-12-10&to=2026-12-31");
  });

  it("shows a summary report as rows, and an empty report", async () => {
    let empty = false;
    server.use(http.get("*/api/v1/manufacturing/analytics/:name", () => HttpResponse.json(empty ? [] : { completed: 4, on_time: 3, on_time_pct: "75.0000" })));
    renderWithProviders(<AnalyticsPage />, { permissions: ["manufacturing.view"] });
    await userEvent.selectOptions(screen.getByLabelText("Report"), "on-time");
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByText("On time pct")).toBeInTheDocument();
    expect(screen.getByText("75.0000")).toBeInTheDocument();
    empty = true;
    await userEvent.selectOptions(screen.getByLabelText("Report"), "scrap");
    expect(await screen.findByText("Nothing to report")).toBeInTheDocument();
  });

  it("shows the server's error", async () => {
    server.use(http.get("*/api/v1/manufacturing/analytics/:name", () => HttpResponse.json({ error: { code: "x", message: "Report failed." } }, { status: 500 })));
    renderWithProviders(<AnalyticsPage />, { permissions: ["manufacturing.view"] });
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByText(/Report failed/)).toBeInTheDocument();
  });
});

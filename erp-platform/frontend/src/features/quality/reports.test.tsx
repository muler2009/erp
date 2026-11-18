import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as csv from "../../shared/lib/csvDownload";
import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ReportsPage, cell, columnsOf, heading, validateRange } from "./ReportsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const list = http.get("*/api/v1/quality/reports", () => HttpResponse.json([{ code: "ncr-register", title: "Non-conformance register" }, { code: "holds", title: "Quality holds" }]));
const A = ["quality.view", "quality.analytics.view"];

describe("helpers", () => {
  it("range, headings, cells and columns", () => {
    expect(validateRange("2026-02-01", "2026-01-01")).toMatch(/before the start/);
    expect(validateRange("2026-01-01", "2026-02-01")).toBeNull();
    expect(validateRange("", "2026-01-01")).toBeNull();
    expect(heading("age_days")).toBe("Age days");
    expect(cell(null)).toBe("–"); expect(cell("")).toBe("–"); expect(cell(true)).toBe("Yes"); expect(cell(false)).toBe("No"); expect(cell(0)).toBe("0");
    expect(cell({ a: 1 })).toBe('{"a":1}');
    expect(columnsOf([{ a: 1 }, { a: 2, b: 3 }])).toEqual(["a", "b"]);
  });
});

describe("ReportsPage", () => {
  it("asks for a report first, then runs it with the date range and shows the rows", async () => {
    const seen: string[] = [];
    server.use(list, http.get("*/api/v1/quality/reports/ncr-register", ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ code: "ncr-register", title: "Non-conformance register", count: 2, rows: [{ number: "NCR-1", age_days: 4, capa: true }, { number: "NCR-2", age_days: 9, capa: false }] }); }));
    renderWithProviders(<ReportsPage />, { permissions: A });
    expect(await screen.findByText("Choose a report to run")).toBeInTheDocument();
    await screen.findByRole("option", { name: "Non-conformance register" });
    await userEvent.selectOptions(screen.getByLabelText("Report"), "ncr-register");
    expect(await screen.findByText("NCR-1")).toBeInTheDocument();
    expect(screen.getByText("Age days")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText(/2 rows/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-01-01" } });
    await waitFor(() => expect(seen.some((s) => s.includes("date_from=2026-01-01"))).toBe(true));
  });

  it("will not run a report with an end date before the start date", async () => {
    let calls = 0;
    server.use(list, http.get("*/api/v1/quality/reports/holds", () => { calls += 1; return HttpResponse.json({ code: "holds", title: "Quality holds", count: 0, rows: [] }); }));
    renderWithProviders(<ReportsPage />, { permissions: A });
    await screen.findByRole("option", { name: "Quality holds" });
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-02-01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-01-01" } });
    await userEvent.selectOptions(screen.getByLabelText("Report"), "holds");
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be before/);
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    expect(calls).toBe(0);
  });

  it("says when a report has no rows and flags a long one", async () => {
    server.use(list, http.get("*/api/v1/quality/reports/holds", () => HttpResponse.json({ code: "holds", title: "Quality holds", count: 0, rows: [] })),
      http.get("*/api/v1/quality/reports/ncr-register", () => HttpResponse.json({ code: "ncr-register", title: "Non-conformance register", count: 600, rows: Array.from({ length: 600 }, (_, i) => ({ n: i })) })));
    renderWithProviders(<ReportsPage />, { permissions: A });
    await screen.findByRole("option", { name: "Quality holds" });
    await userEvent.selectOptions(screen.getByLabelText("Report"), "holds");
    expect(await screen.findByText("No rows for this report")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Report"), "ncr-register");
    expect(await screen.findByText(/Showing the first 500/)).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(501);
  });

  it("exports the CSV with the chosen range, and shows a refused export", async () => {
    const spy = vi.spyOn(csv, "downloadCsv").mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("You cannot export this."));
    server.use(list, http.get("*/api/v1/quality/reports/holds", () => HttpResponse.json({ code: "holds", title: "Quality holds", count: 0, rows: [] })));
    renderWithProviders(<ReportsPage />, { permissions: A });
    await screen.findByRole("option", { name: "Quality holds" });
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Report"), "holds");
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-03-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("/api/v1/quality/reports/holds/csv", { date_to: "2026-03-01" }, "quality-holds.csv"));
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You cannot export this.");
  });

  it("shows the server's refusal when the report cannot be run", async () => {
    server.use(list, http.get("*/api/v1/quality/reports/holds", () => HttpResponse.json({ error: { code: "forbidden", message: "No access to reports." } }, { status: 403 })));
    renderWithProviders(<ReportsPage />, { permissions: ["quality.view"] });
    await screen.findByRole("option", { name: "Quality holds" });
    await userEvent.selectOptions(screen.getByLabelText("Report"), "holds");
    expect(await screen.findByText(/No access to reports/)).toBeInTheDocument();
  });
});

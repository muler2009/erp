import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { HealthCard, PortfolioPage, ragLabel, reasonText } from "./HealthPortfolio";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const emp = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", user_id: "u1", name: "Pat Manager" }], next: null, previous: null }));
const H = { project: "P-1", rag: "RED", reasons: ["COST_OVERRUN", "SOMETHING_NEW"], cpi: "0.70", spi: null, percent_complete: "42.5", overdue_tasks: 1, open_risks: 3, high_risks: 1, open_issues: 2, critical_issues: 1, high_issues: 1 };

it("words ratings and reasons, with a fallback for new codes", () => {
  expect(ragLabel("AMBER")).toBe("At risk");
  expect(ragLabel(null)).toBe("Not rated");
  expect(reasonText("MILESTONE_OVERDUE")).toBe("A milestone is overdue");
  expect(reasonText("SOMETHING_NEW")).toMatch(/something new/i);
});

describe("HealthCard", () => {
  it("shows the rating, reasons and indexes", async () => {
    server.use(http.get("*/api/v1/projects/projects/p1/health", () => HttpResponse.json(H)));
    renderWithProviders(<HealthCard id="p1" />, {});
    expect(await screen.findByText("Off track")).toBeInTheDocument();
    expect(screen.getByText("Costs are well over plan")).toBeInTheDocument();
    expect(screen.getByText(/Cost index 0.70 · Schedule index –/)).toBeInTheDocument();
    expect(screen.getByText(/1 overdue task\b/)).toBeInTheDocument();
  });
  it("degrades quietly when health is unavailable", async () => {
    server.use(http.get("*/api/v1/projects/projects/p1/health", () => HttpResponse.json({ error: { code: "forbidden", message: "Not allowed." } }, { status: 403 })));
    renderWithProviders(<HealthCard id="p1" />, {});
    expect(await screen.findByRole("alert")).toHaveTextContent("Not allowed.");
  });
});

describe("PortfolioPage", () => {
  const D = { by_status: { ACTIVE: 2, COMPLETED: 1 }, rag: { RED: 1, AMBER: 0, GREEN: 1 }, projects: [{ id: "p1", code: "P-1", name: "Alpha", status: "ACTIVE", manager_id: "u1", start_on: "2026-01-01", end_on: "2026-12-31", rag: "RED", reasons: ["COST_OVERRUN"], percent_complete: "40", margin: "1200.00" }, { id: "p2", code: "P-2", name: "Beta", status: "COMPLETED", manager_id: "u1", start_on: "2026-01-01", end_on: "2026-06-30", rag: null, reasons: [], percent_complete: "100" }] };
  it("shows counts, links and margin where the server sent it", async () => {
    server.use(emp, http.get("*/api/v1/projects/portfolio", () => HttpResponse.json(D)));
    renderWithProviders(<PortfolioPage />, {});
    expect(await screen.findByRole("link", { name: "P-1" })).toHaveAttribute("href", "/app/projects/projects/p1");
    expect(screen.getByText("Not rated")).toBeInTheDocument();
    expect(screen.getByText("2 active · 1 completed")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Margin" })).toBeInTheDocument();
    expect(await screen.findAllByText("Pat Manager")).toHaveLength(2);
  });
  it("omits the margin column when no project has one", async () => {
    server.use(emp, http.get("*/api/v1/projects/portfolio", () => HttpResponse.json({ ...D, projects: D.projects.map(({ margin: _m, ...p }) => p) })));
    renderWithProviders(<PortfolioPage />, {});
    await screen.findByRole("link", { name: "P-1" });
    expect(screen.queryByRole("columnheader", { name: "Margin" })).toBeNull();
  });
  it("shows an empty state", async () => {
    server.use(emp, http.get("*/api/v1/projects/portfolio", () => HttpResponse.json({ by_status: {}, rag: { RED: 0, AMBER: 0, GREEN: 0 }, projects: [] })));
    renderWithProviders(<PortfolioPage />, {});
    expect(await screen.findByText("No projects")).toBeInTheDocument();
  });
});
